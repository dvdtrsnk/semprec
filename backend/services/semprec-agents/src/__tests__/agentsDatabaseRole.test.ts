import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
} from "@semprec/data";
import { createGenericOperationAgentTools } from "@semprec/agent-runtime";

/**
 * semprec-agents hosts the choke point in-process, so its pool must authenticate as `semprec_data`
 * (docs/adr/2026-10-03-agents-worker-choke-point-access.md). Test-only role passwords are
 * generated at run time, like leastPrivilegeRoles.test.ts.
 */
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
  await adminPool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'unused')`, [
    `${randomUUID()}@example.com`,
  ]);
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

describe("semprec-agents database role", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    await adminPool.query(`ALTER ROLE semprec_data WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await adminPool.query(`ALTER ROLE semprec_side WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    dataPool = new Pool({ connectionString: roleConnectionString("semprec_data") });
    sidePool = new Pool({ connectionString: roleConnectionString("semprec_side") });
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

  it("persists an agent run's item.create when the pool authenticates as semprec_data", async () => {
    const { runId, databaseId } = await createFixtures();
    const tools = createGenericOperationAgentTools(dataPool, await loadFullModuleRegistry());

    const outcome = await tools["item.create"](runId, { databaseId, properties: {} });

    expect(outcome.error).toBe(false);
    expect(await countItems(databaseId)).toBe(1);
  });

  it("reports permission denied and writes nothing when the pool authenticates as semprec_side", async () => {
    const { runId, databaseId } = await createFixtures();
    const tools = createGenericOperationAgentTools(sidePool, await loadFullModuleRegistry());

    const outcome = await tools["item.create"](runId, { databaseId, properties: {} });

    expect(outcome.error).toBe(true);
    expect(outcome.result).toMatch(/permission denied/);
    expect(await countItems(databaseId)).toBe(0);
  });
});
