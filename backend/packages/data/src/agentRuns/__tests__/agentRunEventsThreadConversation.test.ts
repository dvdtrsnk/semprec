import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createAgentRun, finishAgentRun } from "../agentRunsStore.js";
import { insertAgentRunEvent, listSessionAgentRunEventsFromLastCompaction } from "../agentRunEventsStore.js";
import { handleAgentRunEventsRetentionTask } from "../agentRunEventsRetention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let pool: Pool;

async function insertThread(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
  return rows[0]!.id;
}

async function backdate(runId: string): Promise<void> {
  await pool.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [
    runId,
    new Date(Date.now() - 40 * DAY_MS),
  ]);
}

async function remainingEventIds(runId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id",
    [runId],
  );
  return rows.map((r) => r.id);
}

async function threadSession(threadId: string, parentRunId?: string) {
  return createAgentRun(pool, {
    threadId,
    triggeredBy: parentRunId ? "supervisor" : "user",
    unit: "session",
    task: "chat",
    ...(parentRunId ? { parentRunId } : {}),
  });
}

describe("thread conversation key (issue #1560)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await createTenantZeroUser(pool);
  });

  it("selects only the main conversation of the given thread, never another thread or a delegated session", async () => {
    const threadA = await insertThread();
    const threadB = await insertThread();
    const runA = await threadSession(threadA);
    const runB = await threadSession(threadB);
    const delegated = await threadSession(threadA, runA.id);
    const a1 = await insertAgentRunEvent(pool, runA.id, "message", { kind: "message" });
    await insertAgentRunEvent(pool, runB.id, "message", { kind: "message" });
    await insertAgentRunEvent(pool, delegated.id, "message", { kind: "message" });

    const events = await listSessionAgentRunEventsFromLastCompaction(pool, {
      threadId: threadA,
      triggeredBy: "user",
      parentRunId: null,
    });
    expect(events.map((e) => e.id)).toEqual([a1.id]);
  });

  it("does not let a checkpoint in thread A hide thread B or a delegated session", async () => {
    const threadA = await insertThread();
    const threadB = await insertThread();
    const runA = await threadSession(threadA);
    const runB = await threadSession(threadB);
    const projectItemId = randomUUID();
    const delegated = await createAgentRun(pool, {
      projectItemId,
      parentRunId: runA.id,
      triggeredBy: "supervisor",
      unit: "session",
      task: "chat",
    });
    const b1 = await insertAgentRunEvent(pool, runB.id, "message", { kind: "message" });
    const d1 = await insertAgentRunEvent(pool, delegated.id, "message", { kind: "message" });
    const checkpoint = await insertAgentRunEvent(pool, runA.id, "compaction", { kind: "compaction" });

    const forB = await listSessionAgentRunEventsFromLastCompaction(pool, {
      threadId: threadB,
      triggeredBy: "user",
      parentRunId: null,
    });
    expect(forB.map((e) => e.id)).toEqual([b1.id]);
    const forDelegated = await listSessionAgentRunEventsFromLastCompaction(pool, {
      projectItemId,
      triggeredBy: "supervisor",
      parentRunId: runA.id,
    });
    expect(forDelegated.map((e) => e.id)).toEqual([d1.id]);
    const forA = await listSessionAgentRunEventsFromLastCompaction(pool, {
      threadId: threadA,
      triggeredBy: "user",
      parentRunId: null,
    });
    expect(forA.map((e) => e.id)).toEqual([checkpoint.id]);
    expect(d1.id).not.toBe(checkpoint.id);
  });

  it("keeps the project-item form for non-thread sessions and excludes thread runs of the same project item", async () => {
    const projectItemId = randomUUID();
    const threadId = await insertThread();
    const plain = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
    const threadRun = await createAgentRun(pool, {
      projectItemId,
      threadId,
      triggeredBy: "user",
      unit: "session",
      task: "chat",
    });
    const plainEvent = await insertAgentRunEvent(pool, plain.id, "message", { kind: "message" });
    await insertAgentRunEvent(pool, threadRun.id, "compaction", { kind: "compaction" });

    const events = await listSessionAgentRunEventsFromLastCompaction(pool, {
      projectItemId,
      triggeredBy: "user",
      parentRunId: null,
    });
    expect(events.map((e) => e.id)).toEqual([plainEvent.id]);
  });

  describe("retention", () => {
    it("deletes old pre-checkpoint events of a thread, keeps its checkpoint and tail, and spares other threads and delegated sessions", async () => {
      const threadA = await insertThread();
      const threadB = await insertThread();
      const runA = await threadSession(threadA);
      const oldA = await insertAgentRunEvent(pool, runA.id, "message", { kind: "message" });
      const runB = await threadSession(threadB);
      const b1 = await insertAgentRunEvent(pool, runB.id, "message", { kind: "message" });
      await finishAgentRun(pool, runB.id, "done", null);

      const delegated = await threadSession(threadA, runA.id);
      const d1 = await insertAgentRunEvent(pool, delegated.id, "message", { kind: "message" });
      await finishAgentRun(pool, delegated.id, "done", null);

      const checkpointA = await insertAgentRunEvent(pool, runA.id, "compaction", { kind: "compaction" });
      const tailA = await insertAgentRunEvent(pool, runA.id, "message", { kind: "message" });
      await finishAgentRun(pool, runA.id, "done", null);

      for (const id of [runA.id, runB.id, delegated.id]) await backdate(id);

      const result = await handleAgentRunEventsRetentionTask(pool);
      expect(result.deleted).toBe(1);
      expect(await remainingEventIds(runA.id)).toEqual([checkpointA.id, tailA.id]);
      expect(await remainingEventIds(runA.id)).not.toContain(oldA.id);
      expect(await remainingEventIds(runB.id)).toEqual([b1.id]);
      expect(await remainingEventIds(delegated.id)).toEqual([d1.id]);
    });

    it("deletes nothing for a thread without a checkpoint", async () => {
      const threadId = await insertThread();
      const run = await threadSession(threadId);
      const e1 = await insertAgentRunEvent(pool, run.id, "message", { kind: "message" });
      await finishAgentRun(pool, run.id, "done", null);
      await backdate(run.id);

      expect((await handleAgentRunEventsRetentionTask(pool)).deleted).toBe(0);
      expect(await remainingEventIds(run.id)).toEqual([e1.id]);
    });

    it("keeps grouping non-thread sessions by project item and not by a thread run of the same item", async () => {
      const projectItemId = randomUUID();
      const threadId = await insertThread();
      const plain = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
      const plainOld = await insertAgentRunEvent(pool, plain.id, "message", { kind: "message" });
      await finishAgentRun(pool, plain.id, "done", null);
      const threadRun = await createAgentRun(pool, {
        projectItemId,
        threadId,
        triggeredBy: "user",
        unit: "session",
        task: "chat",
      });
      await insertAgentRunEvent(pool, threadRun.id, "compaction", { kind: "compaction" });
      await finishAgentRun(pool, threadRun.id, "done", null);
      await backdate(plain.id);
      await backdate(threadRun.id);

      // Only the thread run has a checkpoint; the plain session of the same item has none.
      expect((await handleAgentRunEventsRetentionTask(pool)).deleted).toBe(0);
      expect(await remainingEventIds(plain.id)).toEqual([plainOld.id]);

      // A checkpoint in the plain session now deletes its own earlier events only.
      const plain2 = await createAgentRun(pool, { projectItemId, triggeredBy: "user", unit: "session", task: "chat" });
      await insertAgentRunEvent(pool, plain2.id, "compaction", { kind: "compaction" });
      await finishAgentRun(pool, plain2.id, "done", null);
      await backdate(plain2.id);
      expect((await handleAgentRunEventsRetentionTask(pool)).deleted).toBe(1);
      expect(await remainingEventIds(threadRun.id)).toHaveLength(1);
    });
  });
});
