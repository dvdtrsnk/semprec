import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { McpInvokeTool } from "@semprec/agent-runtime";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createItemWithClient,
  createUser,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  sendSempMessage,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { mcpModelToolName } from "../agentSessionComposition.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import { logger } from "../logger.js";
import type { GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";

// The MCP invoker is replaced for one test only, to make a tool call fail with a timeout at once: a real one waits
// for the 60 s tool-call timeout. Everything around the invoker (the grant, the tool composition, the stored run
// events, the step summary, the classification and the stored message) is the production code.
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
 * How a Semp turn that fails is stored (issue #1907), through the real queue runtime, the real turn handler and the
 * real agent session; only the model is a faux provider. Everything runs on the runtime role pool.
 */

let admin: Pool;
let pool: Pool;
let tenant: string;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;

interface StoredFailure {
  status: string;
  text: string | null;
  error_code: string | null;
  error_params: unknown;
  agent_run_id: string | null;
}

const EXCEPTION_TEXT = "RAW-EXCEPTION-TEXT the user asked about the Salary review";

function readMessage(id: string): Promise<StoredFailure | undefined> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<StoredFailure>(
      "SELECT status, text, error_code, error_params, agent_run_id FROM semp_messages WHERE id = $1",
      [id],
    );
    return rows[0];
  });
}

async function awaitFinal(id: string): Promise<StoredFailure> {
  const deadline = Date.now() + 20_000;
  let row = await readMessage(id);
  while ((row?.status === "queued" || row?.status === "running") && Date.now() < deadline) {
    await sleep(50);
    row = await readMessage(id);
  }
  if (!row) throw new Error("The message is missing");
  return row;
}

function gatewayFor(responses: FauxResponseStep[], isBudgetRefusal: boolean): GatewayModel {
  const faux = fauxProvider();
  faux.setResponses(responses);
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => isBudgetRefusal,
  };
}

function send(text: string) {
  return runInTenant(tenant, () =>
    withTransaction(pool, (client) => sendSempMessage(client, { text, context: [], hasContext: false })),
  );
}

/** Runs one turn on a model that fails with `errorMessage` and returns the stored message. */
async function failedModelTurn(errorMessage: string, isBudgetRefusal: boolean): Promise<StoredFailure> {
  runtime = await createAgentsQueueRuntime(pool, registry, {
    sempMessageTask: createSempMessageTask(
      pool,
      registry,
      gatewayFor([fauxAssistantMessage("", { stopReason: "error", errorMessage })], isBudgetRefusal),
      createInFlightAgentRuns(),
    ),
  });
  const sent = await send("fail");
  return awaitFinal(sent.assistantMessageId);
}

