import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { runPeopleEventsInverseCutoverMigration } from "../calendar/peopleEventsInverseCutoverMigration.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;

interface RelationShape {
  sideA: string;
  sideB: string | null;
  cardinality: string;
  properties: Array<{
    module: string;
    key: string;
    type: string;
    name: string | null;
    owner: string;
    owner_process: string | null;
    locked: boolean;
    target: string | null;
    pointsAtDefinition: boolean;
  }>;
}

/** The `Events.people` definition and both of its properties, read in the tenant's own scope. */
async function relationShape(tenant: string): Promise<RelationShape> {
  return runInTenant(tenant, async () => {
    const { rows: definitions } = await pool.query<{
      id: string;
      side_a: string;
      side_b: string | null;
      cardinality: string;
    }>(
      `SELECT r.id, a.key AS side_a, b.key AS side_b, r.cardinality
       FROM relation_definitions r
       JOIN properties a ON a.id = r.property_id_a
       JOIN databases d ON d.id = a.database_id
       LEFT JOIN properties b ON b.id = r.property_id_b
       WHERE d.owner_module_id = 'events' AND a.key = 'people'`,
    );
    expect(definitions).toHaveLength(1);
    const definition = definitions[0]!;
    const { rows: properties } = await pool.query<RelationShape["properties"][number]>(
      `SELECT d.owner_module_id AS module, p.key, p.type, p.name, p.owner, p.owner_process, p.locked,
              target.owner_module_id AS target, (p.config->>'relationDefinitionId') = $1 AS "pointsAtDefinition"
       FROM properties p
       JOIN databases d ON d.id = p.database_id
       LEFT JOIN databases target ON target.id::text = p.config->>'targetDatabaseId'
       WHERE (d.owner_module_id = 'events' AND p.key = 'people') OR (d.owner_module_id = 'people' AND p.key = 'events')
       ORDER BY module, p.key`,
      [definition.id],
    );
    return {
      sideA: definition.side_a,
      sideB: definition.side_b,
      cardinality: definition.cardinality,
      properties,
    };
  });
}

async function databaseIds(tenant: string): Promise<{ events: string; people: string }> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE system AND owner_module_id IN ('events', 'people')",
    );
    const byModule = new Map(rows.map((row) => [row.owner_module_id, row.id]));
    const events = byModule.get("events");
    const people = byModule.get("people");
    if (!events || !people) throw new Error("Events or People not seeded");
    return { events, people };
  });
}

/** Creates a person and an Event that lists them as a participant, through the choke point. */
async function eventWithParticipant(tenant: string): Promise<{ eventId: string; personId: string }> {
  const ids = await databaseIds(tenant);
  return runInTenant(tenant, async () => {
    const cp = createChokePoint(pool);
    const person = await cp.createItem({ databaseId: ids.people, properties: { name: "Jana" } });
    const event = await cp.createItem({ databaseId: ids.events, properties: { name: "Review", date: "2026-10-16" } });
    const participants = (await cp.listProperties(ids.events)).find((property) => property.key === "people");
    if (!participants) throw new Error("Events.people missing");
    await cp.createRelation({ relationPropertyId: participants.id, callerItemId: event.id, targetItemId: person.id });
    return { eventId: event.id, personId: person.id };
  });
}

/** The Events a person's own `events` relation returns. */
async function eventsOfPerson(tenant: string, personId: string): Promise<string[]> {
  const ids = await databaseIds(tenant);
  return runInTenant(tenant, async () => {
    const cp = createChokePoint(pool);
    const inverse = (await cp.listProperties(ids.people)).find((property) => property.key === "events");
    if (!inverse) throw new Error("People.events missing");
    const entries = await cp.listItemRelations(personId, inverse.id);
    return (entries ?? []).map((entry) => entry.targetItemId);
  });
}

async function edgeRows(tenant: string): Promise<unknown[]> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ edge: unknown }>(
      `SELECT to_jsonb(e) - 'created_at' AS edge FROM item_relations e
       WHERE relation_definition_id IN (
         SELECT r.id FROM relation_definitions r JOIN properties a ON a.id = r.property_id_a
         JOIN databases d ON d.id = a.database_id WHERE d.owner_module_id = 'events' AND a.key = 'people')
       ORDER BY e.item_a, e.item_b`,
    );
    return rows;
  });
}

