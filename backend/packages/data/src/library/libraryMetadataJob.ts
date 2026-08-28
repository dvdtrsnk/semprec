import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { withTransaction } from "../db/pool.js";
import { updateItemWithClient } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createBlob, type CreateBlobInput } from "../blobs/blobsStore.js";
import { ensureItemAutomation, getItemAutomation, markItemAutomationDone, markItemAutomationError } from "./itemAutomationStore.js";
import type { ItemRow } from "../types.js";

/**
 * Config-driven mapping (issue #25): which property keys this run is allowed to write,
 * and which external source to read from — swapping the source never changes the job's
 * contract, only this object's `source`/mapping fields.
 */
export interface LibraryMetadataJobConfig {
  /** Discriminates which fetcher a caller-supplied `LibraryMetadataFetcher` resolves to. */
  source: string;
  coverKey: string;
  secondaryRatingKey?: string;
  sourceUrlKey?: string;
}

export interface LibraryMetadataFetchResult {
  cover?: CreateBlobInput;
  secondaryRating?: number;
  sourceUrl?: string;
}

/**
 * Pluggable, same injection shape as `RunAgentFn`/`coreAgentRunAction` (scheduler/actions.ts):
 * actually calling an external metadata source (TMDb/OMDB/...) is out of this issue's scope,
 * so the default (see worker.ts) is a no-op that finds nothing — a legitimate, non-error
 * outcome for "no source wired up yet," not a failure to retry.
 */
export type LibraryMetadataFetcher = (item: ItemRow, config: LibraryMetadataJobConfig) => Promise<LibraryMetadataFetchResult>;

export const noopLibraryMetadataFetcher: LibraryMetadataFetcher = async () => ({});

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
export async function enqueueLibraryMetadataProcessing(client: PoolClient, input: EnqueueLibraryMetadataInput): Promise<void> {
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
 * both "never enqueued for a locked row" (the retry sweep only selects 'error' rows) and
 * "locked mid-flight" (a job already queued when the user locks it).
 *
 * On failure, `item_automation` records the error and this rethrows so graphile-worker's
 * own retry/backoff (`max_attempts: 3` on this job) takes over; on the final failed
 * attempt the row is left in 'error', picked up again by the next daily retry sweep.
 */
export async function handleProcessLibraryMetadataTask(pool: Pool, payload: ProcessLibraryMetadataPayload, fetcher: LibraryMetadataFetcher): Promise<void> {
  const readClient = await pool.connect();
  let automation;
  let item: ItemRow | null;
  try {
    automation = await getItemAutomation(readClient, payload.itemId);
    item = automation?.status === "locked" ? null : await itemsStore.getItemById(readClient, payload.databaseId, payload.itemId);
  } finally {
    readClient.release();
  }
  if (automation?.status === "locked") return;
  if (!item || item.deletedAt) return;

  try {
    const result = await fetcher(item, payload.config);
    await withTransaction(pool, async (client) => {
      const patch: Record<string, unknown> = {};
      const allowedSystemKeys: string[] = [];

      if (result.cover) {
        const blob = await createBlob(client, result.cover);
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

      if (Object.keys(patch).length > 0) {
        await updateItemWithClient(client, { databaseId: payload.databaseId, itemId: payload.itemId, propertiesPatch: patch }, { allowedSystemKeys });
      }
      await markItemAutomationDone(client, payload.itemId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTransaction(pool, (client) => markItemAutomationError(client, payload.itemId, message));
    throw err;
  }
}
