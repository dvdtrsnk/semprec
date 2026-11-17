import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createLogger } from "@semprec/shared";
import { findOrCreateBlob, lockBlobById } from "../blobs/blobsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { runAfterCommit, withClient, withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, UpstreamUnavailableError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter, resolveBlobStorageDir, type BlobStorageWriter } from "../mail/blobStorage.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import type { DatabaseRow } from "../types.js";
import { getCoverCandidate, listCoverCandidates } from "./coverCandidatesStore.js";
import { resetItemAutomationToPending } from "./itemAutomationStore.js";
import { readJobConfig } from "./libraryAutomationRouteHandlers.js";
import { disposeLibraryCover, prepareLibraryCover } from "./libraryCoverStorage.js";
import { COVER_OVERRIDE_KEY, COVER_REMOVED_KEY, COVER_SOURCE_KEY } from "./libraryModuleContract.js";
import { enqueueLibraryMetadataProcessing } from "./libraryMetadataJob.js";
import { downloadLibraryCoverOutcome, type LibraryCoverDownloadOutcome } from "./openLibraryFetcher.js";
import type { CustomRouteResult, RouteParams, RouteUser } from "../customRoute.js";

const logger = createLogger("library-cover-candidates");

export interface LibraryCoverCandidateSelectOptions {
  /** Default `downloadLibraryCoverOutcome`, which goes through `createOutboundHttp()`. */
  downloadCover?: (url: string) => Promise<LibraryCoverDownloadOutcome>;
  /** Default: the local file store of `FILES_STORAGE_DIR`. */
  storage?: BlobStorageWriter;
}

function parseItemId(params: Record<string, string>): string {
  const parsed = z.uuid().safeParse(params.id);
  if (!parsed.success) throw new ValidationError("Item id must be a UUID", { field: "id" });
  return parsed.data;
}

/** Any text other than 0-2 is a candidate that does not exist (404). */
function parseCandidateIndex(params: Record<string, string>): number {
  if (params.index === undefined || !/^[0-2]$/.test(params.index)) throw new NotFoundError("Cover candidate not found");
  return Number(params.index);
}

/** A missing id, another tenant's id, a trashed item and a non-library item are the same 404. */
async function locateLibraryItem(client: PoolClient, itemId: string): Promise<DatabaseRow> {
  const [located] = await itemsStore.getItemsByIdsIncludingDeleted(client, [itemId]);
  const database = located ? await databasesStore.getDatabase(client, located.databaseId) : null;
  if (
    !located ||
    located.deletedAt ||
    !database ||
    (database.ownerModuleId !== BOOKS_MODULE_ID && database.ownerModuleId !== MOVIES_MODULE_ID)
  ) {
    throw new NotFoundError("Item not found");
  }
  return database;
}

/** Reads the stored table only; makes no external request. */
export function createLibraryCoverCandidatesListRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteUser): Promise<CustomRouteResult> => {
    const itemId = parseItemId(ctx.params);
    const candidates = await withClient(pool, async (client) => {
      await locateLibraryItem(client, itemId);
      return listCoverCandidates(client, itemId);
    });
    return { status: 200, body: candidates };
  };
}

/**
 * Like the retry route it locks the automation row, then the item row, and resets to `pending` (even `locked`),
 * but leaves `coverOverride`, `coverRemoved` and `coverSource` untouched. Answers 202; the job runs later.
 */
export function createLibraryCoverCandidatesRefreshRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteUser): Promise<CustomRouteResult> => {
    const itemId = parseItemId(ctx.params);
    const userId = ctx.identity.user.id;
    await withTransaction(pool, async (client) => {
      const database = await locateLibraryItem(client, itemId);
      const config = await readJobConfig(client, database);
      await enqueueLibraryMetadataProcessing(client, { itemId, databaseId: database.id, config });
      await resetItemAutomationToPending(client, itemId);
      // Catches an item trashed after the unlocked read; the throw rolls back the enqueue and the reset.
      const stored = await itemsStore.lockItemById(client, database.id, itemId);
      if (!stored || stored.deletedAt) throw new NotFoundError("Item not found");
      runAfterCommit(client, () =>
        notifyInvalidation({
          scope: "item",
          databaseId: database.id,
          itemId,
          op: "update",
          updatedAt: stored.updatedAt,
          userId,
        }),
      );
    });
    return { status: 202, body: { itemId, status: "pending" } };
  };
}

