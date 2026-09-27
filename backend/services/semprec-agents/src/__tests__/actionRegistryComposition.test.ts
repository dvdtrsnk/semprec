import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { CORE_AGENT_RUN_ACTION_ID, createAgentRun, createUser, seedSystem } from "@semprec/data";
import { ModuleRegistry } from "@semprec/module-registry";
import { createAgentsActionRegistry, unwiredRunAgent } from "../actionRegistryComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

let pool: Pool;
let runtime: AgentsQueueRuntime | undefined;

describe("createAgentsActionRegistry (issue #641)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("registers exactly core.agentRun", () => {
    const registry = createAgentsActionRegistry(pool, unwiredRunAgent);

    expect([...registry.keys()]).toEqual([CORE_AGENT_RUN_ACTION_ID]);
  });

  it("closes a fired core.agentRun heartbeat's run as error naming the unwired runtime", async () => {
    await seedSystem(pool);
    await createUser(pool, { email: "owner@example.com", passwordHash: "unused" });
    const { rows: heartbeats } = await pool.query<{ id: string; project_item_id: string }>(
      `SELECT id, project_item_id FROM project_heartbeats WHERE action_id = $1`,
      [CORE_AGENT_RUN_ACTION_ID],
    );
    expect(heartbeats).toHaveLength(1);
    const heartbeat = heartbeats[0]!;
    // A manual (`triggeredByRunId`) fire skips the seeded rule's item-relation filter, which only
    // applies to an item-triggered fire.
    const parentRun = await createAgentRun(pool, {
      projectItemId: heartbeat.project_item_id,
      triggeredBy: "user",
      task: "trigger the newEmail heartbeat",
    });

    runtime = await createAgentsQueueRuntime(pool, new ModuleRegistry(() => new Set()));
    await enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
      heartbeatId: heartbeat.id,
      triggeredByRunId: parentRun.id,
    });

    // The run is closed before the handler rethrows, so a recorded `last_error` on the job means
    // both the run and this attempt are settled.
    const jobLastError = async (): Promise<string | null> => {
      const { rows } = await pool.query<{ last_error: string | null }>(
        `SELECT jobs.last_error FROM graphile_worker._private_jobs jobs
         JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
         WHERE tasks.identifier = $1`,
        [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT],
      );
      return rows[0]?.last_error ?? null;
    };
    await waitFor(async () => (await jobLastError()) !== null);
    expect(await jobLastError()).toContain("no agent session runtime wired");
    expect(await jobLastError()).not.toContain("No handler registered");

    const { rows: runs } = await pool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM agent_runs WHERE heartbeat_id = $1 ORDER BY started_at LIMIT 1`,
      [heartbeat.id],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.result).toContain("no agent session runtime wired");
  });
});
