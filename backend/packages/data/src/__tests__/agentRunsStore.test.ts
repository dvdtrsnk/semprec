import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { createAgentRun, finishAgentRun, getAgentRun } from "../agentRuns/agentRunsStore.js";
import { NotFoundError } from "../errors.js";

let pool: Pool;

describe("finishAgentRun", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query(
      `INSERT INTO users (email, password_hash, tenant_id)
     VALUES ($1, 'unused', (SELECT $2::uuid WHERE NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = $2::uuid)))`,
      [`${randomUUID()}@example.com`, getTenantZeroId()],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("closes a running run and returns true", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await expect(finishAgentRun(pool, run.id, "done", "result text")).resolves.toBe(true);

    const finished = await getAgentRun(pool, run.id);
    expect(finished).toMatchObject({ status: "done", result: "result text" });
    expect(finished!.finishedAt).not.toBeNull();
  });

  it.each([
    ["done", "error"],
    ["error", "done"],
  ] as const)("keeps the first close (%s) when a second one (%s) arrives and returns false", async (first, second) => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });
    await expect(finishAgentRun(pool, run.id, first, "first")).resolves.toBe(true);
    const afterFirst = await getAgentRun(pool, run.id);

    await expect(finishAgentRun(pool, run.id, second, "second")).resolves.toBe(false);

    const afterSecond = await getAgentRun(pool, run.id);
    expect(afterSecond).toMatchObject({ status: first, result: "first", finishedAt: afterFirst!.finishedAt });
  });

  it("throws NotFoundError for an unknown run id", async () => {
    await expect(finishAgentRun(pool, randomUUID(), "done", null)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("createAgentRun actor in a tenant (issue #1018)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantB: string;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    adminPool = getTestPool();
    runtimePool ??= await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantB = await createTestTenant(adminPool);
    userA = (await createUser(adminPool, { email: "a@example.test", passwordHash: "x", tenantId: getTenantZeroId() }))
      .id;
    userB = (await createUser(adminPool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB })).id;
  });

  afterAll(async () => {
    await runtimePool?.end();
  });

  it("attributes a root run without userId to the tenant's user, never to the earlier-created account", async () => {
    const run = await runInTenant(tenantB, () => createAgentRun(runtimePool, { triggeredBy: "heartbeat", task: "t" }));
    expect(run.actorUserId).toBe(userB);
    expect(run.actorUserId).not.toBe(userA);
  });

  it("throws when the tenant has no bound user", async () => {
    const tenantC = await createTestTenant(adminPool);
    await expect(
      runInTenant(tenantC, () => createAgentRun(runtimePool, { triggeredBy: "heartbeat", task: "t" })),
    ).rejects.toThrow("Cannot create an agent run: the current tenant has no user");
  });

  it("uses an explicit userId, and a delegated run still inherits its parent's actor", async () => {
    const explicit = await runInTenant(tenantB, () =>
      createAgentRun(runtimePool, { triggeredBy: "user", task: "t", userId: userB }),
    );
    expect(explicit.actorUserId).toBe(userB);

    const child = await runInTenant(tenantB, () =>
      createAgentRun(runtimePool, { triggeredBy: "user", task: "child", parentRunId: explicit.id, userId: userA }),
    );
    expect(child.actorUserId).toBe(userB);
  });
});
