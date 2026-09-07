import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { SEMP_BUSY_ERROR_MESSAGE, SempConversation } from "../sempConversation.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "../types.js";

let pool: Pool;

const SEMPREC_PROJECT_ITEM_ID = "99999999-9999-9999-9999-999999999999";

/** A session whose `messages()`/`send()` yield exactly the given batch, one call each. */
function scriptedSession(...batches: AgentMessage[][]): { createAgentSession: CreateAgentSession; callCount: () => number; tasks: string[] } {
  let call = 0;
  const tasks: string[] = [];
  const createAgentSession: CreateAgentSession = (options): AgentSession => {
    tasks.push(options.task);
    return {
      async *messages() {
        const batch = batches[call++];
        for (const message of batch) yield message;
      },
      async *send(task: string) {
        tasks.push(task);
        const batch = batches[call++];
        for (const message of batch) yield message;
      },
    };
  };
  return { createAgentSession, callCount: () => call, tasks };
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
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    const result = await conversation.send("hi");

    expect(result).toEqual({ ok: true, message: "hello there" });

    const { rows } = await pool.query<{ unit: string; triggered_by: string; parent_run_id: string | null; status: string }>(
      `SELECT unit, triggered_by, parent_run_id, status FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe("session");
    expect(rows[0].triggered_by).toBe("user");
    expect(rows[0].parent_run_id).toBeNull();
    expect(rows[0].status).toBe("running");

    conversation.clear();
  });

  it("reuses the same in-memory session and agent_runs row for consecutive sends", async () => {
    const { createAgentSession, callCount } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    const first = await conversation.send("one");
    const second = await conversation.send("two");

    expect(first).toEqual({ ok: true, message: "first" });
    expect(second).toEqual({ ok: true, message: "second" });
    expect(callCount()).toBe(2);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows[0].n).toBe(1);

    conversation.clear();
  });

  it("calls reconstructHistory on every wake and folds its result into the woken session's task", async () => {
    const calls: Array<[string]> = [];
    const reconstructHistory = async (_pool: Pool, projectItemId: string) => {
      calls.push([projectItemId]);
      return calls.length === 1 ? null : "prior: hello there";
    };
    const { createAgentSession, tasks } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first wake" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second wake" }, { kind: "turn_end" }],
    );
    const ttlMs = 40;
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID, reconstructHistory }, ttlMs);

    await conversation.send("hi");
    expect(calls).toEqual([[SEMPREC_PROJECT_ITEM_ID]]);
    expect(tasks).toEqual(["hi"]);

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    await conversation.send("hi again");

    expect(calls).toEqual([[SEMPREC_PROJECT_ITEM_ID], [SEMPREC_PROJECT_ITEM_ID]]);
    expect(tasks).toEqual(["hi", "prior: hello there\n\nhi again"]);

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
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID }, ttlMs);

    await conversation.send("one");

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    const { rows: afterTtl } = await pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(afterTtl).toHaveLength(1);
    expect(afterTtl[0].status).toBe("done");
    expect(afterTtl[0].finished_at).not.toBeNull();

    const second = await conversation.send("two");
    expect(second).toEqual({ ok: true, message: "second wake" });

    const { rows: allRuns } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(allRuns[0].n).toBe(2);

    conversation.clear();
  });

  it("does not pause a conversation touched again before its TTL elapses", async () => {
    const ttlMs = 150;
    const { createAgentSession } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID }, ttlMs);

    await conversation.send("one");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await conversation.send("two");
    await new Promise((resolve) => setTimeout(resolve, 60));

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");

    conversation.clear();
  });

  it("rejects a send that arrives while a TTL pause is mid-flight, instead of reusing the session pause() is finishing as done", async () => {
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first wake" },
      { kind: "turn_end" },
    ]);
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    await conversation.send("one");

    // Invoke the TTL handler's private pause() directly rather than waiting out a real TTL:
    // pause() claims the entry as busy synchronously, before its first `await` (the invariant
    // the high-severity review finding required), so by the time `send()` below runs — the
    // very next synchronous statement — it already observes `busy` and is rejected instead of
    // reusing a session whose run pause() is concurrently finishing as `done`.
    const pausePromise = (conversation as unknown as { pause(): Promise<void> }).pause();
    const duringPause = await conversation.send("during pause");
    expect(duringPause).toEqual({ ok: false, error: SEMP_BUSY_ERROR_MESSAGE });

    await pausePromise;

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE project_item_id = $1`, [
      SEMPREC_PROJECT_ITEM_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");

    conversation.clear();
  });

  it("rejects a send that arrives while another is already in flight, without blocking or overwriting it", async () => {
    const { createAgentSession, release } = blockingSession();
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    const inFlight = conversation.send("slow");

    // Give the in-flight call's first turn_start a chance to be persisted before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const duplicate = await conversation.send("duplicate");
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
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    const firstPromise = conversation.send("first");
    const secondPromise = new Promise((resolve) => setTimeout(resolve, 5)).then(() => conversation.send("second"));

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
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    await expect(conversation.send("fails")).rejects.toThrow("boom");

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].result).toBe("boom");

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
    const conversation = new SempConversation(pool, { createAgentSession, projectItemId: SEMPREC_PROJECT_ITEM_ID });

    const first = await conversation.send("one");
    expect(first).toEqual({ ok: true, message: "first" });

    await expect(conversation.send("two")).rejects.toThrow("second turn boom");
    expect(call).toBe(1);

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [SEMPREC_PROJECT_ITEM_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].result).toBe("second turn boom");

    conversation.clear();
  });
});
