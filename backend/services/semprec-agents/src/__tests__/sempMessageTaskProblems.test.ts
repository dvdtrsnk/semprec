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
  retrySempReply,
  seedSystem,
  sendSempMessage,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { mcpModelToolName } from "../agentSessionComposition.js";
import { createInFlightAgentRuns, type InFlightAgentRuns } from "../inFlightAgentRuns.js";
import type { GatewayModel } from "../modelComposition.js";
import { createSempMessageTask } from "../sempMessageTask.js";

// The MCP invoker is replaced for the incomplete-reply tests only, to make a tool call fail with a timeout at once.
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

// The invalidation after a stored result is made to throw for the rollback tests: it runs inside the result
// transaction after the problem is raised or resolved, so a throw there rolls the whole transaction back.
const publish = vi.hoisted(() => ({ failWith: undefined as undefined | Error }));

vi.mock("@semprec/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/data")>();
  return {
    ...actual,
    publishSempThreadInvalidation: (...args: Parameters<typeof actual.publishSempThreadInvalidation>) => {
      if (publish.failWith) throw publish.failWith;
      return actual.publishSempThreadInvalidation(...args);
    },
  };
});

/**
 * The problem of a failed Semp reply (issue #1931), through the real turn handler, the real agent session and the
 * real problem store; only the model is a faux provider. Each turn is run by calling the handler directly, so a
 * turn that fails to store its result surfaces as the handler's rejection. Everything runs on the runtime role pool.
 */

let admin: Pool;
let pool: Pool;
let registry: ModuleRegistry;
let tenant: string;
let userId: string;
let otherTenant: string;
let counter = 0;

interface StoredMessage {
  status: string;
  error_code: string | null;
  updated_at: Date;
}

interface StoredProblem {
  category: string;
  kind: string;
  severity: string;
  source_table: string;
  source_id: string;
  occurrence_count: number;
  first_seen_at: Date;
  resolved_at: Date | null;
  resolution_kind: string | null;
}

const MODEL_ERROR = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused the request" });

function gatewayFor(responses: FauxResponseStep[]): GatewayModel {
  const faux = fauxProvider();
  faux.setResponses(responses);
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => false,
  };
}

interface SentTurn {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
}

async function send(inTenant: string, threadId?: string): Promise<SentTurn> {
  return runInTenant(inTenant, () =>
    withTransaction(pool, async (client) => {
      const sent = await sendSempMessage(client, {
        ...(threadId ? { threadId } : {}),
        text: `question ${(counter += 1)}`,
        context: [],
        hasContext: false,
      });
      const { rows } = await client.query<{ reply_to_message_id: string | null }>(
        "SELECT reply_to_message_id FROM semp_messages WHERE id = $1",
        [sent.assistantMessageId],
      );
      const userMessageId = rows[0]?.reply_to_message_id;
      if (!userMessageId) throw new Error("The reply answers no message");
      return { threadId: sent.threadId, userMessageId, assistantMessageId: sent.assistantMessageId };
    }),
  );
}

/** Queues another attempt of the reply `turn` through the store function behind the retry route. */
async function retry(turn: SentTurn, failedMessageId: string): Promise<SentTurn> {
  const retried = await runInTenant(tenant, () =>
    withTransaction(pool, (client) => retrySempReply(client, turn.threadId, failedMessageId)),
  );
  return { ...turn, assistantMessageId: retried.messageId };
}

/** Runs the turn handler once for `turn` with a model that answers `responses`; resolves with its outcome. */
function runTurn(
  turn: SentTurn,
  responses: FauxResponseStep[],
  options: { inTenant?: string; inFlight?: InFlightAgentRuns } = {},
): Promise<void> {
  const task = createSempMessageTask(
    pool,
    registry,
    gatewayFor(responses),
    options.inFlight ?? createInFlightAgentRuns(),
  );
  return runInTenant(options.inTenant ?? tenant, () =>
    task(
      { threadId: turn.threadId, assistantMessageId: turn.assistantMessageId },
      { job: { id: `job-${turn.assistantMessageId}` } },
    ),
  );
}

function readMessage(id: string): Promise<StoredMessage> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<StoredMessage>(
      "SELECT status, error_code, updated_at FROM semp_messages WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error("The message is missing");
    return row;
  });
}

