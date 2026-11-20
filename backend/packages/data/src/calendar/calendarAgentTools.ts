// The calendar write tools of an agent. Each handler runs the route handler that owns the same write, so
// validation, writes and payload are those of the app.
//
// The manifest declares them with `requiresApproval`: a run's call files a `moduleTool` approval request and the
// handler runs after approval. The write is still the agent's (`writerKind: "agent"` under the run), so write hooks
// and the run project's per-database grants apply. A human `/mcp` session runs the `...UserTool` handlers as its
// user without approval, written as an agent with the external-client marker and no run
// (docs/architecture/domain-calendar-tasks-and-media.md#calendar-tools-over-mcp).
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
    "Answer an incoming calendar invitation. It sends the answer to the organizer, by email or through the " +
      "internet account's calendar provider, so a person approves every call before it runs.",
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

export interface CalendarAgentToolResult {
  error: boolean;
  result: string;
  /** Marks a result carrying sensitive-database content, so the stored tool result is redacted. */
  sensitive?: true;
}

export type CalendarAgentTool<Args> = (runId: string, args: Args) => Promise<CalendarAgentToolResult>;

export type CalendarUserTool<Args> = (userId: string, args: Args) => Promise<CalendarAgentToolResult>;

type CalendarToolCaller = { kind: "run"; runId: string } | { kind: "user"; userId: string };

type CalendarToolWork = (userId: string, writer: WriterIdentity) => Promise<unknown>;

/** Another tenant's id is refused exactly as an unknown one, because the route handlers refuse it so. */
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
 * A `ChokePointError` from `work` is the tool's error result; anything else propagates so the call is recorded as
 * failed. A run without a project is a 403: tool capability is granted per project.
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

/** The answer sends the iMIP reply to the organizer after commit, which is why a run needs approval. */
export function createCalendarRespondToInvitationTool(
  pool: Pool,
): CalendarAgentTool<z.infer<typeof calendarRespondToInvitationArgsSchema>> {
  return (runId, args) => asAgent(pool, { kind: "run", runId }, respondToInvitationWork(pool, args));
}

export function createCalendarPlaceTaskInEventTool(
  pool: Pool,
): CalendarAgentTool<z.infer<typeof calendarPlaceTaskInEventArgsSchema>> {
  return (runId, args) => asAgent(pool, { kind: "run", runId }, placeTaskInEventWork(pool, args));
}

export function createCalendarRemoveTaskFromEventTool(
  pool: Pool,
): CalendarAgentTool<z.infer<typeof calendarRemoveTaskFromEventArgsSchema>> {
  return (runId, args) => asAgent(pool, { kind: "run", runId }, removeTaskFromEventWork(pool, args));
}

/**
 * No approval request (a session has no run to file one for), so the answer is sent at once. The resolver
 * validates the arguments with the run tool's schema first.
 */
export function createCalendarRespondToInvitationUserTool(
  pool: Pool,
): CalendarUserTool<z.infer<typeof calendarRespondToInvitationArgsSchema>> {
  return (userId, args) => asAgent(pool, { kind: "user", userId }, respondToInvitationWork(pool, args));
}

export function createCalendarPlaceTaskInEventUserTool(
  pool: Pool,
): CalendarUserTool<z.infer<typeof calendarPlaceTaskInEventArgsSchema>> {
  return (userId, args) => asAgent(pool, { kind: "user", userId }, placeTaskInEventWork(pool, args));
}

export function createCalendarRemoveTaskFromEventUserTool(
  pool: Pool,
): CalendarUserTool<z.infer<typeof calendarRemoveTaskFromEventArgsSchema>> {
  return (userId, args) => asAgent(pool, { kind: "user", userId }, removeTaskFromEventWork(pool, args));
}
