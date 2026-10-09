import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createUser, finishAgentRun, hashPassword } from "@semprec/data";
import { currentTenantScope, getTraceContext, runAsSystem, runInTenant } from "@semprec/shared";
import { SEMP_BUSY_ERROR_MESSAGE, SempConversation, type SempConversationOptions } from "../sempConversation.js";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionOptions,
  ConversationEntry,
  CreateAgentSession,
} from "../types.js";

let pool: Pool;
let tenantZero: string;

function sendInTenantZero(conversation: SempConversation, task: string) {
  return runInTenant(tenantZero, () => conversation.send(task));
}

const SEMPREC_PROJECT_ITEM_ID = "99999999-9999-9999-9999-999999999999";

/** A session whose `messages()`/`send()` yield exactly the given batch, one call each. */
function scriptedSession(...batches: AgentMessage[][]): {
  createAgentSession: CreateAgentSession;
  callCount: () => number;
  tasks: string[];
  initialStates: Array<AgentSessionOptions["initialState"]>;
} {
  let call = 0;
  const tasks: string[] = [];
  const initialStates: Array<AgentSessionOptions["initialState"]> = [];
  const createAgentSession: CreateAgentSession = (options): AgentSession => {
    tasks.push(options.task);
    initialStates.push(options.initialState);
    return {
      async *messages() {
        const batch = batches[call++]!;
        for (const message of batch) yield message;
      },
      async *send(task: string) {
        tasks.push(task);
        const batch = batches[call++]!;
        for (const message of batch) yield message;
      },
    };
  };
  return { createAgentSession, callCount: () => call, tasks, initialStates };
}

/** Blocks inside its single turn until `release()` is called — for exercising the busy path. */
function blockingSession(): { createAgentSession: CreateAgentSession; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createAgentSession: CreateAgentSession = (): AgentSession => ({
    async *messages() {
      yield { kind: "turn_start" };
      await gate;
      yield { kind: "message", text: "released" };
      yield { kind: "turn_end" };
    },
  });
  return { createAgentSession, release };
}

