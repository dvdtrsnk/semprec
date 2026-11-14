import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { McpInvokeTool } from "@semprec/agent-runtime";
import { runInTenant } from "@semprec/shared";
import {
  createItemWithClient,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  requestSempTurnCancel,
  retrySempReply,
  seedSystem,
  sendSempMessage,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
  type SempTurnCancelListener,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { mcpModelToolName } from "../agentSessionComposition.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { startSempTurnCancelWiring } from "../sempTurnCancelListener.js";

// The MCP invoker is replaced by a tool call that never returns on its own, so a turn can be stopped while the call
// has no result.
const mcpInvoke = vi.hoisted(() => ({ override: undefined as undefined | ((serverItemId: string) => McpInvokeTool) }));

vi.mock("@semprec/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/agent-runtime")>();
  return {
    ...actual,
    createApprovalGatedMcpInvokeTool: (...args: Parameters<typeof actual.createApprovalGatedMcpInvokeTool>) => {
      const serverItemId = args[5];
      return mcpInvoke.override && serverItemId !== undefined
        ? mcpInvoke.override(serverItemId)
        : actual.createApprovalGatedMcpInvokeTool(...args);
    },
  };
});

/**
 * The turn of a retried Semp reply (issue gh-1926), through the real turn handler, the real queue runtime, the real
 * history reconstruction and the real agent session; only the model is a faux provider and the MCP call is a call
 * that waits for its abort. The retry is queued by `retrySempReply`, the store function behind the route
 * (`sempRetry.test.ts` of `semprec-api` covers the route). Everything runs on the runtime role pool.
 */

/** The text `pairDanglingToolCalls` stores as the result of a call that a cancelled turn left without one. */
const PAIRED_RESULT_TEXT = "Turn cancelled before this tool call completed.";

let admin: Pool;
let pool: Pool;
let registry: ModuleRegistry;
let tenant: string;
let userId: string;
let runtime: AgentsQueueRuntime | undefined;
let listener: SempTurnCancelListener | undefined;

interface StoredMessage {
  status: string;
  text: string | null;
  error_code: string | null;
  agent_run_id: string | null;
}

function readMessage(id: string): Promise<StoredMessage | undefined> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<StoredMessage>(
      "SELECT status, text, error_code, agent_run_id FROM semp_messages WHERE id = $1",
      [id],
    );
    return rows[0];
  });
}

async function awaitStatus(id: string, status: "running" | "done" | "error"): Promise<StoredMessage> {
  const deadline = Date.now() + 20_000;
  let row = await readMessage(id);
  while (row?.status !== status && Date.now() < deadline) {
    await sleep(50);
    row = await readMessage(id);
  }
  if (row?.status !== status) throw new Error(`The message did not reach ${status}: ${row?.status ?? "missing"}`);
  return row;
}

function gatewayFor(responses: FauxResponseStep[]): GatewayModel {
  const faux = fauxProvider();
  faux.setResponses(responses);
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => false,
  };
}

async function createMcpFixture(toolName: string): Promise<{ serverItemId: string }> {
  const fixture = await runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      const servers = await getDatabaseByModuleId(client, "mcpServers");
      if (!inbox?.ownerProjectItemId || !servers) throw new Error("Missing seeded databases");
      const created = await createItemWithClient(
        client,
        { databaseId: servers.id, properties: { name: "Calendar", active: true } },
        { humanWriterUserId: userId },
      );
      return { projectItemId: inbox.ownerProjectItemId, serverItemId: created.id };
    }),
  );
  const registration = await runInTenant(tenant, () =>
    upsertMcpToolRegistration(pool, {
      mcpServerItemId: fixture.serverItemId,
      toolName,
      toolSchema: { type: "object", properties: { query: { type: "string" } } },
    }),
  );
  await runInTenant(tenant, () =>
    withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, {
        projectItemId: fixture.projectItemId,
        mcpToolRegistrationId: registration.id,
        granted: true,
      }),
    ),
  );
  return { serverItemId: fixture.serverItemId };
}

