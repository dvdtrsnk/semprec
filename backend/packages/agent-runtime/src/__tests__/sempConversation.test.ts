import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { AgentRunError, createUser, finishAgentRun, hashPassword, type AgentRunRow } from "@semprec/data";
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

/** An `Error` is expanded, which `JSON.stringify` alone drops. */
function loggedText(...spies: MockInstance[]): string {
  return JSON.stringify(
    spies.map((spy) => spy.mock.calls),
    (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : value,
  );
}

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

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const SEMPREC_PROJECT_ITEM_ID = "99999999-9999-9999-9999-999999999999";

/** One turn that replies `text`. */
const turn = (text: string): AgentMessage[] => [
  { kind: "turn_start" },
  { kind: "message", text },
  { kind: "turn_end" },
];

/** A compaction that never compacts, so reconstruction returns the persisted history as it is. */
const noCompaction: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: (entries) => entries as ConversationEntry[],
  contextWindow: 1_000_000,
  settings: {},
};

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
        yield* batches[call++]!;
      },
      async *send(task: string) {
        tasks.push(task);
        yield* batches[call++]!;
      },
    };
  };
  return { createAgentSession, callCount: () => call, tasks, initialStates };
}

function blockingSession(): { createAgentSession: CreateAgentSession; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createAgentSession: CreateAgentSession = (): AgentSession => ({
    async *messages() {
      yield { kind: "turn_start" };
      await gate;
      yield* turn("released").slice(1);
    },
  });
  return { createAgentSession, release };
}

