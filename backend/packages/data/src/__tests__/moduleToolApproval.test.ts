import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { canonicalizeJson, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../agentTools/moduleAgentTools.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { setInvalidationHook, setSempThreadInvalidationHook } from "../realtimeHook.js";
import { approvalConflictReason } from "../mcp/approvalConflictReason.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { handleApprovalRequestExecuteTask } from "../mcp/approvalRequestExecution.js";
import { getApprovalRequest, type ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { logger } from "../mcp/logger.js";
import { createModuleToolApprovalRequest } from "../mcp/moduleToolApprovalRequest.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";

const notificationControl = vi.hoisted(() => ({ fail: false }));
vi.mock("../notifications/approvalNotificationBody.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notifications/approvalNotificationBody.js")>();
  return {
    ...actual,
    approvalNotificationBody: (...args: Parameters<typeof actual.approvalNotificationBody>) => {
      if (notificationControl.fail) throw new Error("no body entry");
      return actual.approvalNotificationBody(...args);
    },
  };
});

const fixtureHref = new URL(
  "../../../module-registry/src/__tests__/fixtures/approvalGatedToolsModule.js",
  import.meta.url,
).href;

let admin: Pool;
let runtime: Pool;
let registry: ModuleRegistry;
let tenantA: string;
let tenantB: string;
const userByTenant = new Map<string, string>();
let approvalAnnouncements: Array<{ approvalRequestId: string; userId: string | undefined }>;
let threadAnnouncements: Array<{ tenantId: string; threadId: string }>;

/** What the fixture module's snapshot export returns for a thread titled `title`, hashed as the request stores it. */
const hashOfTitle = (title: string | null) => hashOf({ title });
const hashOf = (source: unknown) => createHash("sha256").update(canonicalizeJson(source), "utf8").digest("hex");

async function loadRegistry(active: ReadonlySet<string>): Promise<ModuleRegistry> {
  const loaded = new ModuleRegistry(() => active);
  await loaded.loadModule(fixtureHref);
  return loaded;
}

interface Fixture {
  tenant: string;
  userId: string;
  projectItemId: string;
  runId: string;
  threadId: string;
}

/** A run with a chat thread, owned by the tenant's user, as an agent session would hold it. */
async function createRunFixture(tenant: string, options: { project?: boolean } = {}): Promise<Fixture> {
  const userId = userByTenant.get(tenant);
  if (!userId) throw new Error("Missing user");
  const projectItemId = randomUUID();
  return runInTenant(tenant, async () => {
    // There is no production chat-thread creator on this tip.
    const thread = await runtime.query<{ id: string }>(
      "INSERT INTO semp_threads (kind, title) VALUES ('chat', 'T') RETURNING id",
    );
    const threadId = thread.rows[0]?.id;
    if (!threadId) throw new Error("Missing thread");
    const run = await createAgentRun(runtime, {
      triggeredBy: "user",
      task: "gated",
      userId,
      threadId,
      ...(options.project === false ? {} : { projectItemId }),
    });
    return { tenant, userId, projectItemId, runId: run.id, threadId };
  });
}

