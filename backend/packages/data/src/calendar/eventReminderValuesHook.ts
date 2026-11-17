import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** Minutes before the start. */
export const EVENT_ALERT_MINUTES = [0, 5, 15, 60, 1440] as const;

export const EVENT_TRAVEL_MINUTES = [15, 30, 60] as const;

const REMINDER_VALUE_RULES: ReadonlyArray<{ key: string; allowed: readonly number[] }> = [
  { key: "alertMinutes", allowed: EVENT_ALERT_MINUTES },
  { key: "travelMinutes", allowed: EVENT_TRAVEL_MINUTES },
];

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/**
 * Absent or `null` passes; otherwise the value must be in the key's set, so `0` is allowed as `alertMinutes`,
 * refused as `travelMinutes`, and a numeric string is refused.
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

/** Judges the stored properties after the insert; a rejection rolls the insert back. */
export const eventReminderValuesItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isEventsDatabase(database)) return;
  assertReminderValues(properties);
};

/** Judges the written patch, not the stored row, so an Event holding a disallowed value stays editable. */
export const eventReminderValuesItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isEventsDatabase(database)) return;
  assertReminderValues(propertiesPatch);
};
