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

/** The request context of `POST /api/items/:id/automation/retry`: the path parameter and the authenticated user. */
interface LibraryAutomationRetryRouteContext {
  params: Record<string, string>;
  identity: { user: { id: string } };
}

/**
 * The metadata job config of a library database: the action config of its seeded `onItemEvent` heartbeat, the one
 * the job of a newly created item runs with, so a retry fetches exactly what that job would. It is read, not rebuilt
 * from the contract, because its `source` is the one the tenant's heartbeat holds
 * (`libraryHeartbeatConfigCutoverMigration.ts` upgrades it).
 */
async function readJobConfig(client: PoolClient, database: DatabaseRow): Promise<LibraryMetadataJobConfig> {
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

/**
 * The cover properties that hold a value, with the value that clears each: `coverOverride` and `coverSource` go back
 * to `null`, `coverRemoved` to `false`. Empty when the item holds no manual cover choice.
 */
function clearingPatch(properties: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (properties[COVER_OVERRIDE_KEY] != null) patch[COVER_OVERRIDE_KEY] = null;
  if (properties[COVER_REMOVED_KEY] === true) patch[COVER_REMOVED_KEY] = false;
  if (properties[COVER_SOURCE_KEY] != null) patch[COVER_SOURCE_KEY] = null;
  return patch;
}

/**
 * `POST /api/items/:id/automation/retry` (issue #1793): the user asks a Books or Movies item for a new search. In one
 * transaction it takes the item's automation row, then the item row (the order the metadata job takes them in),
 * clears `coverOverride`, `coverRemoved` and `coverSource` through the same update path a PATCH takes, sets the
 * automation row to `pending` (a `locked` row included) and enqueues the metadata job. After the commit it publishes
 * the item's realtime invalidation, which the status change needs even when no property was written. Answers 202.
 *
 * A malformed id is a 400 on `id`. An id that is not an item of the caller's tenant, a trashed item and an item of
 * another database than Books and Movies are one and the same 404; a trashed item is refused before the request
 * locks anything. The job runs later, outside the request.
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
      // A trashed item is answered from the unlocked read, before any lock: the purge of a trashed item locks and
      // deletes the item row first and its `item_automation` row after, so the automation lock taken below would
      // be requested in the opposite order and could end in a deadlock instead of this 404.
      if (located.deletedAt) throw new NotFoundError("Item not found");
      const config = await readJobConfig(client, database);
      // The automation row first, then the item row, as the job locks them. The locked read below still decides
      // the narrow case of an item trashed after the read above, which rolls the enqueue and the reset back.
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
