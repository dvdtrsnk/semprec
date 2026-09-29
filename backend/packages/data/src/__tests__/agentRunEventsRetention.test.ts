import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import {
  AGENT_RUN_EVENTS_RETENTION_DAYS,
  handleAgentRunEventsRetentionTask,
} from "../agentRuns/agentRunEventsRetention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

/** All ids of `agent_run_events` rows currently belonging to `agentRunId`, in id order. */
async function eventIdsFor(agentRunId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id ASC`,
    [agentRunId],
  );
  return rows.map((r) => r.id);
}

/** Backdates every existing `agent_run_events` row for `agentRunId` to `at`. */
async function backdateEvents(agentRunId: string, at: Date): Promise<void> {
  await pool.query(`UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1`, [agentRunId, at]);
}

/** Wraps a pool so `connectCalls()` reports how many times `.connect()` was invoked on it. */
function withConnectCounter(target: Pool): { pool: Pool; connectCalls: () => number } {
  let calls = 0;
  const boundConnect = target.connect.bind(target);
  const wrapped = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "connect") {
        return (...args: unknown[]) => {
          calls++;
          return (boundConnect as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { pool: wrapped, connectCalls: () => calls };
}

describe("handleAgentRunEventsRetentionTask", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("deletes pre-checkpoint rows of finished runs older than the retention window, keeping the checkpoint and everything after it", async () => {
    const projectItemId = randomUUID();
    const old = new Date(Date.now() - 40 * DAY_MS);

    const run1 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    await insertAgentRunEvent(pool, run1.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run1.id, "message", { kind: "message" });
    await insertAgentRunEvent(pool, run1.id, "turn_end", { kind: "turn_end" });
    await finishAgentRun(pool, run1.id, "done", null);

    const run2 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    await insertAgentRunEvent(pool, run2.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run2.id, "message", { kind: "message" });
    const compactionEvent = await insertAgentRunEvent(pool, run2.id, "compaction", { kind: "compaction" });
    const run2PostCheckpointMessage = await insertAgentRunEvent(pool, run2.id, "message", { kind: "message" });
    const run2LastEvent = await insertAgentRunEvent(pool, run2.id, "turn_end", { kind: "turn_end" });
    await finishAgentRun(pool, run2.id, "done", null);

    const run3 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    const run3FirstEvent = await insertAgentRunEvent(pool, run3.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run3.id, "message", { kind: "message" });
    const run3LastEvent = await insertAgentRunEvent(pool, run3.id, "turn_end", { kind: "turn_end" });

    await backdateEvents(run1.id, old);
    await backdateEvents(run2.id, old);
    // run3 stays at its natural (recent) `at`.

    const result = await handleAgentRunEventsRetentionTask(pool);

    expect(result.deleted).toBe(5);
    expect(await eventIdsFor(run1.id)).toEqual([]);
    expect(await eventIdsFor(run2.id)).toEqual([compactionEvent.id, run2PostCheckpointMessage.id, run2LastEvent.id]);
    // run3's rows are untouched: all three remain.
    const run3Ids = await eventIdsFor(run3.id);
    expect(run3Ids).toHaveLength(3);
    expect(run3Ids[0]).toBe(run3FirstEvent.id);
    expect(run3Ids[2]).toBe(run3LastEvent.id);
  });

  it("leaves every event of a conversation that never compacted untouched, however old", async () => {
    const projectItemId = randomUUID();
    const old = new Date(Date.now() - 40 * DAY_MS);

    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    await insertAgentRunEvent(pool, run.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run.id, "message", { kind: "message" });
    await insertAgentRunEvent(pool, run.id, "turn_end", { kind: "turn_end" });
    await finishAgentRun(pool, run.id, "done", null);
    await backdateEvents(run.id, old);

    const result = await handleAgentRunEventsRetentionTask(pool);

    expect(result.deleted).toBe(0);
    expect(await eventIdsFor(run.id)).toHaveLength(3);
  });

  it("keeps a still-running run's pre-checkpoint rows regardless of age, while deleting an older finished run's rows", async () => {
    const projectItemId = randomUUID();
    const old = new Date(Date.now() - 40 * DAY_MS);

    const run0 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    await insertAgentRunEvent(pool, run0.id, "turn_start", { kind: "turn_start" });
    await insertAgentRunEvent(pool, run0.id, "turn_end", { kind: "turn_end" });
    await finishAgentRun(pool, run0.id, "done", null);
    await backdateEvents(run0.id, old);

    // The compaction lands on the still-running run itself: reconstruction inserts it directly
    // into the active session run when a dormant conversation wakes and gets compacted.
    const run1 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    const run1PreCheckpoint = await insertAgentRunEvent(pool, run1.id, "turn_start", { kind: "turn_start" });
    const compactionEvent = await insertAgentRunEvent(pool, run1.id, "compaction", { kind: "compaction" });
    await backdateEvents(run1.id, old);
    // run1 stays 'running'.

    const result = await handleAgentRunEventsRetentionTask(pool);

    expect(result.deleted).toBe(2);
    expect(await eventIdsFor(run0.id)).toEqual([]);
    expect(await eventIdsFor(run1.id)).toEqual([run1PreCheckpoint.id, compactionEvent.id]);
  });

  it("keeps pre-checkpoint rows younger than the retention window", async () => {
    const projectItemId = randomUUID();
    const recentButPreCheckpoint = new Date(Date.now() - (AGENT_RUN_EVENTS_RETENTION_DAYS - 1) * DAY_MS);

    const run1 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    const run1Event = await insertAgentRunEvent(pool, run1.id, "turn_start", { kind: "turn_start" });
    await finishAgentRun(pool, run1.id, "done", null);
    await backdateEvents(run1.id, recentButPreCheckpoint);

    const run2 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    await insertAgentRunEvent(pool, run2.id, "compaction", { kind: "compaction" });
    await finishAgentRun(pool, run2.id, "done", null);

    const result = await handleAgentRunEventsRetentionTask(pool);

    expect(result.deleted).toBe(0);
    expect(await eventIdsFor(run1.id)).toEqual([run1Event.id]);
  });

  it("deletes in batches of at most 1000 rows per transaction", async () => {
    const projectItemId = randomUUID();
    const old = new Date(Date.now() - 40 * DAY_MS);
    const DELETABLE_ROW_COUNT = 2500;

    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    await pool.query(
      `INSERT INTO agent_run_events (agent_run_id, kind, payload, at)
       SELECT $1::uuid, 'message', '{}'::jsonb, $2::timestamptz
       FROM generate_series(1, $3)`,
      [run.id, old, DELETABLE_ROW_COUNT],
    );
    const compactionEvent = await insertAgentRunEvent(pool, run.id, "compaction", { kind: "compaction" });
    await finishAgentRun(pool, run.id, "done", null);

    const { pool: countedPool, connectCalls } = withConnectCounter(pool);
    const result = await handleAgentRunEventsRetentionTask(countedPool);

    expect(result.deleted).toBe(DELETABLE_ROW_COUNT);
    // pg-pool's own `pool.query()` connects internally, so the count is the conversation-listing
    // query's one connection plus one per delete batch: 2500 rows in batches of 1000 is 3 batches.
    expect(connectCalls()).toBe(4);
    expect(await eventIdsFor(run.id)).toEqual([compactionEvent.id]);
  });
});
