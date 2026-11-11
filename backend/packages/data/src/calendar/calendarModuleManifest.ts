import type { ModuleManifest } from "@semprec/module-registry";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";

export { createCalendarTimelineRouteHandler } from "./timelineRouteHandler.js";

/**
 * Manifest of the calendar module. The later calendar issues (invitations, reminders, recurrence, agent
 * tools) add their databases, routes, heartbeat actions and agent tools to this one manifest. The module
 * owns the calendar databases and the system-owned properties on them (`CALENDAR_MODULE_ID` is their owner
 * process). Its first database is `calendars` (issue #1600), seeded by `seed/seedCalendars.ts`, and its
 * first custom route is the timeline read (issue #1717). Like the Inbox and Mail modules it is
 * non-removable and a system project module.
 */
export const manifest: ModuleManifest = {
  id: CALENDAR_MODULE_ID,
  version: "1.0.0",
  name: "Calendar",
  removable: false,
  systemProject: true,
  databases: [{ key: CALENDARS_MODULE_ID, name: "Calendars" }],
  capabilities: [],
  agentTools: [],
  customRoutes: [
    {
      name: "calendarTimeline",
      method: "GET",
      path: "/api/calendar/timeline",
      handlerExport: "createCalendarTimelineRouteHandler",
      // Shaped for exactly one consumer, the calendar views: one call merges the Events and Tasks of a
      // date range with their calendar, project and people, which the generic query reads one database
      // at a time and without relations.
      justification: "single-consumer-read",
    },
  ],
};
