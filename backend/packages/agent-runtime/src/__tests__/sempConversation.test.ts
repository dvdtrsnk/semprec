import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createUser, finishAgentRun, hashPassword, type AgentRunRow } from "@semprec/data";
import { currentTenantScope, getTraceContext, runAsSystem, runInTenant } from "@semprec/shared";
import {
  SEMP_BUSY_ERROR_MESSAGE,
  SempConversation,
  createReconstructConversationHistory,
  type SempConversationOptions,
  type SempSendOptions,
  type SempThread,
  type SempThreadWake,
} from "../sempConversation.js";
import { logger } from "../logger.js";
import { repairInterruptedRuns } from "../startupRepair.js";
import { AgentRunCancelledError } from "../lifecycleAdapter.js";
import type { CompactionAdapter } from "../compaction.js";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionOptions,
  ConversationEntry,
  CreateAgentSession,
} from "../types.js";

let pool: Pool;
let tenantZero: string;

let chatThread: SempThread;

async function insertThread(adminPool: Pool, tenantId: string): Promise<SempThread> {
  const { rows } = await adminPool.query<{ id: string }>(
    "INSERT INTO semp_threads (tenant_id, kind) VALUES ($1, 'chat') RETURNING id",
    [tenantId],
  );
  return { threadId: rows[0]!.id, kind: "chat" };
}

function sendInTenantZero(conversation: SempConversation, task: string, thread: SempThread = chatThread) {
  return runInTenant(tenantZero, () => conversation.send(task, thread));
}

