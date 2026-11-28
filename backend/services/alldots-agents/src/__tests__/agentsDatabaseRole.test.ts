import type { CollectionMetadataResolver } from "@alldots/data";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTenantZeroUser, getTestPool, resetDatabase, tenantZeroSessionOptions } from "@alldots/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
} from "@alldots/data";
import { createGenericOperationAgentTools } from "@alldots/agent-runtime";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

/** The in-process choke point requires `alldots_data`. Role passwords are generated at run time. */
const TEST_ROLE_PASSWORD = randomUUID();

let adminPool: Pool;
let dataPool: Pool;
let sidePool: Pool;

function roleConnectionString(role: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = TEST_ROLE_PASSWORD;
  return url.toString();
}

async function createFixtures(): Promise<{ runId: string; databaseId: string }> {
  await createTenantZeroUser(adminPool);
  const chokePoint = createChokePoint(adminPool);
  const { rows } = await adminPool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`);
  if (!rows[0]) throw new Error("Projects database was not seeded");
  const project = await chokePoint.createItem({ databaseId: rows[0].id, properties: {} });
  const run = await createAgentRun(adminPool, {
    projectItemId: project.id,
    triggeredBy: "user",
    task: "create an item",
  });
  const database = await chokePoint.createDatabase({ name: `Agents role test ${randomUUID()}` });
  return { runId: run.id, databaseId: database.id };
}

async function countItems(databaseId: string): Promise<number> {
  const { rows } = await adminPool.query<{ count: string }>(
    `SELECT count(*) AS count FROM items WHERE database_id = $1`,
    [databaseId],
  );
  return Number(rows[0]!.count);
}

describe("alldots-agents database role", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    // ALTER ROLE ... WITH PASSWORD cannot take query parameters, so the value is interpolated.
    // It must stay derived from a source limited to SQL-safe characters (randomUUID(): [0-9a-f-]).
    await adminPool.query(`ALTER ROLE alldots_data WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await adminPool.query(`ALTER ROLE alldots_side WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    // Checks grants, not isolation: every connection starts in tenant zero, since strict
    // `app_tenant_default()` has no fallback.
    const inTenantZeroOptions = tenantZeroSessionOptions();
    dataPool = new Pool({ connectionString: roleConnectionString("alldots_data"), options: inTenantZeroOptions });
    sidePool = new Pool({ connectionString: roleConnectionString("alldots_side"), options: inTenantZeroOptions });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await seedSystem(adminPool, createViewTypeRegistry());
  });

  afterAll(async () => {
    await dataPool?.end();
    await sidePool?.end();
    await adminPool?.end();
  });

  it("persists an agent run's item.create when the pool authenticates as alldots_data", async () => {
    const { runId, databaseId } = await createFixtures();
    const tools = createGenericOperationAgentTools(dataPool, await loadFullModuleRegistry(), testMetadataResolver);

    const outcome = await tools["item.create"](runId, { databaseId, properties: {} });

    expect(outcome.error).toBe(false);
    expect(await countItems(databaseId)).toBe(1);
  });

  it("reports permission denied and writes nothing when the pool authenticates as alldots_side", async () => {
    const { runId, databaseId } = await createFixtures();
    const tools = createGenericOperationAgentTools(sidePool, await loadFullModuleRegistry(), testMetadataResolver);

    const outcome = await tools["item.create"](runId, { databaseId, properties: {} });

    expect(outcome.error).toBe(true);
    expect(outcome.result).toMatch(/permission denied/);
    expect(await countItems(databaseId)).toBe(0);
  });
});
