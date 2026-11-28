import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { BOOKS_LIBRARY_CONTRACT, MOVIES_LIBRARY_CONTRACT } from "./libraryModuleContract.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import { findOrCreateBlob, lockBlobById } from "../blobs/blobsStore.js";
import { LocalFsBlobStorageWriter, resolveBlobStorageDir, type BlobStorageWriter } from "../mail/blobStorage.js";
import { disposeLibraryCover, prepareLibraryCover, type DownloadedLibraryCover } from "./libraryCoverStorage.js";
import { createLogger } from "@alldots/shared";

import { assertSupportedLibraryMetadataSource, LibraryMetadataConfigurationError } from "./libraryMetadataConfig.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import {
  databaseHasItemAutomationError,
  ensureItemAutomation,
  getItemAutomation,
  lockItemAutomation,
  markItemAutomationDone,
  markItemAutomationError,
  markItemAutomationNotFound,
  type ItemAutomationErrorCode,
  type LibraryAutomationSource,
} from "./itemAutomationStore.js";
import { replaceCoverCandidates, type CoverCandidateInput } from "./coverCandidatesStore.js";
import { lockProblemKey, raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { automationProblemKey } from "../semp/sourceProblemKeys.js";
import type { ItemRow } from "../types.js";

const logger = createLogger("library-metadata");

/**
 * Which property keys a run may write and which source it reads; shared by the enqueue side
 * (libraryMetadataActions.ts) and the worker payload parsing so the two never drift.
 */
export const libraryMetadataJobConfigSchema = z.object({
  source: z.string(),
  coverKey: z.string(),
  secondaryRatingKey: z.string().optional(),
  sourceUrlKey: z.string().optional(),
  authorKey: z.string().optional(),
  yearKey: z.string().optional(),
  typeKey: z.string().optional(),
  isbnKey: z.string().optional(),
});

export type LibraryMetadataJobConfig = z.infer<typeof libraryMetadataJobConfigSchema>;

export interface LibraryMetadataFetchResult {
  status?: "found" | "notFound" | "error";
  errorCode?: "sourceUnavailable" | "rateLimited" | "invalidResponse";
  source?: "openLibrary" | "googleBooks" | "tmdb";
  candidates?: Array<{ title: string; author?: string; year?: number; coverUrl?: string }>;
  cover?: DownloadedLibraryCover;
  secondaryRating?: number;
  sourceUrl?: string;
  author?: string;
  year?: number;
  type?: string;
  isbn?: string;
}

/** Default is a no-op; the API queue composition supplies the configured dispatcher. */
export type LibraryMetadataFetcher = (
  item: ItemRow,
  config: LibraryMetadataJobConfig,
) => Promise<LibraryMetadataFetchResult>;

export const noopLibraryMetadataFetcher: LibraryMetadataFetcher = async () => ({});

/**
 * Candidates without a cover URL are dropped (the store also drops URLs failing its check); with no source
 * nothing can be stored.
 */
function toCoverCandidates(
  candidates: LibraryMetadataFetchResult["candidates"],
  source: LibraryAutomationSource | undefined,
): CoverCandidateInput[] {
  if (!candidates || !source) return [];
  return candidates.flatMap((candidate) =>
    candidate.coverUrl === undefined
      ? []
      : [
          {
            source,
            title: candidate.title,
            subtitle: [candidate.author, candidate.year].filter((part) => part !== undefined).join(", ") || null,
            imageUrl: candidate.coverUrl,
          },
        ],
  );
}

/**
 * The problem key's lock is taken before the check, so a concurrent failing job of another item either
 * committed its error first (problem stays) or raises after this commits (new problem).
 */
async function resolveAutomationProblemWhenClear(client: PoolClient, databaseId: string): Promise<void> {
  const dedupeKey = automationProblemKey(databaseId);
  await lockProblemKey(client, dedupeKey);
  if (await databaseHasItemAutomationError(client, databaseId)) return;
  await resolveProblem(client, { dedupeKey, resolutionKind: "recovered" });
}

export function libraryMetadataJobKey(itemId: string): string {
  return `library-metadata:${itemId}`;
}

export interface EnqueueLibraryMetadataInput {
  itemId: string;
  databaseId: string;
  config: LibraryMetadataJobConfig;
}

/** Also seeds the `item_automation` row (idempotent) so it exists before the first attempt. */
export async function enqueueLibraryMetadataProcessing(
  client: PoolClient,
  input: EnqueueLibraryMetadataInput,
): Promise<void> {
  assertSupportedLibraryMetadataSource(input.config.source);
  await ensureItemAutomation(client, input.itemId);
  await enqueueJob(
    client,
    CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS,
    { itemId: input.itemId, databaseId: input.databaseId, config: input.config },
    { jobKey: libraryMetadataJobKey(input.itemId), maxAttempts: 3 },
  );
}

export interface ProcessLibraryMetadataPayload {
  itemId: string;
  databaseId: string;
  config: LibraryMetadataJobConfig;
}

/**
 * A `locked` row is never touched. On failure the error is recorded and rethrown so graphile-worker's
 * retry (`maxAttempts: 3`) applies; after the last attempt the row stays 'error' for the daily retry sweep.
 */
export interface ProcessLibraryMetadataHelpers {
  job: { id: string };
}

/** Pass the real per-attempt job id so the `automation_error` notification dedupes across replays. */
export async function handleProcessLibraryMetadataTask(
  pool: Pool,
  payload: ProcessLibraryMetadataPayload,
  fetcher: LibraryMetadataFetcher,
  helpers: ProcessLibraryMetadataHelpers = { job: { id: randomUUID() } },
  coverStorage?: BlobStorageWriter,
): Promise<void> {
  assertSupportedLibraryMetadataSource(payload.config.source);
  const readClient = await pool.connect();
  let automation;
  let item: ItemRow | null;
  try {
    automation = await getItemAutomation(readClient, payload.itemId);
    item =
      automation?.status === "locked"
        ? null
        : await itemsStore.getItemById(readClient, payload.databaseId, payload.itemId);
  } finally {
    readClient.release();
  }
  if (automation?.status === "locked") return;
  if (!item || item.deletedAt) {
    // Settle the row, or the daily retry sweep would re-enqueue a deleted item forever.
    await withTransaction(pool, (client) => markItemAutomationDone(client, payload.itemId));
    return;
  }

  let prepared: Awaited<ReturnType<typeof prepareLibraryCover>> | undefined;
  let storage: BlobStorageWriter | undefined;
  let callbackFinished = false;
  let committed = false;
  let retained = false;
  let candidateRetained = false;
  let failureCode: ItemAutomationErrorCode = "sourceUnavailable";
  const configuredSource = z.enum(["openLibrary", "googleBooks", "tmdb"]).safeParse(payload.config.source);
  let failureSource: LibraryAutomationSource | null = configuredSource.success ? configuredSource.data : null;
  let result: LibraryMetadataFetchResult;
  try {
    result = await fetcher(item, payload.config);
  } catch (error) {
    if (error instanceof LibraryMetadataConfigurationError) throw error;
    result = { status: "error", errorCode: "sourceUnavailable" };
  }
  try {
    failureSource = result.source ?? failureSource;
    if (result.status === "error") {
      failureCode = result.errorCode ?? "sourceUnavailable";
      throw new Error("Library metadata processing failed");
    }
    if (result.cover && result.status !== "notFound") {
      storage = coverStorage ?? new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR"));
      prepared = await prepareLibraryCover(pool, storage, result.cover);
    }
    await withTransaction(pool, async (client) => {
      runAfterCommit(client, () => {
        committed = true;
        retained = candidateRetained;
      });
      // Re-checked under `FOR UPDATE`: the user may have locked the row while the fetch was in flight.
      const current = await lockItemAutomation(client, payload.itemId);
      if (!current || current.status === "locked") {
        callbackFinished = true;
        return;
      }

      const stored = await itemsStore.lockItemById(client, payload.databaseId, payload.itemId);
      if (!stored || stored.deletedAt) {
        await markItemAutomationDone(client, payload.itemId);
        callbackFinished = true;
        return;
      }
      // A successful run always replaces the candidates, after the item row lock above.
      await replaceCoverCandidates(
        client,
        payload.itemId,
        toCoverCandidates(
          result.candidates,
          result.source ?? (configuredSource.success ? configuredSource.data : undefined),
        ),
      );
      if (result.status === "notFound") {
        await markItemAutomationNotFound(client, payload.itemId, result.source ?? null);
        await resolveAutomationProblemWhenClear(client, stored.databaseId);
        runAfterCommit(client, () =>
          notifyInvalidation({
            scope: "item",
            databaseId: stored.databaseId,
            itemId: stored.id,
            op: "update",
            updatedAt: stored.updatedAt,
          }),
        );
        callbackFinished = true;
        return;
      }
      const database = await databasesStore.getDatabase(client, payload.databaseId);
      const contract =
        database?.ownerModuleId === BOOKS_MODULE_ID
          ? BOOKS_LIBRARY_CONTRACT
          : database?.ownerModuleId === MOVIES_MODULE_ID
            ? MOVIES_LIBRARY_CONTRACT
            : undefined;
      const properties = await propertiesStore.listPropertiesByDatabase(client, payload.databaseId);
      const patch: Record<string, unknown> = {};
      for (const [key, value] of [
        [payload.config.authorKey, result.author],
        [payload.config.yearKey, result.year],
        [payload.config.typeKey, result.type],
        [payload.config.isbnKey, result.isbn],
      ] as const) {
        if (!key || !contract?.automationFillableKeys?.includes(key) || value === undefined || value === "") continue;
        const property = properties.find((candidate) => candidate.key === key && candidate.owner === "user");
        if (
          !property ||
          (stored.properties[key] !== undefined && stored.properties[key] !== null && stored.properties[key] !== "")
        )
          continue;
        if (
          key === payload.config.typeKey &&
          (property.type !== "select" ||
            !Array.isArray(property.config.options) ||
            !property.config.options.some(
              (option: unknown) =>
                typeof option === "object" && option !== null && "key" in option && option.key === value,
            ))
        )
          continue;
        patch[key] = value;
      }
      const allowedSystemKeys: string[] = [];

      if (prepared) {
        const blob = await findOrCreateBlob(client, prepared);
        if (!(await lockBlobById(client, blob.id))) throw new Error("Library cover blob disappeared");
        candidateRetained = blob.storageKey === prepared.storageKey;
        patch[payload.config.coverKey] = { blobId: blob.id };
        allowedSystemKeys.push(payload.config.coverKey);
      }
      if (result.secondaryRating !== undefined && payload.config.secondaryRatingKey) {
        patch[payload.config.secondaryRatingKey] = result.secondaryRating;
        allowedSystemKeys.push(payload.config.secondaryRatingKey);
      }
      if (result.sourceUrl !== undefined && payload.config.sourceUrlKey) {
        patch[payload.config.sourceUrlKey] = result.sourceUrl;
        allowedSystemKeys.push(payload.config.sourceUrlKey);
      }

      let updatedAt = stored.updatedAt;
      if (Object.keys(patch).length > 0) {
        const updated = await updateItemWithClient(
          client,
          { databaseId: payload.databaseId, itemId: payload.itemId, propertiesPatch: patch },
          { allowedSystemKeys },
        );
        updatedAt = updated.updatedAt;
      }
      await markItemAutomationDone(client, payload.itemId, result.source ?? null);
      await resolveAutomationProblemWhenClear(client, stored.databaseId);
      runAfterCommit(client, () =>
        notifyInvalidation({
          scope: "item",
          databaseId: stored.databaseId,
          itemId: stored.id,
          op: "update",
          updatedAt,
        }),
      );
      callbackFinished = true;
    });
  } catch {
    if (committed) {
      logger.error("Library metadata committed but transaction release failed");
      return;
    }
    const message = "Library metadata processing failed";
    // Same transaction as the error record, so a replayed job never duplicates the notification.
    await withTransaction(pool, async (client) => {
      const automation = await lockItemAutomation(client, payload.itemId);
      if (!automation || automation.status === "locked") return;
      const stored = await itemsStore.lockItemById(client, payload.databaseId, payload.itemId);
      if (!stored || stored.deletedAt) return;
      await markItemAutomationError(client, payload.itemId, message, failureCode, failureSource);
      runAfterCommit(client, () =>
        notifyInvalidation({
          scope: "item",
          databaseId: stored.databaseId,
          itemId: stored.id,
          op: "update",
          updatedAt: stored.updatedAt,
        }),
      );
      const userId = await getTenantUserId(client);
      if (userId) {
        await writeNotification(client, {
          userId,
          kind: "automation_error",
          linkHref: `?page=library-item&id=${payload.itemId}`,
          sourceTable: "item_automation",
          sourceId: payload.itemId,
          transitionInstance: helpers.job.id,
        });
        await raiseProblem(client, {
          userId,
          category: "automation",
          kind: "libraryAutomation",
          severity: "warning",
          sourceTable: "item_automation",
          sourceId: payload.itemId,
          dedupeKey: automationProblemKey(item.databaseId),
          occurrenceKey: helpers.job.id,
        });
      }
    });
    throw new Error(message);
  } finally {
    if (storage && prepared && (!callbackFinished || (committed && !retained))) {
      try {
        await disposeLibraryCover(storage, prepared.storageKey);
      } catch {
        logger.error("Failed to remove staged library cover bytes");
      }
    }
  }
}