async function resolveTool(fixture: Fixture, name: string): Promise<ResolvedModuleAgentTool> {
  const tools = await runInTenant(fixture.tenant, () =>
    resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectItemId, undefined, {
      includeApprovalGated: true,
    }),
  );
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool ${name} was not resolved`);
  return tool;
}

/** What `agentSessionComposition` does for a gated tool call: read the snapshot, then create the request. */
async function requestCall(
  fixture: Fixture,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string | null = "call_1",
): Promise<ApprovalRequest> {
  const tool = await resolveTool(fixture, toolName);
  return runInTenant(fixture.tenant, async () =>
    createModuleToolApprovalRequest(runtime, {
      agentRunId: fixture.runId,
      toolName,
      riskClass: tool.riskClass,
      args,
      snapshotSha256: await tool.snapshotOf(args),
      toolCallId,
    }),
  );
}

/** Raw SQL: models the user editing the source (the thread title) outside the agent. */
async function setTitle(fixture: Fixture, title: string): Promise<void> {
  await admin.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [fixture.threadId, title]);
}

/** The source of the fixture tools; `T` plus one `+<value>` for every time a handler ran. */
async function titleOf(fixture: Fixture): Promise<string | null> {
  const { rows } = await admin.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [
    fixture.threadId,
  ]);
  return rows[0]?.title ?? null;
}

/**
 * Holds a row lock on the thread so that a handler's write to it waits: the handler of a delivery
 * is then verifiably still running. `release` ends the lock.
 */
async function holdThreadLock(fixture: Fixture): Promise<{ release: () => Promise<void> }> {
  const client = await admin.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM semp_threads WHERE id = $1 FOR UPDATE", [fixture.threadId]);
  return {
    async release() {
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

async function waitForBlockedWriter(): Promise<void> {
  await vi.waitFor(async () => {
    const { rows } = await admin.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted",
    );
    expect(rows[0]?.waiting).toBeGreaterThan(0);
  });
}

function decide(fixture: Fixture, requestId: string, decision: "approved" | "rejected") {
  return runInTenant(fixture.tenant, () =>
    withTransaction(runtime, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision,
        decidedByUserId: fixture.userId,
      }),
    ),
  );
}

/** `moduleRegistry` is the worker's registry: the loaded one by default, `null` for a worker that has none. */
function deliver(tenant: string, requestId: string, moduleRegistry: ModuleRegistry | null = registry) {
  return runInTenant(tenant, () =>
    handleApprovalRequestExecuteTask(runtime, { approvalRequestId: requestId }, undefined, moduleRegistry ?? undefined),
  );
}

async function reload(fixture: Fixture, requestId: string): Promise<ApprovalRequest> {
  const request = await runInTenant(fixture.tenant, () =>
    withTransaction(runtime, (client) => getApprovalRequest(client, requestId)),
  );
  if (!request) throw new Error("Request vanished");
  return request;
}

function outcomeMessages(fixture: Fixture) {
  return runInTenant(fixture.tenant, () =>
    runtime.query<{ system_key: string; system_params: unknown }>(
      "SELECT system_key, system_params FROM semp_messages WHERE thread_id = $1 AND system_key IS NOT NULL ORDER BY created_at, id",
      [fixture.threadId],
    ),
  );
}

async function approvedRequest(
  fixture: Fixture,
  toolName = "gated.apply",
  args: Record<string, unknown> = { value: "x" },
) {
  const request = await requestCall(fixture, toolName, args);
  await decide(fixture, request.id, "approved");
  return request;
}

describe("module tool approval requests (issue #1791)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    notificationControl.fail = false;
    registry = await loadRegistry(new Set(["gatedTools"]));
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(admin);
    userByTenant.clear();
    userByTenant.set(tenantA, (await createTenantZeroUser(admin)).id);
    userByTenant.set(
      tenantB,
      (await createUser(admin, { tenantId: tenantB, email: `${randomUUID()}@example.test`, passwordHash: "unused" }))
        .id,
    );
    approvalAnnouncements = [];
    threadAnnouncements = [];
    setInvalidationHook((event) => {
      if (event.scope === "approvalRequest")
        approvalAnnouncements.push({ approvalRequestId: event.approvalRequestId, userId: event.userId });
    });
    setSempThreadInvalidationHook((event) => threadAnnouncements.push(event));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setInvalidationHook(() => {});
    setSempThreadInvalidationHook(() => {});
  });

  describe("resolving the tools of a run", () => {
    it("offers a gated tool only when asked, and a gated tool without a declared risk class is unclassified", async () => {
      const fixture = await createRunFixture(tenantA);
      const names = (tools: ResolvedModuleAgentTool[]) => tools.map((tool) => tool.name);

      const direct = await runInTenant(tenantA, () =>
        resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectItemId),
      );
      const gated = await runInTenant(tenantA, () =>
        resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectItemId, undefined, {
          includeApprovalGated: true,
        }),
      );

      expect(names(direct)).toEqual(["gated.free"]);
      expect(direct[0]).toMatchObject({ requiresApproval: false, riskClass: "read" });
      expect(names(gated)).toEqual(["gated.apply", "gated.noSnapshot", "gated.noneApproval", "gated.free"]);
      expect(gated.find((tool) => tool.name === "gated.apply")).toMatchObject({
        requiresApproval: true,
        riskClass: "write",
      });
      expect(gated.find((tool) => tool.name === "gated.noSnapshot")).toMatchObject({
        requiresApproval: true,
        riskClass: "unclassified",
      });
    });

    it("hashes the canonical JSON of the snapshot, which stays with the source and changes with it", async () => {
      const fixture = await createRunFixture(tenantA);
      const tool = await resolveTool(fixture, "gated.apply");

      const first = await runInTenant(tenantA, () => tool.snapshotOf({ value: "x" }));
      const again = await runInTenant(tenantA, () => tool.snapshotOf({ value: "other argument" }));
      await setTitle(fixture, "T2");
      const changed = await runInTenant(tenantA, () => tool.snapshotOf({ value: "x" }));

      expect(first).toBe(hashOfTitle("T"));
      expect(again).toBe(first);
      expect(changed).toBe(hashOfTitle("T2"));
    });

    it("has no snapshot for a tool that declares none", async () => {
      const fixture = await createRunFixture(tenantA);
      const tool = await resolveTool(fixture, "gated.noSnapshot");
      expect(await runInTenant(tenantA, () => tool.snapshotOf({ value: "x" }))).toBeNull();
    });

    it("refuses to read the snapshot for arguments the tool does not accept", async () => {
      const fixture = await createRunFixture(tenantA);
      const tool = await resolveTool(fixture, "gated.apply");
      await expect(tool.snapshotOf({ value: 1 })).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a snapshot export that is not a function or does not return one", async () => {
      const fixture = await createRunFixture(tenantA);
      const definitions = await registry.getAgentToolDefinitions(new Set(), { includeApprovalGated: true });
      const apply = definitions.find((definition) => definition.name === "gated.apply");
      if (!apply) throw new Error("Fixture tool missing");
      const resolveWith = (snapshot: unknown) => {
        vi.spyOn(registry, "getAgentToolDefinitions").mockResolvedValue([{ ...apply, snapshot }]);
        return runInTenant(tenantA, () =>
          resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectItemId, undefined, {
            includeApprovalGated: true,
          }),
        );
      };

      await expect(resolveWith(5)).rejects.toThrow("Invalid module tool snapshot: gated.apply");
      const [tool] = await resolveWith(() => 5);
      await expect(tool?.snapshotOf({ value: "x" })).rejects.toThrow("Invalid module tool snapshot factory");
    });
  });

  describe("creating the request", () => {
    it("creates a pending moduleTool request that records the description, tool call and snapshot, and runs nothing", async () => {
      const fixture = await createRunFixture(tenantA);
      // Raw SQL: the thread must be older than the request to show that the request raises its activity.
      await admin.query("UPDATE semp_threads SET last_activity_at = now() - interval '1 day' WHERE id = $1", [
        fixture.threadId,
      ]);

      const request = await requestCall(fixture, "gated.apply", { value: "x" }, "call_42");

      expect(request).toMatchObject({
        agentRunId: fixture.runId,
        toolName: "gated.apply",
        riskClass: "write",
        status: "pending",
        executionStatus: "not_approved",
        toolCallId: "call_42",
        reason: null,
        payload: { moduleToolName: "gated.apply", args: { value: "x" } },
        resourceSnapshot: { kind: "module_tool", resourceId: "gated.apply", sha256: hashOfTitle("T") },
        description: { key: "approval.moduleTool", params: { toolName: "gated.apply" } },
      });
      expect(await titleOf(fixture)).toBe("T");
      const thread = await admin.query<{ fresh: boolean }>(
        "SELECT last_activity_at > now() - interval '1 hour' AS fresh FROM semp_threads WHERE id = $1",
        [fixture.threadId],
      );
      expect(thread.rows).toEqual([{ fresh: true }]);
      expect(approvalAnnouncements).toEqual([{ approvalRequestId: request.id, userId: fixture.userId }]);
      expect(threadAnnouncements).toEqual([{ tenantId: tenantA, threadId: fixture.threadId }]);
    });

    it("writes one approval_pending notification linked by source to the Semp chats page", async () => {
      const fixture = await createRunFixture(tenantA);

      const request = await requestCall(fixture, "gated.apply", { value: "secret-argument-value" });

      const rows = await admin.query<{
        user_id: string;
        kind: string;
        link_href: string | null;
        source_table: string;
        source_id: string;
        body: string | null;
      }>("SELECT user_id, kind, link_href, source_table, source_id, body FROM notifications");
      expect(rows.rows).toEqual([
        {
          user_id: fixture.userId,
          kind: "approval_pending",
          link_href: `?page=semp-chats&tab=semp&approvalRequestId=${request.id}`,
          source_table: "approval_requests",
          source_id: request.id,
          // The tenant user's locale is Czech by default: the body is the cs template filled with the tool name.
          body: expect.stringContaining("Spustit nástroj modulu „gated.apply“."),
        },
      ]);
      expect(JSON.stringify(rows.rows)).not.toContain("secret-argument-value");
    });

    it("creates a request for a tool without a snapshot with a null hash", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await requestCall(fixture, "gated.noSnapshot", { value: "x" });
      expect(request.resourceSnapshot).toEqual({ kind: "module_tool", resourceId: "gated.noSnapshot", sha256: null });
    });

    it("returns the existing request for a repeated tool call and writes and announces nothing again", async () => {
      const fixture = await createRunFixture(tenantA);
      const first = await requestCall(fixture, "gated.apply", { value: "x" }, "call_1");
      approvalAnnouncements.length = 0;
      threadAnnouncements.length = 0;

      const repeated = await requestCall(fixture, "gated.apply", { value: "x" }, "call_1");

      expect(repeated.id).toBe(first.id);
      const counts = await admin.query<{ requests: number; notifications: number }>(
        "SELECT (SELECT count(*)::int FROM approval_requests) AS requests, (SELECT count(*)::int FROM notifications) AS notifications",
      );
      expect(counts.rows).toEqual([{ requests: 1, notifications: 1 }]);
      expect(approvalAnnouncements).toEqual([]);
      expect(threadAnnouncements).toEqual([]);
    });

    it("creates separate requests for calls without a tool call id", async () => {
      const fixture = await createRunFixture(tenantA);
      const first = await requestCall(fixture, "gated.apply", { value: "x" }, null);
      const second = await requestCall(fixture, "gated.apply", { value: "x" }, null);
      expect(second.id).not.toBe(first.id);
    });

    it("rolls the request back with the notification when the notification cannot be written", async () => {
      const fixture = await createRunFixture(tenantA);
      notificationControl.fail = true;

      await expect(requestCall(fixture, "gated.apply", { value: "x" })).rejects.toThrow("no body entry");

      const counts = await admin.query<{ requests: number; notifications: number }>(
        "SELECT (SELECT count(*)::int FROM approval_requests) AS requests, (SELECT count(*)::int FROM notifications) AS notifications",
      );
      expect(counts.rows).toEqual([{ requests: 0, notifications: 0 }]);
      expect(approvalAnnouncements).toEqual([]);
    });
  });

  describe("executing an approved request", () => {
    it("runs the handler once after approval, records the outcome and posts and announces it", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture, "gated.apply", { value: "x" });
      approvalAnnouncements.length = 0;
      expect(await titleOf(fixture)).toBe("T");

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T+x");
      const settled = await reload(fixture, request.id);
      expect(settled).toMatchObject({
        status: "approved",
        executionStatus: "succeeded",
        executionError: false,
        executionResult: "applied x",
      });
      expect(settled.executedAt).not.toBeNull();
      expect((await outcomeMessages(fixture)).rows).toEqual([
        { system_key: "approval.outcome.executed", system_params: { toolName: "gated.apply" } },
      ]);
      expect(approvalAnnouncements).toEqual([{ approvalRequestId: request.id, userId: fixture.userId }]);
    });

    it("runs a tool without a snapshot, whose stored and current hashes are both null", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture, "gated.noSnapshot", { value: "y" });

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T+y");
      expect((await reload(fixture, request.id)).executionStatus).toBe("succeeded");
    });

    it("runs the handler once when the task is delivered twice", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);

      await deliver(tenantA, request.id);
      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T+x");
      expect((await outcomeMessages(fixture)).rows).toHaveLength(1);
      expect((await reload(fixture, request.id)).executionStatus).toBe("succeeded");
    });

    it("runs the handler once when a second delivery arrives while the first is still running", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);
      const lock = await holdThreadLock(fixture);

      const first = deliver(tenantA, request.id);
      try {
        await waitForBlockedWriter();
        await expect(deliver(tenantA, request.id)).rejects.toThrow("execution claim is still in flight");
      } finally {
        await lock.release();
      }
      await first;

      expect(await titleOf(fixture)).toBe("T+x");
      expect((await reload(fixture, request.id)).executionStatus).toBe("succeeded");
    });

    it("discards an outcome that arrives after another path settled the request", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);
      const warn = vi.spyOn(logger, "warn");
      const lock = await holdThreadLock(fixture);

      const first = deliver(tenantA, request.id);
      try {
        await waitForBlockedWriter();
        // Raw SQL: models the stale-claim sweep settling the row while the handler is still running.
        await admin.query("UPDATE approval_requests SET execution_status = 'conflict' WHERE id = $1", [request.id]);
      } finally {
        await lock.release();
      }
      await first;

      expect(await titleOf(fixture)).toBe("T+x");
      expect((await reload(fixture, request.id)).executionStatus).toBe("conflict");
      expect((await outcomeMessages(fixture)).rows).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { approvalRequestId: request.id },
        "Module tool approval outcome discarded: the request was already settled by another delivery",
      );
    });

    it("records a conflict and does not run the handler when the source changed after the request", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);
      await setTitle(fixture, "T2");

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T2");
      const settled = await reload(fixture, request.id);
      expect(settled.executionStatus).toBe("conflict");
      expect(settled.executionError).toBe(true);
      expect(approvalConflictReason(settled.executionStatus, settled.executionResult)).toEqual({
        key: "approval.conflict.changed",
      });
      expect((await outcomeMessages(fixture)).rows).toEqual([
        { system_key: "approval.outcome.conflict", system_params: { toolName: "gated.apply" } },
      ]);
    });

    it("records a conflict when the tool gained or lost a snapshot since the request", async () => {
      const fixture = await createRunFixture(tenantA);
      const create = (toolName: string, snapshotSha256: string | null, toolCallId: string) =>
        runInTenant(tenantA, () =>
          createModuleToolApprovalRequest(runtime, {
            agentRunId: fixture.runId,
            toolName,
            riskClass: "write",
            args: { value: "x" },
            snapshotSha256,
            toolCallId,
          }),
        );
      // `gated.apply` declares a snapshot now but the request was made without one, and `gated.noSnapshot`
      // declares none now but the request carries a hash.
      const gained = await create("gated.apply", null, "gained");
      const lost = await create("gated.noSnapshot", hashOfTitle("T"), "lost");
      await decide(fixture, gained.id, "approved");
      await decide(fixture, lost.id, "approved");

      await deliver(tenantA, gained.id);
      await deliver(tenantA, lost.id);

      expect(await titleOf(fixture)).toBe("T");
      expect((await reload(fixture, gained.id)).executionStatus).toBe("conflict");
      expect((await reload(fixture, lost.id)).executionStatus).toBe("conflict");
    });

    it("never runs the handler for a rejected request, also when the task is delivered", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await requestCall(fixture, "gated.apply", { value: "x" });
      await decide(fixture, request.id, "rejected");

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T");
      expect(await reload(fixture, request.id)).toMatchObject({
        status: "rejected",
        executionStatus: "not_approved",
        executedAt: null,
      });
      expect((await outcomeMessages(fixture)).rows).toEqual([
        { system_key: "approval.outcome.rejected", system_params: { toolName: "gated.apply" } },
      ]);
    });

    it("never runs the handler for a request that is still pending", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await requestCall(fixture, "gated.apply", { value: "x" });

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T");
      expect(await reload(fixture, request.id)).toMatchObject({ status: "pending", executionStatus: "not_approved" });
    });

    it("records an error outcome and runs nothing when the tool is no longer registered", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);

      await deliver(tenantA, request.id, await loadRegistry(new Set()));

      expect(await titleOf(fixture)).toBe("T");
      const settled = await reload(fixture, request.id);
      expect(settled).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(approvalConflictReason(settled.executionStatus, settled.executionResult)).toEqual({
        key: "approval.conflict.toolUnavailable",
      });
      expect((await outcomeMessages(fixture)).rows.map((row) => row.system_key)).toEqual(["approval.outcome.conflict"]);
    });

    it("records an error outcome and runs nothing when the worker has no module registry", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);

      await deliver(tenantA, request.id, null);

      expect(await titleOf(fixture)).toBe("T");
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
    });

    it("records an error outcome and runs nothing when the requesting run has no project", async () => {
      const fixture = await createRunFixture(tenantA, { project: false });
      const request = await runInTenant(tenantA, () =>
        createModuleToolApprovalRequest(runtime, {
          agentRunId: fixture.runId,
          toolName: "gated.apply",
          riskClass: "write",
          args: { value: "x" },
          snapshotSha256: hashOfTitle("T"),
          toolCallId: "call_1",
        }),
      );
      await decide(fixture, request.id, "approved");

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T");
      expect(await reload(fixture, request.id)).toMatchObject({ executionStatus: "conflict", executionError: true });
    });

    it("records the handler's own error result as a failed outcome", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture, "gated.apply", { value: "x", mode: "errorResult" });

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T+x");
      const settled = await reload(fixture, request.id);
      expect(settled).toMatchObject({
        executionStatus: "conflict",
        executionError: true,
        executionResult: { text: "handler refused", outcomeKind: "callFailed" },
      });
      expect(approvalConflictReason(settled.executionStatus, settled.executionResult)).toEqual({
        key: "approval.outcome.failed",
      });
    });

    it("records a throwing handler as a failed outcome, logs its class only and stores none of its text", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture, "gated.apply", { value: "x", mode: "throw" });
      const error = vi.spyOn(logger, "error");

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("T+x");
      const settled = await reload(fixture, request.id);
      expect(settled).toMatchObject({ executionStatus: "conflict", executionError: true });
      expect(JSON.stringify(settled.executionResult)).not.toContain("private handler detail");
      expect(settled.executionResult).toMatchObject({ outcomeKind: "callFailed" });
      expect(error).toHaveBeenCalledWith(
        { errorName: "Error", approvalRequestId: request.id, toolName: "gated.apply" },
        "Approved module tool call failed",
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain("private handler detail");
    });

    it("records a failed outcome and runs nothing when the snapshot cannot be read", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);
      await setTitle(fixture, "boom");
      const error = vi.spyOn(logger, "error");

      await deliver(tenantA, request.id);

      expect(await titleOf(fixture)).toBe("boom");
      expect(await reload(fixture, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionResult: { outcomeKind: "callFailed" },
      });
      expect(error).toHaveBeenCalledWith(
        { errorName: "Error", approvalRequestId: request.id, toolName: "gated.apply" },
        "Module tool approval snapshot could not be read",
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain("snapshot unavailable");
    });

    it("executes through the worker's task list, which hands over its module registry", async () => {
      const fixture = await createRunFixture(tenantA);
      const request = await approvedRequest(fixture);
      const handler = createCoreTaskList(
        runtime,
        createActionRegistry(),
        undefined,
        undefined,
        undefined,
        undefined,
        registry,
      )[CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE];
      if (!handler) throw new Error("Missing approval handler");

      await runOnce({ pgPool: runtime, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handler } });
      await runInTenant(tenantA, () =>
        withTransaction(runtime, (client) =>
          enqueueJob(
            client,
            CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE,
            { approvalRequestId: request.id },
            { jobKey: `redelivery-${request.id}` },
          ),
        ),
      );
      await runOnce({ pgPool: runtime, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handler } });

      expect(await titleOf(fixture)).toBe("T+x");
      expect((await reload(fixture, request.id)).executionStatus).toBe("succeeded");
    });
  });

  describe("across two tenants", () => {
    it("does not run tenant A's approved request when the task is delivered in tenant B", async () => {
      const fixtureA = await createRunFixture(tenantA);
      const fixtureB = await createRunFixture(tenantB);
      const request = await approvedRequest(fixtureA);

      await deliver(tenantB, request.id);

      expect(await titleOf(fixtureA)).toBe("T");
      expect(await titleOf(fixtureB)).toBe("T");
      const seenByB = await runInTenant(tenantB, () =>
        withTransaction(runtime, (client) => getApprovalRequest(client, request.id)),
      );
      expect(seenByB).toBeNull();
      expect(await reload(fixtureA, request.id)).toMatchObject({ executionStatus: "queued", executedAt: null });
      expect((await outcomeMessages(fixtureB)).rows).toEqual([]);

      await deliver(tenantA, request.id);

      expect(await titleOf(fixtureA)).toBe("T+x");
      expect(await titleOf(fixtureB)).toBe("T");
    });

    it("notifies only the owner of the run's tenant", async () => {
      const fixtureA = await createRunFixture(tenantA);
      const fixtureB = await createRunFixture(tenantB);

      const requestA = await requestCall(fixtureA, "gated.apply", { value: "a" });
      const requestB = await requestCall(fixtureB, "gated.apply", { value: "b" });

      const rows = await admin.query<{ user_id: string; source_id: string }>(
        "SELECT user_id, source_id FROM notifications ORDER BY user_id",
      );
      expect(rows.rows).toEqual(
        [
          { user_id: fixtureA.userId, source_id: requestA.id },
          { user_id: fixtureB.userId, source_id: requestB.id },
        ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
      );
    });
  });
});
