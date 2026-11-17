import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import { enqueueLibraryMetadataProcessing, libraryMetadataJobConfigSchema } from "./libraryMetadataJob.js";
import { assertSupportedLibraryMetadataSource } from "./libraryMetadataConfig.js";
import { listRetryableLibraryAutomationForDatabases } from "./itemAutomationStore.js";

export const LIBRARY_METADATA_TRIGGER_ACTION_ID = "core.libraryMetadataTrigger";
export const LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID = "core.libraryMetadataRetrySweep";

const libraryMetadataActionConfigSchema = libraryMetadataJobConfigSchema.extend({
  databaseId: z.string().uuid(),
});

/**
 * `onItemEvent` ('create') action, so every `createItem` caller gets the same automation. It only seeds
 * `item_automation` and enqueues the job; the retry policy belongs to that job.
 */
export function createLibraryMetadataTriggerAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return; // only meaningful for an onItemEvent fire
    const config = libraryMetadataActionConfigSchema.parse(actionConfig);
    assertSupportedLibraryMetadataSource(config.source);
    await withTransaction(pool, (client) =>
      enqueueLibraryMetadataProcessing(client, {
        itemId: context.itemId as string,
        databaseId: config.databaseId,
        config,
      }),
    );
  };
}

/**
 * Daily: re-enqueues a fresh 3-attempt batch for every 'error' or 'notFound' row. The `jobKey` makes a row whose
 * job is already queued a no-op.
 */
export function createLibraryMetadataRetrySweepAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>) => {
    const config = libraryMetadataActionConfigSchema.parse(actionConfig);
    assertSupportedLibraryMetadataSource(config.source);
    await withTransaction(pool, async (client) => {
      const errored = await listRetryableLibraryAutomationForDatabases(client, [config.databaseId]);
      for (const row of errored) {
        await enqueueLibraryMetadataProcessing(client, { itemId: row.itemId, databaseId: config.databaseId, config });
      }
    });
  };
}
