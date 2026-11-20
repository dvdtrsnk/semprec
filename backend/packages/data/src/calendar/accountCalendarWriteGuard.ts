// The Events of a read-only account calendar follow the provider: a user or agent create, update, trash or move
// (an edge of `Events.calendar` added or removed) answers 403 `calendar_read_only`. System writers pass: the calendar
// sync applying the provider's state, and the internal writers of derived fields and cascades.
//
// Lock order: the account calendar's row `FOR SHARE` before the Event's row, the order a calendar trash takes them
// in. The pre-lock hooks take it for an update and a trash; the later hooks read `readOnly` under that lock.
import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type {
  ItemDeleteApprovalGuard,
  ItemDeleteHook,
  ItemDeletePreLockHook,
  ItemUpdateHook,
  ItemUpdatePreLockHook,
  RelationEdgeDeleteHook,
  RelationEdgeWriteHook,
} from "../chokePoint/hooks.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { RelationEdgeContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { WriterKind } from "../chokePoint/writerKind.js";
import { ForbiddenError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";

const CALENDAR_READ_ONLY_CODE = "calendar_read_only";

const EVENT_CALENDAR_PROPERTY_KEY = "calendar";
const CALENDAR_EVENTS_PROPERTY_KEY = "events";

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

function readOnlyRefusal(calendarId: string): { message: string; details: { calendarId: string } } {
  return {
    message: "The calendar is read-only at its provider; its events cannot be changed here",
    details: { calendarId },
  };
}

export function assertAccountCalendarWritable(
  calendarId: string,
  readOnly: boolean,
  writer: { writerKind: WriterKind },
): void {
  if (!readOnly || writer.writerKind === "system") return;
  const refusal = readOnlyRefusal(calendarId);
  throw new ForbiddenError(refusal.message, refusal.details, CALENDAR_READ_ONLY_CODE);
}

/** `Events.calendar` and its definition; the seed creates both. */
async function eventCalendarRelation(
  client: PoolClient,
  eventsDatabaseId: string,
): Promise<{ propertyId: string; definitionId: string }> {
  const property = await propertiesStore.getPropertyByKey(client, eventsDatabaseId, EVENT_CALENDAR_PROPERTY_KEY);
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!property || !definition) throw new Error("Events 'calendar' relation not found");
  return { propertyId: property.id, definitionId: definition.id };
}

interface AccountCalendarLock {
  id: string;
  readOnly: boolean;
}

const EVENT_ACCOUNT_CALENDAR_SQL = `
  SELECT c.id, c.properties->'readOnly' = 'true'::jsonb AS read_only
    FROM item_relations r
    JOIN items c ON c.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
   WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
     AND c.properties->>'kind' = 'account'
   ORDER BY c.id`;

/** `null` when the Event's calendar, if any, is no account calendar; nothing is locked then. */
async function lockEventAccountCalendar(
  client: PoolClient,
  eventsDatabaseId: string,
  eventId: string,
  lock: "share" | "none",
): Promise<AccountCalendarLock | null> {
  const { definitionId } = await eventCalendarRelation(client, eventsDatabaseId);
  const { rows } = await client.query<{ id: string; read_only: boolean }>(
    lock === "share" ? `${EVENT_ACCOUNT_CALENDAR_SQL} FOR SHARE OF c` : EVENT_ACCOUNT_CALENDAR_SQL,
    [definitionId, eventId],
  );
  const row = rows[0];
  return row ? { id: row.id, readOnly: row.read_only } : null;
}

/** `null` when `calendarId` is no account calendar. */
async function lockAccountCalendar(client: PoolClient, calendarId: string): Promise<AccountCalendarLock | null> {
  const { rows } = await client.query<{ id: string; read_only: boolean }>(
    `SELECT id, properties->'readOnly' = 'true'::jsonb AS read_only FROM items
      WHERE id = $1 AND properties->>'kind' = 'account'
      FOR SHARE`,
    [calendarId],
  );
  const row = rows[0];
  return row ? { id: row.id, readOnly: row.read_only } : null;
}

export const accountCalendarEventUpdatePreLockHook: ItemUpdatePreLockHook = async ({ client, database, itemId }) => {
  if (!isEventsDatabase(database)) return;
  await lockEventAccountCalendar(client, database.id, itemId, "share");
};

export const accountCalendarEventDeletePreLockHook: ItemDeletePreLockHook = async ({ client, database, itemId }) => {
  if (!isEventsDatabase(database)) return;
  await lockEventAccountCalendar(client, database.id, itemId, "share");
};

export const accountCalendarEventUpdateHook: ItemUpdateHook = async ({ client, database, item, writer }) => {
  if (writer.writerKind === "system" || !isEventsDatabase(database)) return;
  const calendar = await lockEventAccountCalendar(client, database.id, item.id, "share");
  if (calendar) assertAccountCalendarWritable(calendar.id, calendar.readOnly, writer);
};

export const accountCalendarEventDeleteHook: ItemDeleteHook = async ({ client, database, item, writerKind }) => {
  if (writerKind === "system" || !isEventsDatabase(database)) return;
  const calendar = await lockEventAccountCalendar(client, database.id, item.id, "share");
  if (calendar) assertAccountCalendarWritable(calendar.id, calendar.readOnly, { writerKind });
};

/** An agent's trash is refused before an approval request is stored, with the code the delete hook answers. */
export const accountCalendarEventDeleteApprovalGuard: ItemDeleteApprovalGuard = async ({ client, database, item }) => {
  const calendar = await lockEventAccountCalendar(client, database.id, item.id, "none");
  if (!calendar?.readOnly) return null;
  return { message: readOnlyRefusal(calendar.id).message, code: CALENDAR_READ_ONLY_CODE };
};

/** The calendar end of an `Events.calendar` / `Calendars.events` edge, or `null` for any other relation. */
async function edgeCalendarId(
  client: PoolClient,
  edgeContext: RelationEdgeContext,
  callerItemId: string,
  targetItemId: string,
): Promise<string | null> {
  const key = edgeContext.property.key;
  if (key !== EVENT_CALENDAR_PROPERTY_KEY && key !== CALENDAR_EVENTS_PROPERTY_KEY) return null;
  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) return null;
  const relation = await eventCalendarRelation(client, events.id);
  if (edgeContext.reldef.id !== relation.definitionId) return null;
  return edgeContext.property.id === relation.propertyId ? targetItemId : callerItemId;
}

/** Adding an Event to a read-only account calendar, by moving or creating it there. */
export const accountCalendarEventEdgeWriteHook: RelationEdgeWriteHook = async ({
  client,
  edgeContext,
  callerItemId,
  targetItemId,
  writer,
}) => {
  if (writer.writerKind === "system") return;
  const calendarId = await edgeCalendarId(client, edgeContext, callerItemId, targetItemId);
  if (calendarId === null) return;
  const calendar = await lockAccountCalendar(client, calendarId);
  if (calendar) assertAccountCalendarWritable(calendar.id, calendar.readOnly, writer);
};

/** Moving an Event out of a read-only account calendar. */
export const accountCalendarEventEdgeDeleteHook: RelationEdgeDeleteHook = async ({
  client,
  edgeContext,
  callerItemId,
  targetItemId,
  writer,
}) => {
  if (writer.writerKind === "system") return;
  const calendarId = await edgeCalendarId(client, edgeContext, callerItemId, targetItemId);
  if (calendarId === null) return;
  const calendar = await lockAccountCalendar(client, calendarId);
  if (calendar) assertAccountCalendarWritable(calendar.id, calendar.readOnly, writer);
};