/** A session whose first turn starts a tool call and then throws `failure`. */
const midToolFailure =
  (failure: Error): CreateAgentSession =>
  () => ({
    async *messages() {
      yield { kind: "turn_start" };
      yield { kind: "tool_use", toolCallId: "call-1", name: "search", arguments: {} };
      throw failure;
    },
  });

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

  function conversationOf(
    createAgentSession: CreateAgentSession,
    extra: Partial<SempConversationOptions> = {},
    ttlMs?: number,
    conversationPool: Pool = pool,
  ): SempConversation {
    return new SempConversation(
      conversationPool,
      {
        createAgentSessionForRun: async () => createAgentSession,
        resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
        ...extra,
      },
      ttlMs,
    );
  }

  /** The runs of the Semprec project. */
  async function projectRuns() {
    const { rows } = await pool.query<{
      id: string;
      unit: string;
      triggered_by: string;
      parent_run_id: string | null;
      status: string;
      result: string | null;
      error_code: string | null;
      finished_at: Date | null;
    }>(
      `SELECT id, unit, triggered_by, parent_run_id, status, result, error_code, finished_at
         FROM agent_runs WHERE project_item_id = $1 ORDER BY started_at`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    return rows;
  }

  const statuses = async () => (await projectRuns()).map((run) => run.status);

  /** Runs `body` with a runtime-role pool and the conversations it makes, then clears and closes them. */
  async function withRuntimeRole(
    body: (runtimePool: Pool, conversations: SempConversation[]) => Promise<void>,
    cleanups: Array<() => Promise<unknown>> = [],
  ): Promise<void> {
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const conversations: SempConversation[] = [];
    let failure: { error: unknown } | undefined;
    try {
      await body(runtimePool, conversations);
    } catch (error) {
      failure = { error };
    }
    for (const conversation of conversations) conversation.clear();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [...cleanups, () => runtimePool.end()]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(failure ? [failure.error, ...cleanupErrors] : cleanupErrors, "Test cleanup failed");
    if (failure) throw failure.error;
  }

  it("wakes with persisted history after startup repair closes an idle session", async () => {
    await withRuntimeRole(async (runtimePool, conversations) => {
      const scripted = scriptedSession(turn("first"), turn("second"));
      const extra = { reconstructHistory: createReconstructConversationHistory(noCompaction) };
      const beforeRestart = conversationOf(scripted.createAgentSession, extra, undefined, runtimePool);
      const afterRestart = conversationOf(scripted.createAgentSession, extra, undefined, runtimePool);
      conversations.push(beforeRestart, afterRestart);

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
    });
  });

  it.each(["failure", "cancellation"] as const)(
    "wakes after mid-tool %s using the immediately paired persisted history",
    async (kind) => {
      await withRuntimeRole(async (runtimePool, conversations) => {
        const next = scriptedSession(turn("recovered"));
        const turnFailure = new Error("tool interrupted");
        const controller = new AbortController();
        let wakes = 0;
        const conversation = new SempConversation(runtimePool, {
          createAgentSessionForRun: async () => {
            if (wakes++ > 0) return next.createAgentSession;
            if (kind === "failure") return midToolFailure(turnFailure);
            return () => ({
              async *messages() {
                yield { kind: "turn_start" };
                yield { kind: "tool_use", toolCallId: "call-1", name: "search", arguments: {} };
                controller.abort();
                await new Promise((resolve) => setTimeout(resolve, 0));
              },
            });
          },
          resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
          reconstructHistory: createReconstructConversationHistory(noCompaction),
        });
        conversations.push(conversation);

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
      });
    },
  );

  it("leaves failed pairing repairable and wakes the thread after startup repair", async () => {
    await withRuntimeRole(
      async (runtimePool, conversations) => {
        const turnFailure = new Error("turn failed");
        const next = scriptedSession(turn("recovered"));
        let wakes = 0;
        const options = {
          createAgentSessionForRun: async (): Promise<CreateAgentSession> =>
            wakes++ > 0 ? next.createAgentSession : midToolFailure(turnFailure),
          resolveProjectItemId: async () => SEMPREC_PROJECT_ITEM_ID,
          reconstructHistory: createReconstructConversationHistory(noCompaction),
        };
        const beforeRestart = new SempConversation(runtimePool, options);
        const afterRestart = new SempConversation(runtimePool, options);
        conversations.push(beforeRestart, afterRestart);
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
        const runs = await projectRuns();
        expect(runs.map((run) => run.status)).toEqual(["running"]);
        const events = await pool.query<{ kind: string }>(
          "SELECT kind FROM agent_run_events WHERE agent_run_id = $1 AND kind IN ('tool_result', 'run_status') ORDER BY id",
          [runs[0]!.id],
        );
        expect(events.rows).toEqual([{ kind: "run_status" }]);
        const notices = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM notifications WHERE source_id = $1",
          [runs[0]!.id],
        );
        expect(notices.rows[0]?.count).toBe("0");
        await pool.query("DROP TRIGGER batch15_reject_semp_result ON agent_run_events");
        expect((await repairInterruptedRuns(runtimePool)).repairedRunIds).toContain(runs[0]!.id);
        expect(await sendInTenantZero(afterRestart, "next")).toEqual({ ok: true, message: "recovered" });
        expect(next.initialStates[0]?.messages.map((entry) => entry.message.kind)).toEqual([
          "turn_start",
          "tool_use",
          "tool_result",
        ]);
      },
      [
        () => pool.query("DROP TRIGGER IF EXISTS batch15_reject_semp_result ON agent_run_events"),
        () => pool.query("DROP FUNCTION IF EXISTS batch15_reject_semp_result()"),
      ],
    );
  });

  it("wakes a session-unit, user-triggered run on the first send, reuses its session and run for the next, and binds the run's id into the trace context of both (#167)", async () => {
    const observed: { traceId: string | undefined; agentRunId: string | undefined }[] = [];
    const scripted = scriptedSession(turn("first"), turn("second"));
    const observe = () =>
      observed.push({ traceId: getTraceContext()?.traceId, agentRunId: getTraceContext()?.agentRunId });
    const conversation = conversationOf((options) => {
      const session = scripted.createAgentSession(options);
      return {
        async *messages() {
          observe();
          yield* session.messages();
        },
        async *send(task: string) {
          observe();
          yield* session.send!(task);
        },
      };
    });

    expect(await sendInTenantZero(conversation, "one")).toEqual({ ok: true, message: "first" });
    expect(await sendInTenantZero(conversation, "two")).toEqual({ ok: true, message: "second" });

    expect(scripted.callCount()).toBe(2);
    const runs = await projectRuns();
    expect(runs).toEqual([
      expect.objectContaining({ unit: "session", triggered_by: "user", parent_run_id: null, status: "running" }),
    ]);
    expect(observed.map((entry) => entry.agentRunId)).toEqual([runs[0]!.id, runs[0]!.id]);
    for (const entry of observed) expect(entry.traceId).toMatch(/^[0-9a-f-]{36}$/i);
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
    const { createAgentSession, tasks, initialStates } = scriptedSession(turn("first wake"), turn("second wake"));
    const conversation = conversationOf(createAgentSession, { reconstructHistory }, 40);

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
    const conversation = conversationOf(scriptedSession(turn("woke")).createAgentSession, {
      reconstructHistory: async () => ({ entries: [priorEntry], compacted: true }),
    });

    await sendInTenantZero(conversation, "hi");

    const runs = await projectRuns();
    expect(runs).toHaveLength(1);
    const { rows: events } = await pool.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'`,
      [runs[0]!.id],
    );
    expect(events.map((event) => event.payload)).toEqual([[priorEntry]]);
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
      const runs = await projectRuns();
      expect(runs).toEqual([expect.objectContaining({ status: "error", error_code: "internal" })]);
      const checkpoints = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'",
        [runs[0]!.id],
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
    // The second wake calls createAgentSession() again, consuming the next scripted batch.
    const conversation = conversationOf(
      scriptedSession(turn("first wake"), turn("second wake")).createAgentSession,
      {},
      ttlMs,
    );

    await sendInTenantZero(conversation, "one");
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    const afterTtl = await projectRuns();
    expect(afterTtl.map((run) => run.status)).toEqual(["done"]);
    expect(afterTtl[0]!.finished_at).not.toBeNull();
    expect(await sendInTenantZero(conversation, "two")).toEqual({ ok: true, message: "second wake" });
    expect(await projectRuns()).toHaveLength(2);
    conversation.clear();
  });

  it("records the stored error run_status, not done, when its TTL fires on a run another writer already closed as error", async () => {
    const ttlMs = 60;
    const conversation = conversationOf(scriptedSession(turn("first wake")).createAgentSession, {}, ttlMs);

    await sendInTenantZero(conversation, "one");
    const runId = (await projectRuns())[0]!.id;
    expect(await finishAgentRun(pool, runId, "error", "internal")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    expect(await statuses()).toEqual(["error"]);
    const { rows: events } = await pool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM agent_run_events
        WHERE agent_run_id = $1 AND kind = 'run_status' ORDER BY id`,
      [runId],
    );
    expect(events.map((r) => r.status)).toEqual(["running", "error"]);
    conversation.clear();
  });

  it("does not pause a conversation touched again before its TTL elapses", async () => {
    const conversation = conversationOf(scriptedSession(turn("first"), turn("second")).createAgentSession, {}, 150);

    await sendInTenantZero(conversation, "one");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await sendInTenantZero(conversation, "two");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await statuses()).toEqual(["running"]);
    conversation.clear();
  });

  it("rejects a send that arrives while a TTL pause is mid-flight, instead of reusing the session pause() is finishing as done", async () => {
    const conversation = conversationOf(scriptedSession(turn("first wake")).createAgentSession);

    await sendInTenantZero(conversation, "one");

    // Call the private pause() directly: it claims the entry as busy synchronously, before its first `await`, so the
    // very next `send()` observes `busy` and is rejected.
    const pausePromise = pauseTenant(conversation, tenantZero);
    expect(await sendInTenantZero(conversation, "during pause")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });
    await pausePromise;

    expect(await statuses()).toEqual(["done"]);
    conversation.clear();
  });

  it("rejects a send that arrives while another is already in flight, without blocking or overwriting it", async () => {
    const { createAgentSession, release } = blockingSession();
    const conversation = conversationOf(createAgentSession);

    const inFlight = sendInTenantZero(conversation, "slow");
    // Give the in-flight call's first turn_start a chance to be persisted before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await sendInTenantZero(conversation, "duplicate")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });
    release();
    expect(await inFlight).toEqual({ ok: true, message: "released" });
    expect(await projectRuns()).toHaveLength(1);
    conversation.clear();
  });

  it("rejects two concurrent first-time wakes without opening two runs", async () => {
    const { createAgentSession, release } = blockingSession();
    const conversation = conversationOf(createAgentSession);

    const firstPromise = sendInTenantZero(conversation, "first");
    const secondPromise = new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
      sendInTenantZero(conversation, "second"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    const outcomes = await Promise.all([firstPromise, secondPromise]);
    expect(outcomes.filter((o) => o.ok === false)).toEqual([{ ok: false, error: SEMP_BUSY_ERROR_MESSAGE }]);
    expect(await projectRuns()).toHaveLength(1);
    conversation.clear();
  });

  it.each([
    ["an error", new Error("boom"), "internal"],
    ["a model error", new AgentRunError("modelError", "provider said sentinel-52de"), "modelError"],
  ])(
    "closes a brand-new wake's run as error with the code of %s as its result, does not register it, and keeps the exception message and the task out of the row and the logs",
    async (_label, failure, code) => {
      const conversation = conversationOf(() => ({
        async *messages() {
          yield { kind: "turn_start" };
          throw failure;
        },
      }));
      const spies = [vi.spyOn(logger, "error"), vi.spyOn(logger, "warn"), vi.spyOn(logger, "info")];
      try {
        await expect(sendInTenantZero(conversation, "look up sentinel-52de")).rejects.toThrow(failure.message);

        expect(await projectRuns()).toEqual([
          expect.objectContaining({ status: "error", result: code, error_code: code }),
        ]);
        expect(loggedText(...spies)).not.toContain("sentinel-52de");
      } finally {
        for (const spy of spies) spy.mockRestore();
        conversation.clear();
      }
    },
  );

  it("closes a reused session's run as error and drops the entry when a later turn throws", async () => {
    let call = 0;
    const conversation = conversationOf(() => ({
      async *messages() {
        yield* turn("first");
      },
      async *send() {
        call++;
        yield { kind: "turn_start" };
        throw new Error("second turn boom");
      },
    }));

    expect(await sendInTenantZero(conversation, "one")).toEqual({ ok: true, message: "first" });
    await expect(sendInTenantZero(conversation, "two")).rejects.toThrow("second turn boom");
    expect(call).toBe(1);

    expect(await projectRuns()).toEqual([expect.objectContaining({ status: "error", result: "internal" })]);
    conversation.clear();
  });

  describe("SempConversation per-run session and turn start", () => {
    function sendWith(conversation: SempConversation, task: string, options: SempSendOptions) {
      return runInTenant(tenantZero, () => conversation.send(task, chatThread, options));
    }

    /** A session whose turn (the wake's when `onContinuation` is false) never ends. */
    const neverEnding =
      (onContinuation: boolean): CreateAgentSession =>
      () => ({
        async *messages() {
          if (onContinuation) {
            yield* turn("first");
            return;
          }
          yield { kind: "turn_start" };
          await new Promise<never>(() => {});
        },
        async *send() {
          yield { kind: "turn_start" };
          await new Promise<never>(() => {});
        },
      });

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

      const [row] = await projectRuns();
      expect(seenRuns).toHaveLength(1);
      expect(seenRuns[0]).toMatchObject({ id: row!.id, status: "running", task: "hi" });
      expect(seenSignals).toEqual([controller.signal]);
      conversation.clear();
    });

    it("reports the run and its first stored event once per turn, and a larger first event for a continuation", async () => {
      const conversation = conversationOf(scriptedSession(turn("one"), turn("two")).createAgentSession);
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

      const [row] = await projectRuns();
      expect(starts.map((start) => start.agentRunId)).toEqual([row!.id, row!.id]);
      expect(BigInt(starts[1]!.firstEventId)).toBeGreaterThan(BigInt(starts[0]!.firstEventId));
      // The first stored event of a turn is its turn_start row, before the reply is stored.
      expect(repliesAtStart).toEqual(["0", "1"]);
      const { rows: first } = await pool.query<{ kind: string }>(`SELECT kind FROM agent_run_events WHERE id = $1`, [
        starts[0]!.firstEventId,
      ]);
      expect(first[0]!.kind).toBe("turn_start");
      conversation.clear();
    });

    it.each([
      ["a wake", false],
      ["a continuation", true],
    ])(
      "rejects, closes the run as error and drops the entry when the signal aborts the blocked prompt of %s",
      async (_label, onContinuation) => {
        let wakes = 0;
        const blocked = neverEnding(onContinuation);
        const conversation = conversationOf((options) => {
          wakes++;
          return blocked(options);
        });
        if (onContinuation) await sendWith(conversation, "one", {});
        const controller = new AbortController();
        const sending = sendWith(conversation, "two", {
          signal: controller.signal,
          onTurnStart: () => {
            setTimeout(() => controller.abort(), 0);
          },
        });

        await expect(sending).rejects.toThrow("account deactivated");
        expect(await statuses()).toEqual(["error"]);
        // The entry is gone, so the next send wakes a brand-new session.
        await sendWith(conversation, "three", { signal: AbortSignal.timeout(50) }).catch(() => undefined);
        expect(wakes).toBe(2);
        conversation.clear();
      },
    );

    it("closes the run as error and propagates when onTurnStart throws, without prompting further", async () => {
      let afterFirstEvent = false;
      const conversation = conversationOf(() => ({
        async *messages() {
          yield { kind: "turn_start" };
          afterFirstEvent = true;
          yield { kind: "message", text: "should not happen" };
        },
      }));

      await expect(
        sendWith(conversation, "hi", {
          onTurnStart: () => {
            throw new Error("record failed");
          },
        }),
      ).rejects.toThrow("record failed");

      expect(afterFirstEvent).toBe(false);
      expect(await projectRuns()).toEqual([expect.objectContaining({ status: "error", result: "internal" })]);
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

      expect(await statuses()).toEqual(["error"]);
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

  /** Sessions record their wake tenant and every task; a task listed in `gates` blocks its turn until released. */
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
        const taskGate = gates.get(task);
        if (taskGate) await taskGate;
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
    const { promise: gatePromise, release } = gate();
    const { createAgentSession } = recordingSessions(new Map([["a slow", gatePromise]]));
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

  it("continues each tenant's own session and run on its next send, resolving the project inside the waking tenant's scope", async () => {
    const { createAgentSession, sessions } = recordingSessions();
    const observed: Array<string | undefined> = [];
    const conversation = conversationFor(createAgentSession, {
      resolveProjectItemId: async () => {
        const scope = currentTenantScope();
        observed.push(scope?.kind === "tenant" ? scope.tenantId : undefined);
        return projectByTenant.get(scope?.kind === "tenant" ? scope.tenantId : "")!;
      },
    });

    await sendAs(tenantA, conversation, "a one");
    await sendAs(tenantB, conversation, "b one");
    await sendAs(tenantA, conversation, "a two");
    await sendAs(tenantB, conversation, "b two");

    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.tenantId === tenantA)!.tasks).toEqual(["a one", "a two"]);
    expect(sessions.find((s) => s.tenantId === tenantB)!.tasks).toEqual(["b one", "b two"]);
    expect(await runsOf(tenantA)).toHaveLength(1);
    expect(await runsOf(tenantB)).toHaveLength(1);
    expect(observed).toEqual([tenantA, tenantB]);
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
      const { promise: gatePromise, release } = gate();
      const { createAgentSession, sessions } = recordingSessions(new Map([["slow one", gatePromise]]));
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
      // RLS hides the run outside a tenant scope, so a pause without one could not close it.
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
      const { promise: gatePromise, release } = gate();
      const { createAgentSession } = recordingSessions(new Map([["slow", gatePromise]]));
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

  describe("dropTenant (issue #1042)", () => {
    /** A TTL no other timer here uses, so the conversation's own timers can be told apart. */
    const DROP_TTL_MS = 987_654;

    async function runRowsOf(tenantId: string): Promise<Array<{ id: string; status: string; result: string | null }>> {
      const { rows } = await adminPool.query<{ id: string; status: string; result: string | null }>(
        `SELECT id, status, result FROM agent_runs WHERE tenant_id = $1 ORDER BY started_at`,
        [tenantId],
      );
      return rows;
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
      expect(await runRowsOf(tenantB)).toEqual([expect.objectContaining({ status: "error", result: "cancelled" })]);
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

    it.each([
      ["a wake", false],
      ["a turn on a reused session", true],
    ])("lets an in-flight %s complete, then discards its entry and closes its run as error", async (_label, reused) => {
      const slow = gate();
      const { createAgentSession, sessions } = recordingSessions(new Map([["b slow", slow.promise]]));
      const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
      await sendAs(tenantA, conversation, "a one");
      if (reused) await sendAs(tenantB, conversation, "b one");

      const bInFlight = sendAs(tenantB, conversation, "b slow");
      await vi.waitFor(() => expect(sessions.find((s) => s.tenantId === tenantB)?.tasks ?? []).toContain("b slow"));
      await conversation.dropTenant(tenantB);
      expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);

      slow.release();
      expect(await bInFlight).toEqual({ ok: true, message: "reply to b slow" });

      expect(await runRowsOf(tenantB)).toEqual([expect.objectContaining({ status: "error", result: "cancelled" })]);
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
       * Makes every close of `tenantId`'s runs to one of `statuses` raise. Trigger DDL takes no bind parameters, so
       * Postgres builds it with `format('%L', …)` from bound values and executes the result.
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
        // The pause of "b one" can fire before `dropTenant`; failing `done` too keeps the run `running` for the drop.
        await failRunCloses(tenantB, ["done", "error"]);
        await sendAs(tenantB, conversation, "b one");
        const errorSpy = vi.spyOn(logger, "error");

        await conversation.dropTenant(tenantB);

        expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);
        // Only the error's name is logged; the Postgres error detail can carry the row.
        const dropLogs = errorSpy.mock.calls.filter(
          ([, msg]) => msg === "SempConversation: failed to close dropped run, will retry",
        );
        expect(dropLogs[0]).toEqual([
          {
            errorName: "error",
            errorCode: "cancelled",
            tenantId: tenantB,
            threadId: expect.any(String),
            agentRunId: expect.any(String),
          },
          "SempConversation: failed to close dropped run, will retry",
        ]);
        expect(await sendAs(tenantB, conversation, "b during")).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });
        expect(sessions.find((s) => s.tenantId === tenantB)!.tasks).toEqual(["b one"]);

        await healRunCloses();
        await vi.waitFor(async () =>
          expect(await runRowsOf(tenantB)).toEqual([expect.objectContaining({ status: "error", result: "cancelled" })]),
        );
        await vi.waitFor(async () => expect((await sendAs(tenantB, conversation, "b after")).ok).toBe(true));
        expect(sessions.filter((s) => s.tenantId === tenantB)).toHaveLength(2);
        conversation.clear();
      });

      it.each([
        ["a wake", false],
        ["a turn", true],
      ])(
        "keeps an in-flight %s's dropped entry when the close after it fails, and retries the close",
        async (_label, reused) => {
          const slow = gate();
          const { createAgentSession, sessions } = recordingSessions(new Map([["b slow", slow.promise]]));
          const conversation = conversationFor(createAgentSession, {}, RETRY_TTL_MS);
          if (reused) await sendAs(tenantB, conversation, "b one");
          const bInFlight = sendAs(tenantB, conversation, "b slow");
          await vi.waitFor(() => expect(sessions.find((s) => s.tenantId === tenantB)?.tasks ?? []).toContain("b slow"));
          await conversation.dropTenant(tenantB);
          await failRunCloses(tenantB, ["error"]);

          slow.release();
          expect(await bInFlight).toEqual({ ok: true, message: "reply to b slow" });
          expect((await runRowsOf(tenantB)).map((r) => r.status)).toEqual(["running"]);
          expect(await sendAs(tenantB, conversation, "b during")).toEqual({
            ok: false,
            error: SEMP_BUSY_ERROR_MESSAGE,
          });

          await healRunCloses();
          await vi.waitFor(async () =>
            expect(await runRowsOf(tenantB)).toEqual([
              expect.objectContaining({ status: "error", result: "cancelled" }),
            ]),
          );
          conversation.clear();
        },
      );

      it.each([
        ["when the tenant is dropped while a TTL pause starts", false],
        ["instead of rescheduling the pause when a TTL pause in progress fails", true],
      ])("closes the run as error instead of done %s", async (_label, pauseFails) => {
        const { createAgentSession, sessions } = recordingSessions();
        const conversation = conversationFor(createAgentSession, {}, DROP_TTL_MS);
        await sendAs(tenantB, conversation, "b one");
        if (pauseFails) await failRunCloses(tenantB, ["done"]);

        const pausing = pauseTenant(conversation, tenantB);
        await conversation.dropTenant(tenantB);
        await pausing;

        expect(await runRowsOf(tenantB)).toEqual([expect.objectContaining({ status: "error", result: "cancelled" })]);
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
          pausing = pauseTenant(conversation, tenantB);
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

        expect(await runRowsOf(tenantB)).toEqual([expect.objectContaining({ status: "error", result: "cancelled" })]);
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
