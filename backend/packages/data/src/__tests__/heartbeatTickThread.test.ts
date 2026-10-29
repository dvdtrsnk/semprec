import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, getTenantZeroId, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createAgentRun, getAgentRun } from "../agentRuns/agentRunsStore.js";
import { finishTickRunWithMessage, getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { setSempThreadInvalidationHook } from "../realtimeHook.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";

let pool: Pool;

async function projectItemId(): Promise<string> {
  const { rows } = await pool.query("SELECT id FROM databases WHERE owner_module_id = 'projects'");
  const { rows: items } = await pool.query("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [rows[0].id]);
  return items[0].id;
}

async function makeHeartbeat(actionId: string): Promise<{ id: string; projectItemId: string }> {
  const itemId = await projectItemId();
  const heartbeat = await withTransaction(pool, (client) =>
    createHeartbeat(client, {
      projectItemId: itemId,
      name: `hb ${actionId}`,
      rule: { kind: "interval", minutes: 5 },
      actionId,
      actionConfig: { task: "do it" },
    }),
  );
  return { id: heartbeat.id, projectItemId: itemId };
}

async function messages(threadId: string) {
  const { rows } = await pool.query(
    `SELECT role, text, status, agent_run_id, event_from_id, event_to_id FROM semp_messages
     WHERE thread_id = $1 ORDER BY created_at, id`,
    [threadId],
  );
  return rows;
}

describe("heartbeat runs in their tick thread", () => {
  const invalidations: string[] = [];

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    await createUser(pool, {
      email: "owner@example.test",
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    invalidations.length = 0;
    setSempThreadInvalidationHook((event) => invalidations.push(event.threadId));
  });

  afterAll(async () => {
    setSempThreadInvalidationHook(() => {});
    await pool?.end();
  });

  it("three runs of one heartbeat produce three messages in one thread and publish start and end", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    const action = coreAgentRunAction(pool, async ({ task }) => ({ result: `handled: ${task}` }));
    for (let i = 0; i < 3; i += 1) {
      await inTenantZero(() => action({ task: "do it" }, { heartbeatId: hb.id, projectItemId: hb.projectItemId }));
    }

    const { rows: threads } = await pool.query("SELECT id FROM semp_threads WHERE heartbeat_id = $1", [hb.id]);
    expect(threads).toHaveLength(1);
    const msgs = await messages(threads[0].id);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((m) => m.role === "assistant" && m.status === "done" && m.text === "handled: do it")).toBe(true);
    const { rows: runs } = await pool.query("SELECT thread_id, status FROM agent_runs WHERE heartbeat_id = $1", [
      hb.id,
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.thread_id === threads[0].id && r.status === "done")).toBe(true);
    // one at start and one at end of each run
    expect(invalidations).toHaveLength(6);
    expect(new Set(invalidations)).toEqual(new Set([threads[0].id]));
  });

  it("a heartbeat whose action is not core.agentRun creates no thread", async () => {
    const hb = await makeHeartbeat("noop");
    const { rows } = await pool.query("SELECT id FROM semp_threads WHERE heartbeat_id = $1", [hb.id]);
    expect(rows).toHaveLength(0);
    const { rows: all } = await pool.query("SELECT id FROM semp_threads");
    expect(all).toHaveLength(0);
  });

  it("an occurrence whose last attempt fails writes exactly one error message", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    const action = coreAgentRunAction(pool, async () => {
      throw new Error("model exploded");
    });
    for (const isFinalAttempt of [false, false, true]) {
      await expect(
        inTenantZero(() =>
          action({ task: "do it" }, { heartbeatId: hb.id, projectItemId: hb.projectItemId, isFinalAttempt }),
        ),
      ).rejects.toThrow("model exploded");
    }

    const { rows: threads } = await pool.query("SELECT id FROM semp_threads WHERE heartbeat_id = $1", [hb.id]);
    const msgs = await messages(threads[0].id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", status: "error", text: null });
    const { rows: runs } = await pool.query("SELECT status FROM agent_runs WHERE heartbeat_id = $1", [hb.id]);
    expect(runs.map((r) => r.status)).toEqual(["error", "error", "error"]);
  });

  it("failing the message insert leaves the run unfinished", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    const thread = await inTenantZero(() => withTransaction(pool, (client) => getOrCreateTickThread(client, hb.id)));
    const run = await createAgentRun(pool, {
      projectItemId: hb.projectItemId,
      heartbeatId: hb.id,
      threadId: thread.id,
      triggeredBy: "heartbeat",
      task: "do it",
    });
    const publish = vi.fn();
    setSempThreadInvalidationHook(publish);

    await expect(
      inTenantZero(() =>
        withTransaction(pool, (client) =>
          finishTickRunWithMessage(client, {
            // a thread that does not exist: the message insert violates its foreign key
            thread: { id: "00000000-0000-4000-8000-000000000000", tenantId: thread.tenantId },
            agentRunId: run.id,
            outcome: { status: "done", result: "x" },
          }),
        ),
      ),
    ).rejects.toThrow();

    const after = await getAgentRun(pool, run.id);
    expect(after!.status).toBe("running");
    expect(after!.finishedAt).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
});
