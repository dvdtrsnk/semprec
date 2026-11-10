import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { CALENDARS_MODULE_ID } from "./calendarsKeys.js";

/** The `kind` options of a calendar; a row without a `kind` is `own`. */
const CALENDAR_KINDS = ["own", "system", "subscription"] as const;

interface CalendarRow {
  /** Names the row's label `seed.calendars.<catalogKey>.name` in the calendar module catalog. */
  catalogKey: string;
  color: string;
  notify: boolean;
  isDefault?: true;
  /** Set on the system calendars only, as their `systemKey`. */
  systemKey?: string;
}

/** The default and system calendars every tenant starts with (issue #1600); `Personal` is the default. */
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

interface PropSpec {
  key: string;
  type: PropertyType;
  owner: PropertyOwner;
  ownerProcess?: string;
  config?: Record<string, unknown>;
}

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
 * The `Calendars.events` / `Events.calendar` pair: one calendar, many Events, so `Calendars.events` is
 * property A of a `one_to_many` definition and each Event has at most one calendar. Events is
 * `schema_locked` and `propertiesStore` refuses to change a locked schema, so both properties, the
 * relation definition and the property configs are written with raw SQL in the three steps
 * `transcription/transcriptsCatalogCutoverMigration.ts` uses, under an exclusive `properties` lock.
 * The fresh seed and the cutover both reach it through `seedCalendarsInTransaction`, so the
 * definitions are identical. Returns the relation definition id.
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
 * Seeds the calendar module's first database (issue #1600) into the caller's open transaction: a system
 * project item for the module, the `calendars` system database with its properties (`kind` and
 * `systemKey` system-owned by the calendar module), the `Calendars.events` / `Events.calendar` relation,
 * and the eight default and system calendars. The project's and the rows' names come from the calendar
 * module catalog in the tenant user's language (`cs` while the tenant has no user). The schema is locked
 * once complete.
 *
 * Not idempotent on its own: `seedSystem` calls it once for a new tenant and
 * `calendar/calendarsCutoverMigration.ts` calls it only for a tenant without a calendars database.
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
  for (const spec of CALENDAR_PROPERTIES) {
    // `name` is null like every built-in property of a system database; labels come from the catalog.
    await propertiesStore.createProperty(client, {
      databaseId: calendars.id,
      key: spec.key,
      name: null,
      type: spec.type,
      owner: spec.owner,
      ownerProcess: spec.ownerProcess,
      config: spec.config,
    });
  }
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
  return { calendars, relationDefinitionId, defaultCalendarId };
}
