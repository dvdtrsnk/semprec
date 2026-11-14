import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import {
  resolveModuleAgentToolsForRun,
  resolveModuleAgentToolsForUser,
  type ResolvedHumanModuleAgentTool,
  type ResolvedModuleAgentTool,
} from "../../agentTools/moduleAgentTools.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import {
  registerItemCreateHook,
  registerItemDeleteHook,
  registerRelationEdgeChangedHook,
} from "../../chokePoint/hooks.js";
import type { WriterIdentity, WriterKind } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { decideAndEnqueueApprovalRequest } from "../../mcp/approvalDecisionAction.js";
import { handleApprovalRequestExecuteTask } from "../../mcp/approvalRequestExecution.js";
import { getApprovalRequest, type ApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { createModuleToolApprovalRequest } from "../../mcp/moduleToolApprovalRequest.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
} from "../../tasks/taskHostEventRouteHandlers.js";
import { createEventInCalendar } from "../defaultCalendarCreateHook.js";
import { createRespondToInvitationRouteHandler } from "../invitationRouteHandlers.js";
import { createInvitation } from "./invitationFixtures.js";

/**
 * The three calendar write tools (issue gh-1957), on the runtime role pool and in tenants of their own. The handlers
 * run as `ResolvedModuleAgentTool.invoke`, the entry the approval executor and an agent session use, so the argument
 * schema of each tool is in the path. The routes the tools stand for run on the same pool for the expected payloads.
 */

const RESPOND = "calendar.respondToInvitation";
const PLACE = "calendar.placeTaskInEvent";
const REMOVE = "calendar.removeTaskFromEvent";
const REPLY_TASK = "calendarSendInvitationReply";

interface Tenant {
  id: string;
  userId: string;
  /** The project that owns the calendar databases: the project of a run that holds `calendar.write`. */
  calendarProjectId: string;
  tasksId: string;
  eventsId: string;
  calendarsId: string;
  runId: string;
}

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let home: Tenant;
let foreign: Tenant;

/** What the write hooks saw of the writes the tools made, cleared before each test. */
const seen = {
  eventCreates: [] as { writer: WriterIdentity; humanWriterUserId: string | undefined }[],
  eventTrashes: [] as { writerKind: WriterKind; agentRunId: string | undefined }[],
  hostEventEdges: [] as { op: string; writer: WriterIdentity; itemA: string; itemB: string }[],
};

const refusalSchema = z.looseObject({ status: z.number(), error: z.string(), message: z.string() });
const hostEventsSchema = z.object({
  taskId: z.string(),
  hostEvents: z.array(z.object({ eventId: z.string(), addedAt: z.string() })),
});

async function seededTenant(): Promise<Tenant> {
  const id = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId: id,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(id, () => seedSystem(runtime));
  return runInTenant(id, async () => {
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const calendarProjectId = db(CALENDARS_MODULE_ID).ownerProjectItemId;
    if (!calendarProjectId) throw new Error("The calendars database has no owner project");
    const run = await createAgentRun(runtime, {
      projectItemId: calendarProjectId,
      userId: user.id,
      triggeredBy: "user",
      task: "calendar work",
    });
    return {
      id,
      userId: user.id,
      calendarProjectId,
      tasksId: db(TASKS_MODULE_ID).id,
      eventsId: db(EVENTS_MODULE_ID).id,
      calendarsId: db(CALENDARS_MODULE_ID).id,
      runId: run.id,
    };
  });
}

/** The tools the run of `tenant` is offered, approval-gated ones included, as an agent session resolves them. */
function toolsOf(
  tenant: Tenant,
  options: { includeApprovalGated?: boolean; projectItemId?: string; runId?: string } = {},
): Promise<ResolvedModuleAgentTool[]> {
  return runInTenant(tenant.id, () =>
    resolveModuleAgentToolsForRun(
      runtime,
      registry,
      options.runId ?? tenant.runId,
      options.projectItemId ?? tenant.calendarProjectId,
      undefined,
      { includeApprovalGated: options.includeApprovalGated ?? true },
    ),
  );
}

