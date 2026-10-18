import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createAgentRun, setAgentRunEventHook, type AgentRunRow } from "@semprec/data";
import { createTenantZeroUser, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { getTraceContext } from "@semprec/shared";
import { publishRealtimeMessage } from "@semprec/realtime";
import {
  AgentRunCancelledError,
  pushRunStatus,
  runAgentSession,
  runAgentSessionForRun,
  runAgentTurn,
} from "../lifecycleAdapter.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "../types.js";

let pool: Pool;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

function fakeSession(messages: AgentMessage[]): CreateAgentSession {
  return (): AgentSession => ({
    async *messages() {
      for (const message of messages) yield message;
    },
  });
}

afterAll(async () => {
  await pool?.end();
});

describe("runAgentSession", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
    setAgentRunEventHook((event) => {
      publishRealtimeMessage(pool, { type: "agent_run_event", ...event }).catch((err: unknown) => {
        console.error("Failed to publish agent_run_event realtime message", err);
      });
    });
  });

  afterEach(() => {
    setAgentRunEventHook(() => {});
  });

  it("reconstructs a completed run's transcript from agent_run_events in monotonic order", async () => {
    const messages: AgentMessage[] = [
      { kind: "turn_start" },
      { kind: "message_update", text: "Hel" },
      { kind: "message_update", text: "Hello" },
      { kind: "message", text: "Hello there" },
      { kind: "tool_use", tool: "search" },
      { kind: "tool_result", tool: "search", result: "ok" },
      { kind: "run_status", status: "waiting_for_approval" },
      { kind: "turn_end" },
    ];

    const run = await runAgentSession(pool, {
      createAgentSession: fakeSession(messages),
      task: "do the thing",
      triggeredBy: "user",
    });

    expect(run.status).toBe("done");
    expect(run.result).toBe("Hello there");
    expect(run.unit).toBe("invocation");
  });

  it("binds the new run's id into the trace context the session's message stream runs under (#167)", async () => {
    const observed: { traceId: string | undefined; agentRunId: string | undefined }[] = [];
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        observed.push({ traceId: getTraceContext()?.traceId, agentRunId: getTraceContext()?.agentRunId });
        yield { kind: "turn_start" };
        yield { kind: "turn_end" };
      },
    });

    const run = await runAgentSession(pool, {
      createAgentSession,
      task: "do the thing",
      triggeredBy: "user",
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]!.agentRunId).toBe(run.id);
    expect(observed[0]!.traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("never persists message_update deltas", async () => {
    const run = await runAgentSession(pool, {
      createAgentSession: fakeSession([
        { kind: "turn_start" },
        { kind: "message_update", text: "partial" },
        { kind: "message_update", text: "partial two" },
        { kind: "turn_end" },
      ]),
      task: "stream something",
      triggeredBy: "mcp",
    });

    const { rows } = await pool.query("SELECT kind FROM agent_run_events WHERE agent_run_id = $1", [run.id]);
    expect(rows.some((r) => r.kind === "message_update")).toBe(false);
  });

  it("persists the caller-chosen unit, defaulting to invocation", async () => {
    const sessionRun = await runAgentSession(pool, {
      createAgentSession: fakeSession([{ kind: "turn_start" }, { kind: "turn_end" }]),
      task: "managed conversation",
      triggeredBy: "user",
      unit: "session",
    });
    expect(sessionRun.unit).toBe("session");

    const invocationRun = await runAgentSession(pool, {
      createAgentSession: fakeSession([{ kind: "turn_start" }, { kind: "turn_end" }]),
      task: "one-shot",
      triggeredBy: "heartbeat",
    });
    expect(invocationRun.unit).toBe("invocation");
  });

  it("marks the run as errored and stops persisting further events when the session throws", async () => {
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        throw new Error("boom");
      },
    });

    await expect(
      runAgentSession(pool, { createAgentSession, task: "fails", triggeredBy: "supervisor" }),
    ).rejects.toThrow("boom");

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      "SELECT status, result FROM agent_runs WHERE task = 'fails'",
    );
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("boom");
  });

  it("announces durable events as thin references and sends message_update only on the ephemeral stream", async () => {
    const listenClient = await pool.connect();
    await listenClient.query("LISTEN semprec_events");
    await listenClient.query("LISTEN semprec_agent_stream");
    const notifications: Array<{ channel: string; payload?: string }> = [];
    listenClient.on("notification", (msg) => notifications.push(msg));

    const messages: AgentMessage[] = [
      { kind: "turn_start" },
      { kind: "message_update", text: "partial" },
      { kind: "message", text: "done" },
      { kind: "turn_end" },
    ];

    const run = await runAgentSession(pool, {
      createAgentSession: fakeSession(messages),
      task: "push live",
      triggeredBy: "user",
    });

    const durableForRun = () =>
      notifications
        .filter((n) => n.channel === "semprec_events")
        .map((n) => JSON.parse(n.payload ?? "{}") as { tenantId: string; message: { agentRunId?: string } })
        .filter((envelope) => envelope.message.agentRunId === run.id);
    const deltasForRun = () =>
      notifications
        .filter((n) => n.channel === "semprec_agent_stream")
        .map((n) => JSON.parse(n.payload ?? "{}") as { tenantId: string; message: { agentRunId?: string } })
        .filter((envelope) => envelope.message.agentRunId === run.id);

    // NOTIFY delivery to a LISTEN-ing client is asynchronous relative to the query that
    // triggered it; poll instead of a fixed sleep so this isn't flaky under load.
    const expectedCount = 5; // run_status(running), turn_start, message, turn_end, run_status(done)
    const deadline = Date.now() + 5000;
    while ((durableForRun().length < expectedCount || deltasForRun().length < 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const durable = durableForRun().map((envelope) => envelope.message as Record<string, unknown>);
    expect(durableForRun().every((envelope) => envelope.tenantId === getTenantZeroId())).toBe(true);
    expect(deltasForRun().every((envelope) => envelope.tenantId === getTenantZeroId())).toBe(true);
    const { rows } = await pool.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC",
      [run.id],
    );
    expect(durable.every((m) => m.type === "agent_run_event")).toBe(true);
    expect(durable.map((m) => m.eventId)).toEqual(rows.map((row) => row.id));
    expect(durable.every((m) => !("payload" in m) && !("kind" in m))).toBe(true);
    expect(deltasForRun().map((envelope) => envelope.message)).toEqual([
      {
        type: "agent_run_delta",
        agentRunId: run.id,
        delta: {
          kind: "message_update",
          text: "partial",
        },
      },
    ]);
    expect(rows.some((row) => row.kind === "message_update")).toBe(false);
    expect((deltasForRun()[0]?.message as { delta?: unknown } | undefined)?.delta).toEqual({
      kind: "message_update",
      text: "partial",
    });

    listenClient.release(true);
  });
});

