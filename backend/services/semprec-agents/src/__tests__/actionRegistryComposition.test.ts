import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { AiGatewayClientPort } from "@semprec/shared";
import { getTenantZeroId, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  createAgentRun,
  createUser,
  seedSystem,
  type ActionRegistry,
} from "@semprec/data";
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

  it("registers exactly core.agentRun and core.journalWeeklyCleanup", () => {
    const registry = createAgentsActionRegistry(pool, unwiredRunAgent);

    expect([...registry.keys()]).toEqual([CORE_AGENT_RUN_ACTION_ID, JOURNAL_WEEKLY_CLEANUP_ACTION_ID]);
  });

  it("hands the AI gateway to core.agentRun for the answer-expected gate, and a registry without one fails a heartbeat that turns the gate on (issue gh-1941)", async () => {
    const gateway: AiGatewayClientPort = {
      complete: () => Promise.reject(new Error("The gate must not ask for a message that has no thread")),
    };
    const context = { heartbeatId: randomUUID(), projectItemId: randomUUID(), itemId: randomUUID() };
    const fire = (registry: ActionRegistry) => {
      const action = registry.get(CORE_AGENT_RUN_ACTION_ID);
      if (!action) throw new Error("core.agentRun is not registered");
      return action({ answerExpectedFilter: {} }, context);
    };

    await expect(fire(createAgentsActionRegistry(pool, unwiredRunAgent, gateway))).resolves.toBeUndefined();
    await expect(fire(createAgentsActionRegistry(pool, unwiredRunAgent))).rejects.toThrow(
      "No answer-expected gate is configured for this action",
    );
  });

  it("resolves the mailThreadProject run project in core.agentRun and refuses any other resolver name (issue gh-1941)", async () => {
    await seedSystem(pool);
    await createUser(pool, { email: "owner@example.com", passwordHash: "unused", tenantId: getTenantZeroId() });
    const { rows: heartbeats } = await pool.query<{ id: string; project_item_id: string }>(
      `SELECT id, project_item_id FROM project_heartbeats WHERE action_id = $1`,
      [CORE_AGENT_RUN_ACTION_ID],
    );
    const heartbeat = heartbeats[0];
    if (!heartbeat) throw new Error("The newEmail heartbeat was not seeded");
    const action = createAgentsActionRegistry(pool, unwiredRunAgent).get(CORE_AGENT_RUN_ACTION_ID);
    if (!action) throw new Error("core.agentRun is not registered");
    const context = { heartbeatId: heartbeat.id, projectItemId: heartbeat.project_item_id, itemId: randomUUID() };

    await expect(action({ runProject: { resolver: "unknownResolver" } }, context)).rejects.toMatchObject({
      name: "ValidationError",
    });
    // A message that is none of the tenant's has no thread, so the resolver answers the heartbeat's own project, and
    // the unwired session then closes the run it opened as an error: the run was started in that project.
    await expect(action({ runProject: { resolver: "mailThreadProject" } }, context)).rejects.toThrow(
      "no agent session runtime wired",
    );
    const { rows: runs } = await pool.query<{ project_item_id: string }>(
      "SELECT project_item_id FROM agent_runs WHERE heartbeat_id = $1",
      [heartbeat.id],
    );
    expect(runs).toEqual([{ project_item_id: heartbeat.project_item_id }]);
  });

  it("closes a fired core.agentRun heartbeat's run as error with the code internal, and the job names the unwired runtime", async () => {
    await seedSystem(pool);
    await createUser(pool, { email: "owner@example.com", passwordHash: "unused", tenantId: getTenantZeroId() });
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
    await inTenantZero(() =>
      enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, {
        heartbeatId: heartbeat.id,
        triggeredByRunId: parentRun.id,
      }),
    );

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
    expect(runs[0]?.result).toBe("internal");
  });

  it("fires a seeded weekly Journal cleanup heartbeat on the agents runtime and starts its agent run", async () => {
    await seedSystem(pool);
    const user = await createUser(pool, {
      email: "owner@example.com",
      passwordHash: "unused",
      tenantId: getTenantZeroId(),
    });
    const { rows: heartbeats } = await pool.query<{ id: string }>(
      `SELECT id FROM project_heartbeats WHERE action_id = $1`,
      [JOURNAL_WEEKLY_CLEANUP_ACTION_ID],
    );
    expect(heartbeats).toHaveLength(1);
    const heartbeatId = heartbeats[0]!.id;

    runtime = await createAgentsQueueRuntime(pool, new ModuleRegistry(() => new Set()));
    await inTenantZero(() =>
      enqueueJob(pool, AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT, { heartbeatId, triggeredByUserId: user.id }),
    );

    // The unwired runtime closes the run it opened as an error; waiting for that settles the attempt, and it is
    // the handler, not the affinity check or the registry lookup, that opened the run.
    const runStatuses = async (): Promise<string[]> => {
      const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agent_runs WHERE heartbeat_id = $1`, [
        heartbeatId,
      ]);
      return rows.map((row) => row.status);
    };
    await waitFor(async () => (await runStatuses()).join() === "error");
    expect(await runStatuses()).toEqual(["error"]);
  });
});
