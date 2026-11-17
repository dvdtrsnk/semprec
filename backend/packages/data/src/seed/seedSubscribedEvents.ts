import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import type { DatabaseRow } from "../types.js";
import { SUBSCRIBED_EVENTS_MODULE_ID } from "./calendarsKeys.js";
import { createProps, type PropSpec } from "./propSpecs.js";

export const SUBSCRIBED_EVENT_RECURRENCE_KEYS = ["recurrenceRule", "exceptionDates", "recurrenceId"] as const;

/**
 * All system-owned by the calendar module. `startsAt`/`endsAt` include a time; `timeZone` is the feed's
 * IANA zone. Date formats are the feed import's convention and are not validated here. Recurrence fields
 * are text: `recurrenceRule` is the `RRULE`, `exceptionDates` a JSON array of excluded original starts,
 * `recurrenceId` the original start an override replaces (tenant wall-clock values). The `calendar`
 * relation is added by `createSubscribedEventsRelation`.
 */
const SUBSCRIBED_EVENT_PROPERTIES: readonly PropSpec[] = [
  { key: "uid", type: "text" },
  { key: "title", type: "title" },
  { key: "startsAt", type: "date", config: { includeTime: true } },
  { key: "endsAt", type: "date", config: { includeTime: true } },
  { key: "timeZone", type: "text" },
  { key: "allDay", type: "checkbox" },
  { key: "place", type: "text" },
  ...SUBSCRIBED_EVENT_RECURRENCE_KEYS.map((key): PropSpec => ({ key, type: "text" })),
];

async function insertCalendarOwnedRelationProperty(
  client: PoolClient,
  databaseId: string,
  key: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
     VALUES ($1, $2, NULL, 'relation', '{}'::jsonb, false, 'system', $3)
     RETURNING id`,
    [databaseId, key, CALENDAR_MODULE_ID],
  );
  return requireSingleRow(rows, "properties row").id;
}

/**
 * `Calendars.subscribedEvents` (property A of a `one_to_many`) / `SubscribedEvents.calendar`, both
 * system-owned so users cannot write edges. Calendars is locked, so this uses raw SQL under an exclusive
 * `properties` lock, as `seedCalendars.ts` does for `Calendars.events`.
 */
async function createSubscribedEventsRelation(
  client: PoolClient,
  calendarsDatabaseId: string,
  subscribedEventsDatabaseId: string,
): Promise<void> {
  await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
  const calendarSide = await insertCalendarOwnedRelationProperty(client, calendarsDatabaseId, "subscribedEvents");
  const eventSide = await insertCalendarOwnedRelationProperty(client, subscribedEventsDatabaseId, "calendar");
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
     VALUES ($1, $2, 'one_to_many') RETURNING id`,
    [calendarSide, eventSide],
  );
  const relationDefinitionId = requireSingleRow(rows, "relation_definitions row").id;
  for (const [propertyId, targetDatabaseId] of [
    [calendarSide, subscribedEventsDatabaseId],
    [eventSide, calendarsDatabaseId],
  ] as const) {
    const result = await client.query(
      `UPDATE properties
         SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
       WHERE id = $1`,
      [propertyId, relationDefinitionId, targetDatabaseId],
    );
    requireAffectedRows(result, "subscribed events relation property config");
  }
}

/**
 * Creates the `subscribedEvents` database under the project owning `calendars`, with its properties,
 * the relation to Calendars and the schema lock. No rows; names are null (labels from the catalog).
 *
 * Not idempotent: `seedCalendarsInTransaction` calls it once.
 */
export async function seedSubscribedEventsInTransaction(
  client: PoolClient,
  calendars: DatabaseRow,
): Promise<DatabaseRow> {
  const database = await databasesStore.createDatabase(client, {
    name: null,
    key: SUBSCRIBED_EVENTS_MODULE_ID,
    system: true,
    ownerModuleId: SUBSCRIBED_EVENTS_MODULE_ID,
    ownerProjectItemId: calendars.ownerProjectItemId ?? undefined,
  });
  await createProps(
    client,
    database.id,
    SUBSCRIBED_EVENT_PROPERTIES.map((spec) => ({ ...spec, owner: "system", ownerProcess: CALENDAR_MODULE_ID })),
  );
  await createSubscribedEventsRelation(client, calendars.id, database.id);
  requireAffectedRows(
    await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [database.id]),
    "subscribed events schema lock",
  );
  return database;
}
