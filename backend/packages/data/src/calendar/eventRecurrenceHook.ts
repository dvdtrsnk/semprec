// Refuses an Events `recurrence` value that is not a rule. Runs after the row is written in the write's
// transaction, so a refusal rolls back, for every choke-point write path.
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { EVENT_RECURRENCE_PROPERTY_KEY, parseEventRecurrenceRule } from "./eventRecurrenceRule.js";

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/** A create that does not name `recurrence` is not judged. */
export const eventRecurrenceItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isEventsDatabase(database)) return;
  if (Object.hasOwn(properties, EVENT_RECURRENCE_PROPERTY_KEY)) {
    parseEventRecurrenceRule(properties[EVENT_RECURRENCE_PROPERTY_KEY]);
  }
};

/**
 * `null` does not remove a rule: a series ends when its Event is deleted. A patch not naming `recurrence` is not
 * judged, so an Event stays editable whatever rule it holds.
 */
export const eventRecurrenceItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isEventsDatabase(database)) return;
  if (Object.hasOwn(propertiesPatch, EVENT_RECURRENCE_PROPERTY_KEY)) {
    parseEventRecurrenceRule(propertiesPatch[EVENT_RECURRENCE_PROPERTY_KEY]);
  }
};
