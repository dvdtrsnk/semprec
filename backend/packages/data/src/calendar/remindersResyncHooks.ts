// The writes that can change a fire time of `GET /api/calendar/reminders` enqueue the debounced reminders resync
// (issue gh-1879): the create, update, delete and restore hooks below run in the write's own transaction, so a write
// that rolls back leaves no job. They are registered in `../domainWriteHooks.ts` after the hooks that validate or
// refuse these writes, so a refused write throws before it enqueues.
// Constrained by: docs/adr/2026-11-14-a-reminders-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction.md
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import type { ItemCreateHook, ItemDeleteHook, ItemRestoreHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { requireSingleRow } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { enqueueRemindersResync } from "./remindersResync.js";

/** The databases whose items have a reminder: an Event or a Task. */
const REMINDER_ITEM_MODULE_IDS: readonly (string | null)[] = [EVENTS_MODULE_ID, TASKS_MODULE_ID];

/**
 * The properties of an Event or a Task that decide whether and when its reminder fires: its start (`date`, `timeFrom`),
 * its end day (`endDate`), the alert and travel offsets, the Task's `notifications` switch and its `status` (a finished
 * Task has none). `reminderFireTime.ts` reads them.
 */
const FIRE_TIME_KEYS: readonly string[] = [
  "date",
  "endDate",
  "timeFrom",
  "alertMinutes",
  "travelMinutes",
  "notifications",
  "status",
];

/** The one property of a calendar that decides whether the reminders of its Events fire. */
const CALENDAR_NOTIFY_KEY = "notify";

/**
 * Whether the patch stores a value for `key` that differs from the one the item stored before it; every named key
 * counts as changed when the hook was not given the previous values.
 */
function changesKey(
  propertiesPatch: Record<string, unknown>,
  previous: Readonly<Record<string, unknown>> | undefined,
  key: string,
): boolean {
  if (!Object.hasOwn(propertiesPatch, key)) return false;
  return previous === undefined || !isDeepStrictEqual(previous[key] ?? null, propertiesPatch[key] ?? null);
}

/**
 * Enqueues the debounced `remindersResync` job for the tenant of the write, on the write's client, so the job commits
 * or rolls back with the write. The tenant is the one `app_tenant_default()` names for the transaction, which is the
 * tenant the written row belongs to.
 */
async function enqueueResyncForWrite(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
  const { tenant_id: tenantId } = requireSingleRow(rows, "reminders resync tenant");
  if (tenantId === null) throw new Error("A reminders write ran without a tenant");
  await enqueueRemindersResync(client, tenantId);
}

/**
 * A new Event or Task that carries a value for a property of `FIRE_TIME_KEYS` has a reminder the phone has to learn: a
 * create is a change from nothing, as an update that sets a value is. A key the create only filled in from its default,
 * such as a Task's `status`, or that a pre-write transform set to `null`, such as the `timeFrom` of a Task without a
 * date, is not one: a Task created with only a name has no reminder and enqueues nothing.
 */
export const remindersResyncCreateHook: ItemCreateHook = async ({ client, database, properties, defaultedKeys }) => {
  if (
    REMINDER_ITEM_MODULE_IDS.includes(database.ownerModuleId) &&
    FIRE_TIME_KEYS.some((key) => !defaultedKeys?.has(key) && changesKey(properties, {}, key))
  ) {
    await enqueueResyncForWrite(client);
  }
};

/**
 * An update of an Event or a Task that changes the value of a property of `FIRE_TIME_KEYS`, an update of a calendar
 * that changes `notify`, and an update of the System settings item that changes `timezone`, because the zone decides
 * the instant of every reminder. A patch of other properties, such as a name, and a patch that names one of these
 * with the value the item already stores enqueue nothing: the feed answers the same.
 */
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

/**
 * Whether the item is one whose trash or restore changes which reminders fire: an Event, a Task or a calendar, whose
 * Events are muted or unmuted with it. The trash of a calendar also trashes its Events, each of which enqueues too and
 * leaves the one pending job of the tenant.
 */
function isReminderTrashItem(moduleId: string | null): boolean {
  return REMINDER_ITEM_MODULE_IDS.includes(moduleId) || moduleId === CALENDARS_MODULE_ID;
}

/** An Event, a Task or a calendar that went to the Trash no longer fires, or no longer mutes. */
export const remindersResyncDeleteHook: ItemDeleteHook = async ({ client, database }) => {
  if (isReminderTrashItem(database.ownerModuleId)) await enqueueResyncForWrite(client);
};

/** An Event, a Task or a calendar that came back from the Trash fires, or mutes, again. */
export const remindersResyncRestoreHook: ItemRestoreHook = async ({ client, database }) => {
  if (isReminderTrashItem(database.ownerModuleId)) await enqueueResyncForWrite(client);
};
