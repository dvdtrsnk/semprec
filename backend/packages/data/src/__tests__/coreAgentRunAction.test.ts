import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import {
  coreAgentRunAction,
  CORE_AGENT_RUN_ACTION_ID,
  createActionRegistry,
  type ActionContext,
} from "../scheduler/actions.js";
import { createHeartbeatFireAgentTask } from "../scheduler/sweep.js";
import { createAgentRun, getLatestRunOfOccurrence, listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";

let pool: Pool;

/** Wraps the real pool so its first `connect()` calls reject with `errors`, in order; later calls delegate. */
/** Each entry fails one `connect()` in order; `null` lets that call through to the real pool. */
function poolWithFailingConnects(errors: (Error | null)[]): Pool {
  const remaining = [...errors];
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return () => {
          const next = remaining.shift();
          return next ? Promise.reject(next) : target.connect();
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("coreAgentRunAction", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("passes an item id into the persisted and dispatched task while leaving timed tasks unchanged", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const calls: Array<{ task: string; itemId?: string }> = [];
    const handler = coreAgentRunAction(pool, async (input) => {
      calls.push({ task: input.task, itemId: input.itemId });
    });
    const itemId = "00000000-0000-4000-8000-000000000123";
    await handler({ task: "Review" }, { heartbeatId, projectItemId, itemId });
    await handler({ task: "Timed" }, { heartbeatId, projectItemId });
    expect(calls).toEqual([
      { task: `Review\nTriggering item id: ${itemId}`, itemId },
      { task: "Timed", itemId: undefined },
    ]);
    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs.map((run) => run.task).sort()).toEqual([`Review\nTriggering item id: ${itemId}`, "Timed"].sort());
  });

  async function getSemprecProjectId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
    const database = rows[0];
    if (!database) throw new Error("Missing projects database");
    const { rows: items } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [
      database.id,
    ]);
    const item = items[0];
    if (!item) throw new Error("Missing project item");
    return item.id;
  }

  async function createTestHeartbeat(): Promise<{ heartbeatId: string; projectItemId: string }> {
    const projectItemId = await getSemprecProjectId();
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "Process inbox",
        rule: { kind: "interval", minutes: 1 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "process the inbox" },
      }),
    );
    return { heartbeatId: heartbeat.id, projectItemId };
  }

  async function getNotifications(kind: string) {
    const { rows } = await pool.query<{ kind: string; source_table: string; source_id: string }>(
      "SELECT kind, source_table, source_id FROM notifications WHERE kind = $1",
      [kind],
    );
    return rows;
  }

  it("notifies once per failed occurrence: two non-final attempts close silently, the final attempt notifies on its own run", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const handler = coreAgentRunAction(pool, async () => {
      throw new Error("model failed");
    });
    const baseContext: ActionContext = { heartbeatId, projectItemId };

    // Identifying "the final run" by comparing `startedAt` is unreliable: sequential inserts in a
    // fast test environment can land in the same database millisecond. Instead, capture each
    // call's newly created run id by diffing the run set immediately after that call returns.
    const seenRunIds = new Set<string>();
    async function runAndCaptureNewRunId(isFinalAttempt: boolean): Promise<string> {
      await expect(handler({}, { ...baseContext, isFinalAttempt })).rejects.toThrow("model failed");
      const runsAfter = await listAgentRunsByHeartbeat(pool, heartbeatId);
      const created = runsAfter.find((run) => !seenRunIds.has(run.id));
      if (!created) throw new Error("expected a new agent run to be created");
      seenRunIds.add(created.id);
      return created.id;
    }

    await runAndCaptureNewRunId(false);
    await runAndCaptureNewRunId(false);
    const finalRunId = await runAndCaptureNewRunId(true);

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.status).toBe("error");
      expect(run.errorCode).toBe("internal");
      expect(run.result).toBe("model failed");
    }

    const notifications = await getNotifications("agent_run_error");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.source_id).toBe(finalRunId);
  });

  it("a direct caller with isFinalAttempt omitted gets the pre-existing behaviour: one run, one notification", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const handler = coreAgentRunAction(pool, async () => {
      throw new Error("model failed");
    });

    await expect(handler({}, { heartbeatId, projectItemId })).rejects.toThrow("model failed");

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.errorCode).toBe("internal");

    const notifications = await getNotifications("agent_run_error");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.source_id).toBe(runs[0]!.id);
  });

  it("never masks the original runAgent error when the close-and-notify transaction itself fails", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    // The first connect is the run-start transaction; the second is the close-and-notify one.
    const failingPool = poolWithFailingConnects([null, new Error("db down")]);
    const handler = coreAgentRunAction(failingPool, async () => {
      throw new Error("model failed");
    });

    await expect(handler({}, { heartbeatId, projectItemId, isFinalAttempt: true })).rejects.toThrow("model failed");

    const { rows } = await pool.query<{ status: string }>("SELECT status FROM agent_runs WHERE heartbeat_id = $1", [
      heartbeatId,
    ]);
    expect(rows).toHaveLength(1);
    // The close never completed (its transaction's connect() rejected), so the run is left
    // running — the documented consequence is the next startup repair closes it.
    expect(rows[0]!.status).toBe("running");

    const notifications = await getNotifications("agent_run_error");
    expect(notifications).toHaveLength(0);
  });

  it("through the fire task: a core.agentRun heartbeat failing on the final attempt notifies once", async () => {
    const { heartbeatId } = await createTestHeartbeat();
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async () => {
        throw new Error("model failed");
      }),
    );
    const task = createHeartbeatFireAgentTask(pool, registry);

    const finalHelpers = { job: { id: "job-final", attempts: 3, max_attempts: 3 } } as Parameters<typeof task>[1];
    await expect(task({ heartbeatId, itemId: "unused" }, finalHelpers)).rejects.toThrow("model failed");

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(await getNotifications("agent_run_error")).toHaveLength(1);
    expect(await getNotifications("heartbeat_error")).toHaveLength(1);
  });

  it("through the fire task: a core.agentRun heartbeat failing on a non-final attempt notifies zero times", async () => {
    const { heartbeatId } = await createTestHeartbeat();
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async () => {
        throw new Error("model failed");
      }),
    );
    const task = createHeartbeatFireAgentTask(pool, registry);

    const nonFinalHelpers = { job: { id: "job-retry", attempts: 1, max_attempts: 3 } } as Parameters<typeof task>[1];
    await expect(task({ heartbeatId, itemId: "unused" }, nonFinalHelpers)).rejects.toThrow("model failed");

    const runs = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("error");
    expect(await getNotifications("agent_run_error")).toHaveLength(0);
    expect(await getNotifications("heartbeat_error")).toHaveLength(0);
  });

  async function createOccurrence(heartbeatId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
       VALUES ($1, now(), '{}', 'queued') RETURNING id`,
      [heartbeatId],
    );
    return rows[0]!.id;
  }

  it("selects the highest occurrence attempt and breaks ties by start time", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const occurrenceId = await createOccurrence(heartbeatId);
    expect(await getLatestRunOfOccurrence(pool, occurrenceId)).toBeNull();
    const first = await createAgentRun(pool, {
      triggeredBy: "heartbeat",
      task: "first",
      projectItemId,
      heartbeatId,
      heartbeatOccurrenceId: occurrenceId,
      attempt: 1,
    });
    const older = await createAgentRun(pool, {
      triggeredBy: "heartbeat",
      task: "older",
      projectItemId,
      heartbeatId,
      heartbeatOccurrenceId: occurrenceId,
      attempt: 2,
    });
    const newer = await createAgentRun(pool, {
      triggeredBy: "heartbeat",
      task: "newer",
      projectItemId,
      heartbeatId,
      heartbeatOccurrenceId: occurrenceId,
      attempt: 2,
    });
    // Set distinct timestamps explicitly to prove the tie-break without relying on clock timing.
    for (const [id, startedAt] of [
      [first.id, "2026-01-03T00:00:00Z"],
      [older.id, "2026-01-01T00:00:00Z"],
      [newer.id, "2026-01-02T00:00:00Z"],
    ] as const) {
      const result = await pool.query("UPDATE agent_runs SET started_at = $2::timestamptz WHERE id = $1", [
        id,
        startedAt,
      ]);
      expect(result.rowCount).toBe(1);
    }
    expect((await getLatestRunOfOccurrence(pool, occurrenceId))?.id).toBe(newer.id);
  });

  it("chains the attempts of one occurrence: fails twice, succeeds on the third", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const occurrenceId = await createOccurrence(heartbeatId);
    let calls = 0;
    const handler = coreAgentRunAction(pool, async () => {
      calls += 1;
      if (calls < 3) throw new Error("model failed");
    });
    for (const attempt of [1, 2]) {
      await expect(
        handler({}, { heartbeatId, projectItemId, occurrenceId, attempt, isFinalAttempt: false }),
      ).rejects.toThrow("model failed");
    }
    await handler({}, { heartbeatId, projectItemId, occurrenceId, attempt: 3, isFinalAttempt: true });

    const { rows } = await pool.query<{
      id: string;
      attempt: number;
      retry_of_run_id: string | null;
      heartbeat_occurrence_id: string;
      status: string;
    }>(
      "SELECT id, attempt, retry_of_run_id, heartbeat_occurrence_id, status FROM agent_runs WHERE heartbeat_id = $1 ORDER BY attempt",
      [heartbeatId],
    );
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.heartbeat_occurrence_id === occurrenceId)).toBe(true);
    expect(rows[0]!.retry_of_run_id).toBeNull();
    expect(rows[1]!.retry_of_run_id).toBe(rows[0]!.id);
    expect(rows[2]!.retry_of_run_id).toBe(rows[1]!.id);
    expect(rows.map((r) => r.status)).toEqual(["error", "error", "done"]);
    expect((await getLatestRunOfOccurrence(pool, occurrenceId))?.id).toBe(rows[2]!.id);
    expect(await getNotifications("agent_run_error")).toHaveLength(0);
  });

  it("chains three failed attempts and notifies only on the last run", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const occurrenceId = await createOccurrence(heartbeatId);
    const handler = coreAgentRunAction(pool, async () => {
      throw new Error("model failed");
    });
    for (const attempt of [1, 2, 3]) {
      await expect(
        handler({}, { heartbeatId, projectItemId, occurrenceId, attempt, isFinalAttempt: attempt === 3 }),
      ).rejects.toThrow("model failed");
    }
    const { rows } = await pool.query<{ id: string; attempt: number; retry_of_run_id: string | null }>(
      "SELECT id, attempt, retry_of_run_id FROM agent_runs WHERE heartbeat_id = $1 ORDER BY attempt",
      [heartbeatId],
    );
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(rows[2]!.retry_of_run_id).toBe(rows[1]!.id);
    const notifications = await getNotifications("agent_run_error");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.source_id).toBe(rows[2]!.id);
  });

  it("creates the run unchained when the previous attempt already has a successor", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const occurrenceId = await createOccurrence(heartbeatId);
    const handler = coreAgentRunAction(pool, async () => {
      throw new Error("model failed");
    });
    await expect(handler({}, { heartbeatId, projectItemId, occurrenceId, attempt: 1 })).rejects.toThrow();
    const { rows: first } = await pool.query<{ id: string }>("SELECT id FROM agent_runs WHERE heartbeat_id = $1", [
      heartbeatId,
    ]);
    // A foreign successor (not linked to the occurrence) already retried attempt 1.
    await pool.query(
      `INSERT INTO agent_runs (retry_of_run_id, attempt, triggered_by, unit, task, actor_user_id, heartbeat_id)
       SELECT id, 1, 'heartbeat', 'invocation', 'x', actor_user_id, heartbeat_id FROM agent_runs WHERE id = $1`,
      [first[0]!.id],
    );
    await expect(handler({}, { heartbeatId, projectItemId, occurrenceId, attempt: 2 })).rejects.toThrow();
    const { rows } = await pool.query<{ retry_of_run_id: string | null; heartbeat_occurrence_id: string | null }>(
      "SELECT retry_of_run_id, heartbeat_occurrence_id FROM agent_runs WHERE attempt = 2 AND heartbeat_occurrence_id IS NOT NULL",
    );
    expect(rows).toEqual([{ retry_of_run_id: null, heartbeat_occurrence_id: occurrenceId }]);
  });

  it("a run without an occurrence stays unlinked with attempt 1", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const handler = coreAgentRunAction(pool, async () => undefined);
    await handler({}, { heartbeatId, projectItemId });
    const [run] = await listAgentRunsByHeartbeat(pool, heartbeatId);
    expect(run).toMatchObject({ heartbeatOccurrenceId: null, attempt: 1, retryOfRunId: null });
  });
});
