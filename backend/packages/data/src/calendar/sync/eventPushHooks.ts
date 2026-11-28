// Records a change of an Event in, into or out of a writable account calendar, by any writer but the calendar sync, as
// the state its provider should reach, in the transaction of the change, and queues the push (`eventPushJob.ts`). The
// calendar sync's own writes record nothing: they bring the provider's state here.
import type { PoolClient } from "pg";
import type {
  ItemCreateHook,
  ItemDeleteHook,
  ItemRestoreHook,
  ItemUpdateHook,
  RelationEdgeChangedHook,
} from "../../chokePoint/hooks.js";
import type { SystemWriterProcess } from "../../chokePoint/writerKind.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../../types.js";
import { EVENT_RECURRENCE_PROPERTY_KEY } from "../eventRecurrenceRule.js";
import { enqueueCalendarEventPush } from "./calendarAccountSyncEnqueue.js";
import { readEventPushContext, recordEventPushIntent, type CalendarEventPushOperation } from "./calendarSyncStore.js";

/** The Event properties a provider stores; a change of any other (a task's placement, `nextOccurrenceDate`) is ours. */
export const PUSHED_EVENT_PROPERTY_KEYS = [
  "name",
  "date",
  "endDate",
  "timeFrom",
  "timeTo",
  "place",
  "description",
  "url",
  "alertMinutes",
  EVENT_RECURRENCE_PROPERTY_KEY,
] as const;

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

function isCalendarSync(writer: { systemProcess?: SystemWriterProcess }): boolean {
  return writer.systemProcess === "calendarSync";
}

/**
 * The operation the Event's provider needs now: none for an Event the sync never had and that is not (or no longer)
 * in a writable tracked account calendar, unless an earlier change is still recorded for it.
 */
async function recordEventPush(client: PoolClient, eventItemId: string, trashed: boolean): Promise<void> {
  const context = await readEventPushContext(client, eventItemId);
  const target = context.calendar;
  const writable = target !== null && !target.readOnly && target.tracked;
  // A system writer's change of an Event its read-only or untracked calendar holds is not the provider's to take.
  if (!trashed && target !== null && !writable && context.remoteCalendarItemId === target.calendarItemId) return;
  let operation: CalendarEventPushOperation;
  if (trashed || !writable) {
    if (context.remoteCalendarItemId === null && !context.hasPushState) return;
    operation = "delete";
  } else if (context.remoteCalendarItemId === null) {
    operation = "create";
  } else {
    operation = context.remoteCalendarItemId === target.calendarItemId ? "update" : "move";
  }
  await recordEventPushIntent(client, eventItemId, operation);
  await enqueueCalendarEventPush(client, eventItemId);
}

/** After the calendar edge of a new Event is written (`defaultCalendarCreateHook` runs before it). */
export const eventPushItemCreateHook: ItemCreateHook = async ({ client, database, item, writer }) => {
  if (!isEventsDatabase(database) || isCalendarSync(writer)) return;
  await recordEventPush(client, item.id, false);
};

export const eventPushItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch, writer }) => {
  if (!isEventsDatabase(database) || isCalendarSync(writer)) return;
  if (!PUSHED_EVENT_PROPERTY_KEYS.some((key) => Object.hasOwn(propertiesPatch, key))) return;
  await recordEventPush(client, item.id, item.deletedAt !== null);
};

export const eventPushItemDeleteHook: ItemDeleteHook = async ({ client, database, item, systemProcess }) => {
  if (!isEventsDatabase(database) || isCalendarSync({ ...(systemProcess ? { systemProcess } : {}) })) return;
  await recordEventPush(client, item.id, true);
};

export const eventPushItemRestoreHook: ItemRestoreHook = async ({ client, database, item, systemProcess }) => {
  if (!isEventsDatabase(database) || isCalendarSync({ ...(systemProcess ? { systemProcess } : {}) })) return;
  await recordEventPush(client, item.id, false);
};

/** A move between calendars: an edge of `Events.calendar` / `Calendars.events` added or removed. */
export const eventPushEdgeChangedHook: RelationEdgeChangedHook = async ({
  client,
  op,
  relationDefinitionId,
  itemA,
  itemB,
  writer,
}) => {
  if (op === "update" || isCalendarSync(writer)) return;
  const { rows } = await client.query<{ id: string; deleted: boolean }>(
    `SELECT i.id, i.deleted_at IS NOT NULL AS deleted
       FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
      WHERE i.id IN ($2, $3) AND d.system AND d.owner_module_id = $4
        AND EXISTS (SELECT 1 FROM properties p
                      JOIN databases cd ON cd.id = p.database_id AND cd.tenant_id = p.tenant_id
                     WHERE cd.system AND cd.owner_module_id = $5 AND p.key = 'events'
                       AND (p.config->>'relationDefinitionId')::uuid = $1)`,
    [relationDefinitionId, itemA, itemB, EVENTS_MODULE_ID, CALENDARS_MODULE_ID],
  );
  const event = rows[0];
  if (event === undefined) return;
  await recordEventPush(client, event.id, event.deleted);
};
