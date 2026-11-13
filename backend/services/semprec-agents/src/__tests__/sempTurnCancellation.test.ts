import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { McpInvokeTool } from "@semprec/agent-runtime";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createActionRegistry,
  createCoreTaskList,
  createItemWithClient,
  createUser,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  requestSempTurnCancel,
  seedSystem,
  sendSempMessage,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
  type SempTurnCancelListener,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { startStdioContractServer, type StdioContractServer } from "@semprec/data/testSupport/mcpContractServers";
import type { ModuleRegistry } from "@semprec/module-registry";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { mcpModelToolName } from "../agentSessionComposition.js";
import { createInFlightAgentRuns, type InFlightAgentRuns } from "../inFlightAgentRuns.js";
import { withInFlightRegistration } from "../agentRunTasks.js";
import { logger } from "../logger.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { startSempTurnCancelWiring } from "../sempTurnCancelListener.js";

// The MCP invoker is replaced for the tests that need a tool call that never returns on its own; the approval test
// leaves it unset and runs the real approval-gated invoker against a real stdio MCP server.
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
 * Cancelling one running Semp turn (issue #2019), through the real notification, the real listener wiring of
 * `serve.ts`, the real queue runtime, the real turn handler and the real agent session; only the model is a faux
 * provider. Everything runs on the runtime role pool.
 */

let admin: Pool;
let pool: Pool;
let registry: ModuleRegistry;
let tenantA: string;
let tenantB: string;
let userA: string;
let runtime: AgentsQueueRuntime | undefined;
let listener: SempTurnCancelListener | undefined;
let server: StdioContractServer | undefined;
const releases: Array<() => void> = [];

interface StoredMessage {
  status: string;
  text: string | null;
  error_code: string | null;
  agent_run_id: string | null;
}

function readMessage(tenant: string, id: string): Promise<StoredMessage | undefined> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<StoredMessage>(
      "SELECT status, text, error_code, agent_run_id FROM semp_messages WHERE id = $1",
      [id],
    );
    return rows[0];
  });
}

async function awaitStatus(tenant: string, id: string, status: "running" | "done" | "error"): Promise<StoredMessage> {
  const deadline = Date.now() + 20_000;
  let row = await readMessage(tenant, id);
  while (row?.status !== status && Date.now() < deadline) {
    await sleep(50);
    row = await readMessage(tenant, id);
  }
  if (row?.status !== status) throw new Error(`The message did not reach ${status}: ${row?.status ?? "missing"}`);
  return row;
}

function send(tenant: string, text: string, threadId?: string) {
  return runInTenant(tenant, () =>
    withTransaction(pool, (client) =>
      sendSempMessage(client, { ...(threadId ? { threadId } : {}), text, context: [], hasContext: false }),
    ),
  );
}

