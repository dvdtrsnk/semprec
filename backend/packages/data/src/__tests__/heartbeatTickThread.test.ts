import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getTestPool, getTenantZeroId, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat, sweepDueHeartbeats } from "../scheduler/schedulerStore.js";
import { createActionRegistry, CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction } from "../scheduler/actions.js";
import { createHeartbeatFireAgentTask, createHeartbeatFireCoreTask } from "../scheduler/sweep.js";
import { createAgentRun, getAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAndNotifyAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { createPendingApprovalRequest } from "../mcp/approvalRequestsStore.js";
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
    const registry = createActionRegistry();
    const handler = vi.fn(async () => {});
    registry.set("noop", handler);
    const task = createHeartbeatFireCoreTask(pool, registry);
    // Synthetic Graphile helpers provide the attempt metadata read by the fire task.
    const helpers = { job: { id: "batch16-noop", attempts: 1, max_attempts: 1 } } as Parameters<typeof task>[1];
    await inTenantZero(async () => {
      await task({ heartbeatId: hb.id, itemId: hb.projectItemId }, helpers);
    });
    expect(handler).toHaveBeenCalledOnce();
    const { rows } = await pool.query("SELECT id FROM semp_threads WHERE heartbeat_id = $1", [hb.id]);
    expect(rows).toHaveLength(0);
    const { rows: all } = await pool.query("SELECT id FROM semp_threads");
    expect(all).toHaveLength(0);
  });

  it("stores the first and last event ids with the successful run's assistant message", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    const eventIds: string[] = [];
    const action = coreAgentRunAction(pool, async ({ agentRunId }) => {
      await withTransaction(pool, async (client) => {
        eventIds.push((await insertAndNotifyAgentRunEvent(client, agentRunId, "turn_start", {})).id);
        eventIds.push((await insertAndNotifyAgentRunEvent(client, agentRunId, "message", { text: "done" })).id);
      });
      return { result: "done" };
    });
    await inTenantZero(() => action({ task: "do it" }, { heartbeatId: hb.id, projectItemId: hb.projectItemId }));
    const result = await pool.query<{
      event_from_id: string | null;
      event_to_id: string | null;
      agent_run_id: string | null;
    }>("SELECT event_from_id, event_to_id, agent_run_id FROM semp_messages");
    const runs = await pool.query<{ id: string }>("SELECT id FROM agent_runs WHERE heartbeat_id = $1", [hb.id]);
    expect(eventIds).toHaveLength(2);
    expect(result.rows).toEqual([
      { event_from_id: eventIds[0], event_to_id: eventIds[1], agent_run_id: runs.rows[0]?.id },
    ]);
  });

  it("finishes the run and writes its message when the agent created a pending approval", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    const action = coreAgentRunAction(pool, async ({ agentRunId }) => {
      await withTransaction(pool, (client) =>
        createPendingApprovalRequest(client, {
          agentRunId,
          toolName: "send_email",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        }),
      );
      return { result: "approval requested" };
    });
    await inTenantZero(() => action({ task: "do it" }, { heartbeatId: hb.id, projectItemId: hb.projectItemId }));
    const result = await pool.query<{
      run_status: string;
      message_status: string;
      text: string;
      approval_status: string;
    }>(
      `SELECT r.status AS run_status, m.status AS message_status, m.text, a.status AS approval_status
       FROM agent_runs r JOIN semp_messages m ON m.agent_run_id = r.id
       JOIN approval_requests a ON a.agent_run_id = r.id WHERE r.heartbeat_id = $1`,
      [hb.id],
    );
    expect(result.rows).toEqual([
      { run_status: "done", message_status: "done", text: "approval requested", approval_status: "pending" },
    ]);
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
    expect(invalidations).toHaveLength(6);
    expect(new Set(invalidations)).toEqual(new Set([threads[0].id]));
  });

  it("routes retries of one scheduled occurrence through the agent fire task and writes only the final error message", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    // A due time cannot be set through the heartbeat creation API.
    await withTransaction(pool, (client) =>
      client.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [hb.id]),
    );
    const sweep = await inTenantZero(() => withTransaction(pool, (client) => sweepDueHeartbeats(client)));
    expect(sweep.fired).toHaveLength(1);
    const occurrence = await pool.query<{ id: string }>(
      "SELECT id FROM heartbeat_occurrences WHERE heartbeat_id = $1",
      [hb.id],
    );
    const occurrenceId = occurrence.rows[0]?.id;
    if (!occurrenceId) throw new Error("Missing scheduled occurrence");
    const registry = createActionRegistry();
    registry.set(
      CORE_AGENT_RUN_ACTION_ID,
      coreAgentRunAction(pool, async () => {
        throw new Error("agent failure");
      }),
    );
    const task = createHeartbeatFireAgentTask(pool, registry);
    for (const attempt of [1, 2, 3]) {
      // Synthetic Graphile helpers carry the actual attempt metadata consumed by this task.
      const helpers = { job: { id: "batch16", attempts: attempt, max_attempts: 3 } } as Parameters<typeof task>[1];
      await expect(
        inTenantZero(async () => {
          await task({ heartbeatId: hb.id, occurrenceId, generation: 1 }, helpers);
        }),
      ).rejects.toThrow("agent failure");
      const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages");
      expect(rows[0]?.count).toBe(attempt === 3 ? 1 : 0);
    }
    const runs = await pool.query<{ heartbeat_occurrence_id: string; attempt: number; status: string }>(
      "SELECT heartbeat_occurrence_id, attempt, status FROM agent_runs WHERE heartbeat_id = $1 ORDER BY attempt",
      [hb.id],
    );
    expect(runs.rows).toEqual(
      [1, 2, 3].map((attempt) => ({ heartbeat_occurrence_id: occurrenceId, attempt, status: "error" })),
    );
    expect(invalidations).toHaveLength(6);
    const { rows: message } = await pool.query<{ status: string; role: string }>(
      "SELECT status, role FROM semp_messages",
    );
    expect(message).toEqual([{ status: "error", role: "assistant" }]);
  });

  it("leaves the run unfinished when the actual action cannot insert its success message", async () => {
    const hb = await makeHeartbeat(CORE_AGENT_RUN_ACTION_ID);
    const action = coreAgentRunAction(pool, async () => ({ result: "done" }));
    // Inject a database failure at the message insertion boundary reached by the action.
    await withTransaction(pool, async (client) => {
      await client.query(
        "CREATE FUNCTION batch16_reject_tick_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected message failure'; END $$",
      );
      await client.query(
        "CREATE TRIGGER batch16_reject_tick_message BEFORE INSERT ON semp_messages FOR EACH ROW EXECUTE FUNCTION batch16_reject_tick_message()",
      );
    });
    let failure: { error: unknown } | undefined;
    try {
      await expect(
        inTenantZero(() => action({ task: "do it" }, { heartbeatId: hb.id, projectItemId: hb.projectItemId })),
      ).rejects.toThrow("injected message failure");
      const { rows } = await pool.query<{ status: string; finished_at: Date | null }>(
        "SELECT status, finished_at FROM agent_runs WHERE heartbeat_id = $1",
        [hb.id],
      );
      expect(rows).toEqual([{ status: "running", finished_at: null }]);
      const { rows: count } = await pool.query<{ count: string }>("SELECT count(*) FROM semp_messages");
      expect(count[0]?.count).toBe("0");
      expect(invalidations).toHaveLength(1);
    } catch (error) {
      failure = { error };
    }
    try {
      await withTransaction(pool, async (client) => {
        await client.query("DROP TRIGGER batch16_reject_tick_message ON semp_messages");
        await client.query("DROP FUNCTION batch16_reject_tick_message()");
      });
    } catch (error) {
      if (failure) throw new AggregateError([failure.error, error], "Test and cleanup failed", { cause: error });
      throw error;
    }
    if (failure) throw failure.error;
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
