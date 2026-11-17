import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import {
  NEXT_OCCURRENCE_REFRESH_ACTION_ID,
  NEXT_OCCURRENCE_REFRESH_HEARTBEAT,
} from "../calendar/nextOccurrenceRefreshAction.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import type { DatabaseRow } from "../types.js";
import { CALENDARS_MODULE_ID } from "./calendarsKeys.js";
import { seedSubscribedEventsInTransaction } from "./seedSubscribedEvents.js";
import { createProps, type PropSpec } from "./propSpecs.js";

/** The `kind` options of a calendar; a row without a `kind` is `own`. */
const CALENDAR_KINDS = ["own", "system", "subscription"] as const;

interface CalendarRow {
  /** Label key `seed.calendars.<catalogKey>.name` in the calendar module catalog. */
  catalogKey: string;
  color: string;
  notify: boolean;
  isDefault?: true;
  /** System calendars only. */
  systemKey?: string;
}

/** `Personal` is the default. */
const CALENDAR_ROWS: readonly CalendarRow[] = [
  { catalogKey: "personal", color: "#5856D6", notify: true, isDefault: true },
  { catalogKey: "work", color: "#007AFF", notify: true },
  { catalogKey: "family", color: "#34C759", notify: true },
  { catalogKey: "health", color: "#FF2D55", notify: true },
  { catalogKey: "birthdays", color: "#8E8E93", notify: true, systemKey: "birthdays" },
  { catalogKey: "tasks", color: "#007AFF", notify: false, systemKey: "tasks" },
  { catalogKey: "sleep", color: "#5856D6", notify: false, systemKey: "sleep" },
  { catalogKey: "holidaysCz", color: "#34C759", notify: false, systemKey: "holidaysCz" },
];

const CALENDAR_PROPERTIES: readonly PropSpec[] = [
  { key: "name", type: "title", owner: "user" },
  { key: "color", type: "color", owner: "user" },
  { key: "notify", type: "checkbox", owner: "user" },
  { key: "hidden", type: "checkbox", owner: "user" },
  { key: "isDefault", type: "checkbox", owner: "user" },
  {
    key: "kind",
    type: "select",
    owner: "system",
    ownerProcess: CALENDAR_MODULE_ID,
    config: { options: CALENDAR_KINDS.map((key) => ({ key })) },
  },
  { key: "systemKey", type: "text", owner: "system", ownerProcess: CALENDAR_MODULE_ID },
  // Validated by `calendar/calendarSubscriptionUrlTransform.ts`.
  { key: "subscriptionUrl", type: "url", owner: "user" },
];

async function insertUserRelationProperty(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
     VALUES ($1, $2, NULL, 'relation', '{}'::jsonb, false, 'user', NULL)
     RETURNING id`,
    [databaseId, key],
  );
  return requireSingleRow(rows, "properties row").id;
}

/**
 * `Calendars.events` (property A of a `one_to_many`) / `Events.calendar`. Events is `schema_locked` and
 * `propertiesStore` refuses locked schemas, so the properties, definition and configs are written with
 * raw SQL under an exclusive `properties` lock. Returns the relation definition id.
 */
async function createCalendarEventsRelation(
  client: PoolClient,
  calendarsDatabaseId: string,
  eventsDatabaseId: string,
): Promise<string> {
  await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
  const calendarEvents = await insertUserRelationProperty(client, calendarsDatabaseId, "events");
  const eventCalendar = await insertUserRelationProperty(client, eventsDatabaseId, "calendar");
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality)
     VALUES ($1, $2, 'one_to_many') RETURNING id`,
    [calendarEvents, eventCalendar],
  );
  const relationDefinitionId = requireSingleRow(rows, "relation_definitions row").id;
  for (const [propertyId, targetDatabaseId] of [
    [calendarEvents, eventsDatabaseId],
    [eventCalendar, calendarsDatabaseId],
  ] as const) {
    const result = await client.query(
      `UPDATE properties
         SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid)
       WHERE id = $1`,
      [propertyId, relationDefinitionId, targetDatabaseId],
    );
    requireAffectedRows(result, "calendar relation property config");
  }
  return relationDefinitionId;
}

export interface CalendarsSeedResult {
  calendars: DatabaseRow;
  relationDefinitionId: string;
  defaultCalendarId: string;
}

/**
 * Seeds the calendar module into the caller's transaction: a system project, the `calendars` database
 * (`kind` and `systemKey` system-owned), the events relation, the eight default calendars, and the daily
 * `calendar.refreshNextOccurrence` heartbeat. Names come from the module catalog in the tenant user's
 * language (`cs` without a user). The schema is locked once complete; `subscribedEvents` is created last.
 *
 * Not idempotent: `seedSystem` calls it once per new tenant.
 */
export async function seedCalendarsInTransaction(
  client: PoolClient,
  projectsDatabaseId: string,
  eventsDatabaseId: string,
): Promise<CalendarsSeedResult> {
  const locale = toManifestLocale((await getTenantUserLocale(client)) ?? "cs");
  const catalogs = await loadModuleCatalogs(new URL("../calendar/calendarModuleManifest.js", import.meta.url).href);
  const label = (key: string) => resolveCatalogLabel(null, catalogs[locale], catalogs.en, key);
  const project = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: { name: label("seed.calendars.project.name"), systemActive: true },
  });
  const calendars = await databasesStore.createDatabase(client, {
    name: null,
    key: CALENDARS_MODULE_ID,
    system: true,
    ownerModuleId: CALENDARS_MODULE_ID,
    ownerProjectItemId: project.id,
  });
  await createProps(client, calendars.id, CALENDAR_PROPERTIES);
  const relationDefinitionId = await createCalendarEventsRelation(client, calendars.id, eventsDatabaseId);
  requireAffectedRows(
    await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [calendars.id]),
    "calendars schema lock",
  );

  let defaultCalendarId: string | undefined;
  for (const row of CALENDAR_ROWS) {
    const item = await itemsStore.insertItem(client, {
      databaseId: calendars.id,
      properties: {
        name: label(`seed.calendars.${row.catalogKey}.name`),
        color: row.color,
        notify: row.notify,
        hidden: false,
        isDefault: row.isDefault === true,
        kind: row.systemKey === undefined ? "own" : "system",
        ...(row.systemKey === undefined ? {} : { systemKey: row.systemKey }),
      },
    });
    if (row.isDefault) defaultCalendarId = item.id;
  }
  if (defaultCalendarId === undefined) throw new Error("The calendar seed declares no default calendar");
  await seedSubscribedEventsInTransaction(client, calendars);
  await createHeartbeat(client, {
    projectItemId: project.id,
    ...NEXT_OCCURRENCE_REFRESH_HEARTBEAT,
    actionId: NEXT_OCCURRENCE_REFRESH_ACTION_ID,
    actionConfig: { eventsDatabaseId },
  });
  return { calendars, relationDefinitionId, defaultCalendarId };
}
