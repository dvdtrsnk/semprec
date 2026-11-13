import type { ModuleManifest } from "@semprec/module-registry";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";

export { createCalendarTimelineRouteHandler } from "./timelineRouteHandler.js";
export { createCalendarAgendaRouteHandler } from "./agendaRouteHandler.js";
export { calendarSendEventInvitationPayloadSchema, handleCalendarSendEventInvitation } from "./eventInvitationJob.js";
export { createCalendarCancellationImpactRouteHandler } from "./cancellationImpactRouteHandler.js";

/**
 * Manifest of the calendar module. The later calendar issues (invitations, reminders, recurrence, agent
 * tools) add their databases, routes, heartbeat actions and agent tools to this one manifest. The module
 * owns the calendar databases and the system-owned properties on them (`CALENDAR_MODULE_ID` is their owner
 * process). Its first database is `calendars` (issue #1600), seeded by `seed/seedCalendars.ts`, and its
 * first custom route is the timeline read (issue #1717). Like the Inbox and Mail modules it is
 * non-removable and a system project module.
 *
 * Ownership handoff (docs/adr/2026-09-10-single-writer-ownership-model.md, issue #1757): `Events.people`
 * is a user-owned relation of the systemDatabases module, and the edges and their `role` stay the user's
 * to write. The `invitation` object in an edge's metadata is handed to this module: its one writer is the
 * calendar module's invitation code, which writes with the system writer kind. Issue #1774 added its `sentAt`
 * write (`eventInvitationJob.ts`); issues #1790 and #1950 will add the rest. `eventParticipantEdgeHook.ts`
 * refuses a write of another writer kind that would add an `invitation`, or change or remove the stored one
 * (docs/adr/2026-11-11-event-participant-invitations-are-written-by-system-writers.md).
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
    {
      name: "calendarAgenda",
      method: "GET",
      path: "/api/calendar/agenda",
      handlerExport: "createCalendarAgendaRouteHandler",
      // Shaped for exactly one consumer, the calendar's list view: the entries of the timeline as one
      // list that continues from a day in either direction, paged by a cursor, which the generic query
      // cannot do across the Events and Tasks databases.
      justification: "single-consumer-read",
    },
    {
      name: "calendarCancellationImpact",
      method: "GET",
      path: "/api/calendar/calendars/:id/cancellation-impact",
      handlerExport: "createCalendarCancellationImpactRouteHandler",
      // Shaped for exactly one consumer, the confirmation dialog of a calendar deletion (issue gh-2003): one
      // call counts the Events, cancellations and invited people the deletion affects, which the generic
      // reads would have to assemble from the Events of a calendar and the edges of each.
      justification: "single-consumer-read",
    },
  ],
  taskNames: [
    {
      // Sends the iTIP REQUEST and CANCEL messages about an Event (issue #1774); `eventInvitationJob.ts` enqueues it.
      name: "calendarSendEventInvitation",
      payloadSchemaExport: "calendarSendEventInvitationPayloadSchema",
      handlerExport: "handleCalendarSendEventInvitation",
      queueAffinity: "api",
    },
  ],
};
