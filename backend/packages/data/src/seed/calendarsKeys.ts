/**
 * The canonical key and `owner_module_id` of the Calendars system database (issue #1600). Like the ten
 * core system databases (`seedTenDatabases.ts`), it is identified by its own database key, so this is not
 * the id of the module that declares it: that module is `calendar` (`CALENDAR_MODULE_ID`), which is also
 * the owner process of the database's system-owned properties.
 */
export const CALENDARS_MODULE_ID = "calendars";

/**
 * The canonical key and `owner_module_id` of the subscribed events system database (issue gh-1962), which
 * the calendar module owns like the Calendars database. Every one of its properties is system-owned by the
 * calendar module (`CALENDAR_MODULE_ID`), so the generic write path refuses a user, agent or `/mcp` write.
 */
export const SUBSCRIBED_EVENTS_MODULE_ID = "subscribedEvents";
