// Writes that can change a reminder fire time enqueue the debounced resync in their own transaction, so a rollback
// leaves no job. Registered after the validating hooks, so a refused write throws before it enqueues.
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemDeleteHook, ItemRestoreHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { requireSingleRow } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { enqueueRemindersResync } from "./remindersResync.js";
import {
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_TIME_ZONE_PROPERTY_KEY,
} from "./syncedEventKeys.js";

const REMINDER_ITEM_MODULE_IDS: readonly (string | null)[] = [EVENTS_MODULE_ID, TASKS_MODULE_ID];

/** The inputs of `reminderFireTime.ts`, and the synced Event fields that move or add a reminder in the feed. */
const FIRE_TIME_KEYS: readonly string[] = [
  "date",
  "endDate",
  "timeFrom",
  "alertMinutes",
  "travelMinutes",
  "notifications",
  "status",
  EVENT_TIME_ZONE_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
];

const CALENDAR_NOTIFY_KEY = "notify";

/** Without previous values every named key counts as changed. */
function changesKey(
  propertiesPatch: Record<string, unknown>,
  previous: Readonly<Record<string, unknown>> | undefined,
  key: string,
): boolean {
  if (!Object.hasOwn(propertiesPatch, key)) return false;
  return previous === undefined || !isDeepStrictEqual(previous[key] ?? null, propertiesPatch[key] ?? null);
}

/** `app_tenant_default()` is the tenant the written row belongs to. */
async function enqueueResyncForWrite(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
  const { tenant_id: tenantId } = requireSingleRow(rows, "reminders resync tenant");
  if (tenantId === null) throw new Error("A reminders write ran without a tenant");
  await enqueueRemindersResync(client, tenantId);
}

/**
 * Defaulted keys (a Task's `status`) and keys a transform set to `null` do not count, so a Task created with only a
 * name enqueues nothing.
 */
export const remindersResyncCreateHook: ItemCreateHook = async ({ client, database, properties, defaultedKeys }) => {
  if (
    REMINDER_ITEM_MODULE_IDS.includes(database.ownerModuleId) &&
    FIRE_TIME_KEYS.some((key) => !defaultedKeys?.has(key) && changesKey(properties, {}, key))
  ) {
    await enqueueResyncForWrite(client);
  }
};

/** The tenant `timezone` counts because it decides the instant of every reminder. */
export const remindersResyncUpdateHook: ItemUpdateHook = async ({ client, database, propertiesPatch, previous }) => {
  const moduleId = database.ownerModuleId;
  const changes = (key: string): boolean => changesKey(propertiesPatch, previous, key);
  if (
    (REMINDER_ITEM_MODULE_IDS.includes(moduleId) && FIRE_TIME_KEYS.some(changes)) ||
    (moduleId === CALENDARS_MODULE_ID && changes(CALENDAR_NOTIFY_KEY)) ||
    (moduleId === SYSTEM_SETTINGS_MODULE_ID && changes("timezone"))
  ) {
    await enqueueResyncForWrite(client);
  }
};

/** A calendar's trash also trashes its Events; their enqueues collapse onto the tenant's one pending job. */
function isReminderTrashItem(moduleId: string | null): boolean {
  return REMINDER_ITEM_MODULE_IDS.includes(moduleId) || moduleId === CALENDARS_MODULE_ID;
}

export const remindersResyncDeleteHook: ItemDeleteHook = async ({ client, database }) => {
  if (isReminderTrashItem(database.ownerModuleId)) await enqueueResyncForWrite(client);
};

export const remindersResyncRestoreHook: ItemRestoreHook = async ({ client, database }) => {
  if (isReminderTrashItem(database.ownerModuleId)) await enqueueResyncForWrite(client);
};
