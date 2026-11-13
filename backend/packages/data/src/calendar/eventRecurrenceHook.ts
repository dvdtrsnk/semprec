// The Events recurrence write rule (issue gh-1817): the choke point's item create and update hooks that refuse a
// `recurrence` value that is not a rule. They run in the write's transaction after the row is written, so a
// refusal rolls the write back, and they run for every write path of the choke point (REST, the agent
// operations and MCP).
// Constrained by: docs/adr/2026-11-13-an-event-recurrence-rule-is-a-user-owned-json-property.md,
// docs/adr/2026-10-09-item-create-domain-hooks.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { EVENT_RECURRENCE_PROPERTY_KEY, parseEventRecurrenceRule } from "./eventRecurrenceRule.js";

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/**
 * The Events create rule, registered by `../domainWriteHooks.ts`. A create that names `recurrence` must give a
 * rule (`parseEventRecurrenceRule`), otherwise it is refused with 400 `validation_failed` on `recurrence`. A
 * create that does not name it is not judged, and neither is a row of another database.
 */
export const eventRecurrenceItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isEventsDatabase(database)) return;
  if (Object.hasOwn(properties, EVENT_RECURRENCE_PROPERTY_KEY)) {
    parseEventRecurrenceRule(properties[EVENT_RECURRENCE_PROPERTY_KEY]);
  }
};

/**
 * The Events update rule, registered by `../domainWriteHooks.ts`. An update whose written patch names
 * `recurrence` must give a rule, otherwise it is refused with 400 `validation_failed` on `recurrence`; `null`
 * does not remove a rule, because a series ends when its Event is deleted. A patch that does not name it is
 * not judged, so an Event keeps being editable whatever rule it holds, and neither is a row of another database.
 */
export const eventRecurrenceItemUpdateHook: ItemUpdateHook = async ({ database, propertiesPatch }) => {
  if (!isEventsDatabase(database)) return;
  if (Object.hasOwn(propertiesPatch, EVENT_RECURRENCE_PROPERTY_KEY)) {
    parseEventRecurrenceRule(propertiesPatch[EVENT_RECURRENCE_PROPERTY_KEY]);
  }
};