/** Runs the private TTL pause of the (only) live conversation of `tenantId`, in that tenant's scope. */
function pauseTenant(conversation: SempConversation, tenantId: string): Promise<void> {
  const internals = conversation as unknown as {
    conversations: Map<string, { tenantId: string }>;
    pause(state: unknown): Promise<void>;
  };
  const state = [...internals.conversations.values()].find((candidate) => candidate.tenantId === tenantId);
  return runInTenant(tenantId, () => internals.pause(state));
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
    chatThread = await insertThread(pool, tenantZero);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("wakes with persisted history after startup repair closes an idle session", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const compaction: CompactionAdapter = {
      estimateContextTokens: (messages) => messages.length,
      shouldCompact: () => false,
      prepareCompaction: (entries) => entries,
      compact: (entries) => entries as ConversationEntry[],
      contextWindow: 1_000_000,
      settings: {},
    };
    const scripted = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );
    const options = {
      createAgentSessionForRun: async () => scripted.createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      reconstructHistory: createReconstructConversationHistory(compaction),
    };
    const beforeRestart = new SempConversation(runtimePool, options);
    const afterRestart = new SempConversation(runtimePool, options);
    let failure: { error: unknown } | undefined;
    try {
      expect(await sendInTenantZero(beforeRestart, "first")).toEqual({ ok: true, message: "first" });
      beforeRestart.clear();
      const repaired = await repairInterruptedRuns(runtimePool);
      expect(repaired.closedIdleRunIds).toHaveLength(1);
      const notifications = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error'",
      );
      expect(notifications.rows[0]?.count).toBe("0");
      expect(await sendInTenantZero(afterRestart, "second")).toEqual({ ok: true, message: "second" });
      expect(scripted.initialStates[1]?.messages.map((entry) => entry.message.kind)).toEqual([
        "turn_start",
        "message",
        "turn_end",
      ]);
    } catch (error) {
      failure = { error };
    } finally {
      beforeRestart.clear();
      afterRestart.clear();
    }
    try {
      await runtimePool.end();
    } catch (error) {
      if (failure)
        throw new AggregateError([failure.error, error], "Wake test and pool cleanup failed", { cause: error });
      throw error;
    }
    if (failure) throw failure.error;
  });

  it.each(["failure", "cancellation"] as const)(
    "wakes after mid-tool %s using the immediately paired persisted history",
    async (kind) => {
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      const compaction: CompactionAdapter = {
        estimateContextTokens: (messages) => messages.length,
        shouldCompact: () => false,
        prepareCompaction: (entries) => entries,
        compact: (entries) => entries as ConversationEntry[],
        contextWindow: 1_000_000,
        settings: {},
      };
      const next = scriptedSession([
        { kind: "turn_start" },
        { kind: "message", text: "recovered" },
        { kind: "turn_end" },
      ]);
      const turnFailure = new Error("tool interrupted");
      const controller = new AbortController();
      let wakes = 0;
      const conversation = new SempConversation(runtimePool, {
        createAgentSessionForRun: async () => {
          if (wakes++ > 0) return next.createAgentSession;
          return () => ({
            async *messages() {
              yield { kind: "turn_start" };
              yield { kind: "tool_use", toolCallId: "call-1", name: "search", arguments: {} };
              if (kind === "cancellation") {
                controller.abort();
                await new Promise((resolve) => setTimeout(resolve, 0));
                return;
              }
              throw turnFailure;
            },
          });
        },
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
        reconstructHistory: createReconstructConversationHistory(compaction),
      });
      let failure: { error: unknown } | undefined;
      try {
        const first = runInTenant(tenantZero, () =>
          conversation.send("first", chatThread, { signal: controller.signal }),
        );
        if (kind === "cancellation") await expect(first).rejects.toBeInstanceOf(AgentRunCancelledError);
        else await expect(first).rejects.toBe(turnFailure);
        expect(await sendInTenantZero(conversation, "next")).toEqual({ ok: true, message: "recovered" });
        const messages = next.initialStates[0]?.messages;
        expect(messages?.map((entry) => entry.message.kind)).toEqual(["turn_start", "tool_use", "tool_result"]);
        expect(messages?.[2]?.message).toMatchObject({
          kind: "tool_result",
          toolCallId: "call-1",
          name: "search",
          isError: true,
          result: {
            content: [
              { type: "text", text: expect.stringContaining(kind === "cancellation" ? "cancelled" : "failed") },
            ],
            details: { error: true },
          },
        });
      } catch (error) {
        failure = { error };
      } finally {
        conversation.clear();
      }
      try {
        await runtimePool.end();
      } catch (error) {
        if (failure)
          throw new AggregateError([failure.error, error], "Wake test and pool cleanup failed", { cause: error });
        throw error;
      }
      if (failure) throw failure.error;
    },
  );

  it("leaves failed pairing repairable and wakes the thread after startup repair", async () => {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const compaction: CompactionAdapter = {
      estimateContextTokens: (messages) => messages.length,
      shouldCompact: () => false,
      prepareCompaction: (entries) => entries,
      compact: (entries) => entries as ConversationEntry[],
      contextWindow: 1_000_000,
      settings: {},
    };
    const turnFailure = new Error("turn failed");
    const next = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "recovered" },
      { kind: "turn_end" },
    ]);
    let wakes = 0;
    const options = {
      createAgentSessionForRun: async (): Promise<CreateAgentSession> => {
        if (wakes++ > 0) return next.createAgentSession;
        return () => ({
          async *messages() {
            yield { kind: "turn_start" };
            yield { kind: "tool_use", toolCallId: "call-1", name: "search", arguments: {} };
            throw turnFailure;
          },
        });
      },
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      reconstructHistory: createReconstructConversationHistory(compaction),
    };
    const beforeRestart = new SempConversation(runtimePool, options);
    const afterRestart = new SempConversation(runtimePool, options);
    let failure: { error: unknown } | undefined;
    try {
      await pool.query(`CREATE FUNCTION batch15_reject_semp_result() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind = 'tool_result' THEN RAISE EXCEPTION 'pairing rejected'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER batch15_reject_semp_result BEFORE INSERT ON agent_run_events
        FOR EACH ROW EXECUTE FUNCTION batch15_reject_semp_result()`);
      const result: unknown = await sendInTenantZero(beforeRestart, "first").catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      if (!(result instanceof AggregateError)) throw new Error("Expected recovery failure");
      expect(result.errors[0]).toBe(turnFailure);
      expect(result.cause).toBe(turnFailure);
      expect(result.errors[1]).toBeInstanceOf(Error);
      const runs = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_runs WHERE thread_id = $1",
        [chatThread.threadId],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]!.status).toBe("running");
      const events = await pool.query<{ kind: string }>(
        "SELECT kind FROM agent_run_events WHERE agent_run_id = $1 AND kind IN ('tool_result', 'run_status') ORDER BY id",
        [runs.rows[0]!.id],
      );
      expect(events.rows).toEqual([{ kind: "run_status" }]);
      const notices = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM notifications WHERE source_id = $1",
        [runs.rows[0]!.id],
      );
      expect(notices.rows[0]?.count).toBe("0");
      await pool.query("DROP TRIGGER batch15_reject_semp_result ON agent_run_events");
      expect((await repairInterruptedRuns(runtimePool)).repairedRunIds).toContain(runs.rows[0]!.id);
      expect(await sendInTenantZero(afterRestart, "next")).toEqual({ ok: true, message: "recovered" });
      expect(next.initialStates[0]?.messages.map((entry) => entry.message.kind)).toEqual([
        "turn_start",
        "tool_use",
        "tool_result",
      ]);
    } catch (error) {
      failure = { error };
    }
    beforeRestart.clear();
    afterRestart.clear();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      () => pool.query("DROP TRIGGER IF EXISTS batch15_reject_semp_result ON agent_run_events"),
      () => pool.query("DROP FUNCTION IF EXISTS batch15_reject_semp_result()"),
      () => runtimePool.end(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Semp recovery test cleanup failed",
      );
    if (failure) throw failure.error;
  });

  it("wakes a session-unit, user-triggered agent_runs row on the first send and returns the final assistant message", async () => {
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "hello there" },
      { kind: "turn_end" },
    ]);
    const conversation = new SempConversation(pool, {
      createAgentSessionForRun: async () => createAgentSession,
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
      createAgentSessionForRun: async () => createAgentSession,
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
      createAgentSessionForRun: async () => createAgentSession,
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
    const reconstructHistory = async (_pool: Pool, { projectItemId }: SempThreadWake) => {
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
      {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
        reconstructHistory,
      },
      ttlMs,
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(await sendInTenantZero(conversation, "hi")).toEqual({ ok: true, message: "first wake" });
      expect(calls).toEqual([[SEMPREC_PROJECT_ITEM_ID]]);
      expect(tasks).toEqual(["hi"]);
      expect(initialStates).toEqual([undefined]);

      // Direct pause does not consume the scheduled TTL callback; cancel it before pausing.
      vi.clearAllTimers();
      await pauseTenant(conversation, tenantZero);

      expect(await sendInTenantZero(conversation, "hi again")).toEqual({ ok: true, message: "second wake" });

      expect(calls).toEqual([[SEMPREC_PROJECT_ITEM_ID], [SEMPREC_PROJECT_ITEM_ID]]);
      expect(tasks).toEqual(["hi", "hi again"]);
      expect(initialStates).toEqual([undefined, { messages: [priorEntry] }]);
    } finally {
      conversation.clear();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
      createAgentSessionForRun: async () => createAgentSession,
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

  it("closes a new run if its compaction write fails before session creation", async () => {
    const name = `reject_compaction_${randomUUID().replaceAll("-", "")}`;
    const createAgentSessionForRun = vi.fn(async () => scriptedSession([]).createAgentSession);
    const conversation = new SempConversation(pool, {
      createAgentSessionForRun,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      reconstructHistory: async () => ({ entries: [], compacted: true }),
    });
    try {
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'compaction' AND EXISTS (SELECT 1 FROM agent_runs WHERE id = NEW.agent_run_id AND task = 'compaction-failure-test') THEN
            RAISE EXCEPTION 'compaction write refused';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      await expect(sendInTenantZero(conversation, "compaction-failure-test")).rejects.toThrow(
        "compaction write refused",
      );
      expect(createAgentSessionForRun).not.toHaveBeenCalled();
      const runs = await pool.query<{ id: string; status: string; error_code: string | null }>(
        "SELECT id, status, error_code FROM agent_runs WHERE task = 'compaction-failure-test'",
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({ status: "error", error_code: "internal" });
      const checkpoints = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'",
        [runs.rows[0]!.id],
      );
      expect(checkpoints.rows).toEqual([{ count: "0" }]);
    } finally {
      conversation.clear();
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON agent_run_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
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
      {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      },
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
      {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      },
      ttlMs,
    );

    await sendInTenantZero(conversation, "one");
    const { rows: runs } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    const runId = runs[0]!.id;
    expect(await finishAgentRun(pool, runId, "error", "closed elsewhere", "internal")).toBe(true);

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
      {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      },
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
      createAgentSessionForRun: async () => createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    await sendInTenantZero(conversation, "one");

    // Invoke the TTL handler's private pause() directly rather than waiting out a real TTL:
    // pause() claims the entry as busy synchronously, before its first `await` (the invariant
    // the high-severity review finding required), so by the time `send()` below runs — the
    // very next synchronous statement — it already observes `busy` and is rejected instead of
    // reusing a session whose run pause() is concurrently finishing as `done`.
    const pausePromise = pauseTenant(conversation, tenantZero);
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
      createAgentSessionForRun: async () => createAgentSession,
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
      createAgentSessionForRun: async () => createAgentSession,
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
      createAgentSessionForRun: async () => createAgentSession,
      resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
    });

    await expect(sendInTenantZero(conversation, "fails")).rejects.toThrow("boom");

    const { rows } = await pool.query<{ status: string; result: string | null; error_code: string | null }>(
      `SELECT status, result, error_code FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("boom");
    expect(rows[0]!.error_code).toBe("internal");

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
      createAgentSessionForRun: async () => createAgentSession,
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

  describe("SempConversation per-run session and turn start", () => {
    const turn = (text: string): AgentMessage[] => [
      { kind: "turn_start" },
      { kind: "message", text },
      { kind: "turn_end" },
    ];

    function sendWith(conversation: SempConversation, task: string, options: SempSendOptions) {
      return runInTenant(tenantZero, () => conversation.send(task, chatThread, options));
    }

    async function runStatuses(): Promise<Array<{ id: string; status: string }>> {
      const { rows } = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM agent_runs WHERE project_item_id = $1`,
        [SEMPREC_PROJECT_ITEM_ID],
      );
      return rows;
    }

    it("calls the factory with the turn's run row and passes the signal to the session", async () => {
      const { createAgentSession } = scriptedSession(turn("hi"));
      const seenRuns: AgentRunRow[] = [];
      const seenSignals: Array<AbortSignal | undefined> = [];
      const conversation = new SempConversation(pool, {
        createAgentSessionForRun: async (run) => {
          seenRuns.push(run);
          return (options) => {
            seenSignals.push(options.signal);
            return createAgentSession(options);
          };
        },
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });
      const controller = new AbortController();

      await sendWith(conversation, "hi", { signal: controller.signal });

      const [row] = await runStatuses();
      expect(seenRuns).toHaveLength(1);
      expect(seenRuns[0]).toMatchObject({ id: row!.id, status: "running", task: "hi" });
      expect(seenSignals).toEqual([controller.signal]);
      conversation.clear();
    });

    it("reports the run and its first stored event once per turn, and a larger first event for a continuation", async () => {
      const { createAgentSession } = scriptedSession(turn("one"), turn("two"));
      const conversation = new SempConversation(pool, {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });
      const starts: Array<{ agentRunId: string; firstEventId: string }> = [];
      const repliesAtStart: string[] = [];
      const onTurnStart: SempSendOptions["onTurnStart"] = async (start) => {
        starts.push(start);
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'message'`,
          [start.agentRunId],
        );
        repliesAtStart.push(String(rows.length));
      };

      await sendWith(conversation, "one", { onTurnStart });
      await sendWith(conversation, "two", { onTurnStart });

      const [row] = await runStatuses();
      expect(starts).toHaveLength(2);
      expect(starts[0]!.agentRunId).toBe(row!.id);
      expect(starts[1]!.agentRunId).toBe(row!.id);
      expect(BigInt(starts[1]!.firstEventId)).toBeGreaterThan(BigInt(starts[0]!.firstEventId));
      // The first stored event of a turn is its turn_start row, before the reply is stored.
      expect(repliesAtStart).toEqual(["0", "1"]);
      const { rows: first } = await pool.query<{ kind: string }>(`SELECT kind FROM agent_run_events WHERE id = $1`, [
        starts[0]!.firstEventId,
      ]);
      expect(first[0]!.kind).toBe("turn_start");
      conversation.clear();
    });

    it("rejects, closes the run as error and drops the entry when the signal aborts a blocked prompt", async () => {
      const neverEnds: CreateAgentSession = (): AgentSession => ({
        async *messages() {
          yield { kind: "turn_start" };
          await new Promise<never>(() => {});
        },
      });
      const conversation = new SempConversation(pool, {
        createAgentSessionForRun: async () => neverEnds,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });
      const controller = new AbortController();
      const sending = sendWith(conversation, "hi", {
        signal: controller.signal,
        onTurnStart: () => {
          setTimeout(() => controller.abort(), 0);
        },
      });

      await expect(sending).rejects.toThrow("account deactivated");

      expect((await runStatuses()).map((r) => r.status)).toEqual(["error"]);
      // The entry is gone, so the next send wakes a brand-new run.
      const { createAgentSession } = scriptedSession(turn("again"));
      const next = new SempConversation(pool, {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });
      await expect(sendWith(next, "again", {})).resolves.toEqual({ ok: true, message: "again" });
      conversation.clear();
      next.clear();
    });

    it("drops a continuation entry when its signal aborts", async () => {
      let wakes = 0;
      const blockOnSecond: CreateAgentSession = (): AgentSession => {
        wakes++;
        return {
          async *messages() {
            yield* turn("first");
          },
          async *send() {
            yield { kind: "turn_start" };
            await new Promise<never>(() => {});
          },
        };
      };
      const conversation = new SempConversation(pool, {
        createAgentSessionForRun: async () => blockOnSecond,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });
      await sendWith(conversation, "one", {});
      const controller = new AbortController();
      const sending = sendWith(conversation, "two", {
        signal: controller.signal,
        onTurnStart: () => {
          setTimeout(() => controller.abort(), 0);
        },
      });

      await expect(sending).rejects.toThrow("account deactivated");
      expect((await runStatuses()).map((r) => r.status)).toEqual(["error"]);
      await sendWith(conversation, "three", {}).catch(() => undefined);
      expect(wakes).toBe(2);
      conversation.clear();
    });

    it("closes the run as error and propagates when onTurnStart throws, without prompting further", async () => {
      let afterFirstEvent = false;
      const session: CreateAgentSession = (): AgentSession => ({
        async *messages() {
          yield { kind: "turn_start" };
          afterFirstEvent = true;
          yield { kind: "message", text: "should not happen" };
        },
      });
      const conversation = new SempConversation(pool, {
        createAgentSessionForRun: async () => session,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });

      await expect(
        sendWith(conversation, "hi", {
          onTurnStart: () => {
            throw new Error("record failed");
          },
        }),
      ).rejects.toThrow("record failed");

      expect(afterFirstEvent).toBe(false);
      const { rows } = await pool.query<{ status: string; result: string | null }>(
        `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
        [SEMPREC_PROJECT_ITEM_ID],
      );
      expect(rows).toEqual([{ status: "error", result: "record failed" }]);
      conversation.clear();
    });

    it("closes the run as error when the factory rejects", async () => {
      const conversation = new SempConversation(pool, {
        createAgentSessionForRun: async () => {
          throw new Error("compose failed");
        },
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
      });

      await expect(sendWith(conversation, "hi", {})).rejects.toThrow("compose failed");

      expect((await runStatuses()).map((r) => r.status)).toEqual(["error"]);
      conversation.clear();
    });
  });
});

