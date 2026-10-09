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
import { listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";

let pool: Pool;

/** Wraps the real pool so its first `connect()` calls reject with `errors`, in order; later calls delegate. */
function poolWithFailingConnects(errors: Error[]): Pool {
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

  async function getSemprecProjectId(): Promise<string> {
    const { rows } = await pool.query("SELECT id FROM databases WHERE owner_module_id = 'projects'");
    const { rows: items } = await pool.query("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [rows[0].id]);
    return items[0].id;
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

    const notifications = await getNotifications("agent_run_error");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.source_id).toBe(runs[0]!.id);
  });

  it("never masks the original runAgent error when the close-and-notify transaction itself fails", async () => {
    const { heartbeatId, projectItemId } = await createTestHeartbeat();
    const failingPool = poolWithFailingConnects([new Error("db down")]);
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
});
