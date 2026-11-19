import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Whole minutes before the start, up to four weeks: the presets of a calendar client (at the time of the event,
 * 5 or 10 minutes, a day, a week before) and any custom value between.
 */
export const EVENT_ALERT_MINUTES = { min: 0, max: 40_320 } as const;

/** Whole minutes of travel before the start, from one minute up to a day. */
export const EVENT_TRAVEL_MINUTES = { min: 1, max: 1_440 } as const;

const REMINDER_VALUE_RULES: ReadonlyArray<{ key: string; range: { min: number; max: number } }> = [
  { key: "alertMinutes", range: EVENT_ALERT_MINUTES },
  { key: "travelMinutes", range: EVENT_TRAVEL_MINUTES },
];

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/**
 * Absent or `null` passes; otherwise the value must be a whole number in the key's range, so `0` is allowed as
 * `alertMinutes`, refused as `travelMinutes`, and a numeric string is refused.
 */
function assertReminderValues(values: Record<string, unknown>): void {
  for (const { key, range } of REMINDER_VALUE_RULES) {
    const value = values[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
      throw new ValidationError(`Property '${key}' must be empty or a whole number from ${range.min} to ${range.max}`, {
        field: key,
      });
    }
  }
}

/** Judges the stored properties after the insert; a rejection rolls the insert back. */
export const eventReminderValuesItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isEventsDatabase(database)) return;
  assertReminderValues(properties);
};

/** Judges the written patch, not the stored row, so an Event holding a value out of range stays editable. */
export const eventReminderValuesItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isEventsDatabase(database)) return;
  assertReminderValues(propertiesPatch);
};
