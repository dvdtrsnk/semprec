import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { runEventsFilesRelationCutoverMigration } from "../eventsFilesRelationCutoverMigration.js";

let adminPool: Pool;
let dataPool: Pool;

const pairSchema = z.array(
  z.object({
    database: z.string(),
    key: z.string(),
    name: z.string().nullable(),
    owner: z.string(),
    owner_process: z.string().nullable(),
    locked: z.boolean(),
    target: z.string().nullable(),
    side: z.enum(["a", "b"]),
    cardinality: z.string(),
    definition_id: z.string(),
  }),
);
type Pair = z.infer<typeof pairSchema>;

/** The Events.files / Files.events pair of the tenant in scope, side and cardinality from its relation definition. */
async function readPair(tenantId: string): Promise<Pair> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<Record<string, unknown>>(
      `SELECT d.owner_module_id AS database, p.key, p.name, p.owner, p.owner_process, p.locked,
              (SELECT t.owner_module_id FROM databases t WHERE t.id = (p.config->>'targetDatabaseId')::uuid) AS target,
              CASE WHEN r.property_id_a = p.id THEN 'a' ELSE 'b' END AS side, r.cardinality, r.id::text AS definition_id
         FROM properties p
         JOIN databases d ON d.id = p.database_id
         JOIN relation_definitions r ON r.id = (p.config->>'relationDefinitionId')::uuid
        WHERE (d.owner_module_id = 'events' AND p.key = 'files') OR (d.owner_module_id = 'files' AND p.key = 'events')
        ORDER BY d.owner_module_id`,
    );
    return pairSchema.parse(rows);
  });
}

/** Strips the generated definition id so a fresh seed and a cut-over tenant compare by shape. */
function shape(pair: Pair): Omit<Pair[number], "definition_id">[] {
  return pair.map(({ definition_id: _definitionId, ...rest }) => rest);
}

const EXPECTED_SHAPE = [
  {
    database: "events",
    key: "files",
    name: null,
    owner: "user",
    owner_process: null,
    locked: false,
    target: "files",
    side: "a",
    cardinality: "many_to_many",
  },
  {
    database: "files",
    key: "events",
    name: null,
    owner: "user",
    owner_process: null,
    locked: false,
    target: "events",
    side: "b",
    cardinality: "many_to_many",
  },
];

/**
 * Removes the pair from a seeded tenant, reproducing a tenant seeded before issue #1588. The locked
 * Events/Files schemas have no public path that deletes a property, so this is raw SQL on the admin pool.
 */
async function revertToOldShape(tenantId: string): Promise<void> {
  const pair = await readPair(tenantId);
  const definitionId = pair[0]?.definition_id;
  if (!definitionId) throw new Error("Seeded tenant has no Events/Files relation");
  await adminPool.query("DELETE FROM properties WHERE tenant_id = $1 AND config->>'relationDefinitionId' = $2", [
    tenantId,
    definitionId,
  ]);
  await adminPool.query("DELETE FROM relation_definitions WHERE id = $1", [definitionId]);
  expect(await readPair(tenantId)).toEqual([]);
}

async function snapshotSchema(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const table of ["properties", "relation_definitions"]) {
    const { rows } = await adminPool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
    out.push(rows);
  }
  return out;
}

describe("Events.files / Files.events relation (issue #1588)", () => {
  let zero: string;
  let other: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    other = await createTestTenant(adminPool);
    for (const tenantId of [zero, other]) {
      await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
    }
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("a fresh seed has Events.files and Files.events as one user-owned many-to-many pair", async () => {
    const pair = await readPair(zero);
    expect(shape(pair)).toEqual(EXPECTED_SHAPE);
    expect(pair[0]?.definition_id).toBe(pair[1]?.definition_id);
  });

  it("the registered cutover adds the pair to a tenant seeded before it, identical to a fresh seed, and a second run changes nothing", async () => {
    await revertToOldShape(zero);
    const untouchedOther = await readPair(other);

    await runAsSystem("test Events/Files cutover", () => runTenantCutoverMigrations(dataPool));
    const upgraded = await readPair(zero);
    expect(shape(upgraded)).toEqual(EXPECTED_SHAPE);
    expect(upgraded[0]?.definition_id).toBe(upgraded[1]?.definition_id);
    // The tenant that already had the pair keeps exactly the rows it had.
    expect(await readPair(other)).toEqual(untouchedOther);

    const before = await snapshotSchema();
    await runInTenant(zero, () => runEventsFilesRelationCutoverMigration(dataPool));
    await runInTenant(other, () => runEventsFilesRelationCutoverMigration(dataPool));
    expect(await snapshotSchema()).toEqual(before);
  });

  it("a file linked to an event is listed by the event and the event by the file", async () => {
    const chokePoint = createChokePoint(dataPool);
    await runInTenant(zero, async () => {
      const databases = await chokePoint.listDatabases();
      const events = databases.find((db) => db.ownerModuleId === "events");
      const files = databases.find((db) => db.ownerModuleId === "files");
      if (!events || !files) throw new Error("Events or Files database missing");
      const eventsFiles = (await chokePoint.listProperties(events.id)).find((p) => p.key === "files");
      const filesEvents = (await chokePoint.listProperties(files.id)).find((p) => p.key === "events");
      if (!eventsFiles || !filesEvents) throw new Error("Relation pair missing");
      const event = await chokePoint.createItem(
        { databaseId: events.id, properties: { name: "Client meeting", date: "2026-10-16" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      const file = await chokePoint.createItem(
        { databaseId: files.id, properties: { name: "Proposal.pdf" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      await chokePoint.createRelation({
        relationPropertyId: eventsFiles.id,
        callerItemId: event.id,
        targetItemId: file.id,
      });

      const fromEvent = await chokePoint.listItemRelations(event.id, eventsFiles.id);
      const fromFile = await chokePoint.listItemRelations(file.id, filesEvents.id);
      expect(fromEvent?.map((entry) => [entry.propertyKey, entry.targetItemId])).toEqual([["files", file.id]]);
      expect(fromFile?.map((entry) => [entry.propertyKey, entry.targetItemId])).toEqual([["events", event.id]]);
    });
  });

  it.each(["events", "files"])(
    "does nothing and does not fail when the %s database is missing",
    async (missingModuleId) => {
      await revertToOldShape(zero);
      // The seed always creates both databases, so a tenant with only one of them is reproduced on the
      // admin pool: the other one stops being a system database, which `getDatabaseByModuleId` requires.
      const result = await adminPool.query(
        "UPDATE databases SET system = false WHERE tenant_id = $1 AND owner_module_id = $2 AND system",
        [zero, missingModuleId],
      );
      expect(result.rowCount).toBe(1);
      const before = await snapshotSchema();
      await expect(runInTenant(zero, () => runEventsFilesRelationCutoverMigration(dataPool))).resolves.toBeUndefined();
      expect(await snapshotSchema()).toEqual(before);
    },
  );
});
