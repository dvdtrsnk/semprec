// Trash and restore of a calendar: it goes to the Trash with its live Events and comes back with the Events
// trashed with it. System/subscription calendars and the last own calendar cannot be deleted, an account calendar
// only by the system writer; the default mark moves to another own calendar. The hooks run in the cascade's
// transaction, so a refusal undoes the cascade.
// The pre-lock hooks take the default-mark lock before the cascade locks the calendar's row, the order every
// other writer of the mark uses.
import type { PoolClient } from "pg";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type {
  ItemDeleteHook,
  ItemDeletePreLockHook,
  ItemRestoreHook,
  ItemRestorePreLockHook,
} from "../chokePoint/hooks.js";
import { lockItemTrashEpoch } from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../chokePoint/itemTrash.js";
import type { SystemWriterProcess, WriterIdentity, WriterKind } from "../chokePoint/writerKind.js";
import { ConflictError, ForbiddenError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { isAccountCalendar, isCalendarsDatabase, isSystemOrSubscription, lockDefaultMark } from "./calendarRowHooks.js";

const CALENDAR_EVENTS_PROPERTY_KEY = "events";

/** `ConflictError` otherwise carries `version_conflict`. */
const LAST_OWN_CALENDAR_CODE = "last_own_calendar";

function writerOf(context: {
  writerKind: WriterKind;
  systemProcess?: SystemWriterProcess;
  agentRunId?: string;
}): WriterIdentity {
  return {
    writerKind: context.writerKind,
    ...(context.systemProcess === undefined ? {} : { systemProcess: context.systemProcess }),
    ...(context.agentRunId === undefined ? {} : { agentRunId: context.agentRunId }),
  };
}

/**
 * Rows locked `FOR NO KEY UPDATE` in id order in the same statement. With `deletedAtExact` the trashed Events of exactly
 * that epoch (compared by Postgres); without it the live ones.
 */
async function lockCalendarEvents(
  client: PoolClient,
  calendarsDatabaseId: string,
  calendarId: string,
  deletedAtExact: string | null,
): Promise<Array<{ id: string; databaseId: string }>> {
  const property = await propertiesStore.getPropertyByKey(client, calendarsDatabaseId, CALENDAR_EVENTS_PROPERTY_KEY);
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!definition) throw new Error("Calendars 'events' relation not found");
  const { rows } = await client.query<{ id: string; database_id: string }>(
    `SELECT i.id, i.database_id
       FROM item_relations r
       JOIN items i ON i.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
        AND (($3::timestamptz IS NULL AND i.deleted_at IS NULL) OR i.deleted_at = $3::timestamptz)
      ORDER BY i.id
      FOR NO KEY UPDATE OF i`,
    [definition.id, calendarId, deletedAtExact],
  );
  return rows.map((row) => ({ id: row.id, databaseId: row.database_id }));
}

