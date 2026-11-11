import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** The reminder leads an Event may carry, in minutes before its start: at event time, 5 or 15 minutes, 1 hour, 1 day. */
export const EVENT_ALERT_MINUTES = [0, 5, 15, 60, 1440] as const;

/** The travel times an Event may carry, in minutes: 15 or 30 minutes, 1 hour. */
export const EVENT_TRAVEL_MINUTES = [15, 30, 60] as const;

const REMINDER_VALUE_RULES: ReadonlyArray<{ key: string; allowed: readonly number[] }> = [
  { key: "alertMinutes", allowed: EVENT_ALERT_MINUTES },
  { key: "travelMinutes", allowed: EVENT_TRAVEL_MINUTES },
];

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/**
 * Judges `alertMinutes` and `travelMinutes` in `values`. A key that is absent or `null` carries no value and
 * passes; any other value must be a number of the key's allowed set, so `0` is a value (allowed as
 * `alertMinutes`, refused as `travelMinutes`) and a numeric string is refused.
 */
function assertReminderValues(values: Record<string, unknown>): void {
  for (const { key, allowed } of REMINDER_VALUE_RULES) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !allowed.includes(value)) {
      throw new ValidationError(`Property '${key}' must be empty or one of ${allowed.join(", ")}`, { field: key });
    }
  }
}

/**
 * The Events create rule of issue #1714, registered by `../domainWriteHooks.ts`. It runs after the insert in the
 * write's transaction, on the stored properties, and does nothing for another database. A rejection is a
 * `ValidationError` naming the field, which rolls the insert back.
 */
export const eventReminderValuesItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isEventsDatabase(database)) return;
  assertReminderValues(properties);
};

/**
 * The Events update rule of issue #1714, registered by `../domainWriteHooks.ts`. It runs after the update in the
 * write's transaction and judges the written patch, not the stored row: a stored value the patch does not name is
 * not read, so an Event holding a value outside the allowed sets stays editable. It does nothing for another
 * database. A rejection is a `ValidationError` naming the field, which rolls the update back.
 */
export const eventReminderValuesItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isEventsDatabase(database)) return;
  assertReminderValues(propertiesPatch);
};
