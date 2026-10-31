import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { CardinalityViolationError } from "../../errors.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function propertyIdFor(databaseId: string, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
    databaseId,
    key,
  ]);
  if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
  return rows[0].id;
}

/** Issue #1470: project, company and people relations on Transcripts, on a fresh install. */
describe("Transcript project, company and people relations (issue #1470)", () => {
  let chokePoint: ChokePoint;
  let ids: Record<"transcripts" | "projects" | "companies" | "people" | "events", string>;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    chokePoint = createChokePoint(pool);
    ids = {
      transcripts: await databaseIdFor("transcripts"),
      projects: await databaseIdFor("projects"),
      companies: await databaseIdFor("companies"),
      people: await databaseIdFor("people"),
      events: await databaseIdFor("events"),
    };
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createItem(databaseId: string) {
    return chokePoint.createItem({ databaseId, properties: {} });
  }

  it("a fresh install has the three relations and their inverses", async () => {
    for (const [database, key] of [
      ["transcripts", "project"],
      ["projects", "transcripts"],
      ["transcripts", "company"],
      ["companies", "transcripts"],
      ["transcripts", "people"],
      ["people", "transcripts"],
    ] as const) {
      const { rows } = await pool.query<{ type: string; owner: string }>(
        "SELECT type, owner FROM properties WHERE database_id = $1 AND key = $2",
        [ids[database], key],
      );
      expect(rows[0], `${database}.${key}`).toEqual({ type: "relation", owner: "user" });
    }
  });

  it("refuses a second company for one transcript with cardinality_violation", async () => {
    const companyProperty = await propertyIdFor(ids.transcripts, "company");
    const transcript = await createItem(ids.transcripts);
    const first = await createItem(ids.companies);
    const second = await createItem(ids.companies);
    await chokePoint.createRelation({
      relationPropertyId: companyProperty,
      callerItemId: transcript.id,
      targetItemId: first.id,
    });

    await expect(
      chokePoint.createRelation({
        relationPropertyId: companyProperty,
        callerItemId: transcript.id,
        targetItemId: second.id,
      }),
    ).rejects.toBeInstanceOf(CardinalityViolationError);
  });

  it("refuses a second project for one transcript with cardinality_violation", async () => {
    const projectProperty = await propertyIdFor(ids.transcripts, "project");
    const transcript = await createItem(ids.transcripts);
    const first = await createItem(ids.projects);
    const second = await createItem(ids.projects);
    await chokePoint.createRelation({
      relationPropertyId: projectProperty,
      callerItemId: transcript.id,
      targetItemId: first.id,
    });

    await expect(
      chokePoint.createRelation({
        relationPropertyId: projectProperty,
        callerItemId: transcript.id,
        targetItemId: second.id,
      }),
    ).rejects.toBeInstanceOf(CardinalityViolationError);
  });

  it("accepts several transcripts for one Event: the parts of one meeting (issue #1464)", async () => {
    const eventTranscriptProperty = await propertyIdFor(ids.events, "transcript");
    const event = await createItem(ids.events);
    const firstPart = await createItem(ids.transcripts);
    const secondPart = await createItem(ids.transcripts);
    for (const part of [firstPart, secondPart]) {
      await chokePoint.createRelation({
        relationPropertyId: eventTranscriptProperty,
        callerItemId: event.id,
        targetItemId: part.id,
      });
    }

    const { rows } = await pool.query<{ item_b: string }>(
      `SELECT r.item_b FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE d.property_id_a = $1 AND r.item_a = $2`,
      [eventTranscriptProperty, event.id],
    );
    expect(rows.map((row) => row.item_b).sort()).toEqual([firstPart.id, secondPart.id].sort());
  });

  it("refuses a second Event for one transcript with cardinality_violation (issue #1464)", async () => {
    const eventTranscriptProperty = await propertyIdFor(ids.events, "transcript");
    const transcript = await createItem(ids.transcripts);
    const first = await createItem(ids.events);
    const second = await createItem(ids.events);
    await chokePoint.createRelation({
      relationPropertyId: eventTranscriptProperty,
      callerItemId: first.id,
      targetItemId: transcript.id,
    });

    await expect(
      chokePoint.createRelation({
        relationPropertyId: eventTranscriptProperty,
        callerItemId: second.id,
        targetItemId: transcript.id,
      }),
    ).rejects.toBeInstanceOf(CardinalityViolationError);

    const { rows } = await pool.query<{ item_a: string }>(
      `SELECT r.item_a FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE d.property_id_a = $1 AND r.item_b = $2`,
      [eventTranscriptProperty, transcript.id],
    );
    expect(rows.map((row) => row.item_a)).toEqual([first.id]);
  });

  it("accepts several people and shows them from both sides", async () => {
    const peopleProperty = await propertyIdFor(ids.transcripts, "people");
    const inverseProperty = await propertyIdFor(ids.people, "transcripts");
    const transcript = await createItem(ids.transcripts);
    const alice = await createItem(ids.people);
    const bob = await createItem(ids.people);
    for (const person of [alice, bob]) {
      await chokePoint.createRelation({
        relationPropertyId: peopleProperty,
        callerItemId: transcript.id,
        targetItemId: person.id,
      });
    }

    const { rows: fromTranscript } = await pool.query<{ item_b: string }>(
      `SELECT r.item_b FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE d.property_id_a = $1 AND r.item_a = $2`,
      [peopleProperty, transcript.id],
    );
    expect(fromTranscript.map((row) => row.item_b).sort()).toEqual([alice.id, bob.id].sort());

    // From the People side the inverse property resolves to the same transcript.
    const { rows: fromPerson } = await pool.query<{ item_a: string }>(
      `SELECT r.item_a FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE d.property_id_b = $1 AND r.item_b = $2`,
      [inverseProperty, alice.id],
    );
    expect(fromPerson.map((row) => row.item_a)).toEqual([transcript.id]);
  });
});
