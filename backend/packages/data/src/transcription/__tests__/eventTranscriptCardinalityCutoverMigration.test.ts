import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createPool } from "../../db/pool.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { CardinalityViolationError } from "../../errors.js";
import { getTestPool, getTenantZeroId, resetDatabase } from "../../testSupport/testDb.js";
import { runEventTranscriptCardinalityCutoverMigration } from "../eventTranscriptCardinalityCutoverMigration.js";

let adminPool: Pool;
/** Runtime role (semprec_data) pool: every production write and read in this file goes through it, so row-level security applies. */
let dataPool: Pool;
let chokePoint: ChokePoint;

/** Every `item_relations` row of the tenant, in full: a cutover that changes or moves any edge shows up here. */
interface EdgeRow {
  id: string;
  relation_definition_id: string;
  item_a: string;
  item_b: string;
  metadata: Record<string, unknown>;
}

async function seedTenant(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

async function databaseIdFor(tenantId: string, moduleId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
    return rows[0].id;
  });
}

/** A bare item of the module's database; an Event carries the date issue #1663 requires of every Event. */
async function createItemIn(tenantId: string, moduleId: string): Promise<string> {
  const databaseId = await databaseIdFor(tenantId, moduleId);
  const properties = moduleId === "events" ? { date: "2026-10-22" } : {};
  return runInTenant(tenantId, async () => (await chokePoint.createItem({ databaseId, properties })).id);
}

async function eventTranscriptPropertyId(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ id: string }>(
      `SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'events' AND p.key = 'transcript'`,
    );
    if (!rows[0]) throw new Error("Events.transcript was not seeded");
    return rows[0].id;
  });
}

/** Links an Event to a transcript through the production choke point, as the REST relation route does. */
async function linkEventToTranscript(tenantId: string, eventId: string, transcriptId: string): Promise<void> {
  const relationPropertyId = await eventTranscriptPropertyId(tenantId);
  await runInTenant(tenantId, () =>
    chokePoint.createRelation({ relationPropertyId, callerItemId: eventId, targetItemId: transcriptId }),
  );
}

async function eventTranscriptCardinality(tenantId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ cardinality: string }>(
      `SELECT rd.cardinality FROM relation_definitions rd
         JOIN properties p ON p.id = rd.property_id_a
         JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'events' AND p.key = 'transcript'`,
    );
    return rows[0]?.cardinality ?? null;
  });
}

/** The transaction id that last wrote the Events.transcript definition row; unchanged while the row is untouched. */
async function eventTranscriptDefinitionXmin(tenantId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ xmin: string }>(
      `SELECT rd.xmin::text AS xmin FROM relation_definitions rd
         JOIN properties p ON p.id = rd.property_id_a
         JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'events' AND p.key = 'transcript'`,
    );
    return rows[0]?.xmin ?? null;
  });
}

async function edgeSnapshot(tenantId: string): Promise<EdgeRow[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<EdgeRow>(
      `SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations ORDER BY id`,
    );
    return rows;
  });
}

/**
 * Sets the tenant's Events.transcript back to one_to_one, the shape every install seeded before
 * issue #1464 has. Direct SQL is the fixture: the seed now declares one_to_many, and no public
 * writer changes the cardinality of a schema-locked relation.
 */
async function setEventTranscriptOneToOne(tenantId: string): Promise<void> {
  await adminPool.query(
    `UPDATE relation_definitions SET cardinality = 'one_to_one'
      WHERE tenant_id = $1 AND id IN (
        SELECT rd.id FROM relation_definitions rd
          JOIN properties p ON p.id = rd.property_id_a
          JOIN databases d ON d.id = p.database_id
         WHERE d.owner_module_id = 'events' AND p.key = 'transcript' AND d.tenant_id = $1)`,
    [tenantId],
  );
}

describe("Events.transcript allows several transcripts per Event (issue #1464)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("a fresh install declares Events.transcript as one_to_many", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);

    expect(await eventTranscriptCardinality(zero)).toBe("one_to_many");
  });

  it("a populated tenant refuses a second transcript for an Event until the cutover runs, then accepts it and keeps every existing edge", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    await setEventTranscriptOneToOne(zero);
    const event = await createItemIn(zero, "events");
    const first = await createItemIn(zero, "transcripts");
    const second = await createItemIn(zero, "transcripts");
    await linkEventToTranscript(zero, event, first);
    const before = await edgeSnapshot(zero);

    await expect(linkEventToTranscript(zero, event, second)).rejects.toBeInstanceOf(CardinalityViolationError);
    expect(await edgeSnapshot(zero)).toEqual(before);

    await runInTenant(zero, () => runEventTranscriptCardinalityCutoverMigration(dataPool));

    expect(await eventTranscriptCardinality(zero)).toBe("one_to_many");
    expect(await edgeSnapshot(zero)).toEqual(before);
    await linkEventToTranscript(zero, event, second);
    expect(await edgeSnapshot(zero)).toHaveLength(before.length + 1);
    expect(await edgeSnapshot(zero)).toEqual(expect.arrayContaining(before));
  });

  it("running the cutover again changes no row: the definition keeps its transaction id and no edge moves", async () => {
    const zero = getTenantZeroId();
    await seedTenant(zero);
    await setEventTranscriptOneToOne(zero);
    const event = await createItemIn(zero, "events");
    const transcript = await createItemIn(zero, "transcripts");
    await linkEventToTranscript(zero, event, transcript);

    await runInTenant(zero, () => runEventTranscriptCardinalityCutoverMigration(dataPool));
    const afterFirstRun = await edgeSnapshot(zero);
    const definitionXmin = await eventTranscriptDefinitionXmin(zero);

    await runInTenant(zero, () => runEventTranscriptCardinalityCutoverMigration(dataPool));

    expect(await eventTranscriptCardinality(zero)).toBe("one_to_many");
    expect(await eventTranscriptDefinitionXmin(zero)).toBe(definitionXmin);
    expect(await edgeSnapshot(zero)).toEqual(afterFirstRun);
  });

  it("does nothing in a tenant without an Events database", async () => {
    // beforeEach leaves tenant zero unseeded, so it has no Events database.
    const zero = getTenantZeroId();

    await expect(
      runInTenant(zero, () => runEventTranscriptCardinalityCutoverMigration(dataPool)),
    ).resolves.toBeUndefined();

    const databaseCount = await runInTenant(zero, async () => {
      const { rows } = await dataPool.query<{ count: string }>("SELECT count(*) AS count FROM databases");
      return Number(rows[0]?.count);
    });
    expect(databaseCount).toBe(0);
  });
});
