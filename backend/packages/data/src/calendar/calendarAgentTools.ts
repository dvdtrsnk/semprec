// Issue gh-1957: the three calendar write tools of an agent, declared in `calendarModuleManifest.ts`. Each handler runs
// the handler of the route that owns the same write (`createRespondToInvitationRouteHandler`, issue gh-1944, and the
// task-in-event handlers, issue #1764) for the user of the run, so the validation, the writes and the payload are those
// of the app and nothing is duplicated.
//
// The manifest declares all three with `requiresApproval`, so neither an agent session nor a run credential on `/mcp`
// runs a handler on the call: the call files a `moduleTool` approval request and the handler runs once, after the user
// approved it (docs/adr/2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request.md). What
// the handlers write is still the agent's write: the route handlers take the writer, and these tools pass
// `{ writerKind: "agent", agentRunId, agentProjectItemId, onBehalfOfUserId }` and no human writer, so the Event, the
// `hostEvents` edge and every write hook see an agent under the run and the per-database grants of the run's project
// apply. The manifest also declares them with `mcp`, so a human `/mcp` session runs the `...UserTool` handlers below as
// its user without an approval, written as an agent acting for that user with the external-client marker and no run
// (docs/adr/2026-11-14-calendar-tools-over-mcp-are-gated-for-a-run-credential-and-run-as-the-user-for-a-session.md).
// Constrained by: docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md,
// docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md
import type { Pool } from "pg";
import { z } from "zod";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ChokePointError, ForbiddenError, NotFoundError } from "../errors.js";
import {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
} from "../tasks/taskHostEventRouteHandlers.js";
import { INVITATION_RESPONSES, createRespondToInvitationRouteHandler } from "./invitationRouteHandlers.js";

export const calendarRespondToInvitationArgsSchema = z
  .strictObject({
    invitationId: z.uuid().describe("The id of the incoming invitation to answer."),
    response: z
      .enum(INVITATION_RESPONSES)
      .describe("accepted, tentative or declined for an invitation; acknowledged for a shared calendar notice."),
    calendarId: z
      .uuid()
      .optional()
      .describe(
        "The calendar for the Event an accepted or tentative answer creates; the suggested calendar when absent.",
      ),
  })
  .describe(
    "Answer an incoming calendar invitation. It sends the answer to the organizer by email, so a person approves " +
      "every call before it runs.",
  );

export const calendarPlaceTaskInEventArgsSchema = z
  .strictObject({
    taskId: z.uuid().describe("The id of the task."),
    eventId: z.uuid().describe("The id of the event the task is put into."),
  })
  .describe("Put a task into an event. A person approves every call before it runs.");

export const calendarRemoveTaskFromEventArgsSchema = z
  .strictObject({
    taskId: z.uuid().describe("The id of the task."),
    eventId: z.uuid().describe("The id of the event the task is taken out of."),
  })
  .describe("Take a task out of an event. A person approves every call before it runs.");

/** What a calendar tool answers: the payload of its route as a JSON string, or the refusal of the route as an error. */
export interface CalendarAgentToolResult {
  error: boolean;
  result: string;
  /**
   * Set by a tool whose answer carries content of a sensitive database, so that the stored tool result is redacted
   * (docs/adr/2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted.md).
   */
  sensitive?: true;
}

export type CalendarAgentTool<Args> = (runId: string, args: Args) => Promise<CalendarAgentToolResult>;

/** A calendar tool as a human `/mcp` session runs it: as the session's user, who has no run (issue gh-1957). */
export type CalendarUserTool<Args> = (userId: string, args: Args) => Promise<CalendarAgentToolResult>;

/** Who calls a calendar tool: a run (an agent session or a run credential) or the user of a human `/mcp` session. */
type CalendarToolCaller = { kind: "run"; runId: string } | { kind: "user"; userId: string };

/** The body of a calendar tool, written once for both callers. */
type CalendarToolWork = (userId: string, writer: WriterIdentity) => Promise<unknown>;

/**
 * The refusal of a route as a tool result: the status the route would answer, its error code and message, and the
 * `field` it names. Another tenant's id is refused exactly as an unknown one is, because the handlers refuse it so.
 */
export function refusal(error: ChokePointError): CalendarAgentToolResult {
  const details: unknown = error.details;
  const field: unknown = typeof details === "object" && details !== null ? Reflect.get(details, "field") : undefined;
  return {
    error: true,
    result: JSON.stringify({
      status: error.status,
      error: error.code,
      message: error.message,
      ...(typeof field === "string" ? { field } : {}),
    }),
  };
}

/**
 * Runs `work` for the caller as an agent. A run is the user of the run, written as the agent of that run; a human
 * session is its user, written as an agent acting for that user with the external-client marker and no run or project
 * (docs/adr/2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases.md). A `ChokePointError` the work
 * throws (a 400, 403, 404 or 409 of the route) is the tool's error result; anything else is not an answer of the tool
 * and propagates, so the caller records a failed call. A run without a project is a 403: the capability of the tools is
 * granted per project, so a run that has none holds none.
 */
