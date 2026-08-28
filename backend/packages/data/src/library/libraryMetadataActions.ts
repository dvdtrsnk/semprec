import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import { enqueueLibraryMetadataProcessing, libraryMetadataJobConfigSchema } from "./libraryMetadataJob.js";
import { listErroredItemAutomationForDatabases } from "./itemAutomationStore.js";

export const LIBRARY_METADATA_TRIGGER_ACTION_ID = "core.libraryMetadataTrigger";
export const LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID = "core.libraryMetadataRetrySweep";

/** The heartbeat's `action_config` for both library-metadata actions: the job config plus the database it's scoped to. */
const libraryMetadataActionConfigSchema = libraryMetadataJobConfigSchema.extend({
  databaseId: z.string().uuid(),
});

/**
 * Registered as an `onItemEvent` ('create') heartbeat action for a library database
 * (Books, Movies/TV): the choke-point's generic "react to an item write" mechanism gives
 * every caller of `createItem` — UI or AI, present or future — the same automation
 * hookup, with no special-cased second path (issue #25's "single path for adding an
 * item"). The action itself only seeds `item_automation` and enqueues the actual
 * `processLibraryMetadata` job; the outer heartbeatFire job's own retry is an
 * implementation detail underneath, not the retry policy the issue specifies (that one
 * belongs to the enqueued job itself — see libraryMetadataJob.ts).
 */
export function createLibraryMetadataTriggerAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return; // only meaningful for an onItemEvent fire
    const config = libraryMetadataActionConfigSchema.parse(actionConfig);
    await withTransaction(pool, (client) =>
      enqueueLibraryMetadataProcessing(client, { itemId: context.itemId as string, databaseId: config.databaseId, config }),
    );
  };
}

/**
 * Registered as a `dailyTime` heartbeat action for the same project: walks every
 * `item_automation` row left in 'error' for this project's library database and
 * re-enqueues a fresh 3-attempt batch for each — the daily catch-up the issue's retry
 * policy names ("once a day until it either succeeds or is manually locked"). `jobKey`
 * dedup (see `libraryMetadataJobKey`) means a row whose retry job is already in flight is
 * a harmless no-op re-enqueue, not a duplicate.
 */
export function createLibraryMetadataRetrySweepAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>) => {
    const config = libraryMetadataActionConfigSchema.parse(actionConfig);
    await withTransaction(pool, async (client) => {
      const errored = await listErroredItemAutomationForDatabases(client, [config.databaseId]);
      for (const row of errored) {
        await enqueueLibraryMetadataProcessing(client, { itemId: row.itemId, databaseId: config.databaseId, config });
      }
    });
  };
}