/** A model call that stays open until it is aborted or released, and says when it was entered. */
function holdingStep(): {
  step: FauxResponseStep;
  entered: Promise<void>;
  aborted: () => boolean;
  release: (text: string) => void;
} {
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let wasAborted = false;
  let release: (message: AssistantMessage) => void = () => {};
  const step: FauxResponseStep = (_context, options) => {
    const signal = options?.signal;
    if (!signal) throw new Error("Missing provider abort signal");
    entered();
    return new Promise((resolve, reject) => {
      release = resolve;
      const onAbort = () => {
        wasAborted = true;
        reject(new Error("provider aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const releaseText = (text: string) => release(fauxAssistantMessage(text));
  releases.push(() => releaseText("released at cleanup"));
  return { step, entered: enteredPromise, aborted: () => wasAborted, release: releaseText };
}

function withinTenSeconds(entered: Promise<void>, what: string): Promise<void> {
  return Promise.race([
    entered,
    sleep(10_000).then(() => {
      throw new Error(`${what} did not start`);
    }),
  ]);
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

/** Starts the queue runtime and the cancel wiring over one registry, as `serve.ts` does. */
async function startProcess(responses: FauxResponseStep[]): Promise<InFlightAgentRuns> {
  const inFlight = createInFlightAgentRuns();
  runtime = await createAgentsQueueRuntime(pool, registry, {
    sempMessageTask: createSempMessageTask(pool, registry, gatewayFor(responses), inFlight),
  });
  listener = await startSempTurnCancelWiring(pool, inFlight);
  return inFlight;
}

interface McpFixture {
  projectItemId: string;
  serverItemId: string;
}

async function createMcpFixture(
  tenant: string,
  userId: string,
  toolName: string,
  connectionConfig?: object,
): Promise<McpFixture> {
  const fixture = await runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      const servers = await getDatabaseByModuleId(client, "mcpServers");
      if (!inbox?.ownerProjectItemId || !servers) throw new Error("Missing seeded databases");
      const created = await createItemWithClient(
        client,
        {
          databaseId: servers.id,
          properties: { name: "Calendar", active: true, ...(connectionConfig ? { connectionConfig } : {}) },
        },
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
  return fixture;
}

describe("cancelling one running Semp turn", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    userA = (
      await createUser(admin, {
        tenantId: tenantA,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        role: "admin",
      })
    ).id;
    await createUser(admin, { tenantId: tenantB, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mcpInvoke.override = undefined;
    for (const release of releases.splice(0)) release();
    await listener?.close();
    listener = undefined;
    await runtime?.stop();
    runtime = undefined;
    await server?.stop();
    server = undefined;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("aborts the requested turn only: a pairing of another tenant, an unknown id and a turn of another tenant change nothing", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const holdA = holdingStep();
    const holdB = holdingStep();
    await startProcess([holdA.step, holdB.step]);
    const sentA = await send(tenantA, "turn of tenant A");
    await withinTenSeconds(holdA.entered, "the turn of tenant A");
    const sentB = await send(tenantB, "turn of tenant B");
    await withinTenSeconds(holdB.entered, "the turn of tenant B");

    // Notifications reach one listener in the order they were sent, so the three requests below are handled before the
    // fourth, which is the only one that names a running turn under its own tenant.
    await requestSempTurnCancel(pool, { tenantId: tenantB, assistantMessageId: sentA.assistantMessageId });
    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: sentB.assistantMessageId });
    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: randomUUID() });
    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: sentA.assistantMessageId });
    const cancelled = await awaitStatus(tenantA, sentA.assistantMessageId, "error");

    expect(cancelled).toMatchObject({ status: "error", error_code: "cancelled", text: null });
    expect(holdA.aborted()).toBe(true);
    const aborts = infoSpy.mock.calls.filter(([, message]) => message === "Aborted a running Semp turn on request");
    expect(aborts).toEqual([
      [{ tenantId: tenantA, assistantMessageId: sentA.assistantMessageId }, "Aborted a running Semp turn on request"],
    ]);
    // The other tenant's turn is still running and finishes normally once the model answers.
    expect(holdB.aborted()).toBe(false);
    expect((await readMessage(tenantB, sentB.assistantMessageId))?.status).toBe("running");
    holdB.release("answer of tenant B");
    expect(await awaitStatus(tenantB, sentB.assistantMessageId, "done")).toMatchObject({
      status: "done",
      text: "answer of tenant B",
    });
    const run = await runInTenant(tenantA, () =>
      pool.query<{ status: string; error_code: string | null }>(
        "SELECT status, error_code FROM agent_runs WHERE id = $1",
        [cancelled.agent_run_id],
      ),
    );
    expect(run.rows).toEqual([{ status: "error", error_code: "cancelled" }]);
  });

  it("forgets a turn once it has ended, whether it ended as done or as error", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const hold = holdingStep();
    const inFlight = await startProcess([
      fauxAssistantMessage("a finished answer"),
      () => {
        throw new Error("the model is down");
      },
      hold.step,
    ]);
    const done = await send(tenantA, "a request that is answered");
    await awaitStatus(tenantA, done.assistantMessageId, "done");
    const failed = await send(tenantA, "a request that fails", done.threadId);
    const failure = await awaitStatus(tenantA, failed.assistantMessageId, "error");
    // The reply is stored before the job returns: the registration is gone once the job has settled.
    expect(await inFlight.observeSempSettlement().wait()).toEqual([]);

    expect(failure.error_code).not.toBe("cancelled");
    for (const sent of [done, failed]) {
      expect(inFlight.abortTurn(tenantA, sent.assistantMessageId)).toBe(false);
      await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: sent.assistantMessageId });
    }
    expect(inFlight.abortTenant(tenantA)).toBe(0);
    // A late request for an ended turn reaches the listener and finds nothing to abort. The listener handles the
    // notifications in order, so once the running turn below is aborted, the two late requests were handled.
    const running = await send(tenantA, "a request that is aborted", done.threadId);
    await withinTenSeconds(hold.entered, "the third turn");
    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: running.assistantMessageId });
    await awaitStatus(tenantA, running.assistantMessageId, "error");
    const aborts = infoSpy.mock.calls.filter(([, message]) => message === "Aborted a running Semp turn on request");
    expect(aborts).toEqual([
      [{ tenantId: tenantA, assistantMessageId: running.assistantMessageId }, "Aborted a running Semp turn on request"],
    ]);
  });

  it.each([
    ["resolves", () => Promise.resolve("done")],
    ["throws", () => Promise.reject(new Error("the job failed"))],
  ] as const)("unregisters the turn of a job that %s", async (_how, work) => {
    const inFlight = createInFlightAgentRuns();
    const assistantMessageId = randomUUID();
    let signalDuring: AbortSignal | undefined;

    const outcome = runInTenant(tenantA, () =>
      withInFlightRegistration(
        pool,
        inFlight,
        (signal) => {
          signalDuring = signal;
          // While the job runs, its turn is found and aborted through the registry.
          expect(inFlight.abortTurn(tenantA, assistantMessageId)).toBe(true);
          return work();
        },
        true,
        assistantMessageId,
      ),
    );
    await Promise.allSettled([outcome]);

    expect(signalDuring?.aborted).toBe(true);
    expect(inFlight.abortTurn(tenantA, assistantMessageId)).toBe(false);
    expect(inFlight.abortTenant(tenantA)).toBe(0);
    expect(inFlight.abortSemp()).toBe(0);
  });

  it("wakes the thread for the next message after a cancelled turn", async () => {
    const hold = holdingStep();
    const prompts: string[] = [];
    await startProcess([
      hold.step,
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("answer after the stop");
      },
    ]);
    const first = await send(tenantA, "a long request");
    await withinTenSeconds(hold.entered, "the first turn");

    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: first.assistantMessageId });
    await awaitStatus(tenantA, first.assistantMessageId, "error");
    const second = await send(tenantA, "the next request", first.threadId);

    expect(await awaitStatus(tenantA, second.assistantMessageId, "done")).toMatchObject({
      status: "done",
      text: "answer after the stop",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("the next request");
  });

  it("pairs the dangling tool call of the cancelled turn and wakes the thread with it", async () => {
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
    const fixture = await createMcpFixture(tenantA, userA, "events");
    const prompts: string[] = [];
    // The aborted turn may still ask the model once more for the failed tool result before it notices the abort, so
    // every later call is answered by the same step, and only the calls that carry the next request are recorded.
    const answer: FauxResponseStep = (context) => {
      const serialized = JSON.stringify(context.messages);
      if (serialized.includes("ask again")) prompts.push(serialized);
      return fauxAssistantMessage("answer after the paired call");
    };
    await startProcess([
      () =>
        fauxAssistantMessage([fauxToolCall(mcpModelToolName("events", fixture.serverItemId), {}, { id: "mcp-1" })], {
          stopReason: "toolUse",
        }),
      answer,
      answer,
      answer,
    ]);
    const first = await send(tenantA, "what is in my calendar");
    await withinTenSeconds(toolStarted, "the tool call");
    // The run log is written behind the session: the call is dangling only once its `tool_use` is stored.
    await vi.waitFor(
      async () => {
        const stored = await runInTenant(tenantA, () =>
          pool.query(
            "SELECT 1 FROM agent_run_events e JOIN semp_messages m ON m.agent_run_id = e.agent_run_id WHERE m.id = $1 AND e.kind = 'tool_use'",
            [first.assistantMessageId],
          ),
        );
        expect(stored.rowCount).toBe(1);
      },
      { timeout: 10_000 },
    );

    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: first.assistantMessageId });
    const cancelled = await awaitStatus(tenantA, first.assistantMessageId, "error");

    expect(cancelled.error_code).toBe("cancelled");
    const events = await runInTenant(tenantA, () =>
      pool.query<{
        kind: string;
        payload: { toolCallId?: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } };
      }>(
        "SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind IN ('tool_use', 'tool_result') ORDER BY id",
        [cancelled.agent_run_id],
      ),
    );
    expect(events.rows.map((row) => [row.kind, row.payload.toolCallId])).toEqual([
      ["tool_use", "mcp-1"],
      ["tool_result", "mcp-1"],
    ]);
    // The synthetic result of the pairing (`pairDanglingToolCalls`), not a result the aborted tool produced.
    expect(events.rows[1]?.payload.isError).toBe(true);
    expect(events.rows[1]?.payload.result?.content?.[0]?.text).toBe("Turn cancelled before this tool call completed.");
    const second = await send(tenantA, "ask again", first.threadId);
    expect(await awaitStatus(tenantA, second.assistantMessageId, "done")).toMatchObject({
      status: "done",
      text: "answer after the paired call",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("mcp-1");
  });

  it("leaves the approval request of a cancelled turn pending and executes its write only after the approval", async () => {
    server = startStdioContractServer();
    const fixture = await createMcpFixture(tenantA, userA, "search_web", server.connectionConfig);
    const hold = holdingStep();
    await startProcess([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(
              mcpModelToolName("search_web", fixture.serverItemId),
              { query: "closed fixture" },
              { id: "approval-call" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
      hold.step,
    ]);
    const sent = await send(tenantA, "run the tool");
    await withinTenSeconds(hold.entered, "the model call after the approval request");
    const requestRows = await runInTenant(tenantA, () =>
      pool.query<{ id: string }>(
        "SELECT a.id FROM approval_requests a JOIN semp_messages m ON m.tenant_id = a.tenant_id AND m.agent_run_id = a.agent_run_id WHERE m.id = $1",
        [sent.assistantMessageId],
      ),
    );
    expect(requestRows.rows).toHaveLength(1);
    const requestId = requestRows.rows[0]!.id;
    const loadRequest = () =>
      runInTenant(tenantA, () => withTransaction(pool, (client) => getApprovalRequest(client, requestId)));
    expect((await loadRequest())?.status).toBe("pending");

    await requestSempTurnCancel(pool, { tenantId: tenantA, assistantMessageId: sent.assistantMessageId });
    const cancelled = await awaitStatus(tenantA, sent.assistantMessageId, "error");

    expect(cancelled.error_code).toBe("cancelled");
    expect(hold.aborted()).toBe(true);
    const pending = await loadRequest();
    expect(pending?.status).toBe("pending");
    expect(pending?.executionStatus).toBe("not_approved");
    expect(server.getHandshakeCount()).toBe(0);
    expect(server.getLastToolCall()).toBeNull();

    await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: requestId,
          decision: "approved",
          decidedByUserId: userA,
        }),
      ),
    );
    const handler = createCoreTaskList(pool, createActionRegistry())[CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE];
    if (!handler) throw new Error("Missing approval handler");
    await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handler } });

    expect(server.getLastToolCall()).toEqual({
      name: "search_web",
      arguments: { query: "closed fixture" },
      meta: { idempotencyKey: requestId },
    });
    expect((await loadRequest())?.executionStatus).toBe("succeeded");
    // The outcome is posted to the thread of the cancelled turn.
    const outcome = await runInTenant(tenantA, () =>
      pool.query<{ system_key: string }>(
        "SELECT system_key FROM semp_messages WHERE thread_id = $1 AND role = 'system'",
        [sent.threadId],
      ),
    );
    expect(outcome.rows).toEqual([{ system_key: "approval.outcome.executed" }]);
  });
});