describe("SempConversation across tenants", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantA: string;
  let tenantB: string;
  const projectByTenant = new Map<string, string>();
  const threadByTenant = new Map<string, SempThread>();

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
        createAgentSessionForRun: async () => createAgentSession,
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
    runInTenant(tenantId, () => conversation.send(task, threadByTenant.get(tenantId)!));

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
    adminPool ??= getTestPool();
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
      threadByTenant.set(tenantId, await insertThread(adminPool, tenantId));
    }
  });

  afterEach(async () => {
    await runtimePool?.end();
  });

  afterAll(async () => {
    await adminPool?.end();
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

    await expect(conversation.send("hi", threadByTenant.get(tenantA)!)).rejects.toThrow(
      "SempConversation.send must run inside a tenant scope",
    );
    await expect(runAsSystem("test", () => conversation.send("hi", threadByTenant.get(tenantA)!))).rejects.toThrow(
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

  describe("per-thread registry", () => {
    const TTL_MS = 5_000;

    async function threadRuns(
      threadId: string,
    ): Promise<Array<{ id: string; status: string; thread_id: string; project_item_id: string }>> {
      const { rows } = await adminPool.query<{
        id: string;
        status: string;
        thread_id: string;
        project_item_id: string;
      }>(`SELECT id, status, thread_id, project_item_id FROM agent_runs WHERE thread_id = $1 ORDER BY started_at`, [
        threadId,
      ]);
      return rows;
    }

    function pauseThread(conversation: SempConversation, tenantId: string, threadId: string): Promise<void> {
      const internals = conversation as unknown as {
        conversations: Map<string, unknown>;
        pause(state: unknown): Promise<void>;
      };
      const state = internals.conversations.get(`${tenantId}:${threadId}`);
      return runInTenant(tenantId, () => internals.pause(state));
    }

    const sendThread = (tenantId: string, conversation: SempConversation, task: string, thread: SempThread) =>
      runInTenant(tenantId, () => conversation.send(task, thread));

    it("runs two threads of one tenant in parallel, each with its own run, thread id and reconstruction", async () => {
      const threadOne = threadByTenant.get(tenantA)!;
      const threadTwo = await insertThread(adminPool, tenantA);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { createAgentSession, sessions } = recordingSessions(new Map([["slow one", gate]]));
      const reconstructed: string[] = [];
      const conversation = conversationFor(createAgentSession, {
        reconstructHistory: async (_pool, wake) => {
          reconstructed.push(wake.threadId);
          return null;
        },
      });

      const inFlight = sendThread(tenantA, conversation, "slow one", threadOne);
      const settledInFlight = Promise.allSettled([inFlight]);
      let failure: { error: unknown } | undefined;
      let settledFailure: { error: unknown } | undefined;
      try {
        await vi.waitFor(() => expect(sessions.some((session) => session.tasks.includes("slow one"))).toBe(true));
        expect(await sendThread(tenantA, conversation, "other", threadTwo)).toEqual({
          ok: true,
          message: "reply to other",
        });
        expect(await sendThread(tenantA, conversation, "slow again", threadOne)).toEqual({
          ok: false,
          error: SEMP_BUSY_ERROR_MESSAGE,
        });
        release();
        expect(await inFlight).toEqual({ ok: true, message: "reply to slow one" });
        expect(reconstructed.sort()).toEqual([threadOne.threadId, threadTwo.threadId].sort());
        for (const thread of [threadOne, threadTwo]) {
          const runs = await threadRuns(thread.threadId);
          expect(runs).toHaveLength(1);
          expect(runs[0]!.project_item_id).toBe(projectByTenant.get(tenantA));
        }
      } catch (error) {
        failure = { error };
      } finally {
        release();
        const [settled] = await settledInFlight;
        conversation.clear();
        if (settled?.status === "rejected") settledFailure = { error: settled.reason };
      }
      if (failure && settledFailure && failure.error !== settledFailure.error) {
        throw new AggregateError([failure.error, settledFailure.error]);
      }
      if (failure) throw failure.error;
      if (settledFailure) throw settledFailure.error;
    });

    it("gives a tick thread's wake run the heartbeat's project and does not call the resolver", async () => {
      const heartbeatProject = randomUUID();
      const { rows: heartbeats } = await adminPool.query<{ id: string }>(
        `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id)
         VALUES ($1, 'hb', '{"kind":"dailyTime","at":"09:00"}'::jsonb, 'noop') RETURNING id`,
        [heartbeatProject],
      );
      const { rows: threads } = await adminPool.query<{ id: string }>(
        "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
        [heartbeats[0]!.id],
      );
      const tickThread: SempThread = { threadId: threads[0]!.id, kind: "tick", projectItemId: heartbeatProject };
      const { createAgentSession } = recordingSessions();
      let resolverCalls = 0;
      const wakes: SempThreadWake[] = [];
      const conversation = conversationFor(createAgentSession, {
        resolveProjectItemId: async () => {
          resolverCalls++;
          return projectByTenant.get(tenantA)!;
        },
        reconstructHistory: async (_pool, wake) => {
          wakes.push(wake);
          return null;
        },
      });

      await sendThread(tenantA, conversation, "tick", tickThread);

      expect(resolverCalls).toBe(0);
      expect(wakes).toEqual([{ threadId: tickThread.threadId, projectItemId: heartbeatProject }]);
      const runs = await threadRuns(tickThread.threadId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.project_item_id).toBe(heartbeatProject);
      conversation.clear();
    });

    it("pauses only the thread whose TTL expired, leaving the other thread's session live", async () => {
      const threadOne = threadByTenant.get(tenantA)!;
      const threadTwo = await insertThread(adminPool, tenantA);
      const { createAgentSession, sessions } = recordingSessions();
      const conversation = conversationFor(createAgentSession, {}, TTL_MS);
      await sendThread(tenantA, conversation, "one", threadOne);
      await sendThread(tenantA, conversation, "two", threadTwo);

      await pauseThread(conversation, tenantA, threadOne.threadId);

      expect((await threadRuns(threadOne.threadId)).map((r) => r.status)).toEqual(["done"]);
      expect((await threadRuns(threadTwo.threadId)).map((r) => r.status)).toEqual(["running"]);
      await sendThread(tenantA, conversation, "two again", threadTwo);
      expect(sessions).toHaveLength(2);
      expect(sessions[1]!.tasks).toEqual(["two", "two again"]);
      conversation.clear();
    });

    it("fires a thread's TTL timer inside the tenant context", async () => {
      // The runtime role's row-level security hides the run outside a tenant scope, so a pause that
      // ran without one could not close it as done.
      const { createAgentSession } = recordingSessions();
      const conversation = conversationFor(createAgentSession, {}, TTL_MS);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const threadId = threadByTenant.get(tenantB)!.threadId;
        await sendAs(tenantB, conversation, "b one");
        await vi.advanceTimersByTimeAsync(TTL_MS);
        vi.useRealTimers();
        await vi.waitFor(async () => {
          expect((await threadRuns(threadId)).map((r) => r.status)).toEqual(["done"]);
        });
      } finally {
        vi.useRealTimers();
        conversation.clear();
      }
    });

    it("drops every thread conversation of the tenant, clears their timers and leaves other tenants intact", async () => {
      const aOne = threadByTenant.get(tenantA)!;
      const aTwo = await insertThread(adminPool, tenantA);
      const bOne = threadByTenant.get(tenantB)!;
      const { createAgentSession } = recordingSessions();
      const conversation = conversationFor(createAgentSession, {}, TTL_MS);
      const setSpy = vi.spyOn(globalThis, "setTimeout");
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        await sendThread(tenantA, conversation, "a1", aOne);
        await sendThread(tenantA, conversation, "a2", aTwo);
        await sendThread(tenantB, conversation, "b1", bOne);
        const ttlTimers = setSpy.mock.calls.flatMap((call, index) =>
          call[1] === TTL_MS ? [setSpy.mock.results[index]!.value as ReturnType<typeof setTimeout>] : [],
        );
        expect(ttlTimers).toHaveLength(3);

        await conversation.dropTenant(tenantA);

        expect(clearSpy).toHaveBeenCalledWith(ttlTimers[0]);
        expect(clearSpy).toHaveBeenCalledWith(ttlTimers[1]);
        expect(clearSpy).not.toHaveBeenCalledWith(ttlTimers[2]);
        for (const thread of [aOne, aTwo]) {
          expect((await threadRuns(thread.threadId)).map((r) => r.status)).toEqual(["error"]);
        }
        expect((await threadRuns(bOne.threadId)).map((r) => r.status)).toEqual(["running"]);
        expect(await sendThread(tenantB, conversation, "b2", bOne)).toEqual({ ok: true, message: "reply to b2" });
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        conversation.clear();
      }
    });

    it("lets an in-flight turn in one thread finish when the tenant is dropped, closing every thread's run", async () => {
      const aOne = threadByTenant.get(tenantA)!;
      const aTwo = await insertThread(adminPool, tenantA);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { createAgentSession } = recordingSessions(new Map([["slow", gate]]));
      const conversation = conversationFor(createAgentSession, {}, TTL_MS);
      await sendThread(tenantA, conversation, "idle", aTwo);
      const inFlight = sendThread(tenantA, conversation, "slow", aOne);
      await new Promise((resolve) => setTimeout(resolve, 30));

      await conversation.dropTenant(tenantA);
      expect((await threadRuns(aTwo.threadId)).map((r) => r.status)).toEqual(["error"]);
      expect(await sendThread(tenantA, conversation, "late", aOne)).toEqual({
        ok: false,
        error: SEMP_BUSY_ERROR_MESSAGE,
      });

      release();
      await inFlight;
      expect((await threadRuns(aOne.threadId)).map((r) => r.status)).toEqual(["error"]);
      conversation.clear();
    });
  });

  it("reconstructs a wake's history only from the waking tenant's prior runs", async () => {
    const { createAgentSession, sessions } = recordingSessions();
    const seenRuns: Array<{ tenantId: string; projectItemId: string }> = [];
    const reconstructHistory = async (_pool: Pool, { projectItemId }: SempThreadWake) => {
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

  describe("dropTenant (issue #1042)", () => {
    /** A TTL no other timer in these tests uses, so the conversation's own TTL timers can be told apart. */
    const DROP_TTL_MS = 987_654;

    async function runRowsOf(tenantId: string): Promise<Array<{ id: string; status: string; result: string | null }>> {
      const { rows } = await adminPool.query<{ id: string; status: string; result: string | null }>(
        `SELECT id, status, result FROM agent_runs WHERE tenant_id = $1 ORDER BY started_at`,
        [tenantId],
      );
      return rows;
    }

    function gate(): { promise: Promise<void>; release: () => void } {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("closes an idle tenant's wake run as error, removes its entry and clears its TTL timer, leaving A untouched", async () => {
      const setSpy = vi.spyOn(globalThis, "setTimeout");
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      const { createAgentSession, sessions } = recordingSessions();
      const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
      await sendAs(tenantA, conversation, "a one");
      await sendAs(tenantB, conversation, "b one");
      const ttlTimers = setSpy.mock.calls.flatMap((call, index) =>
        call[1] === DROP_TTL_MS ? [setSpy.mock.results[index]!.value as ReturnType<typeof setTimeout>] : [],
      );
      expect(ttlTimers).toHaveLength(2);
      const bTimer = ttlTimers[1];

      await conversation.dropTenant(tenantB);

      expect(clearSpy).toHaveBeenCalledWith(bTimer);
      expect(clearSpy).not.toHaveBeenCalledWith(ttlTimers[0]);
      expect(await runRowsOf(tenantB)).toEqual([
        expect.objectContaining({ status: "error", result: "account deactivated" }),
      ]);
      const { rows: codes } = await adminPool.query<{ error_code: string | null }>(
        `SELECT error_code FROM agent_runs WHERE tenant_id = $1`,
        [tenantB],
      );
      expect(codes).toEqual([{ error_code: "cancelled" }]);
      expect((await runRowsOf(tenantA)).map((r) => r.status)).toEqual(["running"]);

      // B's entry is gone: its next send wakes a new session and run. A's continues its own.
      await sendAs(tenantB, conversation, "b two");
      await sendAs(tenantA, conversation, "a two");
      expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
      expect(await runRowsOf(tenantB)).toHaveLength(2);
      expect(sessions.filter((s) => s.tenantId === tenantA)).toHaveLength(1);
      expect(sessions.find((s) => s.tenantId === tenantA)!.tasks).toEqual(["a one", "a two"]);
      conversation.clear();
    });

    it("lets an in-flight wake complete, then discards its entry and closes its run as error", async () => {
      const slow = gate();
      const { createAgentSession, sessions } = recordingSessions(new Map([["b slow", slow.promise]]));
      const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
      await sendAs(tenantA, conversation, "a one");

      const bInFlight = sendAs(tenantB, conversation, "b slow");
      await vi.waitFor(async () => expect(await runRowsOf(tenantB)).toHaveLength(1));
      await conversation.dropTenant(tenantB);
      expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);

      slow.release();
      expect(await bInFlight).toEqual({ ok: true, message: "reply to b slow" });

      expect(await runRowsOf(tenantB)).toEqual([
        expect.objectContaining({ status: "error", result: "account deactivated" }),
      ]);
      expect((await runRowsOf(tenantA)).map((r) => r.status)).toEqual(["running"]);
      await sendAs(tenantB, conversation, "b after");
      expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
      conversation.clear();
    });

    it("lets an in-flight turn on a reused session complete, then discards its entry and closes its run as error", async () => {
      const slow = gate();
      const { createAgentSession, sessions } = recordingSessions(new Map([["b slow", slow.promise]]));
      const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
      await sendAs(tenantA, conversation, "a one");
      await sendAs(tenantB, conversation, "b one");

      const bInFlight = sendAs(tenantB, conversation, "b slow");
      await vi.waitFor(() => expect(sessions.find((s) => s.tenantId === tenantB)!.tasks).toContain("b slow"));
      await conversation.dropTenant(tenantB);
      expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);

      slow.release();
      expect(await bInFlight).toEqual({ ok: true, message: "reply to b slow" });

      expect(await runRowsOf(tenantB)).toEqual([
        expect.objectContaining({ status: "error", result: "account deactivated" }),
      ]);
      expect((await runRowsOf(tenantA)).map((r) => r.status)).toEqual(["running"]);
      await sendAs(tenantB, conversation, "b after");
      expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
      await sendAs(tenantA, conversation, "a two");
      expect(sessions.filter((s) => s.tenantId === tenantA)).toHaveLength(1);
      conversation.clear();
    });

    describe("when closing the run fails or a TTL pause holds the entry", () => {
      /** Short enough that the pause retry and the dropped-run retry both fire within a test. */
      const RETRY_TTL_MS = 80;

      afterEach(async () => {
        await adminPool.query("DROP TRIGGER IF EXISTS test_fail_run_close ON agent_runs");
        await adminPool.query("DROP FUNCTION IF EXISTS test_fail_run_close()");
      });

      /**
       * Makes every close of `tenantId`'s runs to one of `statuses` raise until the trigger is dropped.
       * The trigger body is DDL, which takes no bind parameters, so Postgres builds it with
       * `format('%L', …)` from the bound values and the statement it returns is then executed.
       */
      async function failRunCloses(tenantId: string, statuses: Array<"done" | "error">): Promise<void> {
        const { rows } = await adminPool.query<{ ddl: string }>(
          `SELECT format($fmt$
             CREATE OR REPLACE FUNCTION test_fail_run_close() RETURNS trigger AS $body$
             BEGIN
               IF NEW.tenant_id = %L::uuid AND NEW.status::text = ANY (%L::text[]) THEN
                 RAISE EXCEPTION 'injected run close failure';
               END IF;
               RETURN NEW;
             END $body$ LANGUAGE plpgsql$fmt$, $1::uuid, $2::text[]) AS ddl`,
          [tenantId, statuses],
        );
        const ddl = rows[0]?.ddl;
        if (ddl === undefined) throw new Error("failRunCloses: format() returned no row");
        await adminPool.query(ddl);
        await adminPool.query(
          `CREATE TRIGGER test_fail_run_close BEFORE UPDATE ON agent_runs
           FOR EACH ROW EXECUTE FUNCTION test_fail_run_close()`,
        );
      }

      async function healRunCloses(): Promise<void> {
        await adminPool.query("DROP TRIGGER test_fail_run_close ON agent_runs");
      }

      function pauseOf(conversation: SempConversation, tenantId: string): Promise<void> {
        return pauseTenant(conversation, tenantId);
      }

      it("preserves the actual pause failure for strict freshness and succeeds after recovery", async () => {
        const { createAgentSession } = recordingSessions();
        const conversation = conversationFor(createAgentSession, {}, 60_000);
        try {
          await sendAs(tenantB, conversation, "before");
          await failRunCloses(tenantB, ["done"]);
          const thread = threadByTenant.get(tenantB);
          if (!thread) throw new Error("Missing thread");
          await expect(runInTenant(tenantB, () => conversation.ensureFresh(thread.threadId, null))).rejects.toThrow(
            "injected run close failure",
          );
          expect((await runRowsOf(tenantB)).map((run) => run.status)).toEqual(["running"]);
          await healRunCloses();
          await runInTenant(tenantB, () => conversation.ensureFresh(thread.threadId, null));
          expect((await runRowsOf(tenantB)).map((run) => run.status)).toEqual(["done"]);
        } finally {
          conversation.clear();
        }
      });

      it("keeps an idle dropped entry when its close fails, rejects sends meanwhile, and retries the close", async () => {
        const { createAgentSession, sessions } = recordingSessions();
        const conversation = conversationFor(createAgentSession, {}, RETRY_TTL_MS);
        // The TTL pause of "b one" can fire before `dropTenant`; failing its `done` close too keeps
        // the run open on that interleaving, so the drop still finds it `running`.
        await failRunCloses(tenantB, ["done", "error"]);
        await sendAs(tenantB, conversation, "b one");
        const errorSpy = vi.spyOn(logger, "error");

        await conversation.dropTenant(tenantB);

        expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);
        // Only the error's name is logged, never the Postgres error whose detail can carry the row.
        const dropLogs = errorSpy.mock.calls.filter(
          ([, msg]) => msg === "SempConversation: failed to close dropped run, will retry",
        );
        expect(dropLogs[0]).toEqual([
          { errorName: "error", tenantId: tenantB, threadId: expect.any(String), agentRunId: expect.any(String) },
          "SempConversation: failed to close dropped run, will retry",
        ]);
        expect(await sendAs(tenantB, conversation, "b during")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });
        expect(sessions.find((s) => s.tenantId === tenantB)!.tasks).toEqual(["b one"]);

        await healRunCloses();
        await vi.waitFor(async () =>
          expect(await runRowsOf(tenantB)).toEqual([
            expect.objectContaining({ status: "error", result: "account deactivated" }),
          ]),
        );
        await vi.waitFor(async () => expect((await sendAs(tenantB, conversation, "b after")).ok).toBe(true));
        expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
        conversation.clear();
      });

      it("keeps an in-flight turn's dropped entry when the close after it fails, and retries the close", async () => {
        const slow = gate();
        const { createAgentSession, sessions } = recordingSessions(new Map([["b slow", slow.promise]]));
        const conversation = conversationFor(createAgentSession, {}, RETRY_TTL_MS);
        await sendAs(tenantB, conversation, "b one");
        const bInFlight = sendAs(tenantB, conversation, "b slow");
        await vi.waitFor(() => expect(sessions.find((s) => s.tenantId === tenantB)!.tasks).toContain("b slow"));
        await conversation.dropTenant(tenantB);
        await failRunCloses(tenantB, ["error"]);

        slow.release();
        expect(await bInFlight).toEqual({ ok: true, message: "reply to b slow" });
        expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);
        expect(await sendAs(tenantB, conversation, "b during")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });

        await healRunCloses();
        await vi.waitFor(async () =>
          expect(await runRowsOf(tenantB)).toEqual([
            expect.objectContaining({ status: "error", result: "account deactivated" }),
          ]),
        );
        conversation.clear();
      });

      it("keeps an in-flight wake's dropped entry when the close after it fails, and retries the close", async () => {
        const slow = gate();
        const { createAgentSession } = recordingSessions(new Map([["b slow", slow.promise]]));
        const conversation = conversationFor(createAgentSession, {}, RETRY_TTL_MS);
        const bInFlight = sendAs(tenantB, conversation, "b slow");
        await vi.waitFor(async () => expect(await runRowsOf(tenantB)).toHaveLength(1));
        await conversation.dropTenant(tenantB);
        await failRunCloses(tenantB, ["error"]);

        slow.release();
        expect(await bInFlight).toEqual({ ok: true, message: "reply to b slow" });
        expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);
        expect(await sendAs(tenantB, conversation, "b during")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });

        await healRunCloses();
        await vi.waitFor(async () =>
          expect(await runRowsOf(tenantB)).toEqual([
            expect.objectContaining({ status: "error", result: "account deactivated" }),
          ]),
        );
        conversation.clear();
      });

      it("closes the run as error instead of done when the tenant is dropped while a TTL pause starts", async () => {
        const { createAgentSession, sessions } = recordingSessions();
        const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
        await sendAs(tenantB, conversation, "b one");

        const pausing = pauseOf(conversation, tenantB);
        await conversation.dropTenant(tenantB);
        await pausing;

        expect(await runRowsOf(tenantB)).toEqual([
          expect.objectContaining({ status: "error", result: "account deactivated" }),
        ]);
        await sendAs(tenantB, conversation, "b after");
        expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
        conversation.clear();
      });

      it("rolls back a TTL pause's done update and closes the run as error when the drop arrives while that update runs", async () => {
        const { createAgentSession, sessions } = recordingSessions();
        const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
        await sendAs(tenantB, conversation, "b one");
        const [run] = await runRowsOf(tenantB);
        // A row lock held elsewhere keeps the pause's `done` update waiting until the drop arrived.
        const locker = await adminPool.connect();
        let pausing: Promise<void> | undefined;
        try {
          await locker.query("BEGIN");
          await locker.query("SELECT 1 FROM agent_runs WHERE id = $1 FOR UPDATE", [run!.id]);
          pausing = pauseOf(conversation, tenantB);
          await vi.waitFor(async () => {
            const { rows } = await adminPool.query<{ waiting: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE agent_runs SET status%'
               ) AS waiting`,
            );
            expect(rows[0]!.waiting).toBe(true);
          });
          await conversation.dropTenant(tenantB);
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
        }
        await pausing;

        expect(await runRowsOf(tenantB)).toEqual([
          expect.objectContaining({ status: "error", result: "account deactivated" }),
        ]);
        await sendAs(tenantB, conversation, "b after");
        expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
        conversation.clear();
      });

      it("closes the run as error instead of rescheduling the pause when a TTL pause in progress fails", async () => {
        const { createAgentSession, sessions } = recordingSessions();
        const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
        await sendAs(tenantB, conversation, "b one");
        await failRunCloses(tenantB, ["done"]);

        const pausing = pauseOf(conversation, tenantB);
        await conversation.dropTenant(tenantB);
        await pausing;

        expect(await runRowsOf(tenantB)).toEqual([
          expect.objectContaining({ status: "error", result: "account deactivated" }),
        ]);
        await sendAs(tenantB, conversation, "b after");
        expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
        conversation.clear();
      });
    });

    it("does nothing on a second call, during a turn or after it, or for a tenant with no conversation", async () => {
      const slow = gate();
      const { createAgentSession } = recordingSessions(new Map([["b slow", slow.promise]]));
      const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
      await conversation.dropTenant(tenantB);
      expect(await runRowsOf(tenantB)).toEqual([]);

      const bInFlight = sendAs(tenantB, conversation, "b slow");
      await vi.waitFor(async () => expect(await runRowsOf(tenantB)).toHaveLength(1));
      await conversation.dropTenant(tenantB);
      await conversation.dropTenant(tenantB);
      slow.release();
      await bInFlight;
      await conversation.dropTenant(tenantB);

      const { rows } = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications WHERE kind = 'agent_run_error'`,
      );
      expect(rows[0]!.n).toBe(1);
      expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["error"]);
      conversation.clear();
    });
  });
});
