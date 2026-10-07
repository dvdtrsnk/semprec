import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { ForbiddenError } from "../errors.js";
import { reserveGatewayCall } from "../aiGateway/aiGatewayCallsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
/** `createPool` applies the ambient tenant scope as `app.tenant_id`; the plain test pool does not. */
let pool: Pool;
let tenantZero: string;

const RESERVATION = { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 };

async function createRun(): Promise<string> {
  await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: "hash" });
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
    await seedSystem(adminPool);
    tenantZero = getTenantZeroId();
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    pool = createPool(url);
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
      runId: await createRun(),
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

  it("reserves with no ids, and with no scope at all (falling to the sole tenant)", async () => {
    const row = await reserveGatewayCall(pool, RESERVATION);

    expect(row).toMatchObject({ status: "reserved", agentRunId: null, projectItemId: null });
    const { rows } = await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM ai_gateway_calls");
    expect(rows).toEqual([{ tenant_id: tenantZero }]);
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

  it("refuses another tenant's run and project item exactly like unknown ids, writing no row", async () => {
    const tenantB = await createTestTenant(adminPool);
    await runInTenant(tenantB, () => seedSystem(pool));
    const { runB, itemB } = await runInTenant(tenantB, async () => ({
      runB: await createRun(),
      itemB: await createProjectItem(),
    }));

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
