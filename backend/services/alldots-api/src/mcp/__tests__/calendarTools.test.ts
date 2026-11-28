import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { ModuleRegistry } from "@alldots/module-registry";
import { createGenericOperationGateway } from "@alldots/application";
import { CORE_TASK_NAMES, runOnce } from "@alldots/queue";
import { CAPABILITY_IDS, runInTenant } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import {
  CALENDAR_MODULE_ID,
  createActionRegistry,
  createChokePoint,
  createCoreTaskList,
  createItemWithClient,
  createRespondToInvitationRouteHandler,
  createUser,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  hashPassword,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
  type ApprovalRequest,
} from "@alldots/data";
import { createMcpRequestListener } from "../mcpHandler.js";

/**
 * A run credential of a calendar-owning project lists them; a call files a `moduleTool` approval
 * request and answers -32001 without running the handler, and the approved request runs it once. A
 * credential not naming `calendar.write`, a project without the databases and an unknown name get
 * the same -32601. A human session runs them as its user, without a request.
 */

const calendarManifestHref = new URL(
  "../../../../../packages/data/src/calendar/calendarModuleManifest.js",
  import.meta.url,
).href;
const REPLY_TASK = "calendarSendInvitationReply";
const PASSWORD = "mcp-test-password";
const metadata = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const rpcBodySchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
const approvalDataSchema = z.object({ approvalRequestId: z.string(), link: z.string() });
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean(),
});
const toolListSchema = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })) });

interface Tenant {
  id: string;
  userId: string;
  email: string;
  calendarProjectId: string;
  otherProjectId: string;
  tasksId: string;
  eventsId: string;
  invitationsId: string;
  /**
   * In the calendar-owning project: one naming `calendar.write` with the item capabilities, one
   * restricted to reading items, one that may write items but does not name it. In another project:
   * one that names it.
   */
  calendarToken: string;
  readOnlyCalendarToken: string;
  noCalendarCapabilityToken: string;
  otherToken: string;
}

let admin: Pool;
let pool: Pool;
let server: Server;
let url: string;
let registry: ModuleRegistry;
let home: Tenant;
let foreign: Tenant;

async function seededTenant(): Promise<Tenant> {
  const id = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, {
    tenantId: id,
    email,
    passwordHash: await hashPassword(PASSWORD),
    locale: "en",
  });
  return runInTenant(id, async () => {
    await seedSystem(pool);
    const chokePoint = createChokePoint(pool);
    const databases = await chokePoint.listDatabases();
    const database = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const calendarProjectId = database("calendars").ownerProjectItemId;
    if (!calendarProjectId) throw new Error("The calendars database has no owner project");
    const other = await chokePoint.createItem({ databaseId: database("projects").id, properties: { name: "Other" } });
    const mint = (
      projectItemId: string,
      capabilities: string[] = ["core.item.read", "core.item.write", "calendar.write"],
    ) =>
      withTransaction(pool, (client) =>
        mintMcpRunCredential(client, {
          projectItemId,
          capabilities,
          moduleCapabilityIds: ["calendar.write"],
          userId: user.id,
        }),
      );
    return {
      id,
      userId: user.id,
      email,
      calendarProjectId,
      otherProjectId: other.id,
      tasksId: database("tasks").id,
      eventsId: database("events").id,
      invitationsId: database("invitations").id,
      calendarToken: (await mint(calendarProjectId)).token,
      readOnlyCalendarToken: (await mint(calendarProjectId, ["core.item.read"])).token,
      noCalendarCapabilityToken: (await mint(calendarProjectId, ["core.item.read", "core.item.write"])).token,
      otherToken: (await mint(other.id)).token,
    };
  });
}

async function rpc(token: string, method: string, params?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return rpcBodySchema.parse(await response.json());
}

async function toolNames(token: string): Promise<string[]> {
  return toolListSchema.parse((await rpc(token, "tools/list")).result).tools.map((tool) => tool.name);
}

const callTool = (token: string, name: string, args: unknown) => rpc(token, "tools/call", { name, arguments: args });

/** The id of the approval request a gated call filed. */
function requestIdOf(answer: z.infer<typeof rpcBodySchema>): string {
  expect(answer.error?.code).toBe(-32001);
  return approvalDataSchema.parse(answer.error?.data).approvalRequestId;
}

