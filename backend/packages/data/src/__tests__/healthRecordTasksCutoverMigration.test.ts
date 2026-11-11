import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { SchemaLockedError } from "../errors.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { runHealthRecordTasksCutoverMigration } from "../seed/healthRecordTasksCutoverMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let first: string;
let second: string;

const pairSchema = z.array(
  z.strictObject({
    id: z.string(),
    database: z.string(),
    key: z.string(),
    name: z.string().nullable(),
    type: z.string(),
    owner: z.string(),
    ownerProcess: z.string().nullable(),
    locked: z.boolean(),
    configKeys: z.array(z.string()),
    target: z.string().nullable(),
    side: z.enum(["a", "b"]),
    cardinality: z.string(),
    definitionId: z.string(),
  }),
);
type Pair = z.infer<typeof pairSchema>;

/**
 * The `HealthRecords.tasks` / `Tasks.healthRecords` properties of the tenant, read as that tenant on the runtime
 * role, with the side and the cardinality of the relation definition their config points at. Empty when the tenant
 * has neither property.
 */
async function readPair(tenantId: string): Promise<Pair> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<Record<string, unknown>>(
      `SELECT p.id, d.owner_module_id AS database, p.key, p.name, p.type, p.owner, p.owner_process AS "ownerProcess",
              p.locked, (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p.config) AS k) AS "configKeys",
              (SELECT t.owner_module_id FROM databases t WHERE t.id = (p.config->>'targetDatabaseId')::uuid) AS target,
              CASE WHEN r.property_id_a = p.id THEN 'a' ELSE 'b' END AS side, r.cardinality,
              r.id::text AS "definitionId"
         FROM properties p
         JOIN databases d ON d.id = p.database_id
         JOIN relation_definitions r ON r.id = (p.config->>'relationDefinitionId')::uuid
        WHERE d.system AND ((d.owner_module_id = 'tasks' AND p.key = 'healthRecords')
                         OR (d.owner_module_id = 'healthRecords' AND p.key = 'tasks'))
        ORDER BY d.owner_module_id`,
    );
    return pairSchema.parse(rows);
  });
}

/** Strips the generated ids, so a fresh seed and an upgraded tenant compare by shape. */
function shape(pair: Pair): Omit<Pair[number], "id" | "definitionId">[] {
  return pair.map(({ id: _id, definitionId: _definitionId, ...rest }) => rest);
}

const EXPECTED_SHAPE = [
  {
    database: "healthRecords",
    key: "tasks",
    name: null,
    type: "relation",
    owner: "user",
    ownerProcess: null,
    locked: false,
    configKeys: ["relationDefinitionId", "targetDatabaseId"],
    target: "tasks",
    side: "b",
    cardinality: "many_to_many",
  },
  {
    database: "tasks",
    key: "healthRecords",
    name: null,
    type: "relation",
    owner: "user",
    ownerProcess: null,
    locked: false,
    configKeys: ["relationDefinitionId", "targetDatabaseId"],
    target: "healthRecords",
    side: "a",
    cardinality: "many_to_many",
  },
];

function expectOnePair(pair: Pair): void {
  expect(shape(pair)).toEqual(EXPECTED_SHAPE);
  expect(pair[0]?.definitionId).toBe(pair[1]?.definitionId);
}

const databasesSchema = z.array(z.strictObject({ id: z.string(), moduleId: z.string(), schemaLocked: z.boolean() }));

/** The tenant's Tasks and Health records system databases, Health records first. */
async function readDatabases(tenantId: string): Promise<z.infer<typeof databasesSchema>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<Record<string, unknown>>(
      `SELECT id, owner_module_id AS "moduleId", schema_locked AS "schemaLocked" FROM databases
        WHERE system AND owner_module_id = ANY($1::text[]) ORDER BY owner_module_id`,
      [["tasks", "healthRecords"]],
    );
    return databasesSchema.parse(rows);
  });
}

async function databaseIds(tenantId: string): Promise<{ tasks: string; healthRecords: string }> {
  const databases = await readDatabases(tenantId);
  const tasks = databases.find((database) => database.moduleId === "tasks")?.id;
  const healthRecords = databases.find((database) => database.moduleId === "healthRecords")?.id;
  if (!tasks || !healthRecords) throw new Error("Tasks or Health records database missing");
  return { tasks, healthRecords };
}

