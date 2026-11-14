// Owns the calendar module's item purge hook for the download state of a subscription calendar (issue gh-1960): the
// `calendar_feed_state` row of a permanently deleted calendar is deleted with it, in the purge's transaction.
// Constrained by: docs/adr/2026-11-10-item-purge-domain-hooks.md
import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { deleteCalendarFeedState } from "./calendarFeedState.js";

/**
 * The calendar module's item purge hook, registered by `../domainWriteHooks.ts`. It deletes the purged calendar's
 * `calendar_feed_state` row through its store, for an item of the Calendars database only; a calendar that was never
 * requested has no row, so it may match none.
 */
export const calendarFeedStatePurgeHook: ItemPurgeHook = async ({ client, database, item }) => {
  if (database.ownerModuleId !== CALENDARS_MODULE_ID) return;
  await deleteCalendarFeedState(client, item.id);
};
