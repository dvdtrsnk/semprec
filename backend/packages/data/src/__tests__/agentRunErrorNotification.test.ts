import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import {
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
} from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { coreAgentRunAction, CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { AgentRunError } from "../agentRuns/agentRunErrorCodes.js";

let pool: Pool;

describe("finishAgentRunWithErrorNotification (issue #149)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTestUser() {
    const passwordHash = await hashPassword("s3cret-password");
    return createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  }

  it("writes an agent_run_error notification in the same transaction as the status write, and replaying the same run never duplicates it", async () => {
    const user = await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await expect(
      withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, run.id, "boom", "internal")),
    ).resolves.toBe(true);
    const stored = await pool.query<{ error_code: string | null }>("SELECT error_code FROM agent_runs WHERE id = $1", [
      run.id,
    ]);
    expect(stored.rows).toEqual([{ error_code: "internal" }]);

    const { rows: afterFirst } = await pool.query(
      `SELECT user_id, kind, title, link_href, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [run.id],
    );
    expect(afterFirst).toMatchObject([
      {
        user_id: user.id,
        kind: "agent_run_error",
        title: "Agent run failed",
        link_href: `?page=agent-run&id=${run.id}`,
        source_table: "agent_runs",
        transition_instance: run.id,
      },
    ]);

    // Replaying the same close (e.g. a retried caller after a crash) must not duplicate it.
    await expect(
      withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, run.id, "boom", "internal")),
    ).resolves.toBe(false);
    const { rows: afterReplay } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [run.id]);
    expect(afterReplay).toHaveLength(1);
  });

  it("rolls back the notification along with the rest of the transaction on failure", async () => {
    await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await expect(
      withTransaction(pool, async (client) => {
        await finishAgentRunWithErrorNotification(client, run.id, "boom", "internal");
        throw new Error("later step in the same transaction fails");
      }),
    ).rejects.toThrow("later step in the same transaction fails");

    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [run.id]);
    expect(rows).toHaveLength(0);
    const finished = await getAgentRun(pool, run.id);
    expect(finished!.status).toBe("running");
  });

  it("opens its own transaction when given a bare pool, so the close and the notification still land atomically together", async () => {
    const user = await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await finishAgentRunWithErrorNotification(pool, run.id, "boom", "internal");

    const finished = await getAgentRun(pool, run.id);
    expect(finished!.status).toBe("error");
    const stored = await pool.query<{ error_code: string | null }>("SELECT error_code FROM agent_runs WHERE id = $1", [
      run.id,
    ]);
    expect(stored.rows).toEqual([{ error_code: "internal" }]);
    const { rows } = await pool.query(`SELECT user_id, kind FROM notifications WHERE source_id = $1`, [run.id]);
    expect(rows).toMatchObject([{ user_id: user.id, kind: "agent_run_error" }]);
  });

  it("returns false and writes no notification when the run was already finished as done", async () => {
    await createTestUser();
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });
    await finishAgentRun(pool, run.id, "done", "all good");

    await expect(finishAgentRunWithErrorNotification(pool, run.id, "boom", "internal")).resolves.toBe(false);

    const finished = await getAgentRun(pool, run.id);
    expect(finished!.status).toBe("done");
    expect(finished!.result).toBe("all good");
    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [run.id]);
    expect(rows).toHaveLength(0);
  });

  it("rejects creating an agent run before any user account exists", async () => {
    await expect(createAgentRun(pool, { triggeredBy: "user", task: "do the thing" })).rejects.toThrow(
      "Cannot create an agent run: the current tenant has no user",
    );
  });

  it("records the structured code on both final and non-final heartbeat failures", async () => {
    await createTestUser();
    await seedSystem(pool);
    const { rows } = await pool.query<{ id: string }>(
      "SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = 'projects' LIMIT 1",
    );
    const projectItemId = rows[0]!.id;
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: "failure test",
        rule: { kind: "interval", minutes: 5 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "test" },
      }),
    );
    const action = coreAgentRunAction(pool, async () => {
      throw new AgentRunError("modelError", "model failed");
    });
    for (const isFinalAttempt of [false, true]) {
      await expect(
        runInTenant(getTenantZeroId(), () =>
          action({ task: "test" }, { heartbeatId: heartbeat.id, projectItemId, isFinalAttempt }),
        ),
      ).rejects.toThrow("model failed");
    }
    const runs = await pool.query<{ status: string; error_code: string | null }>(
      "SELECT status, error_code FROM agent_runs WHERE heartbeat_id = $1 ORDER BY wake_seq",
      [heartbeat.id],
    );
    expect(runs.rows).toEqual([
      { status: "error", error_code: "modelError" },
      { status: "error", error_code: "modelError" },
    ]);
  });
});

describe("finishAgentRunWithErrorNotification in a tenant (issue #1018)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantB: string;
  let userA: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(adminPool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(adminPool));
    tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(adminPool));
    userA = (
      await runInTenant(getTenantZeroId(), () =>
        createUser(adminPool, { email: "a@example.test", passwordHash: "x", tenantId: getTenantZeroId() }),
      )
    ).id;
  });

  afterAll(async () => {
    await Promise.all([runtimePool?.end(), adminPool?.end()]);
  });

  it("notifies the tenant's user with the tenant's id, not the earlier-created account", async () => {
    const userB = (
      await runInTenant(tenantB, () =>
        createUser(adminPool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
      )
    ).id;
    const run = await runInTenant(tenantB, () => createAgentRun(runtimePool, { triggeredBy: "user", task: "t" }));

    await expect(
      runInTenant(tenantB, () => finishAgentRunWithErrorNotification(runtimePool, run.id, "boom", "internal")),
    ).resolves.toBe(true);

    const { rows } = await adminPool.query<{ user_id: string; kind: string; tenant_id: string }>(
      `SELECT user_id, kind, tenant_id FROM notifications WHERE source_id = $1`,
      [run.id],
    );
    expect(rows).toEqual([{ user_id: userB, kind: "agent_run_error", tenant_id: tenantB }]);
    expect(rows[0]?.user_id).not.toBe(userA);
  });

  it("closes the run and writes nothing when the tenant has no user", async () => {
    // A run in a tenant without a user is a state agent_runs_actor_user_id_tenant_fkey (issue #1066)
    // refuses, since its actor must be that tenant's user. Raw fixture: the admin connection skips
    // foreign-key triggers for this one insert so the defensive no-user branch stays reachable.
    const run = await withTenantTransaction(adminPool, tenantB, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      return createAgentRun(client, { triggeredBy: "user", task: "t", userId: userA });
    });

    await expect(
      runInTenant(tenantB, () => finishAgentRunWithErrorNotification(runtimePool, run.id, "boom", "internal")),
    ).resolves.toBe(true);

    expect(await getAgentRun(adminPool, run.id)).toMatchObject({ status: "error", result: "boom" });
    const { rows } = await adminPool.query<{ id: string }>(`SELECT id FROM notifications WHERE source_id = $1`, [
      run.id,
    ]);
    expect(rows).toHaveLength(0);
  });
});