const BOTH_LOCKED = [
  { moduleId: "healthRecords", schemaLocked: true },
  { moduleId: "tasks", schemaLocked: true },
];

/** Both databases carry `schema_locked`, and the public property write refuses each of them for that reason. */
async function expectBothSchemaLocked(tenantId: string): Promise<void> {
  const databases = await readDatabases(tenantId);
  expect(databases.map(({ moduleId, schemaLocked }) => ({ moduleId, schemaLocked }))).toEqual(BOTH_LOCKED);
  const chokePoint = createChokePoint(runtime);
  for (const database of databases) {
    await expect(
      runInTenant(tenantId, () =>
        chokePoint.createProperty({ databaseId: database.id, key: "extra", name: "Extra", type: "text" }),
      ),
    ).rejects.toBeInstanceOf(SchemaLockedError);
  }
}

/**
 * Removes the pair from a seeded tenant, reproducing a tenant seeded before issue #1836. Raw SQL, as that tenant:
 * both schemas are locked, so no production write deletes a built-in property. The relation definition goes with
 * its properties (`ON DELETE CASCADE`).
 */
async function revertToOldShape(tenantId: string): Promise<void> {
  const pair = await readPair(tenantId);
  expect(pair).toHaveLength(2);
  await runInTenant(tenantId, async () => {
    const removed = await runtime.query("DELETE FROM properties WHERE id = ANY($1::uuid[])", [
      pair.map((property) => property.id),
    ]);
    expect(removed.rowCount).toBe(2);
    const definitions = await runtime.query<{ id: string }>("SELECT id FROM relation_definitions WHERE id = $1", [
      pair[0]?.definitionId,
    ]);
    expect(definitions.rows).toEqual([]);
  });
  expect(await readPair(tenantId)).toEqual([]);
}

function seed(tenantId: string): Promise<unknown> {
  return runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
}

function runCutovers(): Promise<void> {
  return runAsSystem("health record tasks cutover test", () => runTenantCutoverMigrations(runtime));
}

function runCutoverIn(tenantId: string): Promise<void> {
  return runInTenant(tenantId, () => runHealthRecordTasksCutoverMigration(runtime));
}

/**
 * Every tenant's databases, properties and relation definitions with their row versions (`xmin`), as the owner.
 * A row version changes with every write to the row, including one that stores equal values.
 */
async function snapshotSchema(): Promise<unknown[]> {
  const databases = await admin.query<{ row: unknown; version: string }>(
    "SELECT to_jsonb(t) AS row, t.xmin::text AS version FROM databases t ORDER BY t.id",
  );
  const properties = await admin.query<{ row: unknown; version: string }>(
    "SELECT to_jsonb(t) AS row, t.xmin::text AS version FROM properties t ORDER BY t.id",
  );
  const definitions = await admin.query<{ row: unknown; version: string }>(
    "SELECT to_jsonb(t) AS row, t.xmin::text AS version FROM relation_definitions t ORDER BY t.id",
  );
  return [databases.rows, properties.rows, definitions.rows];
}

/** Resolves once `count` sessions are queued for an EXCLUSIVE lock on `properties`; throws after about ten seconds without them. */
async function waitForQueuedPropertiesLocks(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks l
        WHERE l.relation = 'public.properties'::regclass AND l.mode = 'ExclusiveLock' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    await delay(50);
  }
  throw new Error(`Fewer than ${count} sessions queued for an EXCLUSIVE lock on properties`);
}

