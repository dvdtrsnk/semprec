import type { ModuleManifest } from "@semprec/module-registry";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { CALENDAR_INGEST_INVITATION_ACTION_ID } from "./invitationIngestAction.js";
import { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID } from "./invitationReplyAction.js";
import { NEXT_OCCURRENCE_REFRESH_ACTION_ID } from "./nextOccurrenceRefreshAction.js";

export { createCalendarTimelineRouteHandler } from "./timelineRouteHandler.js";
export { createCalendarAgendaRouteHandler } from "./agendaRouteHandler.js";
export { calendarSendEventInvitationPayloadSchema, handleCalendarSendEventInvitation } from "./eventInvitationJob.js";
export { createCalendarCancellationImpactRouteHandler } from "./cancellationImpactRouteHandler.js";
export { createRespondToInvitationRouteHandler } from "./invitationRouteHandlers.js";

/**
 * Manifest of the calendar module. The later calendar issues (invitations, reminders, recurrence, agent
 * tools) add their databases, routes, heartbeat actions and agent tools to this one manifest. The module
 * owns the calendar databases and the system-owned properties on them (`CALENDAR_MODULE_ID` is their owner
 * process). Its first database is `calendars` (issue #1600), seeded by `seed/seedCalendars.ts`; `invitations` (issue
 * gh-1901), seeded by `seed/seedInvitationsDatabase.ts`, holds the incoming meeting invitations; `subscribedEvents`
 * (issue gh-1962), seeded by `seed/seedSubscribedEvents.ts`, holds the read-only events of subscribed calendars. Its
 * first custom route is the timeline read (issue #1717). Like the Inbox and Mail modules it is
 * non-removable and a system project module.
 *
 * Ownership handoff (docs/adr/2026-09-10-single-writer-ownership-model.md, issue #1757): `Events.people`
 * is a user-owned relation of the systemDatabases module, and the edges and their `role` stay the user's
 * to write. The `invitation` object in an edge's metadata is handed to this module: its one writer is the
 * calendar module's invitation code, which writes with the system writer kind. Issue #1774 added its `sentAt`
 * write (`eventInvitationJob.ts`); issue #1790 added the pending invitation. Issue #1950 added the writer of
 * `invitation.status` and `invitation.respondedAt`: the heartbeat action `calendar.applyInvitationReply`
 * (`invitationReplyAction.ts`), which sets them from the iMIP reply of an invited person. `eventParticipantEdgeHook.ts`
 * refuses a write of another writer kind that would add an `invitation`, or change or remove the stored one
 * (docs/adr/2026-11-11-event-participant-invitations-are-written-by-system-writers.md).
 *
 * Ownership handoff (issue gh-2007, docs/adr/2026-11-14-an-organizers-update-is-adopted-into-an-event-by-the-calendar-module-until-the-user-changes-the-field.md):
 * `name`, `place`, `date`, `timeFrom`, `timeTo` and `endDate` of an Event are user-owned. The invitation ingest
 * (`invitationIngestAction.ts`) is the only non-user writer of them, and only for the Event an answered invitation links
 * through its `event` relation. It writes with the system writer kind, only for an update that comes from the
 * invitation's stored organizer, and only a field that still equals the invitation's previous mapped value
 * (`invitationEventFields`); it never clears the title.
 */
export const manifest: ModuleManifest = {
  id: CALENDAR_MODULE_ID,
  version: "1.1.0",
  name: "Calendar",
  removable: false,
  systemProject: true,
  databases: [
    { key: CALENDARS_MODULE_ID, name: "Calendars" },
    { key: INVITATIONS_MODULE_ID, name: "Invitations" },
    // Read-only events of subscribed calendars (issue gh-1962); every property is system-owned by this module.
    { key: SUBSCRIBED_EVENTS_MODULE_ID, name: "Subscribed events" },
  ],
  capabilities: [],
  agentTools: [],
  // Moves the stored `nextOccurrenceDate` of recurring Events on as days pass (issue gh-1905).
  // Also reads the calendar part of a new email into a pending invitation (issue gh-1929), applies the organizer's
  // update (issue gh-2007) or cancellation (issue gh-2006) of a known invitation, and applies the reply of an invited
  // person to the invitation on their participant edge (issue gh-1950).
  heartbeatActions: [
    NEXT_OCCURRENCE_REFRESH_ACTION_ID,
    CALENDAR_INGEST_INVITATION_ACTION_ID,
    CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
  ],
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
    {
      name: "respondToInvitation",
      method: "POST",
      path: "/api/calendar/invitations/:id/respond",
      handlerExport: "createRespondToInvitationRouteHandler",
      // The answer and the Event it creates, restores or trashes (issue gh-1944) must commit together, which the
      // generic item endpoints cannot express.
      justification: "transactional-semantics",
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