async function invitation(tenant: Tenant): Promise<string> {
  const keys = [
    "title",
    "startsAt",
    "endsAt",
    "allDay",
    "organizerEmail",
    "status",
    "kind",
    "uid",
    "sequence",
    "respondedAt",
  ] as const;
  // Raw write as the calendar module: the invitation ingest is the only production writer of such a
  // row.
  const created = await runInTenant(tenant.id, () =>
    withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: tenant.invitationsId,
          properties: {
            title: "Sprint review",
            startsAt: "2026-10-22T11:00:00.000Z",
            endsAt: "2026-10-22T12:00:00.000Z",
            allDay: false,
            status: "pending",
            kind: "invite",
            uid: `${randomUUID()}@example.test`,
            sequence: 0,
          },
        },
        { allowedSystemKeys: keys, systemOwnerProcess: CALENDAR_MODULE_ID },
      ),
    ),
  );
  return created.id;
}

async function statusOf(invitationId: string): Promise<unknown> {
  const { rows } = await admin.query("SELECT properties FROM items WHERE id = $1", [invitationId]);
  return z.object({ properties: z.record(z.string(), z.unknown()) }).parse(rows[0]).properties.status;
}

async function queuedReplies(): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = $1", [
    REPLY_TASK,
  ]);
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

async function requestCount(tenant: Tenant): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM approval_requests WHERE tenant_id = $1", [
    tenant.id,
  ]);
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

async function reload(tenant: Tenant, requestId: string): Promise<ApprovalRequest> {
  const request = await runInTenant(tenant.id, () =>
    withTransaction(pool, (client) => getApprovalRequest(client, requestId)),
  );
  if (!request) throw new Error("Request vanished");
  return request;
}

async function approveAndRun(tenant: Tenant, requestId: string): Promise<void> {
  await runInTenant(tenant.id, () =>
    withTransaction(pool, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: tenant.userId,
      }),
    ),
  );
  const handler = createCoreTaskList(pool, createActionRegistry(), undefined, undefined, undefined, registry)[
    CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE
  ];
  if (!handler) throw new Error("Missing approval handler");
  await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handler } });
}

async function hostEventIds(tenant: Tenant, taskId: string): Promise<string[]> {
  const edges = await runInTenant(tenant.id, () => createChokePoint(pool).listItemRelations(taskId));
  return (edges ?? []).filter((edge) => edge.propertyKey === "hostEvents").map((edge) => edge.targetItemId);
}

async function taskAndEvent(tenant: Tenant): Promise<{ taskId: string; eventId: string }> {
  return runInTenant(tenant.id, async () => {
    const chokePoint = createChokePoint(pool);
    const task = await chokePoint.createItem({ databaseId: tenant.tasksId, properties: { name: "Task" } });
    const event = await chokePoint.createItem({
      databaseId: tenant.eventsId,
      properties: { name: "Event", date: "2026-10-16" },
    });
    return { taskId: task.id, eventId: event.id };
  });
}

