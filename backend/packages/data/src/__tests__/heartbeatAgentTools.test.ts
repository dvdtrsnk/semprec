import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat, sweepDueHeartbeats } from "../scheduler/schedulerStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createHeartbeatHistoryTool,
  createHeartbeatListTool,
  createHeartbeatTriggerTool,
  HEARTBEAT_EVENT_TRIGGERED_ERROR,
  HEARTBEAT_HISTORY_DEFAULT_LIMIT,
  HEARTBEAT_HISTORY_MAX_LIMIT,
  type HeartbeatHistoryEntry,
  type HeartbeatListEntry,
} from "../scheduler/heartbeatAgentTools.js";

let pool: Pool;

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";

function parseResult<T>(outcome: { error: boolean; result: string }): T {
  expect(outcome.error).toBe(false);
  return JSON.parse(outcome.result) as T;
}

interface TriggerJobRow {
  key: string;
  payload: { heartbeatId: string; triggeredByRunId?: string };
}

async function pendingTriggerJobs(pool: Pool): Promise<TriggerJobRow[]> {
  const { rows } = await pool.query<TriggerJobRow>(
    `SELECT j.key, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'heartbeatFire'`,
  );
  return rows;
}

describe("heartbeat.list / heartbeat.history / heartbeat.trigger agent tools", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("heartbeat.list returns only the calling run's own project's heartbeats", async () => {
    const ownHeartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Process Inbox",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "core.agentRun",
      }),
    );
    await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_B,
        name: "Someone else's heartbeat",
        rule: { kind: "dailyTime", at: "10:00" },
        actionId: "core.agentRun",
      }),
    );
    const run = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "check heartbeats" });

    const heartbeatList = createHeartbeatListTool(pool);
    const outcome = await heartbeatList(run.id, {});
    const entries = parseResult<HeartbeatListEntry[]>(outcome);

    expect(entries).toEqual([
      {
        id: ownHeartbeat.id,
        name: "Process Inbox",
        rule: { kind: "dailyTime", at: "09:00" },
        enabled: true,
        lastFiredAt: null,
      },
    ]);
  });

  it("heartbeat.list fails without leaking data when the run has no project context", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "supervisor", task: "supervise" });

    const heartbeatList = createHeartbeatListTool(pool);
    const outcome = await heartbeatList(run.id, {});

    expect(outcome.error).toBe(true);
  });

  it("heartbeat.history returns bounded status/timestamps/result records for an owned heartbeat, most recent first", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Process Inbox",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "core.agentRun",
      }),
    );
    const olderRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      heartbeatId: heartbeat.id,
      triggeredBy: "heartbeat",
      task: "t1",
    });
    await pool.query(
      "UPDATE agent_runs SET status = 'done', result = 'ok-1', started_at = now() - interval '1 hour' WHERE id = $1",
      [olderRun.id],
    );
    const newerRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      heartbeatId: heartbeat.id,
      triggeredBy: "heartbeat",
      task: "t2",
    });
    await pool.query("UPDATE agent_runs SET status = 'error', result = 'boom' WHERE id = $1", [newerRun.id]);

    const callingRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      triggeredBy: "user",
      task: "check history",
    });
    const heartbeatHistory = createHeartbeatHistoryTool(pool);
    const outcome = await heartbeatHistory(callingRun.id, { heartbeatId: heartbeat.id });
    const entries = parseResult<HeartbeatHistoryEntry[]>(outcome);

    expect(entries.map((entry) => entry.id)).toEqual([newerRun.id, olderRun.id]);
    expect(entries[0]).toMatchObject({ status: "error", result: "boom" });
    expect(entries[1]).toMatchObject({ status: "done", result: "ok-1" });
  });

  it("event-started agent runs appear in history", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Inbox tick (create)",
        rule: { kind: "onItemEvent", databaseId: "33333333-3333-4333-8333-333333333333", event: "create" },
        actionId: "semprec.tick",
      }),
    );
    const eventRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      heartbeatId: heartbeat.id,
      triggeredBy: "heartbeat",
      task: "process item",
    });

    const callingRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      triggeredBy: "user",
      task: "check history",
    });
    const heartbeatHistory = createHeartbeatHistoryTool(pool);
    const outcome = await heartbeatHistory(callingRun.id, { heartbeatId: heartbeat.id });
    const entries = parseResult<HeartbeatHistoryEntry[]>(outcome);

    expect(entries.map((entry) => entry.id)).toEqual([eventRun.id]);
  });

  it("a deterministic action's heartbeat has no history rows to report", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Manifest drift check",
        rule: { kind: "dailyTime", at: "03:00" },
        actionId: "core.driftCheck",
      }),
    );
    const callingRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      triggeredBy: "user",
      task: "check history",
    });

    const heartbeatHistory = createHeartbeatHistoryTool(pool);
    const outcome = await heartbeatHistory(callingRun.id, { heartbeatId: heartbeat.id });

    expect(parseResult<HeartbeatHistoryEntry[]>(outcome)).toEqual([]);
  });

  it("treats an unknown heartbeatId and one belonging to another project identically", async () => {
    const otherProjectHeartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_B,
        name: "Not yours",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "core.agentRun",
      }),
    );
    const callingRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      triggeredBy: "user",
      task: "check history",
    });
    const heartbeatHistory = createHeartbeatHistoryTool(pool);

    const unknownHeartbeatId = "44444444-4444-4444-8444-444444444444";
    const unknownOutcome = await heartbeatHistory(callingRun.id, { heartbeatId: unknownHeartbeatId });
    const crossProjectOutcome = await heartbeatHistory(callingRun.id, { heartbeatId: otherProjectHeartbeat.id });

    expect(unknownOutcome.error).toBe(true);
    expect(crossProjectOutcome.error).toBe(true);
    expect(crossProjectOutcome.result).toBe(
      unknownOutcome.result.replace(unknownHeartbeatId, otherProjectHeartbeat.id),
    );
  });

  it("applies the default limit and rejects a limit past the bounded maximum", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Process Inbox",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "core.agentRun",
      }),
    );
    for (let i = 0; i < HEARTBEAT_HISTORY_DEFAULT_LIMIT + 5; i++) {
      await createAgentRun(pool, {
        projectItemId: PROJECT_A,
        heartbeatId: heartbeat.id,
        triggeredBy: "heartbeat",
        task: `t${i}`,
      });
    }
    const callingRun = await createAgentRun(pool, {
      projectItemId: PROJECT_A,
      triggeredBy: "user",
      task: "check history",
    });
    const heartbeatHistory = createHeartbeatHistoryTool(pool);

    const defaulted = await heartbeatHistory(callingRun.id, { heartbeatId: heartbeat.id });
    expect(parseResult<HeartbeatHistoryEntry[]>(defaulted)).toHaveLength(HEARTBEAT_HISTORY_DEFAULT_LIMIT);

    const overMax = await heartbeatHistory(callingRun.id, {
      heartbeatId: heartbeat.id,
      limit: HEARTBEAT_HISTORY_MAX_LIMIT + 1,
    });
    expect(overMax.error).toBe(true);
  });

  it("enqueues a manually-attributed fire job under a dedup key distinct from the scheduler's own", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Process Inbox",
        rule: { kind: "interval", minutes: 5 },
        actionId: "core.agentRun",
      }),
    );
    const callingRun = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "trigger" });

    const heartbeatTrigger = createHeartbeatTriggerTool(pool);
    const outcome = await heartbeatTrigger(callingRun.id, { heartbeatId: heartbeat.id });

    expect(outcome.error).toBe(false);
    const jobs = await pendingTriggerJobs(pool);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe(`heartbeat-fire:manual:${heartbeat.id}`);
    expect(jobs[0].key).not.toBe(`heartbeat-fire:${heartbeat.id}`);
    expect(jobs[0].payload).toEqual({ heartbeatId: heartbeat.id, triggeredByRunId: callingRun.id });
  });

  it("collapses repeated pending manual triggers onto a single job", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Process Inbox",
        rule: { kind: "interval", minutes: 5 },
        actionId: "core.agentRun",
      }),
    );
    const firstRun = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "trigger 1" });
    const secondRun = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "trigger 2" });

    const heartbeatTrigger = createHeartbeatTriggerTool(pool);
    await heartbeatTrigger(firstRun.id, { heartbeatId: heartbeat.id });
    await heartbeatTrigger(secondRun.id, { heartbeatId: heartbeat.id });

    const jobs = await pendingTriggerJobs(pool);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.triggeredByRunId).toBe(secondRun.id);
  });

  it("does not collapse a pending manual trigger with a pending scheduled fire, or vice versa", async () => {
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "Process Inbox",
        rule: { kind: "interval", minutes: 5 },
        actionId: "core.agentRun",
      }),
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      heartbeat.id,
    ]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));
    const { rows: occurrenceRows } = await pool.query<{ id: string }>(
      "SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1",
      [heartbeat.id],
    );
    expect(occurrenceRows).toHaveLength(1);
    const occurrenceId = occurrenceRows[0].id;

    const callingRun = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "trigger" });
    const heartbeatTrigger = createHeartbeatTriggerTool(pool);
    await heartbeatTrigger(callingRun.id, { heartbeatId: heartbeat.id });

    const jobs = await pendingTriggerJobs(pool);
    expect(jobs.map((j) => j.key).sort()).toEqual(
      [`heartbeat-fire:${heartbeat.id}:${occurrenceId}`, `heartbeat-fire:manual:${heartbeat.id}`].sort(),
    );
  });

  it("returns the canonical 409 for an onItemEvent heartbeat and enqueues nothing", async () => {
    const chokePoint = createChokePoint(pool);
    const db = await chokePoint.createDatabase({ name: "Watched" });
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_A,
        name: "On create",
        rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
        actionId: "core.agentRun",
      }),
    );
    const callingRun = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "trigger" });

    const heartbeatTrigger = createHeartbeatTriggerTool(pool);
    const outcome = await heartbeatTrigger(callingRun.id, { heartbeatId: heartbeat.id });

    expect(outcome).toEqual({ error: true, result: HEARTBEAT_EVENT_TRIGGERED_ERROR });
    expect(await pendingTriggerJobs(pool)).toHaveLength(0);
  });

  it("treats an unknown heartbeatId and one belonging to another project identically, without enqueueing", async () => {
    const otherProjectHeartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: PROJECT_B,
        name: "Not yours",
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: "core.agentRun",
      }),
    );
    const callingRun = await createAgentRun(pool, { projectItemId: PROJECT_A, triggeredBy: "user", task: "trigger" });
    const heartbeatTrigger = createHeartbeatTriggerTool(pool);

    const unknownHeartbeatId = "44444444-4444-4444-8444-444444444444";
    const unknownOutcome = await heartbeatTrigger(callingRun.id, { heartbeatId: unknownHeartbeatId });
    const crossProjectOutcome = await heartbeatTrigger(callingRun.id, { heartbeatId: otherProjectHeartbeat.id });

    expect(unknownOutcome.error).toBe(true);
    expect(crossProjectOutcome.error).toBe(true);
    expect(crossProjectOutcome.result).toBe(
      unknownOutcome.result.replace(unknownHeartbeatId, otherProjectHeartbeat.id),
    );
    expect(await pendingTriggerJobs(pool)).toHaveLength(0);
  });
});
