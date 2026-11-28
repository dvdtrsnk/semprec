// What every source of one timeline read looks up the same way: the system databases, the calendars the entries name,
// the user's language, the Tasks' `hostEvents` relation and the databases an item may be read from. Each is read at most once per lookups object, which lives
// for one read in one transaction and is never shared between reads.
import type { PoolClient } from "pg";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getDatabasesByModuleIds } from "../chokePoint/databasesStore.js";
import { getItemsByIdsAmong, visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import { toManifestLocale, type ManifestLocale } from "../manifest/catalogResolution.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadHostEventsRelationIn, type HostEventsRelation } from "../tasks/taskHostEventState.js";
import type { DatabaseRow, ItemRow } from "../types.js";

const TIMELINE_MODULE_IDS = [
  EVENTS_MODULE_ID,
  TASKS_MODULE_ID,
  PEOPLE_MODULE_ID,
  CALENDARS_MODULE_ID,
  INVITATIONS_MODULE_ID,
  SUBSCRIBED_EVENTS_MODULE_ID,
  SLEEP_SETTINGS_MODULE_ID,
  SLEEP_PLANS_MODULE_ID,
  SLEEP_NIGHTS_MODULE_ID,
] as const;

export type TimelineModuleId = (typeof TIMELINE_MODULE_IDS)[number];

export interface CalendarIds {
  defaultCalendarId: string | null;
  /** By `systemKey`; of several live calendars with one key the lowest id. */
  systemCalendarIds: ReadonlyMap<string, string>;
  /** The live account calendars the provider does not let the user write to. */
  readOnlyCalendarIds: ReadonlySet<string>;
}

export interface CalendarTimelineLookups {
  /** The tenant's system database of the module; all of them are read in one statement on first use. */
  database(moduleId: TimelineModuleId): Promise<DatabaseRow | null>;
  calendarIds(): Promise<CalendarIds>;
  /** The tenant user's language, Czech without a user. */
  locale(): Promise<ManifestLocale>;
  hostEventsRelation(): Promise<HostEventsRelation | null>;
  /** `getItemsByIds`: the live items of any visible database, which are read once for every call. */
  itemsByIds(itemIds: string[]): Promise<ItemRow[]>;
}

const NO_CALENDARS: CalendarIds = {
  defaultCalendarId: null,
  systemCalendarIds: new Map(),
  readOnlyCalendarIds: new Set(),
};

async function readCalendarIds(client: PoolClient, calendars: DatabaseRow | null): Promise<CalendarIds> {
  if (!calendars) return NO_CALENDARS;
  const { rows } = await client.query<{
    id: string;
    is_default: boolean | null;
    system_key: string | null;
    read_only: boolean;
  }>(
    `SELECT id, properties->'isDefault' = 'true'::jsonb AS is_default,
            properties->>'systemKey' AS system_key,
            (properties->>'kind' = 'account' AND properties->'readOnly' = 'true'::jsonb) IS TRUE AS read_only
       FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND (properties->'isDefault' = 'true'::jsonb OR properties->>'systemKey' IS NOT NULL
             OR (properties->>'kind' = 'account' AND properties->'readOnly' = 'true'::jsonb))
      ORDER BY id`,
    [calendars.id],
  );
  const systemCalendarIds = new Map<string, string>();
  for (const row of rows) {
    if (row.system_key !== null && !systemCalendarIds.has(row.system_key))
      systemCalendarIds.set(row.system_key, row.id);
  }
  return {
    defaultCalendarId: rows.find((row) => row.is_default === true)?.id ?? null,
    systemCalendarIds,
    readOnlyCalendarIds: new Set(rows.filter((row) => row.read_only).map((row) => row.id)),
  };
}

/** Lookups for one read on `client`; a lookup that failed fails again for the rest of the read, as its transaction has. */
export function createCalendarTimelineLookups(client: PoolClient): CalendarTimelineLookups {
  let databases: Promise<Map<string, DatabaseRow>> | undefined;
  let calendarIds: Promise<CalendarIds> | undefined;
  let locale: Promise<ManifestLocale> | undefined;
  let hostEventsRelation: Promise<HostEventsRelation | null> | undefined;
  let visible: Promise<string[]> | undefined;
  const database = async (moduleId: TimelineModuleId): Promise<DatabaseRow | null> => {
    databases ??= getDatabasesByModuleIds(client, TIMELINE_MODULE_IDS);
    return (await databases).get(moduleId) ?? null;
  };
  return {
    database,
    calendarIds: () => (calendarIds ??= database(CALENDARS_MODULE_ID).then((row) => readCalendarIds(client, row))),
    locale: () => (locale ??= getTenantUserLocale(client).then((stored) => toManifestLocale(stored ?? "cs"))),
    hostEventsRelation: () =>
      (hostEventsRelation ??= database(TASKS_MODULE_ID).then((tasks) =>
        tasks === null ? null : loadHostEventsRelationIn(client, tasks.id),
      )),
    itemsByIds: async (itemIds) => {
      if (itemIds.length === 0) return [];
      visible ??= visibleDatabaseIds(client);
      return getItemsByIdsAmong(client, itemIds, await visible);
    },
  };
}