async function tool(tenant: Tenant, name: string): Promise<ResolvedModuleAgentTool> {
  const found = (await toolsOf(tenant)).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool ${name} is not offered`);
  return found;
}

/** Calls the tool of `tenant`'s run the way the approval executor does, inside the tenant. */
async function call(tenant: Tenant, name: string, args: unknown) {
  const resolved = await tool(tenant, name);
  return runInTenant(tenant.id, () => resolved.invoke(args));
}

/** A refused call: the error result, parsed. A call that was not refused fails the test. */
async function refused(tenant: Tenant, name: string, args: unknown) {
  const answer = await call(tenant, name, args);
  expect(answer.error).toBe(true);
  return refusalSchema.parse(JSON.parse(answer.result));
}

/** A refusal with the ids its message names blanked out: the ids are the only difference an unknown id may show. */
function withoutIds(answer: z.infer<typeof refusalSchema>) {
  return { ...answer, message: answer.message.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "ID") };
}

async function calendarNamed(tenant: Tenant, name: string): Promise<string> {
  const { items } = await runInTenant(tenant.id, () => cp.listItems(tenant.calendarsId, { limit: 50 }));
  const found = items.find((item) => item.properties.name === name);
  if (!found) throw new Error(`Missing calendar ${name}`);
  return found.id;
}

async function hide(tenant: Tenant, calendarId: string): Promise<void> {
  await runInTenant(tenant.id, () =>
    cp.updateItem({ databaseId: tenant.calendarsId, itemId: calendarId, propertiesPatch: { hidden: true } }),
  );
}

async function task(tenant: Tenant, properties: Record<string, unknown> = {}): Promise<string> {
  const item = await runInTenant(tenant.id, () =>
    cp.createItem({ databaseId: tenant.tasksId, properties: { name: "Task", ...properties } }),
  );
  return item.id;
}

/** An Event in `calendarId`, or in the default calendar when none is named. */
async function event(tenant: Tenant, calendarId?: string): Promise<string> {
  const properties = { name: "Event", date: "2026-10-16" };
  if (calendarId === undefined) {
    return (await runInTenant(tenant.id, () => cp.createItem({ databaseId: tenant.eventsId, properties }))).id;
  }
  const created = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      createEventInCalendar(client, { properties }, calendarId, {
        writer: { writerKind: "user" },
        actingUserId: tenant.userId,
        humanWriterUserId: tenant.userId,
      }),
    ),
  );
  return created.id;
}

async function invitation(tenant: Tenant, overrides: Record<string, unknown> = {}): Promise<string> {
  return runInTenant(tenant.id, async () => createInvitation(runtime, overrides, await calendarNamed(tenant, "Work")));
}

async function storedInvitation(id: string) {
  const { rows } = await admin.query("SELECT properties, updated_at FROM items WHERE id = $1", [id]);
  return z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.date() }).parse(rows[0]);
}

/** The Events written for invitations, trashed ones included. */
async function eventCount(tenant: Tenant): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tenant.eventsId]);
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

/** The queued replies to organizers, by invitation: what would leave as email once the job runs. */
async function queuedReplies(): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = $1", [
    REPLY_TASK,
  ]);
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

/** The route's own answer for the same answer to the same invitation: an answer equal to the stored one writes nothing. */
function routeRespond(tenant: Tenant, invitationId: string, body: unknown) {
  return runInTenant(tenant.id, () =>
    createRespondToInvitationRouteHandler(runtime)({
      params: { id: invitationId },
      body,
      identity: { user: { id: tenant.userId } },
    }),
  );
}

async function hostEventIds(tenant: Tenant, taskId: string): Promise<string[]> {
  // An event the task does not sit in: the remove route answers with the current list and writes nothing.
  const body = await runInTenant(tenant.id, () =>
    createTaskHostEventRemoveRouteHandler(runtime)({
      params: { id: taskId, eventId: randomUUID() },
      body: {},
      identity: { user: { id: tenant.userId } },
    }),
  );
  return hostEventsSchema.parse(body.body).hostEvents.map((entry) => entry.eventId);
}

/** What `agentSessionComposition` does for a gated call: file the `moduleTool` request. */
async function requestCall(tenant: Tenant, name: string, args: Record<string, unknown>): Promise<ApprovalRequest> {
  const resolved = await tool(tenant, name);
  return runInTenant(tenant.id, async () =>
    createModuleToolApprovalRequest(runtime, {
      agentRunId: tenant.runId,
      toolName: name,
      riskClass: resolved.riskClass,
      args,
      snapshotSha256: await resolved.snapshotOf(args),
      toolCallId: null,
    }),
  );
}

function approve(tenant: Tenant, requestId: string) {
  return runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: tenant.userId,
      }),
    ),
  );
}

function deliver(tenant: Tenant, requestId: string) {
  return runInTenant(tenant.id, () =>
    handleApprovalRequestExecuteTask(runtime, { approvalRequestId: requestId }, undefined, registry),
  );
}

async function reload(tenant: Tenant, requestId: string): Promise<ApprovalRequest> {
  const request = await runInTenant(tenant.id, () =>
    withTransaction(runtime, (client) => getApprovalRequest(client, requestId)),
  );
  if (!request) throw new Error("Request vanished");
  return request;
}

describe("calendar agent tools (issue gh-1957)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
    registry = await loadFullModuleRegistry();
    registerItemCreateHook(async ({ database, writer, humanWriterUserId }) => {
      if (database.ownerModuleId === EVENTS_MODULE_ID) seen.eventCreates.push({ writer, humanWriterUserId });
    });
    registerItemDeleteHook(async ({ database, writerKind, agentRunId }) => {
      if (database.ownerModuleId === EVENTS_MODULE_ID) seen.eventTrashes.push({ writerKind, agentRunId });
    });
    registerRelationEdgeChangedHook(async ({ op, writer, itemA, itemB }) => {
      seen.hostEventEdges.push({ op, writer, itemA, itemB });
    });
  });

  beforeEach(async () => {
    seen.eventCreates.length = 0;
    seen.eventTrashes.length = 0;
    seen.hostEventEdges.length = 0;
    await resetDatabase(admin);
    home = await seededTenant();
    foreign = await seededTenant();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("the declarations", () => {
    it("offers the three tools, each needing approval, to a run whose project owns the calendar databases", async () => {
      // The read tool `calendar.timeline` (issue gh-1952) needs no approval and has its own tests.
      const tools = (await toolsOf(home)).filter(
        (candidate) => candidate.name.startsWith("calendar.") && candidate.requiresApproval,
      );
      expect(tools.map((candidate) => [candidate.name, candidate.requiresApproval, candidate.riskClass])).toEqual([
        [RESPOND, true, "outbound"],
        [PLACE, true, "write"],
        [REMOVE, true, "write"],
      ]);
    });

    it("leaves them out for a caller that does not ask for approval-gated tools", async () => {
      const names = (await toolsOf(home, { includeApprovalGated: false })).map((candidate) => candidate.name);
      // The read tool `calendar.timeline` (issue gh-1952) needs no approval, so it is offered to such a caller.
      expect(names.filter((name) => name.startsWith("calendar.") && name !== "calendar.timeline")).toEqual([]);
    });

    it("leaves them out for a run whose project does not own the calendar databases", async () => {
      const other = await runInTenant(home.id, async () => {
        const databases = await cp.listDatabases();
        const projects = databases.find((row) => row.ownerModuleId === PROJECTS_MODULE_ID);
        if (!projects) throw new Error("Missing Projects");
        return cp.createItem({ databaseId: projects.id, properties: { name: "Other project" } });
      });
      const run = await runInTenant(home.id, () =>
        createAgentRun(runtime, {
          projectItemId: other.id,
          userId: home.userId,
          triggeredBy: "user",
          task: "other work",
        }),
      );
      const names = (await toolsOf(home, { projectItemId: other.id, runId: run.id })).map((entry) => entry.name);
      expect(names.filter((name) => name.startsWith("calendar."))).toEqual([]);
    });

    it("offers them over /mcp only to a credential whose list names calendar.write", async () => {
      const offered = (effective: string[]) =>
        runInTenant(home.id, () =>
          resolveModuleAgentToolsForRun(runtime, registry, home.runId, home.calendarProjectId, new Set(effective), {
            mcpExposure: true,
            includeApprovalGated: true,
          }),
        ).then((tools) => tools.map((entry) => entry.name).filter((name) => name.startsWith("calendar.")));

      expect(await offered(["core.item.read", "core.item.write", "calendar.write"])).toEqual([RESPOND, PLACE, REMOVE]);
      expect(await offered(["core.item.read", "core.item.write"])).toEqual([]);
    });

    it("refuses arguments the tool does not accept, before any handler runs", async () => {
      const resolved = await tool(home, PLACE);
      expect(resolved.acceptsArguments({ taskId: randomUUID(), eventId: randomUUID() })).toBe(true);
      expect(resolved.acceptsArguments({ taskId: "no", eventId: randomUUID() })).toBe(false);
      expect(resolved.acceptsArguments({ taskId: randomUUID(), eventId: randomUUID(), extra: true })).toBe(false);
      await expect(runInTenant(home.id, () => resolved.invoke({ taskId: "no" }))).rejects.toThrow(
        "Invalid tool arguments.",
      );
    });
  });

  describe(RESPOND, () => {
    it("answers the invitation and returns the invitation the route returns", async () => {
      const id = await invitation(home);
      const answer = await call(home, RESPOND, { invitationId: id, response: "accepted" });

      expect(answer.error).toBe(false);
      expect((await storedInvitation(id)).properties.status).toBe("accepted");
      // The route answers the same answer again with the stored invitation and writes nothing.
      const { item } = await routeRespond(home, id, { response: "accepted" });
      expect(JSON.parse(answer.result)).toEqual(JSON.parse(JSON.stringify(item)));
      expect(await eventCount(home)).toBe(1);
      expect(await queuedReplies()).toBe(1);
    });

    it("creates the Event in a hidden calendar when the answer names it", async () => {
      const id = await invitation(home);
      const hidden = await calendarNamed(home, "Personal");
      await hide(home, hidden);
      const answer = await call(home, RESPOND, { invitationId: id, response: "tentative", calendarId: hidden });

      expect(answer.error).toBe(false);
      const { items } = await runInTenant(home.id, () => cp.listItems(home.eventsId, { limit: 10 }));
      expect(items).toHaveLength(1);
      const edges = await runInTenant(home.id, () => cp.listItemRelations(items[0]!.id));
      expect((edges ?? []).filter((edge) => edge.propertyKey === "calendar").map((edge) => edge.targetItemId)).toEqual([
        hidden,
      ]);
      expect((await storedInvitation(id)).properties.status).toBe("tentative");
    });

    it("refuses what the route refuses and writes nothing", async () => {
      const id = await invitation(home);
      const before = await storedInvitation(id);
      const routeError = await routeRespond(home, id, { response: "acknowledged" }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(routeError).toMatchObject({ status: 400 });

      expect(await refused(home, RESPOND, { invitationId: id, response: "acknowledged" })).toMatchObject({
        status: 400,
        error: "validation_failed",
        field: "response",
      });
      expect(
        await refused(home, RESPOND, { invitationId: id, response: "accepted", calendarId: randomUUID() }),
      ).toMatchObject({ status: 400, field: "calendarId" });
      expect(await storedInvitation(id)).toEqual(before);
      expect(await eventCount(home)).toBe(0);
      expect(await queuedReplies()).toBe(0);
    });

    it("refuses an answer to a cancelled invitation with the route's conflict", async () => {
      const id = await invitation(home, { status: "cancelled" });
      expect(await refused(home, RESPOND, { invitationId: id, response: "accepted" })).toMatchObject({
        status: 409,
        error: "conflict",
      });
      expect(await queuedReplies()).toBe(0);
    });

    it("answers another tenant's invitation as it answers an unknown one", async () => {
      const foreignId = await invitation(foreign);
      const foreignBefore = await storedInvitation(foreignId);
      const foreignAnswer = await refused(home, RESPOND, { invitationId: foreignId, response: "accepted" });
      const unknownAnswer = await refused(home, RESPOND, { invitationId: randomUUID(), response: "accepted" });

      expect(foreignAnswer).toMatchObject({ status: 404, error: "not_found" });
      expect(withoutIds(foreignAnswer)).toEqual(withoutIds(unknownAnswer));
      expect(await storedInvitation(foreignId)).toEqual(foreignBefore);
      expect(await queuedReplies()).toBe(0);
    });

    it("files an approval request without answering, and answers exactly once after approval", async () => {
      const id = await invitation(home);
      const request = await requestCall(home, RESPOND, { invitationId: id, response: "accepted" });

      expect(request.status).toBe("pending");
      expect(request.riskClass).toBe("outbound");
      expect((await storedInvitation(id)).properties.status).toBe("pending");
      expect(await eventCount(home)).toBe(0);
      expect(await queuedReplies()).toBe(0);

      await approve(home, request.id);
      await deliver(home, request.id);
      await deliver(home, request.id);

      const settled = await reload(home, request.id);
      expect(settled.executionStatus).toBe("succeeded");
      expect(settled.executionError).toBe(false);
      const { item } = await routeRespond(home, id, { response: "accepted" });
      expect(JSON.parse(z.string().parse(settled.executionResult))).toEqual(JSON.parse(JSON.stringify(item)));
      expect((await storedInvitation(id)).properties.status).toBe("accepted");
      expect(await eventCount(home)).toBe(1);
      expect(await queuedReplies()).toBe(1);
    });

    it("records a refused approved call as a failed call and changes nothing", async () => {
      const id = await invitation(home);
      const request = await requestCall(home, RESPOND, { invitationId: id, response: "acknowledged" });
      await approve(home, request.id);
      await deliver(home, request.id);

      const settled = await reload(home, request.id);
      expect(settled.executionStatus).toBe("conflict");
      expect(settled.executionError).toBe(true);
      expect((await storedInvitation(id)).properties.status).toBe("pending");
      expect(await queuedReplies()).toBe(0);
    });
  });

  describe(`${PLACE} and ${REMOVE}`, () => {
    it("puts a task into an event and takes it out, answering the route's body", async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      const put = await call(home, PLACE, { taskId, eventId });

      expect(put.error).toBe(false);
      const placed = hostEventsSchema.parse(JSON.parse(put.result));
      expect(placed.taskId).toBe(taskId);
      expect(placed.hostEvents.map((entry) => entry.eventId)).toEqual([eventId]);
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);

      const removed = await call(home, REMOVE, { taskId, eventId });
      expect(removed.error).toBe(false);
      // The route answers a remove of an event the task is not in with the current list: the same body.
      const routeBody = await runInTenant(home.id, () =>
        createTaskHostEventRemoveRouteHandler(runtime)({
          params: { id: taskId, eventId },
          body: {},
          identity: { user: { id: home.userId } },
        }),
      );
      expect(JSON.parse(removed.result)).toEqual(routeBody.body);
      expect(JSON.parse(removed.result)).toEqual({ taskId, hostEvents: [] });
    });

    it("puts a task into an event of a hidden calendar and takes it out again", async () => {
      const hidden = await calendarNamed(home, "Personal");
      await hide(home, hidden);
      const [taskId, eventId] = [await task(home), await event(home, hidden)];

      expect((await call(home, PLACE, { taskId, eventId })).error).toBe(false);
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);
      expect((await call(home, REMOVE, { taskId, eventId })).error).toBe(false);
      expect(await hostEventIds(home, taskId)).toEqual([]);
    });

    it("refuses the placement the route refuses: an event in the Trash", async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      const trashed = await runInTenant(home.id, () => cp.softDeleteItem(home.eventsId, eventId));
      if (!trashed) throw new Error("The event was not trashed");
      const routeError = await runInTenant(home.id, () =>
        createTaskHostEventPutRouteHandler(runtime)({
          params: { id: taskId, eventId },
          body: {},
          identity: { user: { id: home.userId } },
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(routeError).toMatchObject({ status: 404 });

      expect(await refused(home, PLACE, { taskId, eventId })).toMatchObject({ status: 404, error: "not_found" });
      expect(await hostEventIds(home, taskId)).toEqual([]);
    });

    it.each([PLACE, REMOVE])("%s answers another tenant's ids as it answers unknown ones", async (name) => {
      const [foreignTask, foreignEvent] = [await task(foreign), await event(foreign)];
      const [ownTask, ownEvent] = [await task(home), await event(home)];

      const foreignTaskAnswer = await refused(home, name, { taskId: foreignTask, eventId: ownEvent });
      const unknownTaskAnswer = await refused(home, name, { taskId: randomUUID(), eventId: ownEvent });
      expect(foreignTaskAnswer).toMatchObject({ status: 404, error: "not_found" });
      expect(withoutIds(foreignTaskAnswer)).toEqual(withoutIds(unknownTaskAnswer));
      expect(await hostEventIds(foreign, foreignTask)).toEqual([]);

      if (name === PLACE) {
        const foreignEventAnswer = await refused(home, PLACE, { taskId: ownTask, eventId: foreignEvent });
        const unknownEventAnswer = await refused(home, PLACE, { taskId: ownTask, eventId: randomUUID() });
        expect(foreignEventAnswer).toMatchObject({ status: 404, error: "not_found" });
        expect(withoutIds(foreignEventAnswer)).toEqual(withoutIds(unknownEventAnswer));
        expect(await hostEventIds(home, ownTask)).toEqual([]);
      }
    });

    it("files an approval request without changing the task, and places it once after approval", async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      const request = await requestCall(home, PLACE, { taskId, eventId });

      expect(request.status).toBe("pending");
      expect(await hostEventIds(home, taskId)).toEqual([]);

      await approve(home, request.id);
      await deliver(home, request.id);
      await deliver(home, request.id);

      expect((await reload(home, request.id)).executionStatus).toBe("succeeded");
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);
    });

    it("files an approval request without changing the task, and takes it out after approval", async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      expect((await call(home, PLACE, { taskId, eventId })).error).toBe(false);
      const request = await requestCall(home, REMOVE, { taskId, eventId });

      expect(await hostEventIds(home, taskId)).toEqual([eventId]);

      await approve(home, request.id);
      await deliver(home, request.id);

      expect((await reload(home, request.id)).executionStatus).toBe("succeeded");
      expect(await hostEventIds(home, taskId)).toEqual([]);
    });
  });
  describe("who the writes are recorded as", () => {
    /** The writer of an approved call: the agent of the run, on behalf of its user, and no human writer. */
    const agentOfRun = (tenant: Tenant): WriterIdentity => ({
      writerKind: "agent",
      agentRunId: tenant.runId,
      agentProjectItemId: tenant.calendarProjectId,
      onBehalfOfUserId: tenant.userId,
    });

    it(`${RESPOND} writes the Event as the agent of the run, with no human writer`, async () => {
      const id = await invitation(home);
      expect((await call(home, RESPOND, { invitationId: id, response: "accepted" })).error).toBe(false);

      expect(seen.eventCreates).toEqual([{ writer: agentOfRun(home), humanWriterUserId: undefined }]);
    });

    it(`${RESPOND} trashes the Event it declines as the agent of the run`, async () => {
      const id = await invitation(home);
      expect((await call(home, RESPOND, { invitationId: id, response: "accepted" })).error).toBe(false);
      expect((await call(home, RESPOND, { invitationId: id, response: "declined" })).error).toBe(false);

      expect(seen.eventTrashes).toEqual([{ writerKind: "agent", agentRunId: home.runId }]);
    });

    it(`${PLACE} and ${REMOVE} write the hostEvents edge as the agent of the run, also after an approval`, async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      const place = await requestCall(home, PLACE, { taskId, eventId });
      await approve(home, place.id);
      await deliver(home, place.id);
      expect((await reload(home, place.id)).executionStatus).toBe("succeeded");
      expect((await call(home, REMOVE, { taskId, eventId })).error).toBe(false);

      const edges = seen.hostEventEdges.filter((edge) => [edge.itemA, edge.itemB].includes(taskId));
      expect(edges.map((edge) => [edge.op, edge.writer])).toEqual([
        ["create", agentOfRun(home)],
        ["delete", agentOfRun(home)],
      ]);
    });

    it("leaves the routes' own writes recorded as the user", async () => {
      const id = await invitation(home);
      await routeRespond(home, id, { response: "accepted" });
      const answered = [...seen.eventCreates];
      const [taskId, eventId] = [await task(home), await event(home)];
      await runInTenant(home.id, () =>
        createTaskHostEventPutRouteHandler(runtime)({
          params: { id: taskId, eventId },
          body: undefined,
          identity: { user: { id: home.userId } },
        }),
      );

      expect(answered).toEqual([{ writer: { writerKind: "user" }, humanWriterUserId: home.userId }]);
      expect(seen.hostEventEdges.find((edge) => edge.itemA === taskId || edge.itemB === taskId)?.writer).toEqual({
        writerKind: "user",
      });
    });

    it("refuses a run that has no project and writes nothing", async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      const resolved = await tool(home, PLACE);
      await admin.query("UPDATE agent_runs SET project_item_id = NULL WHERE id = $1", [home.runId]);
      const answer = await runInTenant(home.id, () => resolved.invoke({ taskId, eventId }));

      expect(answer.error).toBe(true);
      expect(JSON.parse(answer.result)).toMatchObject({ status: 403 });
      expect(seen.hostEventEdges.filter((edge) => edge.itemA === taskId || edge.itemB === taskId)).toEqual([]);
    });
  });
  describe("a human /mcp session (the human handlers)", () => {
    /** The writer of a session's call: an agent for the user with the external-client marker, and no run or project. */
    const agentOfSession = (tenant: Tenant): WriterIdentity => ({
      writerKind: "agent",
      externalClient: true,
      onBehalfOfUserId: tenant.userId,
    });

    async function sessionTools(tenant: Tenant): Promise<ResolvedHumanModuleAgentTool[]> {
      return runInTenant(tenant.id, () => resolveModuleAgentToolsForUser(runtime, registry, tenant.userId, {}));
    }

    async function sessionCall(tenant: Tenant, name: string, args: unknown) {
      const found = (await sessionTools(tenant)).find((candidate) => candidate.name === name);
      if (!found) throw new Error(`Tool ${name} is not offered to a session`);
      return runInTenant(tenant.id, () => found.invoke(args));
    }

    async function requestCount(tenant: Tenant): Promise<number> {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM approval_requests WHERE tenant_id = $1", [
        tenant.id,
      ]);
      return z.object({ n: z.number() }).parse(rows[0]).n;
    }

    it("offers the three tools although each requires approval of a run, and carries no approval flag", async () => {
      const tools = (await sessionTools(home)).filter(
        (candidate) => candidate.name.startsWith("calendar.") && candidate.name !== "calendar.timeline",
      );
      expect(tools.map((candidate) => candidate.name)).toEqual([RESPOND, PLACE, REMOVE]);
      for (const candidate of tools) expect(candidate).not.toHaveProperty("requiresApproval");
    });

    it(`${RESPOND} answers at once as the user, files no request, and returns the route's invitation`, async () => {
      const id = await invitation(home);
      const answer = await sessionCall(home, RESPOND, { invitationId: id, response: "accepted" });

      expect(answer.error).toBe(false);
      expect((await storedInvitation(id)).properties.status).toBe("accepted");
      expect(await queuedReplies()).toBe(1);
      expect(await requestCount(home)).toBe(0);
      const { item } = await routeRespond(home, id, { response: "accepted" });
      expect(JSON.parse(answer.result)).toEqual(JSON.parse(JSON.stringify(item)));
      expect(seen.eventCreates).toEqual([{ writer: agentOfSession(home), humanWriterUserId: undefined }]);
    });

    it("refuses the arguments the schema does not accept before any write", async () => {
      await expect(sessionCall(home, RESPOND, { invitationId: "no", response: "accepted" })).rejects.toThrow(
        "Invalid tool arguments.",
      );
      expect(await requestCount(home)).toBe(0);
      expect(await queuedReplies()).toBe(0);
    });

    it(`${RESPOND} answers another tenant's invitation as an unknown one and writes nothing`, async () => {
      const foreignId = await invitation(foreign);
      const answer = await sessionCall(home, RESPOND, { invitationId: foreignId, response: "accepted" });

      expect(answer.error).toBe(true);
      expect(JSON.parse(answer.result)).toMatchObject({ status: 404 });
      expect((await storedInvitation(foreignId)).properties.status).toBe("pending");
      expect(await queuedReplies()).toBe(0);
    });

    it(`${PLACE} and ${REMOVE} change the relation at once, written as the agent of the session`, async () => {
      const [taskId, eventId] = [await task(home), await event(home)];
      const placed = await sessionCall(home, PLACE, { taskId, eventId });
      expect(placed.error).toBe(false);
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);
      const removed = await sessionCall(home, REMOVE, { taskId, eventId });
      expect(JSON.parse(removed.result)).toEqual({ taskId, hostEvents: [] });

      const edges = seen.hostEventEdges.filter((edge) => [edge.itemA, edge.itemB].includes(taskId));
      expect(edges.map((edge) => [edge.op, edge.writer])).toEqual([
        ["create", agentOfSession(home)],
        ["delete", agentOfSession(home)],
      ]);
      expect(await requestCount(home)).toBe(0);
    });

    it(`${PLACE} refuses another tenant's task as the route does`, async () => {
      const own = await event(home);
      const other = await task(foreign);
      const answer = await sessionCall(home, PLACE, { taskId: other, eventId: own });

      expect(answer.error).toBe(true);
      expect(JSON.parse(answer.result)).toMatchObject({ status: 404 });
      expect(await hostEventIds(foreign, other)).toEqual([]);
    });
  });
});