function readProblems(inTenant: string, userMessageId: string): Promise<StoredProblem[]> {
  return runInTenant(inTenant, async () => {
    const { rows } = await pool.query<StoredProblem>(
      `SELECT category, kind, severity, source_table, source_id, occurrence_count, first_seen_at, resolved_at,
              resolution_kind FROM semp_problems WHERE dedupe_key = $1 ORDER BY first_seen_at, id`,
      [`agents:reply:${userMessageId}`],
    );
    return rows;
  });
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

/** A model that waits for its abort, and a promise that settles once the turn reached it. */
function hangingModel(): { step: FauxResponseStep; entered: Promise<void> } {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const step: FauxResponseStep = async (_context, options) => {
    const signal = options?.signal;
    if (!signal) throw new Error("Missing provider abort signal");
    enter();
    return new Promise((_, reject) => {
      if (signal.aborted) reject(new Error("provider aborted"));
      else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
    });
  };
  return { step, entered };
}

describe("the problem of a failed Semp reply", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    tenant = await createTestTenant(admin);
    otherTenant = await createTestTenant(admin);
    userId = (await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" }))
      .id;
    await createUser(admin, { tenantId: otherTenant, email: `${randomUUID()}@example.test`, passwordHash: "x" });
    await runInTenant(tenant, () => seedSystem(pool));
    await runInTenant(otherTenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterEach(() => {
    mcpInvoke.override = undefined;
    publish.failWith = undefined;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("raises one active agents warning for a reply that ends in error, in the transaction that stores the error", async () => {
    const turn = await send(tenant);

    await runTurn(turn, [MODEL_ERROR]);

    const message = await readMessage(turn.assistantMessageId);
    expect(message).toMatchObject({ status: "error", error_code: "modelError" });
    const problems = await readProblems(tenant, turn.userMessageId);
    expect(problems).toEqual([
      {
        category: "agents",
        kind: "reply",
        severity: "warning",
        source_table: "semp_messages",
        source_id: turn.assistantMessageId,
        occurrence_count: 1,
        // `now()` is the start of the transaction: the problem and the stored error carry the same instant.
        first_seen_at: message.updated_at,
        resolved_at: null,
        resolution_kind: null,
      },
    ]);
  });

  it("keeps one problem with occurrence count 2 when the retry of the reply fails again", async () => {
    const turn = await send(tenant);
    await runTurn(turn, [MODEL_ERROR]);
    const retried = await retry(turn, turn.assistantMessageId);

    await runTurn(retried, [MODEL_ERROR]);

    expect(await readMessage(retried.assistantMessageId)).toMatchObject({ status: "error" });
    const problems = await readProblems(tenant, turn.userMessageId);
    expect(problems).toHaveLength(1);
    // The retry is the latest attempt, the only one the retry route accepts: the problem's source points at it.
    expect(problems[0]).toMatchObject({
      occurrence_count: 2,
      resolved_at: null,
      source_id: retried.assistantMessageId,
    });
  });

  it("resolves the problem as recovered in the transaction that stores the successful retry", async () => {
    const turn = await send(tenant);
    await runTurn(turn, [MODEL_ERROR]);
    const retried = await retry(turn, turn.assistantMessageId);

    await runTurn(retried, [fauxAssistantMessage("the answer")]);

    const message = await readMessage(retried.assistantMessageId);
    expect(message).toMatchObject({ status: "done", error_code: null });
    const problems = await readProblems(tenant, turn.userMessageId);
    expect(problems).toHaveLength(1);
    // `now()` is the start of the transaction: the resolution and the stored result carry the same instant.
    expect(problems[0]).toMatchObject({ resolution_kind: "recovered", resolved_at: message.updated_at });
  });

  it("raises no problem for a reply that succeeds at the first attempt", async () => {
    const turn = await send(tenant);

    await runTurn(turn, [fauxAssistantMessage("the answer")]);

    expect(await readMessage(turn.assistantMessageId)).toMatchObject({ status: "done" });
    expect(await readProblems(tenant, turn.userMessageId)).toEqual([]);
  });

  it("raises the problem for a reply that is done but left a failed tool call, and resolves it when a retry is complete", async () => {
    const { serverItemId } = await createMcpFixture("events");
    mcpInvoke.override = (serverId) => async () => ({
      error: true,
      result: "the calendar timed out",
      failure: { failureKind: "timeout", mcpServerItemId: serverId, timeoutMs: 60000 },
    });
    const turn = await send(tenant);

    await runTurn(turn, [
      fauxAssistantMessage([fauxToolCall(mcpModelToolName("events", serverItemId), {}, { id: "mcp-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("I could not read the calendar"),
    ]);

    expect(await readMessage(turn.assistantMessageId)).toMatchObject({ status: "done" });
    const incomplete = await readProblems(tenant, turn.userMessageId);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({ kind: "reply", occurrence_count: 1, resolved_at: null });

    const retried = await retry(turn, turn.assistantMessageId);
    await runTurn(retried, [fauxAssistantMessage("nothing to look up")]);

    const resolved = await readProblems(tenant, turn.userMessageId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ resolution_kind: "recovered" });
    expect(resolved[0]?.resolved_at).toBeInstanceOf(Date);
  });

  it("raises no problem for a turn the user stopped, and leaves an active problem of the reply as it was", async () => {
    const stopped = await send(tenant);
    const hang = hangingModel();
    const inFlight = createInFlightAgentRuns();
    const running = runTurn(stopped, [hang.step], { inFlight });
    await Promise.race([
      hang.entered,
      sleep(10_000).then(() => Promise.reject(new Error("The turn did not reach the model"))),
    ]);
    expect(inFlight.abortTenant(tenant)).toBe(1);
    await running;

    expect(await readMessage(stopped.assistantMessageId)).toMatchObject({ status: "error", error_code: "cancelled" });
    expect(await readProblems(tenant, stopped.userMessageId)).toEqual([]);

    const failed = await send(tenant);
    await runTurn(failed, [MODEL_ERROR]);
    const retried = await retry(failed, failed.assistantMessageId);
    const hangRetry = hangingModel();
    const retryInFlight = createInFlightAgentRuns();
    const runningRetry = runTurn(retried, [hangRetry.step], { inFlight: retryInFlight });
    await Promise.race([
      hangRetry.entered,
      sleep(10_000).then(() => Promise.reject(new Error("The retry did not reach the model"))),
    ]);
    expect(retryInFlight.abortTenant(tenant)).toBe(1);
    await runningRetry;

    expect(await readMessage(retried.assistantMessageId)).toMatchObject({ status: "error", error_code: "cancelled" });
    const problems = await readProblems(tenant, failed.userMessageId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ occurrence_count: 1, resolved_at: null });
  });

  it("raises the problem for an interrupted turn like for an error", async () => {
    const turn = await send(tenant);
    const hang = hangingModel();
    const inFlight = createInFlightAgentRuns();
    const running = runTurn(turn, [hang.step], { inFlight });
    await Promise.race([
      hang.entered,
      sleep(10_000).then(() => Promise.reject(new Error("The turn did not reach the model"))),
    ]);
    expect(inFlight.abortSemp()).toBe(1);
    await running;

    expect(await readMessage(turn.assistantMessageId)).toMatchObject({ status: "error", error_code: "interrupted" });
    const problems = await readProblems(tenant, turn.userMessageId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "reply", severity: "warning", occurrence_count: 1, resolved_at: null });
  });

  it("raises no problem for a turn that fails before it has a message to answer", async () => {
    const turn = await send(tenant);
    // The column is nullable and the send path always sets it; a raw UPDATE on the admin pool builds the state that
    // makes the handler fail on a source it cannot find, which no production writer leaves on a queued reply.
    await admin.query("UPDATE semp_messages SET reply_to_message_id = NULL WHERE id = $1", [turn.assistantMessageId]);

    await runTurn(turn, []);

    expect(await readMessage(turn.assistantMessageId)).toMatchObject({ status: "error", error_code: "internal" });
    const { rows } = await admin.query<{ count: string }>(
      "SELECT count(*) FROM semp_problems WHERE tenant_id = $1 AND source_id = $2",
      [tenant, turn.assistantMessageId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("leaves no problem and no stored error when the transaction of a failed result rolls back", async () => {
    const turn = await send(tenant);
    publish.failWith = new Error("invalidation failed inside the result transaction");

    await expect(runTurn(turn, [MODEL_ERROR])).rejects.toThrow();

    publish.failWith = undefined;
    expect(await readMessage(turn.assistantMessageId)).toMatchObject({ status: "running", error_code: null });
    expect(await readProblems(tenant, turn.userMessageId)).toEqual([]);
  });

  it("keeps the problem active when the transaction of a successful retry rolls back", async () => {
    const turn = await send(tenant);
    await runTurn(turn, [MODEL_ERROR]);
    const retried = await retry(turn, turn.assistantMessageId);
    publish.failWith = new Error("invalidation failed inside the result transaction");

    await expect(runTurn(retried, [fauxAssistantMessage("the answer")])).rejects.toThrow();

    publish.failWith = undefined;
    expect(await readMessage(retried.assistantMessageId)).toMatchObject({ status: "running" });
    const problems = await readProblems(tenant, turn.userMessageId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ occurrence_count: 1, resolved_at: null, resolution_kind: null });
  });

  it("does not store the error of a reply whose problem could not be written", async () => {
    const turn = await send(tenant);
    const suffix = randomUUID().replaceAll("-", "");
    const name = `test_reply_problem_${suffix}`;
    // Fault injection on the one synthetic message of this test, in this suite's owned database. The identifiers hold
    // a fixed prefix and hex only, and the embedded value is a UUID taken from the database.
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(turn.assistantMessageId))
      throw new Error("Invalid fixture message UUID");
    await admin.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id = '${turn.assistantMessageId}'::uuid THEN RAISE EXCEPTION 'problem write failed'; END IF; RETURN NEW; END $$`,
    );
    await admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON semp_problems FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await expect(runTurn(turn, [MODEL_ERROR])).rejects.toThrow();
    } finally {
      await admin.query(`DROP TRIGGER ${name} ON semp_problems`);
      await admin.query(`DROP FUNCTION ${name}()`);
    }

    expect(await readMessage(turn.assistantMessageId)).toMatchObject({ status: "running", error_code: null });
    expect(await readProblems(tenant, turn.userMessageId)).toEqual([]);
  });

  it("keeps the problem of one tenant out of another tenant's view", async () => {
    const turn = await send(tenant);
    await runTurn(turn, [MODEL_ERROR]);
    const foreign = await send(otherTenant);
    await runTurn(foreign, [MODEL_ERROR], { inTenant: otherTenant });

    expect(await readProblems(tenant, turn.userMessageId)).toHaveLength(1);
    expect(await readProblems(otherTenant, turn.userMessageId)).toEqual([]);
    expect(await readProblems(otherTenant, foreign.userMessageId)).toHaveLength(1);
    expect(await readProblems(tenant, foreign.userMessageId)).toEqual([]);
  });
});
