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
export { calendarSendInvitationReplyPayloadSchema, handleCalendarSendInvitationReply } from "./invitationReplyJob.js";
export { createCalendarCancellationImpactRouteHandler } from "./cancellationImpactRouteHandler.js";
export { createRespondToInvitationRouteHandler } from "./invitationRouteHandlers.js";
export {
  calendarTimelineArgsSchema,
  createCalendarTimelineTool,
  createCalendarTimelineUserTool,
} from "./calendarTimelineTool.js";
export {
  calendarPlaceTaskInEventArgsSchema,
  calendarRemoveTaskFromEventArgsSchema,
  calendarRespondToInvitationArgsSchema,
  createCalendarPlaceTaskInEventTool,
  createCalendarPlaceTaskInEventUserTool,
  createCalendarRemoveTaskFromEventTool,
  createCalendarRemoveTaskFromEventUserTool,
  createCalendarRespondToInvitationTool,
  createCalendarRespondToInvitationUserTool,
} from "./calendarAgentTools.js";

/**
 * Manifest of the calendar module. The module owns the calendar databases and the system-owned properties on
 * them (`CALENDAR_MODULE_ID` is their owner process). Like Inbox and Mail it is non-removable and a system
 * project module.
 *
 * Ownership handoff: `Events.people` edges and their `role` stay user-owned, but the `invitation` object in an
 * edge's metadata is written only by this module's invitation code with the system writer kind;
 * `eventParticipantEdgeHook.ts` refuses any other writer kind that would add, change or remove it.
 *
 * Ownership handoff: an Event's `name`, `place`, `date`, `timeFrom`, `timeTo` and `endDate` are user-owned. The
 * invitation ingest is their only non-user writer: for the Event an answered invitation links, only for an
 * update from the stored organizer, and only for a field still equal to the previous mapped value; it never
 * clears the title (docs/architecture/domain-calendar-tasks-and-media.md#event-participants-and-invitations).
 *
 * Agent tools: `calendar.timeline` needs `calendar.read` and no approval, because it only reads. The write
 * tools need `calendar.write` and `requiresApproval`; `calendar.respondToInvitation` keeps the requirement
 * for good because the answer emails the organizer. All declare `mcp`. The tools see hidden calendars: hiding
 * is a display preference.
 */
export const manifest: ModuleManifest = {
  id: CALENDAR_MODULE_ID,
  version: "1.2.0",
  name: "Calendar",
  removable: false,
  systemProject: true,
  databases: [
    { key: CALENDARS_MODULE_ID, name: "Calendars" },
    { key: INVITATIONS_MODULE_ID, name: "Invitations" },
    // Every property is system-owned by this module.
    { key: SUBSCRIBED_EVENTS_MODULE_ID, name: "Subscribed events" },
  ],
  capabilities: ["calendar.read", "calendar.write"],
  agentTools: [
    {
      name: "calendar.timeline",
      handlerExport: "createCalendarTimelineTool",
      argumentSchemaExport: "calendarTimelineArgsSchema",
      capability: "calendar.read",
      approval: "none",
      riskClass: "read",
      mcp: { humanHandlerExport: "createCalendarTimelineUserTool" },
    },
    {
      name: "calendar.respondToInvitation",
      handlerExport: "createCalendarRespondToInvitationTool",
      argumentSchemaExport: "calendarRespondToInvitationArgsSchema",
      capability: "calendar.write",
      approval: "always",
      riskClass: "outbound",
      requiresApproval: true,
      mcp: { humanHandlerExport: "createCalendarRespondToInvitationUserTool" },
    },
    {
      name: "calendar.placeTaskInEvent",
      handlerExport: "createCalendarPlaceTaskInEventTool",
      argumentSchemaExport: "calendarPlaceTaskInEventArgsSchema",
      capability: "calendar.write",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      mcp: { humanHandlerExport: "createCalendarPlaceTaskInEventUserTool" },
    },
    {
      name: "calendar.removeTaskFromEvent",
      handlerExport: "createCalendarRemoveTaskFromEventTool",
      argumentSchemaExport: "calendarRemoveTaskFromEventArgsSchema",
      capability: "calendar.write",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      mcp: { humanHandlerExport: "createCalendarRemoveTaskFromEventUserTool" },
    },
  ],
  // Advances `nextOccurrenceDate` of recurring Events; ingests invitations from new email (new, updated,
  // cancelled); applies an invited person's reply to their participant edge.
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
      // One call merges Events and Tasks of a range with calendar, project and people; the generic query reads one
      // database at a time without relations.
      justification: "single-consumer-read",
    },
    {
      name: "calendarAgenda",
      method: "GET",
      path: "/api/calendar/agenda",
      handlerExport: "createCalendarAgendaRouteHandler",
      // One list continuing from a day in either direction, cursor-paged across Events and Tasks.
      justification: "single-consumer-read",
    },
    {
      name: "calendarCancellationImpact",
      method: "GET",
      path: "/api/calendar/calendars/:id/cancellation-impact",
      handlerExport: "createCalendarCancellationImpactRouteHandler",
      // Counts what a calendar deletion affects for the confirmation dialog.
      justification: "single-consumer-read",
    },
    {
      name: "respondToInvitation",
      method: "POST",
      path: "/api/calendar/invitations/:id/respond",
      handlerExport: "createRespondToInvitationRouteHandler",
      // The answer and the Event it creates, restores or trashes must commit together.
      justification: "transactional-semantics",
    },
  ],
  taskNames: [
    {
      // Enqueued by `eventInvitationJob.ts`.
      name: "calendarSendEventInvitation",
      payloadSchemaExport: "calendarSendEventInvitationPayloadSchema",
      handlerExport: "handleCalendarSendEventInvitation",
      queueAffinity: "api",
    },
    {
      // Enqueued by the respond route in the answer's transaction.
      name: "calendarSendInvitationReply",
      payloadSchemaExport: "calendarSendInvitationReplyPayloadSchema",
      handlerExport: "handleCalendarSendInvitationReply",
      queueAffinity: "api",
    },
  ],
};
