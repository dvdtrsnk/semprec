import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createAgentRun, finishAgentRun } from "@semprec/data";
import { BUSY_ERROR_MESSAGE, DelegationRegistry, type ReconstructDelegatedHistory } from "../delegationRegistry.js";
import type { AgentMessage, AgentSession, ConversationEntry, CreateAgentSession } from "../types.js";

/** `vi.waitFor` guards against `expire()`'s pending DB writes finishing asynchronously relative to when we check. */
async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await predicate())) throw new Error(message);
    },
    { timeout: 5_000, interval: 20 },
  );
}

/**
 * Wraps the real pool so its first `query` whose text starts with `sqlPrefix` rejects with
 * `error`; every other call, and every later one, delegates to the real pool. When `matchParams`
 * is given, a call is only failed if it also satisfies that predicate over the query's bind
 * params — needed to target one specific call among several that share the same SQL text (e.g.
 * `insertAgentRunEvent`'s INSERT, issued for every event kind including the `running` status
 * every `delegate()` call writes on creation).
 */
function poolWithFailingQuery(sqlPrefix: string, error: Error, matchParams?: (params: unknown[]) => boolean): Pool {
  let failed = false;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
          const params = (args[1] as unknown[] | undefined) ?? [];
          if (!failed && text?.startsWith(sqlPrefix) && (!matchParams || matchParams(params))) {
            failed = true;
            return Promise.reject(error);
          }
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

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
    await createUser();
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

  it("records the stored error run_status, not done, when its TTL fires on a run another writer already closed as error", async () => {
    const ttlMs = 60;
    const registry = new DelegationRegistry(pool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "67676767-6767-6767-6767-676767676767";
    const { createAgentSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first session" },
      { kind: "turn_end" },
    ]);

    await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });
    const { rows: runs } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
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

    registry.clear();
  });

  it("rejects a delegate() that arrives while expire() is blocked closing the run, then starts a fresh run once expiry completes", async () => {
    // Generous relative to the setup below (fetch the run id, open a second connection, BEGIN,
    // take the row lock) so that setup reliably finishes before the TTL timer fires.
    const ttlMs = 150;
    const registry = new DelegationRegistry(pool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "88888888-8888-8888-8888-888888888888";
    let sendCalls = 0;
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        yield { kind: "message", text: "first" };
        yield { kind: "turn_end" };
      },
      async *send() {
        sendCalls++;
        yield { kind: "turn_start" };
        yield { kind: "message", text: "reused" };
        yield { kind: "turn_end" };
      },
    });

    await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });
    const { rows: runs } = await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    const runId = runs[0]!.id;

    // Holds a row lock on the run so expire()'s finishAgentRun UPDATE blocks mid-flight once the TTL fires.
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE`, [runId]);

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 20));

    const duringExpiry = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId,
      task: "during expiry",
    });
    expect(duringExpiry).toEqual({ ok: false, error: BUSY_ERROR_MESSAGE });
    expect(sendCalls).toBe(0);

    await blocker.query("COMMIT");
    blocker.release();

    // Poll for the exact fact asserted next (the "done" run_status event), not just the
    // agent_runs.status column, since finishAgentRun's UPDATE and expire()'s pushRunStatus are
    // two separate auto-committed statements — the column can already read "done" a moment
    // before the event insert commits.
    await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT payload->>'status' AS status FROM agent_run_events
          WHERE agent_run_id = $1 AND kind = 'run_status' AND payload->>'status' = 'done'`,
        [runId],
      );
      return rows.length === 1;
    }, "expired run's done run_status event never landed");

    const { rows: statuses } = await pool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM agent_run_events
        WHERE agent_run_id = $1 AND kind = 'run_status' ORDER BY id`,
      [runId],
    );
    expect(statuses.map((r) => r.status)).toEqual(["running", "done"]);

    const afterExpiry = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId,
      task: "after expiry",
    });
    expect(afterExpiry).toEqual({ ok: true, message: "first" });
    expect(sendCalls).toBe(0);

    const { rows: allRuns } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(allRuns[0].n).toBe(2);

    registry.clear();
  });

  it("keeps the entry busy=false and reschedules a retry when the expiry close's own UPDATE fails, so a later delegate() reuses the session", async () => {
    // `expire()`'s catch path reschedules another attempt after another full `ttlMs`, and the
    // failing pool below only fails the very first "UPDATE agent_runs" once — the assertions
    // must run in the window after the first (failed) attempt but before the second (successful)
    // one fires, so ttlMs needs enough slack for that window to be reliably wide.
    const ttlMs = 300;
    const failingPool = poolWithFailingQuery("UPDATE agent_runs", new Error("simulated outage"));
    const registry = new DelegationRegistry(failingPool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "99999999-9999-9999-9999-999999999999";
    let sendCalls = 0;
    const createAgentSession: CreateAgentSession = (): AgentSession => ({
      async *messages() {
        yield { kind: "turn_start" };
        yield { kind: "message", text: "first" };
        yield { kind: "turn_end" };
      },
      async *send() {
        sendCalls++;
        yield { kind: "turn_start" };
        yield { kind: "message", text: "reused" };
        yield { kind: "turn_end" };
      },
    });

    await registry.delegate({ createAgentSession, supervisorRunId, targetProjectItemId, task: "one" });

    // Just past the first (failing) attempt, comfortably before the rescheduled second one at
    // 2 * ttlMs.
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 50));

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");

    const reused = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId,
      task: "two",
    });
    expect(reused).toEqual({ ok: true, message: "reused" });
    expect(sendCalls).toBe(1);

    const { rows: allRuns } = await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE project_item_id = $1`, [
      targetProjectItemId,
    ]);
    expect(allRuns[0].n).toBe(1);

    registry.clear();
  });

  it("drops the entry instead of leaving it busy=false when the run is already closed but the expiry's run_status write fails", async () => {
    // `finishAgentRun`'s own "UPDATE agent_runs" succeeds here — the run really is closed as
    // "done" in the DB — but the subsequent run_status event write throws. That's the race the
    // fix addresses: the entry must still be dropped from `entries` (not left busy=false
    // pointing at a terminal run), otherwise a delegate() landing in this window would reuse a
    // session for a run that is already closed.
    const ttlMs = 60;
    // Only fails the `run_status: "done"` event insert expire() issues after closing the run —
    // not the `run_status: "running"` insert delegate() itself issues on creation, which shares
    // the same SQL text.
    const failingPool = poolWithFailingQuery(
      "INSERT INTO agent_run_events",
      new Error("simulated outage"),
      (params) => typeof params[2] === "string" && params[2].includes('"status":"done"'),
    );
    const registry = new DelegationRegistry(failingPool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "aaaaaaaa-1111-1111-1111-111111111111";
    const { createAgentSession: firstSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first session" },
      { kind: "turn_end" },
    ]);

    await registry.delegate({ createAgentSession: firstSession, supervisorRunId, targetProjectItemId, task: "one" });

    await new Promise((resolve) => setTimeout(resolve, ttlMs + 150));

    const { rows: afterTtl } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    expect(afterTtl).toHaveLength(1);
    expect(afterTtl[0]!.status).toBe("done");

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

  it("does not mutate or reschedule a stale entry when a concurrent delegate() replaces it while expire()'s run_status write is still failing", async () => {
    // Reproduces the identity race: `finishAgentRun` closes the run and `entries.delete`
    // already ran, but the `pushRunStatus` insert below is held pending rather than settled
    // immediately. While it's pending, a fresh delegate() onto the same key creates a brand-new
    // entry for a brand-new run. Only once that second entry exists do we reject the held
    // insert, landing in expire()'s catch block with a *different* live entry now occupying the
    // key. The fix must compare the stale `entry` object's identity against what's in `entries`
    // (not just key presence) so it neither mutates the new entry's `busy` flag nor arms an
    // orphaned TTL timer that would later force-close the new run out from under it.
    let rejectPending: ((err: Error) => void) | null = null;
    let matched = false;
    const controlledPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
            const params = (args[1] as unknown[] | undefined) ?? [];
            if (
              !matched &&
              text?.startsWith("INSERT INTO agent_run_events") &&
              typeof params[2] === "string" &&
              params[2].includes('"status":"done"')
            ) {
              matched = true;
              return new Promise((_resolve, reject) => {
                rejectPending = reject;
              });
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const ttlMs = 300;
    const registry = new DelegationRegistry(controlledPool, ttlMs);
    const supervisorRunId = await newSupervisorRunId();
    const targetProjectItemId = "bbbbbbbb-2222-2222-2222-222222222222";
    const { createAgentSession: firstSession } = scriptedSession([
      { kind: "turn_start" },
      { kind: "message", text: "first session" },
      { kind: "turn_end" },
    ]);

    await registry.delegate({ createAgentSession: firstSession, supervisorRunId, targetProjectItemId, task: "one" });
    const { rows: firstRunRows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE project_item_id = $1`,
      [targetProjectItemId],
    );
    const firstRunId = firstRunRows[0]!.id;

    // Wait until expire()'s finishAgentRun has closed the first run and its entry has been
    // dropped, and its pushRunStatus insert is blocked pending our release.
    await waitFor(async () => matched, "expire()'s run_status insert was never reached");
    await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [
        firstRunId,
      ]);
      return rows[0]?.status === "done";
    }, "first run was never closed as done");

    // A fresh delegate() onto the same key now sees no entry (it was already dropped) and no
    // pending create, so it creates a brand-new run and entry.
    const { createAgentSession: secondSession } = scriptedSession(
      [{ kind: "turn_start" }, { kind: "message", text: "second session" }, { kind: "turn_end" }],
      [{ kind: "turn_start" }, { kind: "message", text: "second session, touched" }, { kind: "turn_end" }],
    );
    const second = await registry.delegate({
      createAgentSession: secondSession,
      supervisorRunId,
      targetProjectItemId,
      task: "two",
    });
    expect(second).toEqual({ ok: true, message: "second session" });
    const { rows: secondRunRows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE project_item_id = $1 AND id != $2`,
      [targetProjectItemId, firstRunId],
    );
    const secondRunId = secondRunRows[0]!.id;

    // Now let the first expire() call's pushRunStatus fail, landing in the catch block while
    // the second run's entry occupies the key. A buggy reschedule (armed on the stale, deleted
    // entry) would fire another `expire()` call `ttlMs` after this rejection lands.
    const releasedAt = Date.now();
    rejectPending!(new Error("simulated outage"));

    // Touch the second entry partway through that window, pushing its own legitimate TTL out
    // further than the buggy timer would fire — so if the fix is broken and the second run gets
    // force-closed at (released + ttlMs), that's distinguishable from its own real expiry, which
    // would only be due at (touch + ttlMs), later still.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const touched = await registry.delegate({
      createAgentSession: secondSession,
      supervisorRunId,
      targetProjectItemId,
      task: "touch",
    });
    expect(touched).toEqual({ ok: true, message: "second session, touched" });

    // Past when the buggy orphaned timer would have fired (released + ttlMs), but comfortably
    // before the second entry's own real, touch-extended expiry.
    const elapsedSinceRelease = Date.now() - releasedAt;
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 30 - elapsedSinceRelease));

    const { rows: secondRunStatus } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_runs WHERE id = $1`,
      [secondRunId],
    );
    expect(secondRunStatus[0]!.status).toBe("running");

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
