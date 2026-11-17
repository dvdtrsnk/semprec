/**
 * Key and `owner_module_id` of the Calendars system database. It names the database, not the declaring
 * module, which is `calendar` (`CALENDAR_MODULE_ID`), also the owner process of its system properties.
 */
export const CALENDARS_MODULE_ID = "calendars";

/**
 * Key and `owner_module_id` of the subscribed events database, owned by the calendar module. All its
 * properties are system-owned, so the generic write path refuses user, agent and `/mcp` writes.
 */
export const SUBSCRIBED_EVENTS_MODULE_ID = "subscribedEvents";
