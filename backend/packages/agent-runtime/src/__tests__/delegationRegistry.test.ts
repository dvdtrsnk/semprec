import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun } from "@semprec/data";
import { BUSY_ERROR_MESSAGE, DelegationRegistry, type ReconstructDelegatedHistory } from "../delegationRegistry.js";
import type { AgentMessage, AgentSession, ConversationEntry, CreateAgentSession } from "../types.js";

let pool: Pool;

/** A session whose `messages()`/`send()` yield exactly the given batch, one call each. */
function scriptedSession(...batches: AgentMessage[][]): {
  createAgentSession: CreateAgentSession;
  callCount: () => number;
} {
  let call = 0;
  const createAgentSession: CreateAgentSession = (): AgentSession => ({
    async *messages() {
      const batch = batches[call++]!;
      for (const message of batch) yield message;
    },
    async *send() {
      const batch = batches[call++]!;
      for (const message of batch) yield message;
    },
  });
  return { createAgentSession, callCount: () => call };
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

async function newSupervisorRunId(): Promise<string> {
  const run = await createAgentRun(pool, { triggeredBy: "user", task: "supervise" });
  return run.id;
}

describe("DelegationRegistry", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a session-unit agent_runs row on first delegation and returns the final assistant message", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "11111111-1111-1111-1111-111111111111";
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "done with task one" },
      { kind: "turn_end" },
    ]);

    const result = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId,
      task: "do task one",
    });

    expect(result).toEqual({ ok: true, message: "done with task one" });

    const { rows } = await pool.query<{ unit: string; triggered_by: string; parent_run_id: string; status: string }>(
      `SELECT unit, triggered_by, parent_run_id, status FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unit).toBe("session");
    expect(rows[0]!.triggered_by).toBe("supervisor");
    expect(rows[0]!.parent_run_id).toBe(supervisorRunId);
    expect(rows[0]!.status).toBe("running");

    registry.clear();
  });

  it("reuses the same AgentSession and agent_runs row for a second delegation onto the same key", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "22222222-2222-2222-2222-222222222222";
    const { createAgentSession, callCount } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );

    const first = await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });
    const second = await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "two" });

    expect(first).toEqual({ ok: true, message: "first" });
    expect(second).toEqual({ ok: true, message: "second" });
    expect(callCount()).toBe(2);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(rows[0].n).toBe(1);

    registry.clear();
  });

  it("never shares a target session between two unrelated supervisor runs delegating to the same project", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorA = await newSupervisorRunId();
    const supervisorB = await newSupervisorRunId();
    const targetProjectItemId = "33333333-3333-3333-3333-333333333333";
    const sessionA = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "for A" },
      { kind: "turn_end" },
    ]);
    const sessionB = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "for B" },
      { kind: "turn_end" },
    ]);

    const resultA = await registry.delegate({
      createAgentSession: sessionA.createAgentSession,
      supervisorRunId: supervisorA,
      targetProjectItemId,
      task: "a",
    });
    const resultB = await registry.delegate({
      createAgentSession: sessionB.createAgentSession,
      supervisorRunId: supervisorB,
      targetProjectItemId,
      task: "b",
    });

    expect(resultA).toEqual({ ok: true, message: "for A" });
    expect(resultB).toEqual({ ok: true, message: "for B" });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(rows[0].n).toBe(2);

    registry.clear();
  });

  it("rejects a concurrent delegation onto a busy key immediately, without blocking or overwriting the in-flight call", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "44444444-4444-4444-4444-444444444444";
    const { createAgentSession, release } = blockingSession();

    const inFlight = registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "slow" });

    // Give the in-flight call's first turn_start a chance to be persisted before the second call arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const duplicate = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId,
      task: "duplicate",
    });
    expect(duplicate).toEqual({ ok: false, error: BUSY_ERROR_MESSAGE });

    release();
    const resolved = await inFlight;
    expect(resolved).toEqual({ ok: true, message: "released" });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(rows[0].n).toBe(1);

    registry.clear();
  });

  it("rejects two concurrent first-time delegations onto the same brand-new key without creating two sessions", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "55555555-5555-5555-5555-555555555555";
    const { createAgentSession, release } = blockingSession();

    const firstPromise = registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "first" });
    const secondPromise = new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
      registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "second" }),
    );

    // Whichever call actually reserved the key wins and blocks on the gate; the other must be
    // rejected as busy rather than also creating an agent_runs row. Release the gate before
    // awaiting either, otherwise awaiting the rejected one first would deadlock on the winner.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    const outcomes = await Promise.all([firstPromise, secondPromise]);
    const rejected = outcomes.filter((o) => o.ok === false);
    expect(rejected).toEqual([{ ok: false, error: BUSY_ERROR_MESSAGE }]);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(rows[0].n).toBe(1);

    registry.clear();
  });

  it("closes an idle delegated session as done after its TTL and a fresh delegation afterwards creates a new one", async () => {
    const ttlMs = 60;
    const registry = new DelegationRegistry(pool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "66666666-6666-6666-6666-666666666666";
    const { createAgentSession: firstSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first session" },
      { kind: "turn_end" },
    ]);

    await registry.delegate({ createAgentSession: firstSession, supervisorRunId, targetProjectItemId, task: "one" });

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    const { rows: afterTtl } = await pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    expect(afterTtl).toHaveLength(1);
    expect(afterTtl[0]!.status).toBe("done");
    expect(afterTtl[0]!.finished_at).not.toBeNull();

    const { createAgentSession: secondSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "second session" },
      { kind: "turn_end" },
    ]);
    const second = await registry.delegate({
      createAgentSession: secondSession,
      supervisorRunId,
      targetProjectItemId,
      task: "two",
    });
    expect(second).toEqual({ ok: true, message: "second session" });

    const { rows: allRuns } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(allRuns[0].n).toBe(2);

    registry.clear();
  });

  it("does not expire a delegation touched again before its TTL elapses", async () => {
    const ttlMs = 150;
    const registry = new DelegationRegistry(pool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "77777777-7777-7777-7777-777777777777";
    const { createAgentSession } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "first" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second" }, { kind: "turn_end" }],
    );

    await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "two" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");

    registry.clear();
  });

  it("persists a compacted reconstruction as a 'compaction' event on the run it seeds", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const priorEntry: ConversationEntry = {
      id: "1",
      parentId: null,
      seq: 0,
      timestamp: 0,
      message: { kind: "message", text: "summary" },
    };
    const reconstructHistory: ReconstructDelegatedHistory = async () => ({ entries: [priorEntry], compacted: true });
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "woke" },
      { kind: "turn_end" },
    ]);

    const result = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId,
      task: "do it",
      reconstructHistory,
    });
    expect(result).toEqual({ ok: true, message: "woke" });

    const { rows: runs } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(runs).toHaveLength(1);

    const { rows: events } = await pool.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'`,
      [runs[0]!.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual([priorEntry]);

    registry.clear();
  });

  it("rejects a malformed targetProjectItemId before touching the database", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "x" },
      { kind: "turn_end" },
    ]);

    const result = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId: "not-a-uuid",
      task: "do it",
    });

    expect(result).toEqual({ ok: false, error: 'targetProjectItemId "not-a-uuid" is not a well-formed UUID' });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE task = 'do it'`);
    expect(rows[0].n).toBe(0);

    registry.clear();
  });

  it("closes a brand-new session's agent_runs row as error and does not register it when the first turn throws", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        throw new Error("boom");
      },
    });

    await expect(
      registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "fails" }),
    ).rejects.toThrow("boom");

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("boom");

    // The failed session must not be left registered for reuse — a retry creates a fresh one.
    const { createAgentSession: retrySession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "recovered" },
      { kind: "turn_end" },
    ]);
    const retry = await registry.delegate({
      createAgentSession: retrySession,
      supervisorRunId,
      targetProjectItemId,
      task: "retry",
    });
    expect(retry).toEqual({ ok: true, message: "recovered" });

    registry.clear();
  });

  it("closes a reused session's agent_runs row as error and drops the entry when a later turn throws", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
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

    const first = await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });
    expect(first).toEqual({ ok: true, message: "first" });

    await expect(
      registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "two" }),
    ).rejects.toThrow("second turn boom");
    expect(call).toBe(1);

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toBe("second turn boom");

    registry.clear();
  });

  it("closes the run and drops the entry when a reuse attempt hits a session that cannot continue", async () => {
    const registry = new DelegationRegistry(pool);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    // No `send` implemented — only supports the very first turn, like every session before #229.
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        yield { kind: "message", text: "first" };
        yield { kind: "turn_end" };
      },
    });

    const first = await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });
    expect(first).toEqual({ ok: true, message: "first" });

    await expect(
      registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "two" }),
    ).rejects.toThrow("does not support continuation");

    const { rows } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.result).toMatch(/does not support continuation/);

    // The entry must be gone, not left busy=false-but-broken — a fresh delegation succeeds.
    const { createAgentSession: retrySession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "recovered" },
      { kind: "turn_end" },
    ]);
    const retry = await registry.delegate({
      createAgentSession: retrySession,
      supervisorRunId,
      targetProjectItemId,
      task: "retry",
    });
    expect(retry).toEqual({ ok: true, message: "recovered" });

    registry.clear();
  });
});