/** By creation time, ties by id. */
async function oldestOtherLiveOwnCalendar(
  client: PoolClient,
  calendarsDatabaseId: string,
  calendarId: string,
): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND id <> $2 AND deleted_at IS NULL
        AND COALESCE(properties->>'kind', '') IN ('', 'own')
      ORDER BY created_at, id
      LIMIT 1`,
    [calendarsDatabaseId, calendarId],
  );
  return rows[0] ?? null;
}

/**
 * Taken for every calendar, system/subscription included, because the row's `kind` cannot be read without locking
 * the row. Advisory lock first, rows after, so it cannot deadlock with a write of `isDefault`.
 */
export const calendarItemDeletePreLockHook: ItemDeletePreLockHook = async ({ client, database }) => {
  if (!isCalendarsDatabase(database)) return;
  await lockDefaultMark(client, database.id);
};

/**
 * Same reason as the delete pre-lock hook: the restore hook may clear a stale `isDefault`, which takes the lock,
 * and the stored mark is unknown before the row is locked.
 */
export const calendarItemRestorePreLockHook: ItemRestorePreLockHook = async ({ client, database }) => {
  if (!isCalendarsDatabase(database)) return;
  await lockDefaultMark(client, database.id);
};

/**
 * Runs after the calendar's own soft delete:
 *
 * 1. a `system` or `subscription` calendar is a 403, and so is an `account` calendar unless the writer is `system`
 *    (the provider or the account removed it); an account calendar is never the default or the last own calendar, so
 *    it goes straight to step 4;
 * 2. with the default-mark lock held, no other live own calendar means a 409 `last_own_calendar`. Every delete
 *    takes the lock, so two deletes of the last two own calendars serialize and the second finds itself last;
 * 3. a default calendar's successor gets `isDefault` true as the system writer. The trashed row's own `isDefault`
 *    stays `true` (the choke point refuses to update a trashed row) until a restore clears it;
 * 4. every live Event on the `events` edges is locked in id order and trashed with this trash's writer and the
 *    calendar's deletion epoch, so each runs the usual delete hooks. Earlier-trashed Events are not touched.
 *
 * Nested trashes take the production queue routing, since a delete hook's context carries none. A calendar
 * reached as a subtree member would lock its row first, but the Calendars database has no parent item.
 */
export const calendarItemDeleteHook: ItemDeleteHook = async (context) => {
  const { client, database, item } = context;
  if (!isCalendarsDatabase(database)) return;
  if (isSystemOrSubscription(item.properties.kind)) {
    throw new ForbiddenError("A system or subscription calendar cannot be deleted", { field: "kind" });
  }
  if (isAccountCalendar(item.properties.kind)) {
    if (context.writerKind !== "system") {
      throw new ForbiddenError("An internet account's calendar leaves with the provider or the account", {
        field: "kind",
      });
    }
  } else {
    await lockDefaultMark(client, database.id);
    const successor = await oldestOtherLiveOwnCalendar(client, database.id, item.id);
    if (successor === null) {
      throw new ConflictError(
        "The last own calendar cannot be deleted",
        { calendarId: item.id },
        LAST_OWN_CALENDAR_CODE,
      );
    }
    if (item.properties.isDefault === true) {
      await updateItemWithClient(client, {
        databaseId: database.id,
        itemId: successor.id,
        propertiesPatch: { isDefault: true },
      });
    }
  }
  const events = await lockCalendarEvents(client, database.id, item.id, null);
  if (events.length === 0) return;
  const deletedAtExact = await lockItemTrashEpoch(client, database.id, item.id);
  if (deletedAtExact === null) throw new Error(`Trashed calendar ${item.id} has no deletion epoch`);
  for (const event of events) {
    await itemDeleteWithClient(client, event.databaseId, event.id, {
      queueAffinity: createActionQueueAffinity(),
      actingUserId: context.actingUserId,
      writer: writerOf(context),
      deletedAtExact,
    });
  }
};

/**
 * Runs after the calendar's own restore:
 *
 * 1. every Event in the Trash with exactly the calendar's deletion epoch is locked in id order and restored with
 *    this restore's queue routing, writer and acting user;
 * 2. a stored `isDefault` of `true` is set to false as the system writer. The update rule refuses that when no
 *    other live own calendar holds the mark, which fails the restore.
 *
 * The restore pre-lock hook already took the advisory lock step 2 needs.
 */
export const calendarItemRestoreHook: ItemRestoreHook = async (context) => {
  const { client, database, item } = context;
  if (!isCalendarsDatabase(database)) return;
  const events = await lockCalendarEvents(client, database.id, item.id, context.deletedAtExact);
  for (const event of events) {
    await restoreItemWithClient(
      client,
      event.databaseId,
      event.id,
      context.queueAffinity,
      context.actingUserId,
      writerOf(context),
    );
  }
  if (item.properties.isDefault === true) {
    await updateItemWithClient(client, {
      databaseId: database.id,
      itemId: item.id,
      propertiesPatch: { isDefault: false },
    });
  }
};
