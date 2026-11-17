import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { deleteCalendarFeedState } from "./calendarFeedState.js";

/** Deletes the purged calendar's `calendar_feed_state` row in the purge transaction; may match none. */
export const calendarFeedStatePurgeHook: ItemPurgeHook = async ({ client, database, item }) => {
  if (database.ownerModuleId !== CALENDARS_MODULE_ID) return;
  await deleteCalendarFeedState(client, item.id);
};
