// Trash and restore of a calendar (issue gh-1803): the choke point's item delete and restore hooks for the
// Calendars system database. A calendar goes to the Trash together with its live Events and comes back with
// the Events that were trashed with it; a system or subscription calendar and the last own calendar cannot be
// deleted, and the default mark moves to another own calendar. Both hooks run inside the trash or restore
// cascade's transaction, so a refusal or a failed step undoes the whole cascade. Two pre-lock hooks take the lock
// of the default mark before the cascade locks the calendar's row, the order every other writer of the mark uses.
// Constrained by: docs/adr/2026-11-12-deleting-a-calendar-takes-the-default-mark-lock-and-its-events-into-its-epoch.md,
// docs/adr/2026-11-12-calendar-rows-keep-one-default-under-an-advisory-lock.md,
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md,
// docs/adr/2026-11-08-restore-hooks-carry-exact-deletion-epochs.md
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
import type { WriterIdentity, WriterKind } from "../chokePoint/writerKind.js";
import { ConflictError, ForbiddenError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { isCalendarsDatabase, isSystemOrSubscription, lockDefaultMark } from "./calendarRowHooks.js";

/** The `Calendars.events` property: the Events of a calendar are the items on its edges. */
const CALENDAR_EVENTS_PROPERTY_KEY = "events";

/** The error code of the 409 for the last own calendar; `ConflictError` otherwise carries `version_conflict`. */
const LAST_OWN_CALENDAR_CODE = "last_own_calendar";

/** The writer of a nested trash or restore of an Event: the writer kind and agent run of the hook's own context. */
function writerOf(context: { writerKind: WriterKind; agentRunId?: string }): WriterIdentity {
  return {
    writerKind: context.writerKind,
    ...(context.agentRunId === undefined ? {} : { agentRunId: context.agentRunId }),
  };
}

/**
 * The ids and database ids of the Events on the edges of `calendarId`, in id order, each row locked `FOR UPDATE`
 * in the same statement. With `deletedAtExact` the Events are those in the Trash with exactly that deletion epoch
 * (compared by Postgres); without it they are the live ones, so an Event trashed earlier is not among them.
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
      FOR UPDATE OF i`,
    [definition.id, calendarId, deletedAtExact],
  );
  return rows.map((row) => ({ id: row.id, databaseId: row.database_id }));
}

/**
 * The oldest live own calendar other than `calendarId` (by creation time, ties by id), or `null` when there is
 * none. A calendar is own unless its `kind` is `system` or `subscription`.
 */
async function oldestOtherLiveOwnCalendar(
  client: PoolClient,
  calendarsDatabaseId: string,
  calendarId: string,
): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND id <> $2 AND deleted_at IS NULL
        AND COALESCE(properties->>'kind', '') NOT IN ('system', 'subscription')
      ORDER BY created_at, id
      LIMIT 1`,
    [calendarsDatabaseId, calendarId],
  );
  return rows[0] ?? null;
}

/**
 * The Calendars delete pre-lock rule, registered by `../domainWriteHooks.ts` under the Calendars module id. A delete
 * of a calendar takes the lock of the default mark (`lockDefaultMark`) before the cascade locks or changes the
 * calendar's row, so it orders its locks as every other writer of the mark does, the advisory lock first and the
 * rows after (`calendarItemUpdatePreLockHook`), and cannot wait for a write of `isDefault` that waits for it. It
 * takes the lock for every calendar, a system or subscription one included, since it cannot read the row's `kind`
 * without locking the row. `calendarItemDeleteHook` takes the same lock again, which returns at once.
 */
export const calendarItemDeletePreLockHook: ItemDeletePreLockHook = async ({ client, database }) => {
  if (!isCalendarsDatabase(database)) return;
  await lockDefaultMark(client, database.id);
};

/**
 * The Calendars restore pre-lock rule, registered by `../domainWriteHooks.ts` under the Calendars module id. A
 * restore of a calendar takes the lock of the default mark before the cascade locks the calendar's row, for the
 * same reason as `calendarItemDeletePreLockHook`: the restore hook may clear a stale `isDefault`, which takes that
 * lock, and the stored mark is not known before the row is locked.
 */
export const calendarItemRestorePreLockHook: ItemRestorePreLockHook = async ({ client, database }) => {
  if (!isCalendarsDatabase(database)) return;
  await lockDefaultMark(client, database.id);
};

/**
 * The Calendars delete rule, registered by `../domainWriteHooks.ts`. It runs inside the trash cascade's
 * transaction after the calendar's own soft delete and returns at once for a row of another database:
 *
 * 1. a calendar whose `kind` is `system` or `subscription` is refused with `ForbiddenError` (403 `forbidden`);
 * 2. the lock of the default mark is held (`calendarItemDeletePreLockHook` took it before the calendar's row was
 *    locked; `lockDefaultMark` returns at once), and the oldest other live own calendar is read.
 *    When there is none, the calendar is the last own one and the delete is refused with `ConflictError` code
 *    `last_own_calendar` (409). Every calendar delete takes the lock, so two deletes of the last two own
 *    calendars run one after the other and the second finds itself the last;
 * 3. when the calendar was the default, that successor gets `isDefault` true through `updateItemWithClient` as
 *    the system writer. The calendar row is in the Trash by now, which the choke point's update refuses to
 *    write, so its own `isDefault` stays `true` until a restore clears it (`calendarItemRestoreHook`); no read
 *    of the default mark looks at a trashed row;
 * 4. every live Event on the calendar's `events` edges is locked, in id order, and trashed through
 *    `itemDeleteWithClient` with this trash's writer and acting user and with the calendar's deletion epoch as its
 *    `deleted_at`, so each Event runs the usual delete hooks, heartbeats and after-commit invalidations. An Event
 *    that was in the Trash before is not live, keeps its own deletion time and is not touched.
 *
 * Any refusal or error rolls the whole cascade back. The nested trashes take the production queue routing,
 * since a delete hook's context carries none. The pre-lock hook keeps the order of locks the same as a switch of
 * the default takes: the advisory lock, then the rows. A calendar reached by a cascade as a member of another
 * item's subtree would lock its row first, since a pre-lock hook runs for the root a caller names only; the
 * Calendars database is seeded without a parent item, so no calendar is reached that way.
 */
export const calendarItemDeleteHook: ItemDeleteHook = async (context) => {
  const { client, database, item } = context;
  if (!isCalendarsDatabase(database)) return;
  if (isSystemOrSubscription(item.properties.kind)) {
    throw new ForbiddenError("A system or subscription calendar cannot be deleted", { field: "kind" });
  }
  await lockDefaultMark(client, database.id);
  const successor = await oldestOtherLiveOwnCalendar(client, database.id, item.id);
  if (successor === null) {
    throw new ConflictError("The last own calendar cannot be deleted", { calendarId: item.id }, LAST_OWN_CALENDAR_CODE);
  }
  if (item.properties.isDefault === true) {
    await updateItemWithClient(client, {
      databaseId: database.id,
      itemId: successor.id,
      propertiesPatch: { isDefault: true },
    });
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
 * The Calendars restore rule, registered by `../domainWriteHooks.ts`. It runs inside the restore cascade's
 * transaction after the calendar's own restore and returns at once for a row of another database:
 *
 * 1. every Event on the calendar's `events` edges that is in the Trash with exactly the calendar's deletion
 *    epoch (`deletedAtExact`, compared by Postgres) is locked, in id order, and restored through
 *    `restoreItemWithClient` with this restore's queue routing, writer and acting user; an Event trashed at
 *    another instant stays in the Trash;
 * 2. a restored calendar whose stored `isDefault` is `true` (the mark it held when it was trashed, see
 *    `calendarItemDeleteHook`) gets `isDefault` false through `updateItemWithClient` as the system writer, so it
 *    comes back as a calendar that is not the default. The Calendars update rule refuses that write with
 *    400 `validation_failed` on `isDefault` when no other live own calendar holds the mark, which fails the
 *    restore; it is the case of a default calendar trashed before issue gh-1803, with no other default.
 *
 * Any error rolls the whole restore back. The restore pre-lock hook (`calendarItemRestorePreLockHook`) took the
 * advisory lock that step 2 needs before the calendar's row was locked.
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
