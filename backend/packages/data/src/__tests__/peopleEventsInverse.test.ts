import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
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
});