async function asAgent(
  pool: Pool,
  caller: CalendarToolCaller,
  work: CalendarToolWork,
): Promise<CalendarAgentToolResult> {
  try {
    if (caller.kind === "user") {
      const writer: WriterIdentity = {
        writerKind: "agent",
        externalClient: true,
        onBehalfOfUserId: caller.userId,
      };
      return { error: false, result: JSON.stringify(await work(caller.userId, writer)) };
    }
    const run = await withTransaction(pool, (client) => getAgentRun(client, caller.runId));
    if (!run) throw new NotFoundError("Run not found");
    if (run.projectItemId === null) throw new ForbiddenError("The run has no project and so no access to the calendar");
    const writer: WriterIdentity = {
      writerKind: "agent",
      agentRunId: caller.runId,
      agentProjectItemId: run.projectItemId,
      onBehalfOfUserId: run.actorUserId,
    };
    return { error: false, result: JSON.stringify(await work(run.actorUserId, writer)) };
  } catch (err) {
    if (err instanceof ChokePointError) return refusal(err);
    throw err;
  }
}

/** The work of `calendar.respondToInvitation`, shared by the run and the user handler. */
function respondToInvitationWork(
  pool: Pool,
  args: z.infer<typeof calendarRespondToInvitationArgsSchema>,
): CalendarToolWork {
  const respond = createRespondToInvitationRouteHandler(pool);
  return async (userId, writer) => {
    const { item } = await respond(
      {
        params: { id: args.invitationId },
        body: { response: args.response, ...(args.calendarId === undefined ? {} : { calendarId: args.calendarId }) },
        identity: { user: { id: userId } },
      },
      writer,
    );
    return item;
  };
}

/** The work of `calendar.placeTaskInEvent`, shared by the run and the user handler. */
function placeTaskInEventWork(pool: Pool, args: z.infer<typeof calendarPlaceTaskInEventArgsSchema>): CalendarToolWork {
  const put = createTaskHostEventPutRouteHandler(pool);
  return async (userId, writer) => {
    const { body } = await put(
      { params: { id: args.taskId, eventId: args.eventId }, body: undefined, identity: { user: { id: userId } } },
      writer,
    );
    return body;
  };
}

/** The work of `calendar.removeTaskFromEvent`, shared by the run and the user handler. */
function removeTaskFromEventWork(
  pool: Pool,
  args: z.infer<typeof calendarRemoveTaskFromEventArgsSchema>,
): CalendarToolWork {
  const remove = createTaskHostEventRemoveRouteHandler(pool);
  return async (userId, writer) => {
    const { body } = await remove(
      { params: { id: args.taskId, eventId: args.eventId }, body: undefined, identity: { user: { id: userId } } },
      writer,
    );
    return body;
  };
}

/**
 * `calendar.respondToInvitation { invitationId, response, calendarId? }`: `POST /api/calendar/invitations/:id/respond`
 * for the user of the run, written as the agent of the run. The result is the invitation item the route answers with, as
 * JSON. An answer sends the iMIP reply to the organizer after its transaction commits (issue gh-1953), which is why the
 * manifest requires approval of a run.
 */
export function createCalendarRespondToInvitationTool(
  pool: Pool,
): CalendarAgentTool<z.infer<typeof calendarRespondToInvitationArgsSchema>> {
  return (runId, args) => asAgent(pool, { kind: "run", runId }, respondToInvitationWork(pool, args));
}

/**
 * `calendar.placeTaskInEvent { taskId, eventId }`: `PUT /api/tasks/:id/host-events/:eventId` for the user of the run.
 * The result is the `{ taskId, hostEvents }` body the route answers with.
 */
export function createCalendarPlaceTaskInEventTool(
  pool: Pool,
): CalendarAgentTool<z.infer<typeof calendarPlaceTaskInEventArgsSchema>> {
  return (runId, args) => asAgent(pool, { kind: "run", runId }, placeTaskInEventWork(pool, args));
}

/**
 * `calendar.removeTaskFromEvent { taskId, eventId }`: `DELETE /api/tasks/:id/host-events/:eventId` for the user of the
 * run. The result is the `{ taskId, hostEvents }` body the route answers with.
 */
export function createCalendarRemoveTaskFromEventTool(
  pool: Pool,
): CalendarAgentTool<z.infer<typeof calendarRemoveTaskFromEventArgsSchema>> {
  return (runId, args) => asAgent(pool, { kind: "run", runId }, removeTaskFromEventWork(pool, args));
}

/**
 * The human `/mcp` session's `calendar.respondToInvitation`: the same route handler for the session's user, without an
 * approval request (a session has no run to file one for), so the answer is sent to the organizer at once. The resolver
 * validates the arguments with the schema of the run tool before it calls the handler.
 */
export function createCalendarRespondToInvitationUserTool(
  pool: Pool,
): CalendarUserTool<z.infer<typeof calendarRespondToInvitationArgsSchema>> {
  return (userId, args) => asAgent(pool, { kind: "user", userId }, respondToInvitationWork(pool, args));
}

/** The human `/mcp` session's `calendar.placeTaskInEvent`; see `createCalendarRespondToInvitationUserTool`. */
export function createCalendarPlaceTaskInEventUserTool(
  pool: Pool,
): CalendarUserTool<z.infer<typeof calendarPlaceTaskInEventArgsSchema>> {
  return (userId, args) => asAgent(pool, { kind: "user", userId }, placeTaskInEventWork(pool, args));
}

/** The human `/mcp` session's `calendar.removeTaskFromEvent`; see `createCalendarRespondToInvitationUserTool`. */
export function createCalendarRemoveTaskFromEventUserTool(
  pool: Pool,
): CalendarUserTool<z.infer<typeof calendarRemoveTaskFromEventArgsSchema>> {
  return (userId, args) => asAgent(pool, { kind: "user", userId }, removeTaskFromEventWork(pool, args));
}
