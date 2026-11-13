import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
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
import { createLogger } from "@semprec/shared";

import { assertSupportedLibraryMetadataSource, LibraryMetadataConfigurationError } from "./libraryMetadataConfig.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import {
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
import { raiseProblem } from "../semp/sempProblemsStore.js";
import { automationProblemKey } from "../semp/sourceProblemKeys.js";
import type { ItemRow } from "../types.js";

const logger = createLogger("library-metadata");

/**
 * Config-driven mapping (issue #25): which property keys this run is allowed to write,
 * and which external source to read from — swapping the source never changes the job's
 * contract, only this object's `source`/mapping fields. The single schema both the
 * enqueue side (libraryMetadataActions.ts, which extends it with `databaseId`) and the
 * job payload parsing side (worker.ts) validate against, so the two never drift apart.
 */
export const libraryMetadataJobConfigSchema = z.object({
  /** Discriminates which fetcher a caller-supplied `LibraryMetadataFetcher` resolves to. */
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

/**
 * The worker accepts an injected metadata fetcher. Its default is a no-op; the API queue
 * composition supplies the configured library metadata dispatcher.
 */
export type LibraryMetadataFetcher = (
  item: ItemRow,
  config: LibraryMetadataJobConfig,
) => Promise<LibraryMetadataFetchResult>;

export const noopLibraryMetadataFetcher: LibraryMetadataFetcher = async () => ({});

/**
 * The alternative matches of a run in the form the store takes: the run's source (the configured one when the
 * result names none) on each, and the author and year of an entry joined into its subtitle. An entry without a
 * cover URL is dropped here, and the store drops the entries whose URL fails its check. No source means no
 * candidate can be stored, so the result is empty.
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

export function libraryMetadataJobKey(itemId: string): string {
  return `library-metadata:${itemId}`;
}

export interface EnqueueLibraryMetadataInput {
  itemId: string;
  databaseId: string;
  config: LibraryMetadataJobConfig;
}

/**
 * Also seeds the `item_automation` row (idempotent) so a row always exists before its
 * first processing attempt can run. Called both from the onItemEvent trigger action (one
 * item, just created) and from the daily retry sweep action (many items, already existing
 * `item_automation` rows) — `ensureItemAutomation`'s no-op-on-conflict behavior covers both.
 */
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
 * The job body (registered in worker.ts as `CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS`).
 * `locked` is the one status the heartbeat may never touch — skipped outright, covering
 * both "never enqueued for a locked row" (the retry sweep selects 'error' and 'notFound') and
 * "locked mid-flight" (a job already queued when the user locks it).
 *
 * On failure, `item_automation` records the error and this rethrows so graphile-worker's
 * own retry/backoff (`max_attempts: 3` on this job) takes over; on the final failed
 * attempt the row is left in 'error', picked up again by the next daily retry sweep.
 */
export interface ProcessLibraryMetadataHelpers {
  job: { id: string };
}

/**
 * `helpers` defaults to a freshly generated id: only graphile-worker's real per-attempt job id
 * (threaded through by worker.ts) makes the `automation_error` notification's `transitionInstance`
 * (issue #149) dedupe correctly across retries of the *same* attempt — callers that don't care
 * about that can omit it entirely.
 */
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
    // Settles the row instead of leaving it exactly as found: a job enqueued right before
    // the item was soft-deleted would otherwise leave a 'pending'/'error' row that the daily
    // retry sweep keeps re-enqueuing forever for an item that no longer exists to enrich.
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
      // Re-checked under `FOR UPDATE` inside this same transaction: the plain read above
      // only decided whether it was worth calling `fetcher` at all — a user could still lock
      // the row while that fetch was in flight. Without this, the property write below would
      // land on a since-locked item even though `markItemAutomationDone` (guarded by
      // `WHERE status != 'locked'`) would then silently no-op.
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
      // Every run that did not fail replaces the item's candidates (a run with none leaves it with none), in this
      // transaction and after the item row lock taken above.
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
    // Issue #149: notification lands in the same transaction as the error record, so a
    // replayed job (same job id, same `transitionInstance`) never duplicates it.
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
