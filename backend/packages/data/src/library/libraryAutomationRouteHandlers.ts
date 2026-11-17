import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { listHeartbeatsByProject } from "../scheduler/schedulerStore.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import type { DatabaseRow } from "../types.js";
import { resetItemAutomationToPending } from "./itemAutomationStore.js";
import { LIBRARY_METADATA_TRIGGER_ACTION_ID } from "./libraryMetadataActions.js";
import {
  enqueueLibraryMetadataProcessing,
  libraryMetadataJobConfigSchema,
  type LibraryMetadataJobConfig,
} from "./libraryMetadataJob.js";
import { COVER_OVERRIDE_KEY, COVER_REMOVED_KEY, COVER_SOURCE_KEY } from "./libraryModuleContract.js";

interface LibraryAutomationRetryRouteContext {
  params: Record<string, string>;
  identity: { user: { id: string } };
}

/** Read from the seeded `onItemEvent` heartbeat, not rebuilt, so a retry uses the tenant heartbeat's `source`. */
export async function readJobConfig(client: PoolClient, database: DatabaseRow): Promise<LibraryMetadataJobConfig> {
  const heartbeats = database.ownerProjectItemId
    ? await listHeartbeatsByProject(client, database.ownerProjectItemId)
    : [];
  const heartbeat = heartbeats.find(
    (candidate) =>
      candidate.actionId === LIBRARY_METADATA_TRIGGER_ACTION_ID && candidate.actionConfig.databaseId === database.id,
  );
  if (!heartbeat) throw new Error("The library database has no metadata heartbeat");
  return libraryMetadataJobConfigSchema.parse(heartbeat.actionConfig);
}

/** Empty when the item holds no manual cover choice. */
function clearingPatch(properties: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (properties[COVER_OVERRIDE_KEY] != null) patch[COVER_OVERRIDE_KEY] = null;
  if (properties[COVER_REMOVED_KEY] === true) patch[COVER_REMOVED_KEY] = false;
  if (properties[COVER_SOURCE_KEY] != null) patch[COVER_SOURCE_KEY] = null;
  return patch;
}

/**
 * Locks the automation row, then the item row (the job's order), clears the manual cover choice through the PATCH
 * update path, resets to `pending` (even `locked`) and enqueues the job. The invalidation is published even when no
 * property changed, because the status did. Answers 202.
 */
export function createLibraryAutomationRetryRouteHandler(pool: Pool) {
  return async (ctx: LibraryAutomationRetryRouteContext): Promise<{ status: number; body: unknown }> => {
    const parsed = z.uuid().safeParse(ctx.params.id);
    if (!parsed.success) throw new ValidationError("Item id must be a UUID", { field: "id" });
    const itemId = parsed.data;
    const userId = ctx.identity.user.id;
    await withTransaction(pool, async (client) => {
      const [located] = await itemsStore.getItemsByIdsIncludingDeleted(client, [itemId]);
      const database = located ? await databasesStore.getDatabase(client, located.databaseId) : null;
      if (
        !located ||
        !database ||
        (database.ownerModuleId !== BOOKS_MODULE_ID && database.ownerModuleId !== MOVIES_MODULE_ID)
      ) {
        throw new NotFoundError("Item not found");
      }
      // Answered before any lock: the purge locks the item row before its `item_automation` row, so taking the
      // automation lock below on a trashed item could deadlock with it.
      if (located.deletedAt) throw new NotFoundError("Item not found");
      const config = await readJobConfig(client, database);
      // The locked read below catches an item trashed meanwhile; the throw rolls back the enqueue and the reset.
      await enqueueLibraryMetadataProcessing(client, { itemId, databaseId: database.id, config });
      await resetItemAutomationToPending(client, itemId);
      const stored = await itemsStore.lockItemById(client, database.id, itemId);
      if (!stored || stored.deletedAt) throw new NotFoundError("Item not found");
      const patch = clearingPatch(stored.properties);
      const updatedAt =
        Object.keys(patch).length === 0
          ? stored.updatedAt
          : (
              await updateItemWithClient(
                client,
                { databaseId: database.id, itemId, propertiesPatch: patch },
                { writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
              )
            ).updatedAt;
      runAfterCommit(client, () =>
        notifyInvalidation({ scope: "item", databaseId: database.id, itemId, op: "update", updatedAt, userId }),
      );
    });
    return { status: 202, body: { itemId, status: "pending" } };
  };
}
