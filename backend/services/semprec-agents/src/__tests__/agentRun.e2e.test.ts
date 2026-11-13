import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Pool } from "pg";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import {
  createApprovalGatedMcpInvokeTool,
  createReconstructConversationHistory,
  SempConversation,
} from "@semprec/agent-runtime";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  upsertMailMessageMeta,
} from "@semprec/data/testSupport";
import {
  AgentRunError,
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createPersonEmailReindexAction,
  createCoreTaskList,
  createUser,
  decideAndEnqueueApprovalRequest,
  finishAgentRun,
  getAgentRun,
  getApprovalRequest,
  getProjectMcpGrant,
  loadFullModuleRegistry,
  listMcpToolGrantsForProject,
  setProjectMcpGrantForAgentPage,
  seedSystem,
  runProjectAgentGuidanceCutoverMigration,
  upsertMcpToolRegistration,
  withTransaction,
} from "@semprec/data";
import { startStdioContractServer, type ContractServerTool } from "@semprec/data/testSupport/mcpContractServers";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import { createAgentRunTask, createRunAgentForHeartbeats } from "../agentRunTasks.js";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import { toPiMessages } from "../piConversationHistory.js";
import { createGatewayModel, type GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { logger } from "../logger.js";

/**
 * Lets a test run code while a run's session is being composed — to fail the composition, or to
 * close the run in the gap before the handler claims it. Unset, the real composition runs as is.
 */
const composition = vi.hoisted(() => ({ during: undefined as ((agentRunId: string) => Promise<void>) | undefined }));

vi.mock("../agentSessionComposition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agentSessionComposition.js")>();
  return {
    ...actual,
    createAgentSessionFactoryForRun: async (...args: Parameters<typeof actual.createAgentSessionFactoryForRun>) => {
      await composition.during?.(args[3].id);
      return actual.createAgentSessionFactoryForRun(...args);
    },
  };
});

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

/** Everything the spies recorded as one string; an `Error` is expanded, which `JSON.stringify` alone drops. */
function loggedText(...spies: MockInstance[]): string {
  return JSON.stringify(
    spies.map((spy) => spy.mock.calls),
    (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : value,
  );
}

let pool: Pool;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;
let faux: FauxProviderHandle;
let fauxGateway: GatewayModel;
let requestHeaders: Record<string, string | null>[];

async function jobCount(taskName: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [taskName],
  );
  return Number(rows[0]?.count ?? 0);
}