describe("a Semp turn that fails", () => {
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
    tenant = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mcpInvoke.override = undefined;
    await runtime?.stop();
    runtime = undefined;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("stores budgetExceeded when the gateway refused the call for the budget, whatever the model's error text says", async () => {
    const stored = await failedModelTurn("provider refused the request", true);

    expect(stored).toMatchObject({ status: "error", text: null, error_code: "budgetExceeded", error_params: {} });
  });

  it("does not take budgetExceeded from the text: a model error that speaks of a budget is a modelError", async () => {
    const stored = await failedModelTurn("AI budget exceeded", false);

    expect(stored).toMatchObject({ status: "error", error_code: "modelError", error_params: {} });
  });

  it("stores cancelled when the tenant's in-flight turn is aborted", async () => {
    const inFlight = createInFlightAgentRuns();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hang: FauxResponseStep = async (_context, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Missing provider abort signal");
      entered();
      return new Promise((_, reject) => {
        if (signal.aborted) reject(new Error("provider aborted"));
        else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
      });
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gatewayFor([hang], false), inFlight),
    });
    const sent = await send("abort me");
    await Promise.race([
      started,
      sleep(10_000).then(() => {
        throw new Error("The turn did not reach the model");
      }),
    ]);

    expect(inFlight.abortTenant(tenant)).toBe(1);
    const stored = await awaitFinal(sent.assistantMessageId);

    expect(stored).toMatchObject({ status: "error", error_code: "cancelled" });
  });

  it("stores internal when the turn throws for a reason that is no run error", async () => {
    // The source message is sent with no runtime running, then its text is removed by a raw UPDATE on the admin
    // pool: no production path leaves a user message without text, which is what makes the handler throw an
    // ordinary Error before the model is reached.
    const sent = await send("to be emptied");
    await admin.query("UPDATE semp_messages SET text = NULL WHERE thread_id = $1 AND id <> $2 AND role = 'user'", [
      sent.threadId,
      sent.assistantMessageId,
    ]);
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gatewayFor([], false), createInFlightAgentRuns()),
    });

    const stored = await awaitFinal(sent.assistantMessageId);

    expect(stored).toMatchObject({ status: "error", text: null, error_code: "internal", error_params: {} });
  });

  it("logs the code, the message id and the run id of a failed turn and no exception text", async () => {
    const lines: unknown[][] = [];
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
        return undefined;
      });
    }
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(
        pool,
        registry,
        gatewayFor([fauxAssistantMessage("", { stopReason: "error", errorMessage: EXCEPTION_TEXT })], false),
        createInFlightAgentRuns(),
      ),
    });
    const sent = await send("log me");
    const stored = await awaitFinal(sent.assistantMessageId);

    expect(stored.error_code).toBe("modelError");
    expect(lines).toContainEqual([
      {
        threadId: sent.threadId,
        assistantMessageId: sent.assistantMessageId,
        agentRunId: stored.agent_run_id,
        errorCode: "modelError",
      },
      "Semp turn failed",
    ]);
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain("RAW-EXCEPTION-TEXT");
    expect(everything).not.toContain("Salary review");
    expect(JSON.stringify(stored)).not.toContain("RAW-EXCEPTION-TEXT");
  });

  it("stores the failed step, connector and timeout of the reply when the turn fails after an MCP tool timed out", async () => {
    const users = await admin.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [tenant]);
    const user = users.rows[0];
    if (!user) throw new Error("The tenant has no user");
    const fixture = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        const servers = await getDatabaseByModuleId(client, "mcpServers");
        if (!inbox?.ownerProjectItemId || !servers) throw new Error("Missing seeded databases");
        const server = await createItemWithClient(
          client,
          { databaseId: servers.id, properties: { name: "Calendar", active: true } },
          { humanWriterUserId: user.id },
        );
        return { projectItemId: inbox.ownerProjectItemId, serverItemId: server.id };
      }),
    );
    const registration = await runInTenant(tenant, () =>
      upsertMcpToolRegistration(pool, {
        mcpServerItemId: fixture.serverItemId,
        toolName: "events",
        toolSchema: { type: "object" },
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
    mcpInvoke.override = (serverItemId) => async () => ({
      error: true,
      result: EXCEPTION_TEXT,
      failure: { failureKind: "timeout", mcpServerItemId: serverItemId, timeoutMs: 60000 },
    });
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(
        pool,
        registry,
        gatewayFor(
          [
            fauxAssistantMessage(
              [fauxToolCall(mcpModelToolName("events", fixture.serverItemId), {}, { id: "mcp-1" })],
              {
                stopReason: "toolUse",
              },
            ),
            fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused the request" }),
          ],
          false,
        ),
        createInFlightAgentRuns(),
      ),
    });
    const sent = await send("what is in my calendar");

    const stored = await awaitFinal(sent.assistantMessageId);

    expect(stored).toMatchObject({
      status: "error",
      error_code: "modelError",
      error_params: {
        failedStep: { key: expect.stringMatching(/^agentStep\.title\./), params: expect.any(Object) },
        connectorName: "Calendar",
        timeoutMs: 60000,
      },
    });
    expect(JSON.stringify(stored.error_params)).not.toContain("RAW-EXCEPTION-TEXT");
  });
});
