import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import type { DatabaseRow, PropertyType } from "../types.js";
import { SUBSCRIBED_EVENTS_MODULE_ID } from "./calendarsKeys.js";

interface PropSpec {
  key: string;
  type: PropertyType;
  config?: Record<string, unknown>;
}

/**
 * The scalar properties of a subscribed event (issue gh-1962), all `owner: 'system'` with the calendar module as
 * owner process. `startsAt` and `endsAt` are date properties with a time (`includeTime`); `timeZone` keeps the
 * IANA zone the feed named. The seed does not validate the format of a date value: the format a writer stores
 * is the convention of the feed import (#2004) and of the timeline source that reads it. The `calendar` relation
 * is added by `createSubscribedEventsRelation`.
 */
const SUBSCRIBED_EVENT_PROPERTIES: readonly PropSpec[] = [
  { key: "uid", type: "text" },
  { key: "title", type: "title" },
  { key: "startsAt", type: "date", config: { includeTime: true } },
  { key: "endsAt", type: "date", config: { includeTime: true } },
  { key: "timeZone", type: "text" },
  { key: "allDay", type: "checkbox" },
  { key: "place", type: "text" },
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
 * The `Calendars.subscribedEvents` / `SubscribedEvents.calendar` pair: one calendar, many subscribed events,
 * so `Calendars.subscribedEvents` is property A of a `one_to_many` definition and each subscribed event has at
 * most one calendar, as `Events.calendar` does. Both sides are system-owned by the calendar module, so a user
 * cannot write an edge from either side. The Calendars schema is locked and `propertiesStore` refuses to
 * change a locked schema, so the properties, the definition and their configs are written with raw SQL under
 * an exclusive `properties` lock, in the steps `seedCalendars.ts` uses for `Calendars.events`.
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
 * Creates the `subscribedEvents` system database (issue gh-1962) in the caller's open transaction: the database
 * under the project that owns `calendars`, its system-owned properties, the relation to Calendars, and the
 * schema lock. The fresh seed (`seedCalendarsInTransaction`) and `calendar/subscribedEventsCutoverMigration.ts`
 * both call it, so a seeded and a cut-over tenant get identical definitions. No row is seeded, and a name is
 * stored as null: the labels come from the calendar module catalog.
 *
 * Not idempotent on its own: `seedCalendarsInTransaction` calls it once for the Calendars database it creates, and
 * the cutover calls it only for a tenant that has the Calendars database and no subscribed events database.
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
  for (const spec of SUBSCRIBED_EVENT_PROPERTIES) {
    await propertiesStore.createProperty(client, {
      databaseId: database.id,
      key: spec.key,
      name: null,
      type: spec.type,
      owner: "system",
      ownerProcess: CALENDAR_MODULE_ID,
      config: spec.config,
    });
  }
  await createSubscribedEventsRelation(client, calendars.id, database.id);
  requireAffectedRows(
    await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [database.id]),
    "subscribed events schema lock",
  );
  return database;
}