describe("Tasks.healthRecords / HealthRecords.tasks relation (issue #1836)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    first = getTenantZeroId();
    second = await createTestTenant(admin);
    await seed(first);
    await seed(second);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("seeds a new tenant with the pair as one user-owned many-to-many relation and locks both databases", async () => {
    expectOnePair(await readPair(first));
    await expectBothSchemaLocked(first);
  });

  it("adds the pair to a tenant seeded before it through the tenant runner, as a fresh seed has it, and both databases stay locked", async () => {
    await revertToOldShape(first);
    await expectBothSchemaLocked(first);
    const untouched = await readPair(second);

    await runCutovers();

    expectOnePair(await readPair(first));
    await expectBothSchemaLocked(first);
    // The tenant whose seed already carried the pair keeps exactly the rows it had.
    expect(await readPair(second)).toEqual(untouched);
  });

  it("changes nothing on a second run, through the tenant runner or on its own", async () => {
    await revertToOldShape(first);
    await runCutovers();
    const afterFirstRun = await snapshotSchema();

    await runCutovers();
    await runCutoverIn(first);
    await runCutoverIn(second);

    expect(await snapshotSchema()).toEqual(afterFirstRun);
  });

  it("changes only the tenant it runs in", async () => {
    await revertToOldShape(first);
    await revertToOldShape(second);

    await runCutoverIn(first);

    expectOnePair(await readPair(first));
    expect(await readPair(second)).toEqual([]);
  });

  it.each(["a freshly seeded tenant", "a tenant the cutover upgraded"] as const)(
    "links tasks and health records in both directions, many to many, in %s",
    async (kind) => {
      if (kind === "a tenant the cutover upgraded") {
        await revertToOldShape(first);
        await runCutovers();
      }
      const ids = await databaseIds(first);
      const pair = await readPair(first);
      const recordsTasks = pair.find((property) => property.database === "healthRecords")?.id;
      const tasksRecords = pair.find((property) => property.database === "tasks")?.id;
      if (!recordsTasks || !tasksRecords) throw new Error("Relation pair missing");
      const chokePoint = createChokePoint(runtime);

      const created = await runInTenant(first, async () => {
        const pressure = await chokePoint.createItem({
          databaseId: ids.healthRecords,
          properties: { name: "Blood pressure 150/95" },
        });
        const prevention = await chokePoint.createItem({
          databaseId: ids.healthRecords,
          properties: { name: "Yearly prevention" },
        });
        const checkUp = await chokePoint.createItem({
          databaseId: ids.tasks,
          properties: { name: "Check-up at the doctor", date: "2026-10-30" },
        });
        const measure = await chokePoint.createItem({
          databaseId: ids.tasks,
          properties: { name: "Measure every morning" },
        });
        // One task on two records and one record with two tasks: neither end is capped at one edge.
        for (const [taskId, recordId] of [
          [checkUp.id, pressure.id],
          [checkUp.id, prevention.id],
          [measure.id, pressure.id],
        ] as const) {
          await chokePoint.createRelation({
            relationPropertyId: tasksRecords,
            callerItemId: taskId,
            targetItemId: recordId,
          });
        }
        return { pressure: pressure.id, prevention: prevention.id, checkUp: checkUp.id, measure: measure.id };
      });

      const targets = (itemId: string, relationPropertyId: string) =>
        runInTenant(first, async () => {
          const entries = await chokePoint.listItemRelations(itemId, relationPropertyId);
          if (!entries) throw new Error("Item missing");
          return entries.map((entry) => `${entry.propertyKey}:${entry.targetItemId}`).sort();
        });
      expect(await targets(created.pressure, recordsTasks)).toEqual(
        [`tasks:${created.checkUp}`, `tasks:${created.measure}`].sort(),
      );
      expect(await targets(created.prevention, recordsTasks)).toEqual([`tasks:${created.checkUp}`]);
      expect(await targets(created.checkUp, tasksRecords)).toEqual(
        [`healthRecords:${created.pressure}`, `healthRecords:${created.prevention}`].sort(),
      );
      expect(await targets(created.measure, tasksRecords)).toEqual([`healthRecords:${created.pressure}`]);

      const recordsOfCheckUp = await runInTenant(first, () =>
        chokePoint.queryDatabaseItems(ids.healthRecords, {
          filter: { type: "relation_contains", property: "tasks", value: created.checkUp },
        }),
      );
      expect(recordsOfCheckUp.items.map((item) => item.id).sort()).toEqual(
        [created.pressure, created.prevention].sort(),
      );

      // The other tenant reads none of these edges and answers the foreign record like a missing one.
      const foreign = await runInTenant(second, async () => {
        const edges = await runtime.query<{ id: string }>(
          "SELECT id FROM item_relations WHERE item_a = ANY($1::uuid[]) OR item_b = ANY($1::uuid[])",
          [[created.pressure, created.prevention, created.checkUp, created.measure]],
        );
        return { edges: edges.rows, record: await chokePoint.listItemRelations(created.pressure) };
      });
      expect(foreign).toEqual({ edges: [], record: null });
    },
  );

  it.each([
    ["cs", "Zdravotní záznamy", "Úkoly"],
    ["en", "Health records", "Tasks"],
  ] as const)(
    "projects both properties with their %s labels, many to many, for a new and for an upgraded tenant",
    async (locale, tasksLabel, recordsLabel) => {
      await revertToOldShape(first);
      await runCutovers();
      const registry = await loadFullModuleRegistry();

      for (const tenantId of [first, second]) {
        const ids = await databaseIds(tenantId);
        const schema = await runInTenant(tenantId, () =>
          withTransaction(runtime, (client) => generateSchemaProjection(client, registry, { locale })),
        );
        const property = (databaseKey: string, key: string) =>
          schema.databases.find((database) => database.key === databaseKey)?.properties.find((p) => p.key === key);
        expect(property("tasks", "healthRecords")).toMatchObject({
          type: "relation",
          name: tasksLabel,
          owner: "user",
          locked: false,
          config: { targetDatabaseId: ids.healthRecords, cardinality: "many_to_many" },
        });
        expect(property("healthRecords", "tasks")).toMatchObject({
          type: "relation",
          name: recordsLabel,
          owner: "user",
          locked: false,
          config: { targetDatabaseId: ids.tasks, cardinality: "many_to_many" },
        });
      }
    },
  );

  it.each(["tasks", "healthRecords"] as const)(
    "does nothing and does not fail when the %s database is missing",
    async (missingModuleId) => {
      await revertToOldShape(first);
      // The seed always creates both databases, so a tenant with only one of them is reproduced with raw SQL as the
      // owner: the other one stops being a system database, which `getDatabaseByModuleId` requires.
      const hidden = await admin.query(
        "UPDATE databases SET system = false WHERE tenant_id = $1 AND owner_module_id = $2 AND system",
        [first, missingModuleId],
      );
      expect(hidden.rowCount).toBe(1);
      const before = await snapshotSchema();

      await expect(runCutoverIn(first)).resolves.toBeUndefined();

      expect(await snapshotSchema()).toEqual(before);
    },
  );

  it("does nothing in a tenant that was never seeded", async () => {
    const empty = await createTestTenant(admin);
    const before = await snapshotSchema();

    await expect(runCutoverIn(empty)).resolves.toBeUndefined();

    expect(await snapshotSchema()).toEqual(before);
  });

  it("writes neither property when the second insert fails", async () => {
    await revertToOldShape(first);
    const ids = await databaseIds(first);
    // A `HealthRecords.tasks` property without `Tasks.healthRecords` is a state no seed or cutover leaves behind and
    // the locked schema lets no production write create, so it is inserted with raw SQL, as that tenant.
    const stray = await runInTenant(first, () =>
      runtime.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, 'tasks', NULL, 'text', '{}'::jsonb, false, 'user', NULL)`,
        [ids.healthRecords],
      ),
    );
    expect(stray.rowCount).toBe(1);
    const before = await snapshotSchema();

    // 23505: the unique key `properties (database_id, key)` refuses the second `tasks` property of Health records.
    await expect(runCutoverIn(first)).rejects.toMatchObject({ code: "23505" });

    expect(await snapshotSchema()).toEqual(before);
  });

  it("creates the pair once when two runs of one tenant overlap, and neither fails", async () => {
    await revertToOldShape(first);
    const blocker = await admin.connect();
    let committed = false;
    let runs: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      // SHARE conflicts with the EXCLUSIVE lock the cutover takes and with nothing it does before that, so both
      // runs queue at their LOCK statement, each before its presence check.
      await blocker.query("LOCK TABLE properties IN SHARE MODE");
      runs = Promise.allSettled([runCutoverIn(first), runCutoverIn(first)]);
      await waitForQueuedPropertiesLocks(2);
      await blocker.query("COMMIT");
      committed = true;
    } finally {
      // Destroying the connection aborts a transaction this test left open, which also unblocks the runs.
      blocker.release(!committed);
      await runs;
    }

    expect(await runs).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    expectOnePair(await readPair(first));
  });
});
