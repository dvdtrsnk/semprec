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

const logger = createLogger("library-cover-candidates");

/** The request context of the three routes: the path parameters and the authenticated user. */
interface CoverCandidateRouteContext {
  params: Record<string, string>;
  identity: { user: { id: string } };
}

type RouteResult = { status: number; body: unknown };

/** What the select route downloads and stores through; the defaults are the production ones. */
export interface LibraryCoverCandidateSelectOptions {
  /**
   * Fetches the image of a candidate and says how it ended; the default is `downloadLibraryCoverOutcome`, which goes
   * through `createOutboundHttp()`.
   */
  downloadCover?: (url: string) => Promise<LibraryCoverDownloadOutcome>;
  /** Where the image bytes are written; the default is the local file store of `FILES_STORAGE_DIR`. */
  storage?: BlobStorageWriter;
}

function parseItemId(params: Record<string, string>): string {
  const parsed = z.uuid().safeParse(params.id);
  if (!parsed.success) throw new ValidationError("Item id must be a UUID", { field: "id" });
  return parsed.data;
}

/** A position the table can hold (0 to 2) as written in the path; any other text is a candidate that does not exist. */
function parseCandidateIndex(params: Record<string, string>): number {
  if (params.index === undefined || !/^[0-2]$/.test(params.index)) throw new NotFoundError("Cover candidate not found");
  return Number(params.index);
}

/**
 * The database of a live item of a Books or Movies database of the caller's tenant. A missing id, another tenant's
 * id, a trashed item and an item of another database are one and the same 404.
 */
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

/**
 * `GET /api/items/:id/cover-candidates` (issue #1812): the candidates the metadata job stored for a Books or Movies
 * item, as `[{ index, source, title, subtitle, imageUrl }]` in position order. It reads the table only and makes no
 * request to an external service. A malformed id is a 400 on `id`; an id that is not a live Books or Movies item of
 * the caller's tenant is a 404.
 */
export function createLibraryCoverCandidatesListRouteHandler(pool: Pool) {
  return async (ctx: CoverCandidateRouteContext): Promise<RouteResult> => {
    const itemId = parseItemId(ctx.params);
    const candidates = await withClient(pool, async (client) => {
      await locateLibraryItem(client, itemId);
      return listCoverCandidates(client, itemId);
    });
    return { status: 200, body: candidates };
  };
}

/**
 * `POST /api/items/:id/cover-candidates/refresh` (issue #1812): asks for a new search, so that the metadata job
 * replaces the stored candidates. Like the retry route (`createLibraryAutomationRetryRouteHandler`) it takes the
 * automation row and then the item row, sets the automation row to `pending` (a `locked` one included), enqueues
 * the job with the config of the database's metadata heartbeat and publishes the item's invalidation after the
 * commit. Unlike the retry route it leaves `coverOverride`, `coverRemoved` and `coverSource` as they are. Answers
 * 202; the job runs later, outside the request. The 400 and 404 cases are those of the list route, and a trashed
 * item is refused before any lock is taken.
 */
export function createLibraryCoverCandidatesRefreshRouteHandler(pool: Pool) {
  return async (ctx: CoverCandidateRouteContext): Promise<RouteResult> => {
    const itemId = parseItemId(ctx.params);
    const userId = ctx.identity.user.id;
    await withTransaction(pool, async (client) => {
      const database = await locateLibraryItem(client, itemId);
      const config = await readJobConfig(client, database);
      await enqueueLibraryMetadataProcessing(client, { itemId, databaseId: database.id, config });
      await resetItemAutomationToPending(client, itemId);
      // The locked read decides the narrow case of an item trashed after the read above, which rolls the enqueue
      // and the reset back.
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
 * `POST /api/items/:id/cover-candidates/:index/select` (issue #1812): makes the stored candidate at `index` the
 * item's manual cover. The image is downloaded first, with no transaction open, through `downloadCover` (by
 * default `downloadLibraryCoverOutcome`: the stored-URL baseline, then `createOutboundHttp()`, which refuses an
 * address in a private or link-local range at connect time, a size cap, an image content type and no redirects), and
 * its bytes are staged in the blob store. One transaction then locks the item row, checks that the candidate is
 * still the one that was downloaded, stores the blob and writes `coverOverride` (the blob), `coverSource:
 * "candidate"` and, when the item holds a removal, `coverRemoved: false` as the user through `updateItemWithClient`.
 * The item's invalidation is published after the commit. Answers 200 with the item id and the blob id.
 *
 * A malformed id is a 400 on `id`. An id that is not a live Books or Movies item of the caller's tenant, and an
 * index with no stored candidate (also a path segment that is not 0, 1 or 2), are one 404. A download that is
 * refused (an address the outbound policy denies) or that returns something that is not a usable image is a 400 on
 * `index`; one that fails because the host did not answer (timeout, connection failure, a non-success status) is a
 * 502 `upstream_unavailable`, which the caller may retry. Each of them writes nothing and logs the item id, the
 * index and the kind, never the URL. A candidate set that a metadata run replaced while the image was downloading is
 * a 409 `cover_candidates_changed`: the image belongs to the old set.
 *
 * The staged bytes are removed when the transaction body threw (a confirmed rollback) and when the commit kept
 * another blob for the same bytes. They are kept when COMMIT itself failed, because its outcome is unknown and the
 * live cover may be the staged file (docs/adr/2026-11-05-library-covers-stage-bytes-before-the-owned-item-transaction.md).
 */
export function createLibraryCoverCandidateSelectHandler(pool: Pool, options: LibraryCoverCandidateSelectOptions = {}) {
  const downloadCover = options.downloadCover ?? downloadLibraryCoverOutcome;
  return async (ctx: CoverCandidateRouteContext): Promise<RouteResult> => {
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
      // Only the kind, the reason and the ids are logged: the candidate URL and the exception text come from a
      // provider and stay out of the log.
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

    // `bodyFinished` is the last statement of the transaction body, so a false value in `finally` means the body threw
    // and the transaction was rolled back. With it true and `committed` false, COMMIT itself failed: its outcome is
    // unknown and the staged bytes are kept, as the library cover ADR decides, rather than deleting a possibly live cover.
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

/** The factory the route table mounts for the select route: the production download and storage. */
export function createLibraryCoverCandidateSelectRouteHandler(pool: Pool) {
  return createLibraryCoverCandidateSelectHandler(pool);
}