async function schemaSnapshot(tenant: string): Promise<unknown[]> {
  return runInTenant(tenant, async () => {
    const out: unknown[] = [];
    for (const table of ["properties", "relation_definitions", "item_relations"]) {
      // `table` is one of the three literals above, never input.
      const { rows } = await pool.query<{ row: unknown }>(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY t::text`);
      out.push(rows);
    }
    return out;
  });
}

/**
 * Reverts a seeded tenant to the shape before issue #1664: `Events.people` without an inverse. Synthetic historical
 * schema: the People and Events schemas are locked, and no production writer removes a relation's inverse.
 */
async function revertToPreviousSeed(tenant: string): Promise<void> {
  await runInTenant(tenant, async () => {
    const cleared = await pool.query(
      `UPDATE relation_definitions SET property_id_b = NULL
       WHERE property_id_a = (SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
                              WHERE d.owner_module_id = 'events' AND p.key = 'people')`,
    );
    expect(cleared.rowCount).toBe(1);
    const removed = await pool.query(
      `DELETE FROM properties p USING databases d
       WHERE p.database_id = d.id AND d.owner_module_id = 'people' AND p.key = 'events'`,
    );
    expect(removed.rowCount).toBe(1);
  });
}

describe("People.events, the inverse of Events.people (issue #1664)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => resetDatabase(admin));
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("a freshly seeded tenant has People.events as the inverse of Events.people", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    expect(await relationShape(tenant)).toEqual({
      sideA: "people",
      sideB: "events",
      cardinality: "many_to_many",
      properties: [
        {
          module: "events",
          key: "people",
          type: "relation",
          name: null,
          owner: "user",
          owner_process: null,
          locked: false,
          target: "people",
          pointsAtDefinition: true,
        },
        {
          module: "people",
          key: "events",
          type: "relation",
          name: null,
          owner: "user",
          owner_process: null,
          locked: false,
          target: "events",
          pointsAtDefinition: true,
        },
      ],
    });
  });

  it("a person's events relation returns the Event that lists them, in a fresh tenant", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const { eventId, personId } = await eventWithParticipant(tenant);
    expect(await eventsOfPerson(tenant, personId)).toEqual([eventId]);
  });

  it("the cutover gives existing participant edges a readable inverse equal to the fresh seed, then changes nothing", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const fresh = await relationShape(tenant);
    const { eventId, personId } = await eventWithParticipant(tenant);
    const edges = await edgeRows(tenant);
    expect(edges).toHaveLength(1);
    await revertToPreviousSeed(tenant);
    expect((await relationShape(tenant)).sideB).toBeNull();

    // Another tenant without any database: the cutover must skip it, not fail the run.
    const empty = await createTestTenant(admin);
    await runAsSystem("test:people-events-cutover", () => runTenantCutoverMigrations(pool));

    expect(await relationShape(tenant)).toEqual(fresh);
    expect(await edgeRows(tenant)).toEqual(edges);
    expect(await eventsOfPerson(tenant, personId)).toEqual([eventId]);
    const emptyProperties = await runInTenant(
      empty,
      async () => (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM properties")).rows,
    );
    expect(emptyProperties).toEqual([{ count: 0 }]);

    const before = await schemaSnapshot(tenant);
    await runAsSystem("test:people-events-cutover", () => runTenantCutoverMigrations(pool));
    expect(await schemaSnapshot(tenant)).toEqual(before);
  });

  it("skips a tenant without an Events database without failing", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => runPeopleEventsInverseCutoverMigration(pool));
    const rows = await runInTenant(
      tenant,
      async () =>
        (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM properties WHERE key = 'events'"))
          .rows,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("refuses a People.events property that is not the inverse of Events.people and changes nothing", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    // Synthetic conflicting schema: only the definition is detached, so People.events stays as an unlinked property.
    await runInTenant(tenant, async () => {
      const cleared = await pool.query(
        `UPDATE relation_definitions SET property_id_b = NULL
         WHERE property_id_a = (SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
                                WHERE d.owner_module_id = 'events' AND p.key = 'people')`,
      );
      expect(cleared.rowCount).toBe(1);
    });
    const before = await schemaSnapshot(tenant);
    await expect(runInTenant(tenant, () => runPeopleEventsInverseCutoverMigration(pool))).rejects.toThrow(
      "People.events exists but is not the inverse of Events.people",
    );
    expect(await schemaSnapshot(tenant)).toEqual(before);
  });

  it("refuses an Events.people definition whose inverse is another property and changes nothing", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    await revertToPreviousSeed(tenant);
    // Synthetic conflicting schema: the definition points at a different People property than `events`.
    await runInTenant(tenant, async () => {
      const pointed = await pool.query(
        `UPDATE relation_definitions SET property_id_b = (
           SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
           WHERE d.owner_module_id = 'people' AND p.key = 'name')
         WHERE property_id_a = (SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
                                WHERE d.owner_module_id = 'events' AND p.key = 'people')`,
      );
      expect(pointed.rowCount).toBe(1);
    });
    const before = await schemaSnapshot(tenant);
    await expect(runInTenant(tenant, () => runPeopleEventsInverseCutoverMigration(pool))).rejects.toThrow(
      "Events.people already has another inverse property",
    );
    expect(await schemaSnapshot(tenant)).toEqual(before);
  });

  it("does nothing for a tenant whose Events database has no people relation", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    // Synthetic schema without the relation at all: deleting the property cascades to its definition, and the
    // now unlinked People.events property is deleted next.
    await runInTenant(tenant, async () => {
      const removed = await pool.query(
        `DELETE FROM properties p USING databases d
         WHERE p.database_id = d.id AND d.owner_module_id = 'events' AND p.key = 'people'`,
      );
      expect(removed.rowCount).toBe(1);
      await pool.query(
        `DELETE FROM properties p USING databases d
         WHERE p.database_id = d.id AND d.owner_module_id = 'people' AND p.key = 'events'`,
      );
    });
    const before = await schemaSnapshot(tenant);
    await runInTenant(tenant, () => runPeopleEventsInverseCutoverMigration(pool));
    expect(await schemaSnapshot(tenant)).toEqual(before);
  });
});
