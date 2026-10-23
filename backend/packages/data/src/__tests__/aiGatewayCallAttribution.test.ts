import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { ForbiddenError } from "../errors.js";
import { assertGatewayTenantActive, reserveGatewayCall } from "../aiGateway/aiGatewayCallsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createTestModuleItem } from "../testSupport/projectFixtures.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
/** The runtime-role pool applies the ambient tenant scope as `app.tenant_id` and enforces RLS. */
let pool: Pool;
let tenantZero: string;

const RESERVATION = { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 };

async function createRun(tenantId: string): Promise<string> {
  await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: "hash", tenantId });
  return (await createAgentRun(pool, { triggeredBy: "user", task: "attribution" })).id;
}

async function createProjectItem(): Promise<string> {
  const item = await withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("Projects database was not seeded");
    return insertItem(client, { databaseId: database.id, properties: { name: `Project ${randomUUID()}` } });
  });
  return item.id;
}

async function rowCount(): Promise<number> {
  const { rows } = await adminPool.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_gateway_calls");
  return Number(rows[0]?.count);
}

async function expectRefused(promise: Promise<unknown>): Promise<ForbiddenError> {
  const error: unknown = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ForbiddenError);
  const forbidden = error as ForbiddenError;
  expect(forbidden.status).toBe(403);
  expect(forbidden.code).toBe("attribution_refused");
  expect(forbidden.details).toBeUndefined();
  return forbidden;
}

describe("reserveGatewayCall attribution guard", () => {
  beforeEach(async () => {
    adminPool ??= getTestPool();
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    await runInTenant(tenantZero, () => seedSystem(pool));
  });

  afterEach(async () => {
    await adminPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantZero]);
    await pool.end();
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  it("reserves a row stamped with the ambient tenant, linking a visible run and project item", async () => {
    const { runId, itemId } = await runInTenant(tenantZero, async () => ({
      runId: await createRun(tenantZero),
      itemId: await createProjectItem(),
    }));

    const row = await runInTenant(tenantZero, () =>
      reserveGatewayCall(pool, { ...RESERVATION, agentRunId: runId, projectItemId: itemId, operation: "agent_turn" }),
    );

    expect(row).toMatchObject({
      status: "reserved",
      agentRunId: runId,
      projectItemId: itemId,
      operation: "agent_turn",
    });
    const { rows } = await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM ai_gateway_calls");
    expect(rows).toEqual([{ tenant_id: tenantZero }]);
  });

  // Strict `app_tenant_default()` (#1067): no fallback to the sole tenant.
  it("refuses a reservation with no scope at all, even while tenant zero is the only tenant, writing no row", async () => {
    await expectRefused(reserveGatewayCall(pool, RESERVATION));
    expect(await rowCount()).toBe(0);
  });

  it("refuses a tenant that does not exist, writing no row", async () => {
    await expectRefused(runInTenant(randomUUID(), () => reserveGatewayCall(pool, RESERVATION)));
    expect(await rowCount()).toBe(0);
  });

  it.each(["provisioning", "suspended", "deleting"] as const)("refuses a %s tenant, writing no row", async (status) => {
    await adminPool.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantZero, status]);

    await expectRefused(runInTenant(tenantZero, () => reserveGatewayCall(pool, RESERVATION)));
    expect(await rowCount()).toBe(0);
  });

  it("refuses an agent run id that does not exist, writing no row", async () => {
    await expectRefused(
      runInTenant(tenantZero, () => reserveGatewayCall(pool, { ...RESERVATION, agentRunId: randomUUID() })),
    );
    expect(await rowCount()).toBe(0);
  });

  it("refuses a project item id that does not exist, writing no row", async () => {
    await expectRefused(
      runInTenant(tenantZero, () => reserveGatewayCall(pool, { ...RESERVATION, projectItemId: randomUUID() })),
    );
    expect(await rowCount()).toBe(0);
  });

  it("refuses a same-tenant item outside the Projects database exactly like an unknown id, writing no row", async () => {
    const taskItemId = await runInTenant(tenantZero, () => createTestModuleItem(pool, TASKS_MODULE_ID));
    const { rows: taskRows } = await adminPool.query<{ tenant_id: string; owner_module_id: string; system: boolean }>(
      "SELECT i.tenant_id, d.owner_module_id, d.system FROM items i JOIN databases d ON d.id = i.database_id WHERE i.id = $1",
      [taskItemId],
    );
    expect(taskRows).toEqual([{ tenant_id: tenantZero, owner_module_id: TASKS_MODULE_ID, system: true }]);

    const unknownItem = await expectRefused(
      runInTenant(tenantZero, () => reserveGatewayCall(pool, { ...RESERVATION, projectItemId: randomUUID() })),
    );
    const taskItem = await expectRefused(
      runInTenant(tenantZero, () => reserveGatewayCall(pool, { ...RESERVATION, projectItemId: taskItemId })),
    );

    expect(taskItem.message).toBe(unknownItem.message);
    expect(await rowCount()).toBe(0);
  });

  it("refuses another tenant's run and project item exactly like unknown ids, writing no row", async () => {
    const tenantB = await createTestTenant(adminPool);
    await runInTenant(tenantB, () => seedSystem(pool));
    const { runB, itemB } = await runInTenant(tenantB, async () => ({
      runB: await createRun(tenantB),
      itemB: await createProjectItem(),
    }));
    const { rows: projectRows } = await adminPool.query<{ tenant_id: string; database_tenant_id: string }>(
      "SELECT i.tenant_id, d.tenant_id AS database_tenant_id FROM items i JOIN databases d ON d.id = i.database_id WHERE i.id = $1",
      [itemB],
    );
    expect(projectRows).toEqual([{ tenant_id: tenantB, database_tenant_id: tenantB }]);

    const sidePool = await createRuntimeRolePool(adminPool, "semprec_side");
    try {
      const unknownRun = await expectRefused(
        runInTenant(tenantZero, () => reserveGatewayCall(sidePool, { ...RESERVATION, agentRunId: randomUUID() })),
      );
      const foreignRun = await expectRefused(
        runInTenant(tenantZero, () => reserveGatewayCall(sidePool, { ...RESERVATION, agentRunId: runB })),
      );
      const unknownItem = await expectRefused(
        runInTenant(tenantZero, () => reserveGatewayCall(sidePool, { ...RESERVATION, projectItemId: randomUUID() })),
      );
      const foreignItem = await expectRefused(
        runInTenant(tenantZero, () => reserveGatewayCall(sidePool, { ...RESERVATION, projectItemId: itemB })),
      );

      expect(foreignRun.message).toBe(unknownRun.message);
      expect(foreignItem.message).toBe(unknownItem.message);
      expect(await rowCount()).toBe(0);
    } finally {
      await sidePool.end();
    }
  });
});

describe("assertGatewayTenantActive", () => {
  // The describe above ends the shared admin pool in its afterAll, so this one opens its own.
  beforeAll(() => {
    adminPool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterEach(async () => {
    await adminPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantZero]);
    await pool.end();
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  it("resolves for an active tenant", async () => {
    await expect(runInTenant(tenantZero, () => assertGatewayTenantActive(pool))).resolves.toBeUndefined();
  });

  it.each(["provisioning", "suspended", "deleting"] as const)("refuses a %s tenant", async (status) => {
    await adminPool.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantZero, status]);

    await expectRefused(runInTenant(tenantZero, () => assertGatewayTenantActive(pool)));
  });

  it("refuses a tenant that does not exist with the same refusal", async () => {
    await expectRefused(runInTenant(randomUUID(), () => assertGatewayTenantActive(pool)));
  });
});