describe("the turn of a retried Semp reply", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    tenant = await createTestTenant(admin);
    userId = (
      await createUser(admin, {
        tenantId: tenant,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        role: "admin",
      })
    ).id;
    await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mcpInvoke.override = undefined;
    await listener?.close();
    listener = undefined;
    await runtime?.stop();
    runtime = undefined;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("runs the retry of a turn that was stopped with a tool call without a result, with the original question sent again", async () => {
    let toolEntered!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      toolEntered = resolve;
    });
    mcpInvoke.override = () => (_args, signal) => {
      toolEntered();
      // A tool call that returns only when it is aborted.
      return new Promise((_, reject) => {
        if (signal?.aborted) reject(new Error("tool aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
      });
    };
    const fixture = await createMcpFixture("events");
    const retryContexts: string[] = [];
    // The aborted turn may ask the model once more before it notices the abort, so every later call is answered by the
    // same step, and only the calls of the retry are recorded: they are the ones whose history holds the synthetic result.
    const answer: FauxResponseStep = (context) => {
      const serialized = JSON.stringify(context.messages);
      if (serialized.includes(PAIRED_RESULT_TEXT)) retryContexts.push(serialized);
      return fauxAssistantMessage("answer of the retry");
    };
    const inFlight = createInFlightAgentRuns();
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(
        pool,
        registry,
        gatewayFor([
          () =>
            fauxAssistantMessage(
              [fauxToolCall(mcpModelToolName("events", fixture.serverItemId), {}, { id: "mcp-1" })],
              {
                stopReason: "toolUse",
              },
            ),
          answer,
          answer,
          answer,
        ]),
        inFlight,
      ),
    });
    listener = await startSempTurnCancelWiring(pool, inFlight);
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { text: "the original question", context: [], hasContext: false }),
      ),
    );
    await Promise.race([
      toolStarted,
      sleep(10_000).then(() => Promise.reject(new Error("The tool call did not start"))),
    ]);
    // The run log is written behind the session: the call is dangling only once its `tool_use` is stored.
    await vi.waitFor(
      async () => {
        const stored = await runInTenant(tenant, () =>
          pool.query(
            "SELECT 1 FROM agent_run_events e JOIN semp_messages m ON m.agent_run_id = e.agent_run_id WHERE m.id = $1 AND e.kind = 'tool_use'",
            [first.assistantMessageId],
          ),
        );
        expect(stored.rowCount).toBe(1);
      },
      { timeout: 10_000 },
    );
    await requestSempTurnCancel(pool, { tenantId: tenant, assistantMessageId: first.assistantMessageId });
    const failed = await awaitStatus(first.assistantMessageId, "error");
    expect(failed.error_code).toBe("cancelled");

    const retried = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => retrySempReply(client, first.threadId, first.assistantMessageId)),
    );

    expect(await awaitStatus(retried.messageId, "done")).toMatchObject({ status: "done", text: "answer of the retry" });
    // The retry started a run of its own and sent the first user message again, resolved through
    // `reply_to_message_id`: the message before the retry in the thread is the failed reply, which has no text.
    const failedRun = failed.agent_run_id;
    const retriedRun = (await readMessage(retried.messageId))?.agent_run_id;
    expect(retriedRun).toBeTruthy();
    expect(retriedRun).not.toBe(failedRun);
    expect(retryContexts).toHaveLength(1);
    const context = retryContexts[0] ?? "";
    // The tool call of the failed attempt stays in the history with the synthetic result of the pairing, and the
    // question is in the model's input twice: once from the failed attempt and once as the retry's new user turn.
    expect(context).toContain("mcp-1");
    expect(context).toContain(PAIRED_RESULT_TEXT);
    expect(context.split("the original question")).toHaveLength(3);
    const stored = await runInTenant(tenant, () =>
      pool.query<{ attempt: number; reply_to_message_id: string | null }>(
        "SELECT attempt, reply_to_message_id FROM semp_messages WHERE id = $1",
        [retried.messageId],
      ),
    );
    expect(stored.rows).toEqual([{ attempt: 2, reply_to_message_id: first.messageId }]);
  });
});