/**
 * The image is downloaded with no transaction open (outbound policy: private/link-local addresses refused, size
 * cap, image content type, no redirects) and staged in the blob store. One transaction then locks the item,
 * checks the candidate is still the downloaded one (else 409 `cover_candidates_changed`) and writes the cover as
 * the user.
 *
 * A refused or unusable download is a 400 on `index`; an unreachable host is a retryable 502. The URL is never
 * logged. Staged bytes are removed after a confirmed rollback or when the commit kept another blob for the same
 * bytes, but kept when COMMIT itself failed, because the live cover may be the staged file.
 */
export function createLibraryCoverCandidateSelectHandler(pool: Pool, options: LibraryCoverCandidateSelectOptions = {}) {
  const downloadCover = options.downloadCover ?? downloadLibraryCoverOutcome;
  return async (ctx: RouteParams & RouteUser): Promise<CustomRouteResult> => {
    const itemId = parseItemId(ctx.params);
    const index = parseCandidateIndex(ctx.params);
    const userId = ctx.identity.user.id;

    const { database, candidate } = await withClient(pool, async (client) => {
      const located = await locateLibraryItem(client, itemId);
      const found = await getCoverCandidate(client, itemId, index);
      if (!found) throw new NotFoundError("Cover candidate not found");
      return { database: located, candidate: found };
    });

    const storage = options.storage ?? new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR"));
    const outcome = await downloadCover(candidate.imageUrl);
    if (outcome.kind !== "downloaded") {
      // The candidate URL and exception text come from a provider and stay out of the log.
      logger.warn(
        { itemId, index, outcome: outcome.kind, reason: outcome.kind === "unavailable" ? outcome.reason : undefined },
        "Cover candidate image was not downloaded",
      );
      if (outcome.kind === "unavailable") {
        throw new UpstreamUnavailableError("The cover candidate image host is unavailable", { reason: outcome.reason });
      }
      throw new ValidationError(
        outcome.kind === "refused"
          ? "The cover candidate image address is not allowed"
          : "The cover candidate image is not a usable image",
        { field: "index" },
      );
    }
    const prepared = await prepareLibraryCover(pool, storage, outcome.cover);

    // `bodyFinished` false in `finally` means the body threw (rolled back). True with `committed` false means
    // COMMIT itself failed with an unknown outcome, so the staged bytes are kept rather than risk deleting a live cover.
    let bodyFinished = false;
    let committed = false;
    let blobKept = false;
    try {
      const blobId = await withTransaction(pool, async (client) => {
        runAfterCommit(client, () => {
          committed = true;
        });
        const stored = await itemsStore.lockItemById(client, database.id, itemId);
        if (!stored || stored.deletedAt) throw new NotFoundError("Item not found");
        const current = await getCoverCandidate(client, itemId, index);
        if (!current || current.imageUrl !== candidate.imageUrl) {
          throw new ConflictError(
            "The cover candidates changed; list them again",
            undefined,
            "cover_candidates_changed",
          );
        }
        const blob = await findOrCreateBlob(client, prepared);
        if (!(await lockBlobById(client, blob.id))) throw new Error("Library cover blob disappeared");
        blobKept = blob.storageKey === prepared.storageKey;
        const patch: Record<string, unknown> = {
          [COVER_OVERRIDE_KEY]: { blobId: blob.id },
          [COVER_SOURCE_KEY]: "candidate",
        };
        if (stored.properties[COVER_REMOVED_KEY] === true) patch[COVER_REMOVED_KEY] = false;
        const updated = await updateItemWithClient(
          client,
          { databaseId: database.id, itemId, propertiesPatch: patch },
          { writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
        );
        runAfterCommit(client, () =>
          notifyInvalidation({
            scope: "item",
            databaseId: database.id,
            itemId,
            op: "update",
            updatedAt: updated.updatedAt,
            userId,
          }),
        );
        bodyFinished = true;
        return blob.id;
      });
      return { status: 200, body: { itemId, coverOverride: { blobId }, coverSource: "candidate" } };
    } finally {
      if (!bodyFinished || (committed && !blobKept)) {
        try {
          await disposeLibraryCover(storage, prepared.storageKey);
        } catch {
          logger.error("Failed to remove staged cover candidate bytes");
        }
      }
    }
  };
}

export function createLibraryCoverCandidateSelectRouteHandler(pool: Pool) {
  return createLibraryCoverCandidateSelectHandler(pool);
}
