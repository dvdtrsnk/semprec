import "../../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../../manifest/schemaProjection.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createMailThread, reassignThread } from "../mailMessageMetaStore.js";
import { runThreadTasksCutoverMigration } from "../threadTasksCutoverMigration.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;

async function tasksProperty() {
  return runInTenant(tenant, async () => (await cp.listProperties(databases.threads!)).find((p) => p.key === "tasks"));
}

async function definitionRows(propertyId: string) {
  const { rows } = await runInTenant(tenant, () =>
    runtime.query<{ cardinality: string; property_id_b: string | null }>(
      "SELECT cardinality, property_id_b FROM relation_definitions WHERE property_id_a = $1",
      [propertyId],
    ),
  );
  return rows;
}

const schemaSnapshot = async () =>
  (
    await admin.query(
      `SELECT to_jsonb(p) AS property, to_jsonb(r) AS definition FROM properties p
       LEFT JOIN relation_definitions r ON r.property_id_a = p.id OR r.property_id_b = p.id
       WHERE p.database_id = $1 ORDER BY p.id`,
      [databases.threads],
    )
  ).rows;

/** A new mail thread and its Threads item, through the production thread writer. */
async function newThread(subject: string): Promise<{ threadId: string; itemId: string }> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const thread = await createMailThread(client, subject);
      const { rows } = await client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
        thread.id,
      ]);
      if (!rows[0]) throw new Error("Missing thread item");
      return { threadId: thread.id, itemId: rows[0].item_id };
    }),
  );
}

async function threadsOfTask(propertyId: string, taskId: string): Promise<string[]> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const definition = await getRelationDefinitionByPropertyId(client, propertyId);
      return (await listRelationsForItem(client, definition!.id, taskId)).map((edge) => otherSide(edge, taskId));
    }),
  );
}

describe("Threads.tasks relation (issue #1612)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    cp = createChokePoint(runtime);
    const { rows } = await runInTenant(tenant, () =>
      runtime.query<{ id: string; owner_module_id: string }>("SELECT id, owner_module_id FROM databases"),
    );
    databases = Object.fromEntries(rows.map((row) => [row.owner_module_id, row.id]));
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("exists on a fresh install as a user-owned one-to-many relation to Tasks, and the cutover adds nothing there", async () => {
    const property = await tasksProperty();
    expect(property).toMatchObject({
      type: "relation",
      owner: "user",
      name: null,
      config: { targetDatabaseId: databases.tasks },
    });
    expect(await definitionRows(property!.id)).toEqual([{ cardinality: "one_to_many", property_id_b: null }]);
    const before = await schemaSnapshot();
    await runAsSystem("test:thread-tasks", () => runTenantCutoverMigrations(runtime));
    expect(await schemaSnapshot()).toEqual(before);
  });

  it("is added to an existing tenant by the cutover, and a second run adds nothing", async () => {
    const seeded = await tasksProperty();
    // A tenant whose Threads schema predates issue #1612: the locked schema cannot lose a property publicly.
    await runInTenant(tenant, async () => {
      await runtime.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [seeded!.id]);
      const removed = await runtime.query("DELETE FROM properties WHERE id = $1", [seeded!.id]);
      expect(removed.rowCount).toBe(1);
    });
    await runAsSystem("test:thread-tasks", () => runTenantCutoverMigrations(runtime));
    const migrated = await tasksProperty();
    expect(migrated).toMatchObject({
      type: "relation",
      owner: "user",
      name: null,
      config: { targetDatabaseId: databases.tasks },
    });
    expect(await definitionRows(migrated!.id)).toEqual([{ cardinality: "one_to_many", property_id_b: null }]);
    const before = await schemaSnapshot();
    await runAsSystem("test:thread-tasks-replay", () => runTenantCutoverMigrations(runtime));
    expect(await schemaSnapshot()).toEqual(before);
  });

  it("does nothing in a tenant without a Threads database", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runThreadTasksCutoverMigration(runtime));
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM properties WHERE tenant_id = $1",
      [empty],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("links one thread to several tasks but refuses a second thread for a task that already has one", async () => {
    const property = await tasksProperty();
    const first = await newThread("Invoice");
    const second = await newThread("Other");
    const [taskA, taskB] = await runInTenant(tenant, () =>
      Promise.all(
        ["Pay invoice", "File invoice"].map((name) =>
          cp.createItem({ databaseId: databases.tasks!, properties: { name } }),
        ),
      ),
    );
    for (const task of [taskA!, taskB!]) {
      await runInTenant(tenant, () =>
        cp.createRelation({ relationPropertyId: property!.id, callerItemId: first.itemId, targetItemId: task.id }),
      );
    }
    expect(await threadsOfTask(property!.id, taskA!.id)).toEqual([first.itemId]);
    expect(await threadsOfTask(property!.id, taskB!.id)).toEqual([first.itemId]);
    await expect(
      runInTenant(tenant, () =>
        cp.createRelation({ relationPropertyId: property!.id, callerItemId: second.itemId, targetItemId: taskA!.id }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });
    expect(await threadsOfTask(property!.id, taskA!.id)).toEqual([first.itemId]);
  });

  it("moves the losing thread's task edges to the winner when two threads merge", async () => {
    const property = await tasksProperty();
    const loser = await newThread("Losing");
    const winner = await newThread("Winning");
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: databases.tasks!, properties: { name: "Reply" } }),
    );
    await runInTenant(tenant, () =>
      cp.createRelation({ relationPropertyId: property!.id, callerItemId: loser.itemId, targetItemId: task.id }),
    );
    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => reassignThread(client, loser.threadId, winner.threadId)),
    );
    expect(await threadsOfTask(property!.id, task.id)).toEqual([winner.itemId]);
  });

  it("labels the relation 'Úkoly' in Czech and 'Tasks' in English", async () => {
    const registry = await loadFullModuleRegistry();
    for (const [locale, name] of [
      ["cs", "Úkoly"],
      ["en", "Tasks"],
    ] as const) {
      const schema = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => generateSchemaProjection(client, registry, { locale })),
      );
      expect(schema.databases.find((db) => db.key === "threads")?.properties.find((p) => p.key === "tasks")?.name).toBe(
        name,
      );
    }
  });
});