describe("SempConversation", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantZero = getTenantZeroId();
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("wakes a session-unit, user-triggered agent_runs row on the first send and returns the final assistant message", async () => {
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "hello there" },
      { kind: "turn_end" },
    ]);
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    const result = await sendInTenantZero(conversation, "hi");

    expect(result).toEqual({ ok: true, message: "hello there" });

    const { rows } = await pool.query<{
      unit: string;
      triggered_by: string;
      parent_run_id: string | null;
      status: string;
    }>(`SELECT unit, triggered_by, parent_run_id, status FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unit).toBe("session");
    expect(rows[0]!.triggered_by).toBe("user");
    expect(rows[0]!.parent_run_id).toBeNull();
    expect(rows[0]!.status).toBe("running");

    conversation.clear();
  });

  it("reuses the same in-memory session and agent_runs row for consecutive sends", async () => {
    const { createAgentSession, callCount } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    const first = await sendInTenantZero(conversation, "one");
    const second = await sendInTenantZero(conversation, "two");

    expect(first).toEqual({ ok: true, message: "first" });
    expect(second).toEqual({ ok: true, message: "second" });
    expect(callCount()).toBe(2);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows[0].n).toBe(1);

    conversation.clear();
  });

  it("binds the run's id into the trace context on both the wake and a reused-session send (#167)", async () => {
    const observed: { traceId: string | undefined; agentRunId: string | undefined }[] = [];
    let call = 0;
    const batches = [
      [{ kind: "turn_start" as const }, { kind: "message" as const, text: "first" }, { kind: "turn_end" as const }],
      [{ kind: "turn_start" as const }, { kind: "message" as const, text: "second" }, { kind: "turn_end" as const }],
    ];
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        observed.push({ traceId: getTraceContext()?.traceId, agentRunId: getTraceContext()?.agentRunId });
        for (const message of batches[call++]!) yield message;
      },
      async *send() {
        observed.push({ traceId: getTraceContext()?.traceId, agentRunId: getTraceContext()?.agentRunId });
        for (const message of batches[call++]!) yield message;
      },
    });
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    await sendInTenantZero(conversation, "one");
    await sendInTenantZero(conversation, "two");

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]!.agentRunId).toBe(rows[0]!.id);
    expect(observed[1]!.agentRunId).toBe(rows[0]!.id);
    expect(observed[0]!.traceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(observed[1]!.traceId).toMatch(/^[0-9a-f-]{36}$/i);

    conversation.clear();
  });

  it("calls reconstructHistory on every wake and seeds the woken session's initialState from its result", async () => {
    const calls: Array<[string]> = [];
    const priorEntry: ConversationEntry = {
      id: "1",
      parentId: null,
      seq: 0,
      timestamp: 0,
      message: { kind: "message", text: "hello there" },
    };
    const reconstructHistory = async (_pool: Pool, projectItemId: string) => {
      calls.push([projectItemId]);
      return calls.length === 1 ? null : { entries: [priorEntry], compacted: false };
    };
    const { createAgentSession, tasks, initialStates } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first wake" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second wake" }, { kind: "turn_end" }],
    );
    const ttlMs = 40;
    const conversation = new SempConversation(
      pool,
      { createAgentSession, resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID, reconstructHistory },
      ttlMs,
    );

    await sendInTenantZero(conversation, "hi");
    expect(calls).toEqual([[SEMPREC_PROJECT_ITEM_ID]]);
    expect(tasks).toEqual(["hi"]);
    expect(initialStates).toEqual([undefined]);

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    await sendInTenantZero(conversation, "hi again");

    expect(calls).toEqual([[SEMPREC_PROJECT_ITEM_ID], [SEMPREC_PROJECT_ITEM_ID]]);
    expect(tasks).toEqual(["hi", "hi again"]);
    expect(initialStates).toEqual([undefined, { messages: [priorEntry] }]);

    conversation.clear();
  });

  it("persists a compacted reconstruction as a 'compaction' event on the run it seeds", async () => {
    const priorEntry: ConversationEntry = {
      id: "1",
      parentId: null,
      seq: 0,
      timestamp: 0,
      message: { kind: "message", text: "summary" },
    };
    const reconstructHistory = async () => ({ entries: [priorEntry], compacted: true });
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "woke" },
      { kind: "turn_end" },
    ]);
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      reconstructHistory,
    });

    await sendInTenantZero(conversation, "hi");

    const { rows: runs } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(runs).toHaveLength(1);

    const { rows: events } = await pool.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'`,
      [runs[0]!.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual([priorEntry]);

    conversation.clear();
  });

  it("pauses (not finishes) the conversation on TTL expiry: closes the wake run as done, and the next send opens a fresh one", async () => {
    const ttlMs = 60;
    // Two batches from one factory: the second wake calls createAgentSession() again for a
    // fresh AgentSession, consuming the next scripted batch.
    const { createAgentSession } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first wake" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second wake" }, { kind: "turn_end" }],
    );
    const conversation = new SempConversation(
      pool,
      { createAgentSession, resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID },
      ttlMs,
    );

    await sendInTenantZero(conversation, "one");

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    const { rows: afterTtl } = await pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(afterTtl).toHaveLength(1);
    expect(afterTtl[0]!.status).toBe("done");
    expect(afterTtl[0]!.finished_at).not.toBeNull();

    const second = await sendInTenantZero(conversation, "two");
    expect(second).toEqual({ ok: true, message: "second wake" });

    const { rows: allRuns } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(allRuns[0].n).toBe(2);

    conversation.clear();
  });

  it("records the stored error run_status, not done, when its TTL fires on a run another writer already closed as error", async () => {
    const ttlMs = 60;
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first wake" },
      { kind: "turn_end" },
    ]);
    const conversation = new SempConversation(
      pool,
      { createAgentSession, resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID },
      ttlMs,
    );

    await sendInTenantZero(conversation, "one");
    const { rows: runs } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    const runId = runs[0]!.id;
    expect(await finishAgentRun(pool, runId, "error", "closed elsewhere")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    const { rows: afterTtl } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [
      runId,
    ]);
    expect(afterTtl[0]!.status).toBe("error");
    const { rows: statuses } = await pool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM agent_run_events
        WHERE agent_run_id = $1 AND kind = 'run_status' ORDER BY id`,
      [runId],
    );
    expect(statuses.map((r) => r.status)).toEqual(["running", "error"]);

    conversation.clear();
  });

  it("does not pause a conversation touched again before its TTL elapses", async () => {
    const ttlMs = 150;
    const { createAgentSession } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );
    const conversation = new SempConversation(
      pool,
      { createAgentSession, resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID },
      ttlMs,
    );

    await sendInTenantZero(conversation, "one");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await sendInTenantZero(conversation, "two");
    await new Promise((resolve) => setTimeout(resolve, 60));

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");

    conversation.clear();
  });

  it("rejects a send that arrives while a TTL pause is mid-flight, instead of reusing the session pause() is finishing as done", async () => {
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first wake" },
      { kind: "turn_end" },
    ]);
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    await sendInTenantZero(conversation, "one");

    // Invoke the TTL handler's private pause() directly rather than waiting out a real TTL:
    // pause() claims the entry as busy synchronously, before its first `await` (the invariant
    // the high-severity review finding required), so by the time `send()` below runs — the
    // very next synchronous statement — it already observes `busy` and is rejected instead of
    // reusing a session whose run pause() is concurrently finishing as `done`.
    const pausePromise = runInTenant(tenantZero, () =>
      (conversation as unknown as { pause(tenantId: string): Promise<void> }).pause(tenantZero),
    );
    const duringPause = await sendInTenantZero(conversation, "during pause");
    expect(duringPause).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });

    await pausePromise;

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");

    conversation.clear();
  });

  it("rejects a send that arrives while another is already in flight, without blocking or overwriting it", async () => {
    const { createAgentSession, release } = blockingSession();
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    const inFlight = sendInTenantZero(conversation, "slow");

    // Give the in-flight call's first turn_start a chance to be persisted before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const duplicate = await sendInTenantZero(conversation, "duplicate");
    expect(duplicate).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });

    release();
    const resolved = await inFlight;
    expect(resolved).toEqual({ ok: true, message: "released" });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows[0].n).toBe(1);

    conversation.clear();
  });

  it("rejects two concurrent first-time wakes without opening two runs", async () => {
    const { createAgentSession, release } = blockingSession();
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    const firstPromise = sendInTenantZero(conversation, "first");
    const secondPromise = new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
      sendInTenantZero(conversation, "second"),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    const outcomes = await Promise.all([firstPromise, secondPromise]);
    const rejected = outcomes.filter((o) => o.ok === false);
    expect(rejected).toEqual([{ ok: false, error: SEMP_BUSY_ERROR_MESSAGE }]);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows[0].n).toBe(1);

    conversation.clear();
  });

  it("closes a brand-new wake's agent_runs row as error and does not register it when the first turn throws", async () => {
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        throw new Error("boom");
      },
    });
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    await expect(sendInTenantZero(conversation, "fails")).rejects.toThrow("boom");

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("boom");

    conversation.clear();
  });

  it("closes a reused session's agent_runs row as error and drops the entry when a later turn throws", async () => {
    let call = 0;
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        yield { kind: "message", text: "first" };
        yield { kind: "turn_end" };
      },
      async *send() {
        call++;
        yield { kind: "turn_start" };
        throw new Error("second turn boom");
      },
    });
    const conversation = new SempConversation(pool, {
      createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    const first = await sendInTenantZero(conversation, "one");
    expect(first).toEqual({ ok: true, message: "first" });

    await expect(sendInTenantZero(conversation, "two")).rejects.toThrow("second turn boom");
    expect(call).toBe(1);

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("second turn boom");

    conversation.clear();
  });
});

describe("SempConversation across tenants", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantA: string;
  let tenantB: string;
  const projectByTenant = new Map<string, string>();

  interface SessionRecord {
    tenantId: string;
    tasks: string[];
    initialState: AgentSessionOptions["initialState"];
  }

  /** Sessions record the tenant they were woken in and every task they receive; a task listed in `gates` blocks its turn until released. */
  function recordingSessions(gates: Map<string, Promise<void>> = new Map()): {
    createAgentSession: CreateAgentSession;
    sessions: SessionRecord[];
  } {
    const sessions: SessionRecord[] = [];
    const createAgentSession: CreateAgentSession = (options): AgentSession => {
      const scope = currentTenantScope();
      const record: SessionRecord = {
        tenantId: scope?.kind === "tenant" ? scope.tenantId : "none",
        tasks: [options.task],
        initialState: options.initialState,
      };
      sessions.push(record);
      async function* turn(task: string) {
        yield { kind: "turn_start" as const };
        const gate = gates.get(task);
        if (gate) await gate;
        yield { kind: "message" as const, text: `reply to ${task}` };
        yield { kind: "turn_end" as const };
      }
      return {
        messages: () => turn(options.task),
        send: (task: string) => {
          record.tasks.push(task);
          return turn(task);
        },
      };
    };
    return { createAgentSession, sessions };
  }

  function conversationFor(
    createAgentSession: CreateAgentSession,
    extra: Partial<SempConversationOptions> = {},
    ttlMs?: number,
  ): SempConversation {
    return new SempConversation(
      runtimePool,
      {
        createAgentSession,
        resolveProjectItemId: async () => {
          const scope = currentTenantScope();
          if (scope?.kind !== "tenant") throw new Error("resolver ran outside a tenant scope");
          return projectByTenant.get(scope.tenantId)!;
        },
        ...extra,
      },
      ttlMs,
    );
  }

  const sendAs = (tenantId: string, conversation: SempConversation, task: string) =>
    runInTenant(tenantId, () => conversation.send(task));

  async function runsOf(
    tenantId: string,
  ): Promise<Array<{ id: string; status: string; tenant_id: string; project_item_id: string }>> {
    const { rows } = await adminPool.query<{ id: string; status: string; tenant_id: string; project_item_id: string }>(
      `SELECT id, status, tenant_id, project_item_id FROM agent_runs WHERE tenant_id = $1 ORDER BY started_at`,
      [tenantId],
    );
    return rows;
  }

  beforeEach(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    const passwordHash = await hashPassword("s3cret-password");
    for (const [tenantId, project, email] of [
      [tenantA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a@example.test"],
      [tenantB, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b@example.test"],
    ] as const) {
      await createUser(adminPool, { email, passwordHash, locale: "en", tenantId });
      projectByTenant.set(tenantId, project);
    }
  });

  afterEach(async () => {
    await runtimePool?.end();
  });

  it("rejects send() with no scope or in a system scope, creating no run and not calling the resolver", async () => {
    const { createAgentSession } = recordingSessions();
    let resolverCalls = 0;
    const conversation = conversationFor(createAgentSession, {
      resolveProjectItemId: async () => {
        resolverCalls++;
        return projectByTenant.get(tenantA)!;
      },
    });

    await expect(conversation.send("hi")).rejects.toThrow("SempConversation.send must run inside a tenant scope");
    await expect(runAsSystem("test", () => conversation.send("hi"))).rejects.toThrow(
      "SempConversation.send must run inside a tenant scope",
    );

    expect(resolverCalls).toBe(0);
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM agent_runs`);
    expect(rows[0].n).toBe(0);
    conversation.clear();
  });

  it("does not make tenant B busy while A's turn is in flight, but still rejects a second concurrent send in A", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { createAgentSession } = recordingSessions(new Map([["a slow", gate]]));
    const conversation = conversationFor(createAgentSession);

    const aInFlight = sendAs(tenantA, conversation, "a slow");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const bResult = await sendAs(tenantB, conversation, "b hello");
    expect(bResult).toEqual({ ok: true, message: "reply to b hello" });
    expect(await sendAs(tenantA, conversation, "a second")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });

    release();
    expect(await aInFlight).toEqual({ ok: true, message: "reply to a slow" });

    const bRuns = await runsOf(tenantB);
    expect(bRuns).toHaveLength(1);
    expect(bRuns[0]!.project_item_id).toBe(projectByTenant.get(tenantB));
    expect(bRuns[0]!.tenant_id).toBe(tenantB);
    const aRuns = await runsOf(tenantA);
    expect(aRuns).toHaveLength(1);
    expect(aRuns[0]!.project_item_id).toBe(projectByTenant.get(tenantA));
    conversation.clear();
  });

  it("continues each tenant's own session and run on its next send", async () => {
    const { createAgentSession, sessions } = recordingSessions();
    const conversation = conversationFor(createAgentSession);

    await sendAs(tenantA, conversation, "a one");
    await sendAs(tenantB, conversation, "b one");
    await sendAs(tenantA, conversation, "a two");
    await sendAs(tenantB, conversation, "b two");

    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.tenantId === tenantA)!.tasks).toEqual(["a one", "a two"]);
    expect(sessions.find((s) => s.tenantId === tenantB)!.tasks).toEqual(["b one", "b two"]);
    expect(await runsOf(tenantA)).toHaveLength(1);
    expect(await runsOf(tenantB)).toHaveLength(1);
    conversation.clear();
  });

  it("reconstructs a wake's history only from the waking tenant's prior runs", async () => {
    const { createAgentSession, sessions } = recordingSessions();
    const seenRuns: Array<{ tenantId: string; projectItemId: string }> = [];
    const reconstructHistory = async (_pool: Pool, projectItemId: string) => {
      const scope = currentTenantScope();
      seenRuns.push({ tenantId: scope?.kind === "tenant" ? scope.tenantId : "none", projectItemId });
      const { rows } = await runtimePool.query<{ task: string }>(
        `SELECT task FROM agent_runs WHERE project_item_id = $1`,
        [projectItemId],
      );
      const entries: ConversationEntry[] = rows.map((row, seq) => ({
        id: String(seq),
        parentId: null,
        seq,
        timestamp: 0,
        message: { kind: "message", text: row.task },
      }));
      return entries.length > 0 ? { entries, compacted: false } : null;
    };
    const conversation = conversationFor(createAgentSession, { reconstructHistory }, 40);

    await sendAs(tenantA, conversation, "a secret");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sendAs(tenantB, conversation, "b first");

    const bSession = sessions.find((s) => s.tenantId === tenantB)!;
    expect(bSession.initialState).toBeUndefined();
    expect(seenRuns).toEqual([
      { tenantId: tenantA, projectItemId: projectByTenant.get(tenantA) },
      { tenantId: tenantB, projectItemId: projectByTenant.get(tenantB) },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await sendAs(tenantB, conversation, "b again");
    const bWake = sessions.filter((s) => s.tenantId === tenantB)[1]!;
    expect(bWake.initialState?.messages.map((m) => m.message)).toEqual([{ kind: "message", text: "b first" }]);
    conversation.clear();
  });

  it("pauses A's run as done on A's TTL while B's entry stays live", async () => {
    const ttlMs = 150;
    const { createAgentSession, sessions } = recordingSessions();
    const conversation = conversationFor(createAgentSession, {}, ttlMs);

    await sendAs(tenantA, conversation, "a one");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sendAs(tenantB, conversation, "b one");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const aRuns = await runsOf(tenantA);
    expect(aRuns.map((r) => r.status)).toEqual(["done"]);
    expect(aRuns[0]!.tenant_id).toBe(tenantA);
    const bBefore = await runsOf(tenantB);
    expect(bBefore.map((r) => r.status)).toEqual(["running"]);

    await sendAs(tenantB, conversation, "b two");
    expect(await runsOf(tenantB)).toHaveLength(1);
    expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(1);
    conversation.clear();
  });

  it("runs resolveProjectItemId inside the waking tenant's scope", async () => {
    const { createAgentSession } = recordingSessions();
    const observed: Array<string | undefined> = [];
    const conversation = conversationFor(createAgentSession, {
      resolveProjectItemId: async () => {
        const scope = currentTenantScope();
        observed.push(scope?.kind === "tenant" ? scope.tenantId : undefined);
        return projectByTenant.get(scope?.kind === "tenant" ? scope.tenantId : "")!;
      },
    });

    await sendAs(tenantA, conversation, "a");
    await sendAs(tenantB, conversation, "b");

    expect(observed).toEqual([tenantA, tenantB]);
    conversation.clear();
  });
});