describe("calendar write tools over POST /mcp (issue gh-1957)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "alldots_data");
    registry = new ModuleRegistry(() => new Set(["calendar"]));
    await registry.loadModule(calendarManifestHref);
    server = createServer(
      await createMcpRequestListener(
        pool,
        createGenericOperationGateway(pool, metadata),
        new Set(CAPABILITY_IDS),
        registry,
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    home = await seededTenant();
    foreign = await seededTenant();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });

  describe("listing", () => {
    it("lists the three tools, with their schemas, for a run credential of the calendar project", async () => {
      const list = toolListSchema.parse((await rpc(home.calendarToken, "tools/list")).result);
      const calendar = list.tools.filter((tool) => tool.name.startsWith("alldots.calendar."));
      expect(calendar.map((tool) => tool.name).sort()).toEqual([
        "alldots.calendar.placeTaskInEvent",
        "alldots.calendar.removeTaskFromEvent",
        "alldots.calendar.respondToInvitation",
      ]);
      for (const tool of calendar) expect(tool.inputSchema).toMatchObject({ type: "object" });
    });

    it.each([
      ["a credential restricted to a read capability", (tenant: Tenant) => tenant.readOnlyCalendarToken],
      [
        "a credential of the calendar project that may write items but does not name calendar.write",
        (tenant: Tenant) => tenant.noCalendarCapabilityToken,
      ],
    ])("lists none of them for %s", async (_name, tokenOf) => {
      expect((await toolNames(tokenOf(home))).filter((name) => name.startsWith("alldots.calendar."))).toEqual([]);
    });

    it("lists none of them for a run credential of a project without the calendar databases", async () => {
      expect((await toolNames(home.otherToken)).filter((name) => name.startsWith("alldots.calendar."))).toEqual([]);
    });

    it("lists the three tools for a human session", async () => {
      const session = await login(admin, { email: home.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      // The read tool is listed too and has its own tests.
      expect(
        (await toolNames(session.token))
          .filter((name) => name.startsWith("alldots.calendar.") && name !== "alldots.calendar.timeline")
          .sort(),
      ).toEqual([
        "alldots.calendar.placeTaskInEvent",
        "alldots.calendar.removeTaskFromEvent",
        "alldots.calendar.respondToInvitation",
      ]);
    });
  });

  describe("an ungranted or unknown tool", () => {
    it("answers a call from a project without the grant exactly as it answers an unknown tool, and files nothing", async () => {
      const { taskId, eventId } = await taskAndEvent(home);
      const ungranted = await callTool(home.otherToken, "alldots.calendar.placeTaskInEvent", { taskId, eventId });
      const unknown = await callTool(home.otherToken, "alldots.calendar.unknownTool", { taskId, eventId });

      expect(ungranted.error?.code).toBe(-32601);
      expect(ungranted.error?.message.replace("placeTaskInEvent", "NAME")).toBe(
        unknown.error?.message.replace("unknownTool", "NAME"),
      );
      expect(await requestCount(home)).toBe(0);
      expect(await hostEventIds(home, taskId)).toEqual([]);
    });

    it.each([
      ["a read-restricted credential", (tenant: Tenant) => tenant.readOnlyCalendarToken],
      [
        "a credential that does not name calendar.write, whatever the project holds",
        (tenant: Tenant) => tenant.noCalendarCapabilityToken,
      ],
    ])("answers a call from %s as an unknown tool, and files no request or notification", async (_name, tokenOf) => {
      const { taskId, eventId } = await taskAndEvent(home);
      const token = tokenOf(home);
      const restricted = await callTool(token, "alldots.calendar.placeTaskInEvent", { taskId, eventId });
      const unknown = await callTool(token, "alldots.calendar.unknownTool", { taskId, eventId });

      expect(restricted.error?.code).toBe(-32601);
      expect(restricted.error?.message.replace("placeTaskInEvent", "NAME")).toBe(
        unknown.error?.message.replace("unknownTool", "NAME"),
      );
      expect(await requestCount(home)).toBe(0);
      expect(await hostEventIds(home, taskId)).toEqual([]);
    });
  });

  describe("a human session", () => {
    async function sessionToken(): Promise<string> {
      return (await login(admin, { email: home.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" })).token;
    }

    it("answers an invitation as the user at once: no approval request, and the reply is queued exactly once", async () => {
      const id = await invitation(home);
      const answer = await callTool(await sessionToken(), "alldots.calendar.respondToInvitation", {
        invitationId: id,
        response: "accepted",
      });

      expect(answer.error).toBeUndefined();
      expect(toolResultSchema.parse(answer.result).isError).toBe(false);
      expect(await requestCount(home)).toBe(0);
      expect(await statusOf(id)).toBe("accepted");
      expect(await queuedReplies()).toBe(1);
    });

    it("places a task into an event and takes it out as the user, with no approval request", async () => {
      const { taskId, eventId } = await taskAndEvent(home);
      const token = await sessionToken();

      expect(
        toolResultSchema.parse((await callTool(token, "alldots.calendar.placeTaskInEvent", { taskId, eventId })).result)
          .isError,
      ).toBe(false);
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);
      await callTool(token, "alldots.calendar.removeTaskFromEvent", { taskId, eventId });
      expect(await hostEventIds(home, taskId)).toEqual([]);
      expect(await requestCount(home)).toBe(0);
    });

    it("answers a refusal of the route as an error result and changes nothing", async () => {
      const own = await taskAndEvent(home);
      const other = await taskAndEvent(foreign);
      const answer = await callTool(await sessionToken(), "alldots.calendar.placeTaskInEvent", {
        taskId: other.taskId,
        eventId: own.eventId,
      });

      expect(toolResultSchema.parse(answer.result).isError).toBe(true);
      expect(await hostEventIds(foreign, other.taskId)).toEqual([]);
    });

    it("answers -32602 for arguments the schema does not accept, and writes nothing", async () => {
      const answer = await callTool(await sessionToken(), "alldots.calendar.placeTaskInEvent", {
        taskId: "no",
        eventId: randomUUID(),
      });
      expect(answer.error?.code).toBe(-32602);
      expect(await requestCount(home)).toBe(0);
    });

    it("answers an unknown tool name as method not found", async () => {
      const answer = await callTool(await sessionToken(), "alldots.calendar.unknownTool", {});
      expect(answer.error?.code).toBe(-32601);
    });
  });

  describe("calendar.respondToInvitation", () => {
    it("files an approval request, answers -32001 and sends nothing; the approved request answers exactly once", async () => {
      const id = await invitation(home);
      const answer = await callTool(home.calendarToken, "alldots.calendar.respondToInvitation", {
        invitationId: id,
        response: "accepted",
      });

      const requestId = requestIdOf(answer);
      expect(approvalDataSchema.parse(answer.error?.data).link).toBe(`?page=approvals&id=${requestId}`);
      const request = await reload(home, requestId);
      expect(request).toMatchObject({
        toolName: "calendar.respondToInvitation",
        status: "pending",
        riskClass: "outbound",
        payload: { moduleToolName: "calendar.respondToInvitation", args: { invitationId: id, response: "accepted" } },
      });
      expect(await statusOf(id)).toBe("pending");
      expect(await queuedReplies()).toBe(0);

      await approveAndRun(home, requestId);
      await approveAndRun(home, requestId);

      expect(await statusOf(id)).toBe("accepted");
      expect(await queuedReplies()).toBe(1);
      const settled = await reload(home, requestId);
      expect(settled.executionStatus).toBe("succeeded");
      // The route answers the same again with the stored invitation and writes nothing.
      const { item } = await runInTenant(home.id, () =>
        createRespondToInvitationRouteHandler(pool)({
          params: { id },
          body: { response: "accepted" },
          identity: { user: { id: home.userId } },
        }),
      );
      expect(JSON.parse(z.string().parse(settled.executionResult))).toEqual(JSON.parse(JSON.stringify(item)));
    });

    it("applies the validation of the route when the approved request runs, and changes nothing", async () => {
      const id = await invitation(home);
      const requestId = requestIdOf(
        await callTool(home.calendarToken, "alldots.calendar.respondToInvitation", {
          invitationId: id,
          response: "acknowledged",
        }),
      );

      await approveAndRun(home, requestId);

      expect(await reload(home, requestId)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await statusOf(id)).toBe("pending");
      expect(await queuedReplies()).toBe(0);
    });

    it("does not reach another tenant's invitation, which the route answers as an unknown one", async () => {
      const foreignId = await invitation(foreign);
      const requestId = requestIdOf(
        await callTool(home.calendarToken, "alldots.calendar.respondToInvitation", {
          invitationId: foreignId,
          response: "accepted",
        }),
      );

      await approveAndRun(home, requestId);

      expect(await reload(home, requestId)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await statusOf(foreignId)).toBe("pending");
      expect(await queuedReplies()).toBe(0);
    });

    it.each([
      ["a malformed id", { invitationId: "not-a-uuid", response: "accepted" }],
      ["an unknown answer", { invitationId: randomUUID(), response: "maybe" }],
      ["an unknown key", { invitationId: randomUUID(), response: "accepted", extra: true }],
      ["arguments that are not an object", "accepted"],
    ])("answers -32602 and files nothing for %s", async (_name, args) => {
      const answer = await callTool(home.calendarToken, "alldots.calendar.respondToInvitation", args);
      expect(answer.error?.code).toBe(-32602);
      expect(await requestCount(home)).toBe(0);
    });
  });

  describe("calendar.placeTaskInEvent and calendar.removeTaskFromEvent", () => {
    it("files a request and changes nothing; the approved request places the task, and a second one takes it out", async () => {
      const { taskId, eventId } = await taskAndEvent(home);
      const placeId = requestIdOf(
        await callTool(home.calendarToken, "alldots.calendar.placeTaskInEvent", { taskId, eventId }),
      );
      expect(await reload(home, placeId)).toMatchObject({ toolName: "calendar.placeTaskInEvent", status: "pending" });
      expect(await hostEventIds(home, taskId)).toEqual([]);

      await approveAndRun(home, placeId);
      await approveAndRun(home, placeId);
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);
      expect((await reload(home, placeId)).executionStatus).toBe("succeeded");

      const removeId = requestIdOf(
        await callTool(home.calendarToken, "alldots.calendar.removeTaskFromEvent", { taskId, eventId }),
      );
      expect(await hostEventIds(home, taskId)).toEqual([eventId]);
      await approveAndRun(home, removeId);
      expect(await hostEventIds(home, taskId)).toEqual([]);
      expect(JSON.parse(z.string().parse((await reload(home, removeId)).executionResult))).toEqual({
        taskId,
        hostEvents: [],
      });
    });

    it("leaves another tenant's task untouched when the approved request names it", async () => {
      const own = await taskAndEvent(home);
      const other = await taskAndEvent(foreign);
      const requestId = requestIdOf(
        await callTool(home.calendarToken, "alldots.calendar.placeTaskInEvent", {
          taskId: other.taskId,
          eventId: own.eventId,
        }),
      );

      await approveAndRun(home, requestId);

      expect(await reload(home, requestId)).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(await hostEventIds(foreign, other.taskId)).toEqual([]);
    });

    it("answers -32602 and files nothing for a malformed id", async () => {
      const answer = await callTool(home.calendarToken, "alldots.calendar.placeTaskInEvent", {
        taskId: "no",
        eventId: randomUUID(),
      });
      expect(answer.error?.code).toBe(-32602);
      expect(await requestCount(home)).toBe(0);
    });
  });
});