describe("runAgentSessionForRun terminal close", () => {
  const okSession = fakeSession([{ kind: "turn_start" }, { kind: "message", text: "fine" }, { kind: "turn_end" }]);
  const throwingSession: CreateAgentSession = (): AgentSession => ({
    // eslint-disable-next-line require-yield
    async *messages() {
      throw new Error("boom");
    },
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_fail_terminal_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.kind = 'run_status' AND NEW.payload->>'status' = ANY (TG_ARGV) THEN
          RAISE EXCEPTION 'injected run_status failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_fail_done_close() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'done' THEN RAISE EXCEPTION 'injected finishAgentRun failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
  });

  afterEach(async () => {
    await pool.query("DROP TRIGGER IF EXISTS test_fail_terminal_event ON agent_run_events");
    await pool.query("DROP TRIGGER IF EXISTS test_fail_done_close ON agent_runs");
  });

  async function openRun(): Promise<AgentRunRow> {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "close me" });
    await pushRunStatus(pool, run.id, "running");
    return run;
  }

  async function rowStatus(runId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [runId]);
    return rows[0]!.status;
  }

  async function terminalEvents(runId: string): Promise<string[]> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM agent_run_events
       WHERE agent_run_id = $1 AND kind = 'run_status' AND payload->>'status' <> 'running' ORDER BY id`,
      [runId],
    );
    return rows.map((r) => r.status);
  }

  function failEventsFor(...statuses: Array<"done" | "error">): Promise<unknown> {
    const args = statuses.map((s) => `'${s}'`).join(", ");
    return pool.query(
      `CREATE TRIGGER test_fail_terminal_event BEFORE INSERT ON agent_run_events
       FOR EACH ROW EXECUTE FUNCTION test_fail_terminal_event(${args})`,
    );
  }

  it("closes a succeeding session as done with exactly one done event on a bare pool", async () => {
    const run = await openRun();
    const finished = await runAgentSessionForRun(pool, run, { createAgentSession: okSession });
    expect(finished.status).toBe("done");
    expect(await terminalEvents(run.id)).toEqual(["done"]);
  });

  it("closes a throwing session as error with exactly one error event on a bare pool", async () => {
    const run = await openRun();
    await expect(runAgentSessionForRun(pool, run, { createAgentSession: throwingSession })).rejects.toThrow("boom");
    expect(await rowStatus(run.id)).toBe("error");
    expect(await terminalEvents(run.id)).toEqual(["error"]);
  });

  it("leaves the row running with no terminal event when every terminal event write fails (success)", async () => {
    const run = await openRun();
    await failEventsFor("done", "error");
    await expect(runAgentSessionForRun(pool, run, { createAgentSession: okSession })).rejects.toThrow(
      "injected run_status failure",
    );
    expect(await rowStatus(run.id)).toBe("running");
    expect(await terminalEvents(run.id)).toEqual([]);
  });

  it("leaves the row running with no terminal event when every terminal event write fails (throwing)", async () => {
    const run = await openRun();
    await failEventsFor("done", "error");
    await expect(runAgentSessionForRun(pool, run, { createAgentSession: throwingSession })).rejects.toThrow("boom");
    expect(await rowStatus(run.id)).toBe("running");
    expect(await terminalEvents(run.id)).toEqual([]);
  });

  it("falls back to a single error close when only the done event write fails", async () => {
    const run = await openRun();
    await failEventsFor("done");
    await runAgentSessionForRun(pool, run, { createAgentSession: okSession }).catch(() => undefined);
    expect(await rowStatus(run.id)).toBe("error");
    expect(await terminalEvents(run.id)).toEqual(["error"]);
  });

  it("ends with a single error event when finishAgentRun throws on the success path", async () => {
    const run = await openRun();
    await pool.query(
      `CREATE TRIGGER test_fail_done_close BEFORE UPDATE ON agent_runs
       FOR EACH ROW EXECUTE FUNCTION test_fail_done_close()`,
    );
    await runAgentSessionForRun(pool, run, { createAgentSession: okSession }).catch(() => undefined);
    expect(await rowStatus(run.id)).toBe("error");
    expect(await terminalEvents(run.id)).toEqual(["error"]);
  });

  it("writes no done event and keeps the other closer's status when the row was closed elsewhere", async () => {
    const run = await openRun();
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        await pool.query("UPDATE agent_runs SET status = 'error', result = 'elsewhere' WHERE id = $1", [run.id]);
      },
    });
    const finished = await runAgentSessionForRun(pool, run, { createAgentSession });
    expect(finished.status).toBe("error");
    expect(finished.result).toBe("elsewhere");
    expect(await terminalEvents(run.id)).toEqual([]);
  });

  it("writes no error event and rethrows when the row was closed elsewhere before the failure", async () => {
    const run = await openRun();
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      // eslint-disable-next-line require-yield
      async *messages() {
        await pool.query("UPDATE agent_runs SET status = 'done', result = 'elsewhere' WHERE id = $1", [run.id]);
        throw new Error("boom");
      },
    });
    await expect(runAgentSessionForRun(pool, run, { createAgentSession })).rejects.toThrow("boom");
    expect(await rowStatus(run.id)).toBe("done");
    expect(await terminalEvents(run.id)).toEqual([]);
  });

  it("leaves a caller-supplied PoolClient's close to the caller's transaction", async () => {
    const run = await openRun();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const finished = await runAgentSessionForRun(client, run, { createAgentSession: okSession });
      expect(finished.status).toBe("done");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await rowStatus(run.id)).toBe("running");
    expect(await terminalEvents(run.id)).toEqual([]);
  });
});

describe("runAgentTurn cancellation", () => {
  interface HangingSession {
    messages: AsyncIterable<AgentMessage>;
    nextCalls: () => number;
    returnCalls: () => number;
  }

  /** Yields `first`, then hangs on every later `next()` until the test ends; counts `next()` and `return()` calls. */
  function hangingSession(first: AgentMessage[], options: { rejectReturn?: boolean } = {}): HangingSession {
    let nextCalls = 0;
    let returnCalls = 0;
    const iterator: AsyncIterator<AgentMessage> = {
      next() {
        nextCalls += 1;
        const message = first[nextCalls - 1];
        if (message) return Promise.resolve({ done: false, value: message });
        return new Promise<IteratorResult<AgentMessage>>(() => {});
      },
      return() {
        returnCalls += 1;
        if (options.rejectReturn) return Promise.reject(new Error("return failed"));
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return {
      messages: { [Symbol.asyncIterator]: () => iterator },
      nextCalls: () => nextCalls,
      returnCalls: () => returnCalls,
    };
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
  });

  async function openRun(): Promise<AgentRunRow> {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "cancel me" });
    await pushRunStatus(pool, run.id, "running");
    return run;
  }

  it("stops consuming the session and throws AgentRunCancelledError when the signal aborts while it waits", async () => {
    const run = await openRun();
    const session = hangingSession([{ kind: "turn_start" }]);
    const controller = new AbortController();
    const turn = runAgentTurn(
      pool,
      run.id,
      session.messages,
      (m) => {
        // Later than the recording of this message, so the abort lands while `next()` hangs.
        if (m.kind === "turn_start") setTimeout(() => controller.abort(), 50);
      },
      controller.signal,
    );

    await expect(turn).rejects.toThrow(AgentRunCancelledError);
    await expect(turn).rejects.toThrow("account deactivated");
    expect(session.nextCalls()).toBe(2);
    expect(session.returnCalls()).toBe(1);
  });

  it("throws before consuming the first message when the signal is already aborted", async () => {
    const run = await openRun();
    const session = hangingSession([{ kind: "turn_start" }]);
    const controller = new AbortController();
    controller.abort();

    await expect(runAgentTurn(pool, run.id, session.messages, undefined, controller.signal)).rejects.toThrow(
      AgentRunCancelledError,
    );
    expect(session.nextCalls()).toBe(0);
    expect(session.returnCalls()).toBe(1);
  });

  it("stops before the next message when the signal aborts while a message is being recorded", async () => {
    const run = await openRun();
    const session = hangingSession([{ kind: "turn_start" }, { kind: "turn_end" }]);
    const controller = new AbortController();

    await expect(
      runAgentTurn(pool, run.id, session.messages, () => controller.abort(), controller.signal),
    ).rejects.toThrow(AgentRunCancelledError);
    expect(session.nextCalls()).toBe(1);
    expect(session.returnCalls()).toBe(1);
  });

  it("completes a turn whose signal never aborts and leaves no abort listener behind", async () => {
    const run = await openRun();
    const controller = new AbortController();

    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const last = await runAgentTurn(
      pool,
      run.id,
      fakeSession([{ kind: "turn_start" }, { kind: "message", text: "fine" }, { kind: "turn_end" }])({
        task: "t",
      }).messages(),
      undefined,
      controller.signal,
    );

    expect(last).toEqual({ kind: "message", text: "fine" });
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledExactlyOnceWith("abort", addListener.mock.calls[0]![1]);
    vi.restoreAllMocks();
  });

  it.each([false, true])("does not close an iterator whose next() rejects (signal: %s)", async (withSignal) => {
    const run = await openRun();
    const failure = new Error("next failed");
    const close = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
    const messages: AsyncIterable<AgentMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure), return: close }),
    };
    await expect(
      runAgentTurn(pool, run.id, messages, undefined, withSignal ? new AbortController().signal : undefined),
    ).rejects.toBe(failure);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not create a session for an already-aborted run and closes it as error", async () => {
    const run = await openRun();
    const controller = new AbortController();
    controller.abort();
    const createAgentSession = vi.fn(fakeSession([]));
    await expect(runAgentSessionForRun(pool, run, { createAgentSession, signal: controller.signal })).rejects.toThrow(
      AgentRunCancelledError,
    );
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(
      (await pool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [run.id])).rows,
    ).toEqual([{ status: "error" }]);
  });

  it("rethrows the turn's own failure when the session's return() also fails", async () => {
    const run = await openRun();
    const session = hangingSession([{ kind: "turn_start" }], { rejectReturn: true });

    await expect(
      runAgentTurn(pool, run.id, session.messages, () => {
        throw new Error("observer failed");
      }),
    ).rejects.toThrow("observer failed");
    expect(session.returnCalls()).toBe(1);
  });

  it("closes the run as error with its notification and run_status event through runAgentSessionForRun", async () => {
    const run = await openRun();
    const session = hangingSession([{ kind: "turn_start" }]);
    const controller = new AbortController();
    const createAgentSession = vi.fn<CreateAgentSession>(() => ({ messages: () => session.messages }));

    await expect(
      runAgentSessionForRun(pool, run, {
        createAgentSession,
        signal: controller.signal,
        onEvent: () => setTimeout(() => controller.abort(), 50),
      }),
    ).rejects.toThrow(AgentRunCancelledError);

    const { rows: runs } = await pool.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [
      run.id,
    ]);
    expect(runs).toEqual([{ status: "error" }]);
    const { rows: events } = await pool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM agent_run_events
       WHERE agent_run_id = $1 AND kind = 'run_status' AND payload->>'status' <> 'running'`,
      [run.id],
    );
    expect(events).toEqual([{ status: "error" }]);
    const { rows: notifications } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error' AND source_id = $1",
      [run.id],
    );
    expect(notifications).toEqual([{ count: "1" }]);
    expect(session.returnCalls()).toBe(1);
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