async function runRow(id: string): Promise<{ status: string; result: string | null }> {
  const { rows } = await pool.query<{ status: string; result: string | null }>(
    `SELECT status, result FROM agent_runs WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runEvents(id: string): Promise<{ kind: string; payload: Record<string, unknown> }[]> {
  const { rows } = await pool.query<{ kind: string; payload: unknown }>(
    `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id`,
    [id],
  );
  return rows.map((row) => {
    if (!isRecord(row.payload)) {
      throw new Error("Invalid agent event payload");
    }
    return { kind: row.kind, payload: row.payload };
  });
}

function resultDetails(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload || !isRecord(payload.result) || !isRecord(payload.result.details))
    throw new Error("Missing tool result details");
  return payload.result.details;
}

function tcpPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
  return address.port;
}

async function errorNotificationCount(runId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error' AND source_id = $1`,
    [runId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** The Semprec project item `seedSystem` creates — the project the directly created runs belong to. */
async function seededSemprecProjectItemId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'`);
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/**
 * The seeded `core.agentRun` heartbeat (the `newEmail` rule) and the project that owns it — the
 * Email project, not Semprec, since a heartbeat fire opens its run for the heartbeat's own project.
 */
async function seededAgentHeartbeat(): Promise<{ id: string; projectItemId: string }> {
  const { rows } = await pool.query<{ id: string; project_item_id: string }>(
    `SELECT id, project_item_id FROM project_heartbeats WHERE action_id = $1`,
    [CORE_AGENT_RUN_ACTION_ID],
  );
  expect(rows).toHaveLength(1);
  return { id: rows[0]!.id, projectItemId: rows[0]!.project_item_id };
}

describe("agent sessions in semprec-agents (issue #647)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    registry ??= await loadFullModuleRegistry();
    await resetDatabase(pool);
    await seedSystem(pool);
    await createUser(pool, { email: "owner@example.com", passwordHash: "unused", tenantId: getTenantZeroId() });
    runtime = undefined;
    composition.during = undefined;

    faux = fauxProvider();
    requestHeaders = [];
    const streamFn: StreamFn = (model, context, options) => {
      requestHeaders.push({ ...options?.headers });
      return faux.provider.streamSimple(model, context, options);
    };
    fauxGateway = { model: faux.getModel(), streamFn, isBudgetRefusal: () => false };
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function startRuntime(): Promise<void> {
    runtime = await createAgentsQueueRuntime(pool, registry, {
      runAgent: createRunAgentForHeartbeats(pool, registry, fauxGateway, createInFlightAgentRuns()),
      agentRunTask: createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns()),
      delegatedAgentRunTask: createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns()),
    });
  }

  it("composes converted project guidance into the next real agent session", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await runInTenant(getTenantZeroId(), async () => {
        const projectItemId = await seededSemprecProjectItemId();
        await runProjectAgentGuidanceCutoverMigration(runtimePool);
        const expected =
          "## Purpose\nsupervise Semprec, the personal life-organization system, and delegate to project agents.\n\n" +
          "## Allowed\nread the schema-derived permission manifest for any project and delegate tasks to its agent.\n\n" +
          "## Not allowed\nwrite any property whose owner is 'system', or change a locked/schema_locked database.\n\n" +
          "## General instructions\nkeep delegated tasks and their results terse; the manifest is the source of truth for what is allowed.\n";
        const stored = await withTransaction(runtimePool, (client) =>
          client.query<{ markdown: string }>("SELECT markdown FROM project_agent_guidance WHERE project_item_id = $1", [
            projectItemId,
          ]),
        );
        expect(stored.rows).toEqual([{ markdown: expected }]);
        let prompt: string | undefined;
        faux.setResponses([
          (context) => {
            prompt = context.systemPrompt;
            return fauxAssistantMessage("done");
          },
        ]);
        const run = await createAgentRun(runtimePool, { projectItemId, triggeredBy: "user", task: "inspect" });
        const factory = await createAgentSessionFactoryForRun(runtimePool, registry, fauxGateway, run);
        for await (const event of factory({ task: "inspect" }).messages()) void event;
        expect(prompt).toContain(`## Project-specific guidance\n\n${expected}`);
        await finishAgentRun(runtimePool, run.id, "done", "inspected");
      });
    } finally {
      await runtimePool.end();
    }
  });

  it("offers persisted grants only while their server is active", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await runInTenant(getTenantZeroId(), async () => {
        const cp = createChokePoint(runtimePool);
        const { rows } = await withTransaction(runtimePool, (client) =>
          client.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", ["mcpServers"]),
        );
        const database = rows[0];
        if (!database) throw new Error("Missing MCP servers database");
        const server = await cp.createItem({ databaseId: database.id, properties: { name: "Catalog", active: true } });
        const granted = await upsertMcpToolRegistration(runtimePool, {
          mcpServerItemId: server.id,
          toolName: "granted",
          toolSchema: { type: "object" },
        });
        await upsertMcpToolRegistration(runtimePool, {
          mcpServerItemId: server.id,
          toolName: "ungranted",
          toolSchema: { type: "object" },
        });
        const projectItemId = await seededSemprecProjectItemId();
        await withTransaction(runtimePool, (client) =>
          setProjectMcpGrantForAgentPage(client, {
            projectItemId,
            mcpToolRegistrationId: granted.id,
            granted: true,
          }),
        );
        const grantRows = () =>
          withTransaction(runtimePool, (client) => listMcpToolGrantsForProject(client, projectItemId, "en"));
        const storedGrant = () =>
          withTransaction(runtimePool, (client) => getProjectMcpGrant(client, projectItemId, granted.id));
        const originalGrant = await storedGrant();
        expect(originalGrant).toMatchObject({ projectItemId, mcpToolRegistrationId: granted.id, granted: true });
        const offered = async () => {
          const run = await createAgentRun(runtimePool, { projectItemId, triggeredBy: "user", task: "catalog" });
          let names: string[] = [];
          faux.setResponses([
            (context) => {
              names = context.tools?.map((tool) => tool.name) ?? [];
              return fauxAssistantMessage("done");
            },
          ]);
          const factory = await createAgentSessionFactoryForRun(runtimePool, registry, fauxGateway, run);
          for await (const event of factory({ task: "catalog" }).messages()) void event;
          await finishAgentRun(runtimePool, run.id, "done", "catalog inspected");
          return names.filter((name) => name.startsWith("mcp_"));
        };
        const name = `mcp_granted_${server.id.replace(/-/g, "").slice(0, 8)}`;
        expect(await offered()).toEqual([name]);
        expect(await storedGrant()).toEqual(originalGrant);
        await cp.updateItem({ databaseId: database.id, itemId: server.id, propertiesPatch: { active: false } });
        expect((await grantRows()).find((row) => row.mcpToolRegistrationId === granted.id)).toMatchObject({
          granted: true,
          mcpServerOnline: false,
        });
        expect(await offered()).toEqual([]);
        expect(await storedGrant()).toEqual(originalGrant);
        await cp.updateItem({ databaseId: database.id, itemId: server.id, propertiesPatch: { active: true } });
        expect((await grantRows()).find((row) => row.mcpToolRegistrationId === granted.id)).toMatchObject({
          granted: true,
          mcpServerOnline: true,
        });
        expect(await offered()).toEqual([name]);
        expect(await storedGrant()).toEqual(originalGrant);
      });
    } finally {
      await runtimePool.end();
    }
  });

  it("runs a queued agentRun job's session and closes the row as done with the model's text", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    faux.setResponses([fauxAssistantMessage("Hello from the agent.")]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "done", result: "Hello from the agent." });
    const events = await runEvents(run.id);
    expect(events.map((event) => event.kind)).toEqual([
      "run_status",
      "user_message",
      "turn_start",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(events[0]?.payload).toMatchObject({ status: "running" });
    expect(events[5]?.payload).toMatchObject({ status: "done" });
    expect(requestHeaders).toEqual([expect.objectContaining({ "x-semprec-agent-run-id": run.id })]);
    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.AGENT_RUN)) === 0);
  });

  it("persists each validated turn's own refs before prompting in a composed conversation", async () => {
    logger.error("log-capture-context-marker");
    const projectItemId = await seededSemprecProjectItemId();
    const { rows } = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const thread = { kind: "chat" as const, threadId: rows[0]!.id };
    const ref = { kind: "item" as const, itemId: randomUUID(), databaseId: randomUUID(), label: "ref-label-sentinel" };
    const secondRef = { kind: "block" as const, itemId: randomUUID(), blockId: randomUUID(), label: "Block" };
    faux.setResponses([
      fauxAssistantMessage("model-text-sentinel"),
      fauxAssistantMessage("two"),
      fauxAssistantMessage("three"),
    ]);
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => projectItemId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(pool, registry, fauxGateway, run),
    });
    const starts: string[] = [];
    try {
      for (const malformed of [
        null,
        "not-an-array",
        [{ ...ref, expanded: "expanded-secret-sentinel" }],
        [{ ...ref, label: 42 }],
      ]) {
        await expect(
          runInTenant(getTenantZeroId(), () =>
            // @ts-expect-error Exercise invalid input crossing the conversation boundary.
            conversation.send("invalid", thread, { context: malformed }),
          ),
        ).rejects.toThrow("Invalid user turn context");
      }
      expect(requestHeaders).toHaveLength(0);
      const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_run_events");
      expect(before.rows[0]?.count).toBe("0");
      const send = (text: string, context?: (typeof ref)[] | (typeof secondRef)[]) =>
        runInTenant(getTenantZeroId(), () =>
          conversation.send(text, thread, {
            context,
            onTurnStart: async ({ agentRunId, firstEventId }) => {
              const events = await runEvents(agentRunId);
              expect(events.at(-1)).toMatchObject({ kind: "user_message", payload: { text, context: context ?? [] } });
              expect(requestHeaders).toHaveLength(starts.length);
              starts.push(firstEventId);
            },
          }),
        );
      await send("user-text-sentinel", [ref]);
      const afterWake = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_run_events");
      await expect(
        runInTenant(getTenantZeroId(), () =>
          // @ts-expect-error Exercise invalid follow-up context crossing the conversation boundary.
          conversation.send("invalid-followup-sentinel", thread, { context: [{ ...ref, label: 42 }] }),
        ),
      ).rejects.toThrow("Invalid user turn context");
      const afterInvalid = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_run_events");
      expect(afterInvalid.rows).toEqual(afterWake.rows);
      expect(requestHeaders).toHaveLength(1);
      await send("second", [secondRef]);
      await send("third");
      expect(starts).toHaveLength(3);
      expect(requestHeaders).toHaveLength(3);
      const reconstruct = createReconstructConversationHistory({
        estimateContextTokens: (messages) => messages.length,
        shouldCompact: () => false,
        prepareCompaction: (entries) => entries,
        compact: () => {
          throw new Error("unexpected compaction");
        },
        contextWindow: 1_000_000,
        settings: {},
      });
      const history = await runInTenant(getTenantZeroId(), () =>
        reconstruct(pool, { threadId: thread.threadId, projectItemId }),
      );
      expect(history).not.toBeNull();
      const messages = toPiMessages(history!.entries, fauxGateway.model);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(messages[0]).toMatchObject({ role: "user", content: "user-text-sentinel" });
      expect(messages[2]).toMatchObject({ role: "user", content: "second" });
      expect(messages[4]).toMatchObject({ role: "user", content: "third" });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "model-text-sentinel" }],
      });
      expect(messages[3]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "two" }] });
      expect(messages[5]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "three" }] });
    } finally {
      conversation.clear();
    }
  });

  it("binds tools invoked on wake and continuation to the conversation run", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Conversation tool test" });
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const threads = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const thread = { kind: "chat" as const, threadId: threads.rows[0]!.id };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("item_delete", { itemId: item.id }, { id: "first-call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage([fauxToolCall("item_delete", { itemId: item.id }, { id: "second-call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("second done"),
    ]);
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => projectItemId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(pool, registry, fauxGateway, run),
    });
    const started: string[] = [];
    try {
      for (const text of ["first", "second"]) {
        await runInTenant(getTenantZeroId(), () =>
          conversation.send(text, thread, {
            onTurnStart: ({ agentRunId }) => {
              started.push(agentRunId);
            },
          }),
        );
      }
      expect(started).toHaveLength(2);
      expect(started[1]).toBe(started[0]);
      const requests = await pool.query<{ agent_run_id: string; tool_call_id: string }>(
        "SELECT agent_run_id, tool_call_id FROM approval_requests WHERE agent_run_id = $1 ORDER BY tool_call_id",
        [started[0]],
      );
      expect(requests.rows).toEqual([
        { agent_run_id: started[0], tool_call_id: "first-call" },
        { agent_run_id: started[0], tool_call_id: "second-call" },
      ]);
    } finally {
      conversation.clear();
    }
  });

  it("closes the composed run without prompting when its first-event callback fails", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const { rows } = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const thread = { kind: "chat" as const, threadId: rows[0]!.id };
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => projectItemId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(pool, registry, fauxGateway, run),
    });
    try {
      await expect(
        runInTenant(getTenantZeroId(), () =>
          conversation.send("first", thread, {
            onTurnStart: () => {
              throw new Error("callback failed");
            },
          }),
        ),
      ).rejects.toThrow("callback failed");
      expect(requestHeaders).toHaveLength(0);
      const runs = await pool.query<{ status: string; error_code: string }>(
        "SELECT status, error_code FROM agent_runs WHERE thread_id = $1",
        [thread.threadId],
      );
      expect(runs.rows).toEqual([{ status: "error", error_code: "internal" }]);
    } finally {
      conversation.clear();
    }
  });

  it("aborts a blocked composed prompt and drops the conversation", async () => {
    let observed: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const gatewayServer = createServer((req) => {
      req.resume();
      req.on("end", () => {
        observed?.();
      });
    });
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    const port = tcpPort(gatewayServer);
    const gateway = createGatewayModel({
      AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
      AI_GATEWAY_INTERNAL_TOKEN: "test-token",
      AGENT_MODEL: "test-model",
    });
    const projectItemId = await seededSemprecProjectItemId();
    const { rows } = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
    const thread = { kind: "chat" as const, threadId: rows[0]!.id };
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => projectItemId,
      createAgentSessionForRun: (run) => createAgentSessionFactoryForRun(pool, registry, gateway, run),
    });
    const controller = new AbortController();
    const turn = runInTenant(getTenantZeroId(), () =>
      conversation.send("first", thread, { signal: controller.signal }),
    );
    const observedTurn = turn.then(
      () => "resolved",
      () => "rejected",
    );
    try {
      await Promise.race([
        arrived,
        sleep(3000, undefined, { ref: false }).then(() => {
          throw new Error("gateway request did not arrive");
        }),
      ]);
      controller.abort();
      expect(await observedTurn).toBe("rejected");
      const runs = await pool.query<{ status: string; error_code: string }>(
        "SELECT status, error_code FROM agent_runs WHERE thread_id = $1",
        [thread.threadId],
      );
      expect(runs.rows).toEqual([{ status: "error", error_code: "cancelled" }]);
      await expect(
        runInTenant(getTenantZeroId(), () => conversation.send("next", thread, { signal: AbortSignal.abort() })),
      ).rejects.toThrow();
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM agent_runs WHERE thread_id = $1",
        [thread.threadId],
      );
      expect(count.rows[0]?.count).toBe("2");
    } finally {
      controller.abort();
      await observedTurn;
      conversation.clear();
      gatewayServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("retains the composed server snapshot after the grant is revoked without invoking or queuing", async () => {
    const tool: ContractServerTool = {
      name: "search_web",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const server = startStdioContractServer([tool]);
    try {
      await pool.query("UPDATE users SET role = 'admin' WHERE tenant_id = $1", [getTenantZeroId()]);
      const databases = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE owner_module_id = 'mcpServers'",
      );
      const itemId = randomUUID();
      await pool.query("INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb)", [
        itemId,
        databases.rows[0]!.id,
        JSON.stringify({ name: "Contract server", active: true, connectionConfig: server.connectionConfig }),
      ]);
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: itemId,
        toolName: tool.name,
        toolSchema: tool.inputSchema,
        description: null,
      });
      const projectItemId = await seededSemprecProjectItemId();
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: true,
        }),
      );
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
      const factory = await runInTenant(getTenantZeroId(), () =>
        createAgentSessionFactoryForRun(pool, registry, fauxGateway, run),
      );
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: false,
        }),
      );
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall(`mcp_search_web_${itemId.replace(/-/g, "").slice(0, 8)}`, { query: "test" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      const events = await runInTenant(getTenantZeroId(), async () => {
        const observed = [];
        for await (const event of factory({ task: "test" }).messages()) observed.push(event);
        return observed;
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "tool_result",
          result: expect.objectContaining({
            details: expect.objectContaining({ failureKind: "unavailable", mcpServerItemId: itemId }),
          }),
        }),
      );
      expect(server.getHandshakeCount()).toBe(0);
      const requests = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM approval_requests WHERE agent_run_id = $1",
        [run.id],
      );
      expect(requests.rows[0]?.count).toBe("0");
    } finally {
      await server.stop();
    }
  });

  it.each([true, 123])("stores SDK-normalized MCP reason %s after a composed tool call", async (rawReason) => {
    const tool: ContractServerTool = {
      name: "search_web",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const server = startStdioContractServer([tool]);
    try {
      await pool.query("UPDATE users SET role = 'admin' WHERE tenant_id = $1", [getTenantZeroId()]);
      const databases = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE owner_module_id = 'mcpServers'",
      );
      const itemId = randomUUID();
      await pool.query("INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb)", [
        itemId,
        databases.rows[0]!.id,
        JSON.stringify({ name: "Contract server", active: true, connectionConfig: server.connectionConfig }),
      ]);
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: itemId,
        toolName: tool.name,
        toolSchema: tool.inputSchema,
        description: null,
      });
      const projectItemId = await seededSemprecProjectItemId();
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: true,
        }),
      );
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              `mcp_search_web_${itemId.replace(/-/g, "").slice(0, 8)}`,
              { query: "test", semprecReason: rawReason },
              { id: "mcp-call-1" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
      await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM approval_requests WHERE agent_run_id = $1", [
        run.id,
      ]);
      expect(rows).toHaveLength(1);
      const request = await getApprovalRequest(pool, rows[0]!.id);
      expect(request?.reason).toBe(String(rawReason));
      expect(request?.toolCallId).toBe("mcp-call-1");
      expect((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload).toMatchObject({
        toolCallId: "mcp-call-1",
        result: { details: { approvalRequestId: rows[0]!.id } },
      });
      const details = resultDetails((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload);
      expect(details.error).toBe(false);
      expect(Object.hasOwn(details, "changes")).toBe(false);
      expect(request?.payload).toMatchObject({ args: { query: "test" } });
      expect(JSON.stringify(request?.payload)).not.toContain("semprecReason");
      expect(server.getHandshakeCount()).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("executes the actual approved MCP job without forwarding the agent reason", async () => {
    logger.error("log-capture-mcp-marker");
    const tool: ContractServerTool = {
      name: "search_web",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const server = startStdioContractServer([tool]);
    try {
      await pool.query("UPDATE users SET role = 'admin' WHERE tenant_id = $1", [getTenantZeroId()]);
      const databases = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE owner_module_id = 'mcpServers'",
      );
      const itemId = randomUUID();
      await pool.query("INSERT INTO items (id, database_id, properties) VALUES ($1, $2, $3::jsonb)", [
        itemId,
        databases.rows[0]!.id,
        JSON.stringify({ name: "Contract server", active: true, connectionConfig: server.connectionConfig }),
      ]);
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: itemId,
        toolName: tool.name,
        toolSchema: tool.inputSchema,
        description: null,
      });
      const projectItemId = randomUUID();
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: true,
        }),
      );
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
      const invoke = createApprovalGatedMcpInvokeTool(pool, run.id, projectItemId, registration.id);
      const result = await inTenantZero(() => invoke({ query: "semprec", semprecReason: "private reason" }));
      expect(result.error).toBe(false);
      const id = result.approvalRequestId!;
      await inTenantZero(() =>
        withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: id,
            decision: "approved",
            decidedByUserId: run.actorUserId,
          }),
        ),
      );
      const taskList = createCoreTaskList(pool, new Map());
      await runOnce({ pgPool: pool, taskList });
      expect(server.getLastToolCall()).toMatchObject({ name: "search_web", arguments: { query: "semprec" } });
      expect(JSON.stringify(server.getLastToolCall())).not.toContain("semprecReason");
      const settled = await getApprovalRequest(pool, id);
      expect(settled?.reason).toBe("private reason");
      expect(settled?.executionStatus).toBe("succeeded");
      expect(server.getHandshakeCount()).toBe(1);
      await inTenantZero(() => enqueueJob(pool, CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE, { approvalRequestId: id }));
      await runOnce({ pgPool: pool, taskList });
      expect(server.getHandshakeCount()).toBe(1);
      expect((await getApprovalRequest(pool, id))?.executionResult).toEqual(settled?.executionResult);
    } finally {
      await server.stop();
    }
  });

  it("stores an agent's generic-operation reason outside the canonical input and snapshot", async () => {
    logger.error("log-capture-generic-marker");
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Reason test" });
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("item_delete", { itemId: item.id, reason: "reason-sentinel" }, { id: "call-1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("approval requested"),
    ]);
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
    await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM approval_requests WHERE agent_run_id = $1", [
      run.id,
    ]);
    expect(rows).toHaveLength(1);
    const request = await getApprovalRequest(pool, rows[0]!.id);
    expect(request?.reason).toBe("reason-sentinel");
    expect(request?.toolCallId).toBe("call-1");
    expect((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload).toMatchObject({
      toolCallId: "call-1",
      result: { details: { approvalRequestId: rows[0]!.id } },
    });
    const details = resultDetails((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload);
    expect(details.error).toBe(false);
    expect(Object.hasOwn(details, "changes")).toBe(false);
    expect(request?.payload).toMatchObject({ canonicalInput: { itemId: item.id } });
    expect(JSON.stringify(request?.payload)).not.toContain("reason-sentinel");
    expect(JSON.stringify(request?.resourceSnapshot)).not.toContain("reason-sentinel");
  });

  it("persists the composed item.patch tool result with transactional previous and new values", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Patch event" });
    await chokePoint.createProperty({ databaseId: database.id, key: "due", name: "Due", type: "text" });
    await chokePoint.createProperty({ databaseId: database.id, key: "body", name: "Body", type: "longText" });
    const item = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId: database.id,
        properties: { due: "2026-10-21T14:00", body: "old-private-body" },
      }),
    );
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "item_patch",
            {
              itemId: item.id,
              properties: { due: "2026-10-22T09:00", body: "new-private-body" },
              ifVersion: item.updatedAt,
            },
            { id: "patch-call-1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
    await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));
    expect((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload).toMatchObject({
      toolCallId: "patch-call-1",
      result: {
        details: {
          error: false,
          changes: [{ key: "due", before: "2026-10-21T14:00", after: "2026-10-22T09:00" }, { key: "body" }],
        },
      },
    });
    const details = resultDetails((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload);
    expect(JSON.stringify(details)).not.toContain("private-body");
  });

  it.each(["success", "failure"] as const)(
    "persists %s non-patch details without approval or changes",
    async (outcome) => {
      const projectItemId = await seededSemprecProjectItemId();
      const cp = createChokePoint(pool);
      const database = await cp.createDatabase({ name: "Read event" });
      const item = await cp.createItem({ databaseId: database.id, properties: {} });
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "read" });
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("item_get", { itemId: outcome === "success" ? item.id : randomUUID() }, { id: "read-call" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await runInTenant(getTenantZeroId(), () =>
        createAgentRunTask(
          pool,
          registry,
          fauxGateway,
          createInFlightAgentRuns(),
        )({ agentRunId: run.id }, { job: { id: "1" } }),
      );
      const payload = (await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload;
      expect(payload?.toolCallId).toBe("read-call");
      const details = resultDetails(payload);
      expect(details.error).toBe(outcome === "failure");
      expect(Object.hasOwn(details, "approvalRequestId")).toBe(false);
      expect(Object.hasOwn(details, "changes")).toBe(false);
    },
  );

  it("keeps a reason out of logs when approval insertion fails", async () => {
    logger.error("log-capture-failed-insert-marker");
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Approval insertion failure" });
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
    await pool.query(`CREATE FUNCTION fail_test_approval_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'controlled approval insert failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_test_approval_insert BEFORE INSERT ON approval_requests
      FOR EACH ROW EXECUTE FUNCTION fail_test_approval_insert()`);
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("item_delete", { itemId: item.id, reason: "insert-failure-reason-sentinel" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("handled"),
      ]);
      const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
      await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));
      const events = await runEvents(run.id);
      expect(events.find((event) => event.kind === "tool_result")?.payload).toMatchObject({
        result: { details: { error: true } },
      });
      const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_requests");
      expect(rows[0]?.count).toBe("0");
    } finally {
      await pool.query("DROP TRIGGER fail_test_approval_insert ON approval_requests");
      await pool.query("DROP FUNCTION fail_test_approval_insert()");
    }
  });

  it.each([true, 123])("stores SDK-normalized generic reason %s after a composed tool call", async (rawReason) => {
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "SDK reason test" });
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("item_delete", { itemId: item.id, reason: rawReason })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
    await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM approval_requests WHERE agent_run_id = $1", [
      run.id,
    ]);
    expect(rows).toHaveLength(1);
    const request = await getApprovalRequest(pool, rows[0]!.id);
    expect(request?.reason).toBe(String(rawReason));
    expect(request?.payload).toMatchObject({ canonicalInput: { itemId: item.id } });
    expect(JSON.stringify(request?.payload)).not.toContain('"reason"');
  });

  it("enforces the generic approval reason limit in Unicode code points through the agent run", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Unicode reason test" });
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
    for (const count of [500, 501]) {
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
      const reason = "😀".repeat(count);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("item_delete", { itemId: item.id, reason }, { id: `call-${count}` })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: `${count}` } }));
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM approval_requests WHERE agent_run_id = $1", [
        run.id,
      ]);
      if (count === 500) {
        expect(rows).toHaveLength(1);
        expect((await getApprovalRequest(pool, rows[0]!.id))?.reason).toBe(reason);
      } else {
        expect(rows).toHaveLength(0);
        expect((await runEvents(run.id)).find((event) => event.kind === "tool_result")?.payload).toMatchObject({
          isError: true,
        });
      }
    }
  });

  it("returns a validation error to the model without creating an approval for an oversized reason", async () => {
    logger.error("log-capture-invalid-reason-marker");
    const projectItemId = await seededSemprecProjectItemId();
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Oversized reason test" });
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "item_delete",
            { itemId: item.id, reason: "oversized-reason-sentinel" + "x".repeat(500) },
            { id: "call-1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("failed"),
    ]);
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
    await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM approval_requests WHERE agent_run_id = $1",
      [run.id],
    );
    expect(rows[0]?.count).toBe("0");
    const result = (await runEvents(run.id)).find((event) => event.kind === "tool_result");
    expect(result?.payload).toMatchObject({ isError: true });
    expect(JSON.stringify(result?.payload)).toMatch(/reason/i);
  });

  it("closes the row as error with one agent_run_error notification when the model call fails", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await runRow(run.id)).status !== "running");
    expect(await runRow(run.id)).toEqual({ status: "error", result: "modelError" });
    const events = await runEvents(run.id);
    expect(events.at(-1)).toMatchObject({ kind: "run_status", payload: { status: "error" } });
    expect(await errorNotificationCount(run.id)).toBe(1);
  });

  it("closes a composed run with the budget code after a gateway HTTP refusal", async () => {
    const gatewayServer = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(403, { "content-type": "application/json", "x-semprec-error-code": "budget_exceeded" });
        res.end(JSON.stringify({ error: "response-secret-sentinel", providerError: "provider-exception-sentinel" }));
      });
    });
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    try {
      const port = tcpPort(gatewayServer);
      const gateway = createGatewayModel({
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
        AI_GATEWAY_INTERNAL_TOKEN: "credential-secret-sentinel",
        AGENT_MODEL: "test-model",
      });
      const projectItemId = await seededSemprecProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "request-secret-sentinel" });
      const task = createAgentRunTask(pool, registry, gateway, createInFlightAgentRuns());
      await expect(
        runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
      ).rejects.toThrow("AI budget exceeded");
      expect(await getAgentRun(pool, run.id)).toMatchObject({
        status: "error",
        errorCode: "budgetExceeded",
        result: "budgetExceeded",
      });
      const diagnostic = (await runEvents(run.id)).find((event) => event.kind === "message");
      expect(diagnostic?.payload).toMatchObject({ errorMessage: "AI budget exceeded" });
      expect(JSON.stringify(diagnostic?.payload)).not.toMatch(
        /response-secret-sentinel|provider-exception-sentinel|credential-secret-sentinel|request-secret-sentinel/,
      );
    } finally {
      await new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("keeps budget classification isolated across overlapping composed runs", async () => {
    const pending: { runId: string | undefined; response: import("node:http").ServerResponse }[] = [];
    let refusedRunId = "";
    const gatewayServer = createServer((req, res) => {
      const deadline = setTimeout(() => res.destroy(), 3000);
      res.once("close", () => clearTimeout(deadline));
      req.resume();
      req.on("end", () => {
        const header = req.headers["x-semprec-agent-run-id"];
        pending.push({ runId: typeof header === "string" ? header : undefined, response: res });
        if (pending.length !== 2) return;
        for (const request of pending) {
          const refused = request.runId === refusedRunId;
          request.response.writeHead(refused ? 403 : 500, {
            "content-type": "application/json",
            ...(refused ? { "x-semprec-error-code": "budget_exceeded" } : {}),
          });
          request.response.end(JSON.stringify({ error: "provider-response-sentinel" }));
        }
      });
    });
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    try {
      const port = tcpPort(gatewayServer);
      const gateway = createGatewayModel({
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
        AI_GATEWAY_INTERNAL_TOKEN: "credential-sentinel",
        AGENT_MODEL: "test-model",
      });
      const projectItemId = await seededSemprecProjectItemId();
      const refused = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "first" });
      const failed = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "second" });
      refusedRunId = refused.id;
      const task = createAgentRunTask(pool, registry, gateway, createInFlightAgentRuns());
      const outcomes = await Promise.allSettled(
        [refused.id, failed.id].map((id) =>
          runInTenant(getTenantZeroId(), () => task({ agentRunId: id }, { job: { id } })),
        ),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(pending.map(({ runId }) => runId).sort()).toEqual([refused.id, failed.id].sort());
      expect(await getAgentRun(pool, refused.id)).toMatchObject({
        errorCode: "budgetExceeded",
        result: "budgetExceeded",
      });
      expect(await getAgentRun(pool, failed.id)).toMatchObject({ errorCode: "modelError", result: "modelError" });
      const refusedEvent = (await runEvents(refused.id)).find((event) => event.kind === "message");
      const failedEvent = (await runEvents(failed.id)).find((event) => event.kind === "message");
      expect(refusedEvent?.payload).toMatchObject({ errorMessage: "AI budget exceeded" });
      expect(failedEvent?.payload.errorMessage).toEqual(expect.stringContaining("provider-response-sentinel"));
    } finally {
      await new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it.each(["403 without header", "500", "network error", "provider error"])(
    "closes a composed %s as modelError",
    async (kind) => {
      const gatewayServer = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          if (kind === "network error") return res.destroy();
          if (kind === "provider error") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
              `data: ${JSON.stringify({ type: "error", reason: "error", errorMessage: "provider failure" })}\n\n`,
            );
            return;
          }
          res.writeHead(kind === "500" ? 500 : 403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "refused" }));
        });
      });
      await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
      try {
        const port = tcpPort(gatewayServer);
        const gateway = createGatewayModel({
          AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
          AI_GATEWAY_INTERNAL_TOKEN: "test-token",
          AGENT_MODEL: "test-model",
        });
        const projectItemId = await seededSemprecProjectItemId();
        const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "test" });
        const task = createAgentRunTask(pool, registry, gateway, createInFlightAgentRuns());
        const failure: unknown = await runInTenant(getTenantZeroId(), () =>
          task({ agentRunId: run.id }, { job: { id: "1" } }),
        ).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("expected model failure");
        expect(failure.message).not.toBe("AI budget exceeded");
        expect(await getAgentRun(pool, run.id)).toMatchObject({
          status: "error",
          errorCode: "modelError",
          result: "modelError",
        });
      } finally {
        await new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve())));
      }
    },
  );

  it("writes nothing for a job naming a run that is no longer running", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    await finishAgentRun(pool, run.id, "done", "earlier result");
    faux.setResponses([fauxAssistantMessage("must not run")]);

    await startRuntime();
    await inTenantZero(() => enqueueJob(pool, AGENT_TASK_NAMES.DELEGATED_AGENT_RUN, { agentRunId: run.id }));

    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.DELEGATED_AGENT_RUN)) === 0);
    expect(await runRow(run.id)).toEqual({ status: "done", result: "earlier result" });
    expect(await runEvents(run.id)).toEqual([]);
    expect(requestHeaders).toEqual([]);
  });

  it("closes the row as error with the code internal when the session cannot be composed", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    composition.during = async () => {
      throw new Error("mcp grants unavailable");
    };
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());

    await expect(
      runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
    ).rejects.toThrow("mcp grants unavailable");

    expect(await runRow(run.id)).toEqual({ status: "error", result: "internal" });
    expect((await getAgentRun(pool, run.id))?.errorCode).toBe("internal");
    const storedCode = await pool.query<{ error_code: string | null }>(
      "SELECT error_code FROM agent_runs WHERE id = $1",
      [run.id],
    );
    expect(storedCode.rows).toEqual([{ error_code: "internal" }]);
    expect(await errorNotificationCount(run.id)).toBe(1);
    const events = await runEvents(run.id);
    expect(events).toEqual([{ kind: "run_status", payload: { kind: "run_status", status: "error" } }]);
    expect(requestHeaders).toEqual([]);
  });

  it("keeps the exception message and the task out of the row and of every log line when the session cannot be composed", async () => {
    const sentinel = "sentinel-a8d3";
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: `say hello ${sentinel}` });
    composition.during = async () => {
      throw new AgentRunError("modelError", `grants unavailable for ${sentinel}`);
    };
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());
    const spies = [vi.spyOn(logger, "error"), vi.spyOn(logger, "warn"), vi.spyOn(logger, "info")];
    try {
      await expect(
        runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
      ).rejects.toThrow(sentinel);

      expect(await runRow(run.id)).toEqual({ status: "error", result: "modelError" });
      expect(loggedText(...spies)).not.toContain(sentinel);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("logs the run's code and the name of the close error, never the close error itself, when closing a run that could not be composed fails", async () => {
    const sentinel = "sentinel-e41f";
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: `say hello ${sentinel}` });
    let failNextConnect = false;
    const failablePool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "connect") {
          return () => {
            if (!failNextConnect) return target.connect();
            failNextConnect = false;
            return Promise.reject(new Error(`could not write the row of ${sentinel}`));
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    composition.during = async () => {
      failNextConnect = true;
      throw new AgentRunError("modelError", `grants unavailable for ${sentinel}`);
    };
    const task = createAgentRunTask(failablePool, registry, fauxGateway, createInFlightAgentRuns());
    const errorSpy = vi.spyOn(logger, "error");
    try {
      await expect(
        runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
      ).rejects.toThrow(sentinel);

      // The close never ran, so the row stays open for the next startup repair.
      expect(await runRow(run.id)).toEqual({ status: "running", result: null });
      expect(errorSpy.mock.calls).toEqual([
        [
          { errorName: "Error", errorCode: "modelError", agentRunId: run.id },
          "Failed to close an agent run whose session could not be composed",
        ],
      ]);
      expect(loggedText(errorSpy)).not.toContain(sentinel);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs the run's code and the name of the status error, never the status error itself, when a failed heartbeat run cannot record its error status", async () => {
    const sentinel = "sentinel-5b92";
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: `say hello ${sentinel}` });
    let failNextEventInsert = false;
    const failablePool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            if (failNextEventInsert && String(args[0]).includes("INSERT INTO agent_run_events")) {
              failNextEventInsert = false;
              return Promise.reject(new Error(`could not write the event of ${sentinel}`));
            }
            return (target.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    composition.during = async () => {
      failNextEventInsert = true;
      throw new AgentRunError("modelError", `grants unavailable for ${sentinel}`);
    };
    const runAgent = createRunAgentForHeartbeats(failablePool, registry, fauxGateway, createInFlightAgentRuns());
    const spies = [vi.spyOn(logger, "error"), vi.spyOn(logger, "warn"), vi.spyOn(logger, "info")];
    try {
      await expect(
        runInTenant(getTenantZeroId(), () => runAgent({ agentRunId: run.id, projectItemId, task: run.task })),
      ).rejects.toThrow(sentinel);

      // The error status never reached agent_run_events; the caller (coreAgentRunAction) closes the row.
      expect(await runEvents(run.id)).toEqual([]);
      expect(spies[0]!.mock.calls).toEqual([
        [
          { errorName: "Error", errorCode: "modelError", agentRunId: run.id },
          "Failed to record a failed agent run's run_status",
        ],
      ]);
      expect(loggedText(...spies)).not.toContain(sentinel);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("writes no error event for a run closed elsewhere before its failed composition closes it", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    composition.during = async (agentRunId) => {
      await finishAgentRun(pool, agentRunId, "done", "closed elsewhere");
      throw new Error("mcp grants unavailable");
    };
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());

    await expect(
      runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } })),
    ).rejects.toThrow("mcp grants unavailable");

    expect(await runRow(run.id)).toEqual({ status: "done", result: "closed elsewhere" });
    expect(await errorNotificationCount(run.id)).toBe(0);
    expect(await runEvents(run.id)).toEqual([]);
    expect(requestHeaders).toEqual([]);
  });

  it("writes nothing for a run closed while its session was being composed", async () => {
    const projectItemId = await seededSemprecProjectItemId();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "say hello" });
    composition.during = async (agentRunId) => {
      await finishAgentRun(pool, agentRunId, "done", "closed elsewhere");
    };
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const task = createAgentRunTask(pool, registry, fauxGateway, createInFlightAgentRuns());

    await runInTenant(getTenantZeroId(), () => task({ agentRunId: run.id }, { job: { id: "1" } }));

    expect(await runRow(run.id)).toEqual({ status: "done", result: "closed elsewhere" });
    expect(await runEvents(run.id)).toEqual([]);
    expect(requestHeaders).toEqual([]);
  });

  it("runs the seeded core.agentRun heartbeat's session through coreAgentRunAction", async () => {
    const heartbeat = await seededAgentHeartbeat();
    // A manual (`triggeredByRunId`) fire skips the seeded rule's item-relation filter, which only
    // applies to an item-triggered fire.
    const parentRun = await createAgentRun(pool, {
      projectItemId: heartbeat.projectItemId,
      triggeredBy: "user",
      task: "trigger the newEmail heartbeat",
    });
    faux.setResponses([fauxAssistantMessage("Triaged the new email.")]);

    await startRuntime();
    await inTenantZero(() =>
      enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
        heartbeatId: heartbeat.id,
        triggeredByRunId: parentRun.id,
      }),
    );

    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT)) === 0);
    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE heartbeat_id = $1`,
      [heartbeat.id],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "done", result: "Triaged the new email." });
    const events = await runEvents(runs[0]!.id);
    expect(events.map((event) => event.kind)).toEqual([
      "run_status",
      "user_message",
      "turn_start",
      "message",
      "turn_end",
      "run_status",
    ]);
    expect(events[5]?.payload).toMatchObject({ status: "done" });

    const { rows: heartbeats } = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM project_heartbeats WHERE id = $1`,
      [heartbeat.id],
    );
    expect(heartbeats[0]?.last_error).toBeNull();
  });

  it("passes the triggering item through the real queued action and session", async () => {
    const seeded = await seededAgentHeartbeat();
    const cp = createChokePoint(pool);
    const setup = await inTenantZero(async () => {
      const dbs = await cp.listDatabases();
      const emails = dbs.find((db) => db.ownerModuleId === "emails");
      const people = dbs.find((db) => db.ownerModuleId === "people");
      if (!emails || !people) throw new Error("Missing email or people database");
      const person = await cp.createItem({
        databaseId: people.id,
        properties: { name: "Sender", emails: "sender@example.test" },
      });
      await createPersonEmailReindexAction(pool)(
        { peopleDatabaseId: people.id },
        { heartbeatId: seeded.id, projectItemId: seeded.projectItemId, itemId: person.id },
      );
      const item = await cp.createItem({ databaseId: emails.id, properties: {} });
      await withTransaction(pool, (client) =>
        upsertMailMessageMeta(client, {
          itemId: item.id,
          mailboxItemId: null,
          messageId: `<${randomUUID()}@example.test>`,
          envelope: { from: { address: "sender@example.test" } },
        }),
      );
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: seeded.projectItemId,
          name: "Item proof",
          rule: { kind: "onItemEvent", databaseId: emails.id, event: "create" },
          actionId: CORE_AGENT_RUN_ACTION_ID,
          actionConfig: { task: "Inspect", senderKnownFilter: {} },
          origin: "user",
        }),
      );
      return { heartbeat, item };
    });
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);
    await startRuntime();
    await inTenantZero(() =>
      enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
        heartbeatId: setup.heartbeat.id,
        itemId: setup.item.id,
      }),
    );
    await waitFor(async () => (await jobCount(AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT)) === 0);
    const { rows } = await pool.query<{ task: string; status: string }>(
      "SELECT task, status FROM agent_runs WHERE heartbeat_id = $1",
      [setup.heartbeat.id],
    );
    expect(rows).toEqual([{ task: `Inspect\nTriggering item id: ${setup.item.id}`, status: "done" }]);
    expect(prompt).toContain(`Triggering item id: ${setup.item.id}`);
  });

  /**
   * Fires the seeded heartbeat as a single-attempt job, so its one failure is the final attempt that
   * records `last_error`, then returns the one run it opened and that `last_error`.
   */
  async function fireFailingHeartbeat(): Promise<{
    run: { id: string; status: string; result: string | null };
    lastError: string | null;
  }> {
    const heartbeat = await seededAgentHeartbeat();
    const parentRun = await createAgentRun(pool, {
      projectItemId: heartbeat.projectItemId,
      triggeredBy: "user",
      task: "trigger the newEmail heartbeat",
    });

    await startRuntime();
    await inTenantZero(() =>
      enqueueJob(
        pool,
        AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT,
        { heartbeatId: heartbeat.id, triggeredByRunId: parentRun.id },
        { maxAttempts: 1 },
      ),
    );

    const lastError = async (): Promise<string | null> => {
      const { rows } = await pool.query<{ last_error: string | null }>(
        `SELECT last_error FROM project_heartbeats WHERE id = $1`,
        [heartbeat.id],
      );
      return rows[0]?.last_error ?? null;
    };
    await waitFor(async () => (await lastError()) !== null);
    const { rows: runs } = await pool.query<{ id: string; status: string; result: string | null }>(
      `SELECT id, status, result FROM agent_runs WHERE heartbeat_id = $1`,
      [heartbeat.id],
    );
    expect(runs).toHaveLength(1);
    return { run: runs[0]!, lastError: await lastError() };
  }

  it("closes a heartbeat run as error with the code internal when its session cannot be composed", async () => {
    composition.during = async () => {
      throw new Error("mcp grants unavailable");
    };

    const { run, lastError } = await fireFailingHeartbeat();

    expect(run).toMatchObject({ status: "error", result: "internal" });
    expect(lastError).toBe("mcp grants unavailable");
    expect(await errorNotificationCount(run.id)).toBe(1);
    expect(await runEvents(run.id)).toEqual([{ kind: "run_status", payload: { kind: "run_status", status: "error" } }]);
    expect(requestHeaders).toEqual([]);
  });

  it("closes a heartbeat run as error with the code modelError when the model call fails", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);

    const { run, lastError } = await fireFailingHeartbeat();

    expect(run).toMatchObject({ status: "error", result: "modelError" });
    expect(lastError).toBe("gateway refused: budget");
    expect(await errorNotificationCount(run.id)).toBe(1);
    const events = await runEvents(run.id);
    expect(events[0]).toMatchObject({ kind: "run_status", payload: { status: "running" } });
    expect(events.at(-1)).toMatchObject({ kind: "run_status", payload: { status: "error" } });
    expect(events.filter((event) => event.kind === "run_status")).toHaveLength(2);
    expect(requestHeaders).toEqual([expect.objectContaining({ "x-semprec-agent-run-id": run.id })]);
  });
});
