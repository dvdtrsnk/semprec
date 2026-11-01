import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId } from "../testSupport/tenantFixtures.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";
import type { PropertyRow } from "../types.js";

let pool: Pool;
let chokePoint: ChokePoint;

function requireProperty(properties: PropertyRow[], key: string): PropertyRow {
  const property = properties.find((candidate) => candidate.key === key);
  if (!property) throw new Error(`expected a property with key ${key}`);
  return property;
}

describe("choke-point listItemRelations (issue #1404)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Tasks and People joined by a paired `assignedTo` / `assignedTasks` relation. */
  async function makePairedRelation() {
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    const people = await chokePoint.createDatabase({ name: "People" });
    const { property: assignedTo } = await chokePoint.createRelationProperty({
      sourceDatabaseId: tasks.id,
      key: "assignedTo",
      name: "Assigned To",
      targetDatabaseId: people.id,
      inverse: { key: "assignedTasks", name: "Assigned Tasks" },
    });
    const assignedTasks = requireProperty(await chokePoint.listProperties(people.id), "assignedTasks");
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    const person = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    return { tasks, people, assignedTo, assignedTasks, task, person };
  }

  it("reads one or many nonempty relation sets with a fixed number of production queries", async () => {
    const { tasks, people, task, person } = await makePairedRelation();
    const singleDatabase = await chokePoint.createDatabase({ name: "Single relation" });
    const { property: only } = await chokePoint.createRelationProperty({
      sourceDatabaseId: singleDatabase.id,
      key: "only",
      name: "Only",
      targetDatabaseId: people.id,
    });
    const single = await chokePoint.createItem({ databaseId: singleDatabase.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: only.id,
      callerItemId: single.id,
      targetItemId: person.id,
    });
    const expected = [];
    for (let i = 0; i < 5; i += 1) {
      const key = `group${i}`;
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: tasks.id,
        key,
        name: key,
        targetDatabaseId: people.id,
      });
      const target = await chokePoint.createItem({ databaseId: people.id, properties: {} });
      await chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: task.id,
        targetItemId: target.id,
      });
      expected.push({
        relationPropertyId: property.id,
        propertyKey: key,
        targetItemId: target.id,
        targetDatabaseId: people.id,
        metadata: {},
      });
    }
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const wrapped = new Map<PoolClient, PoolClient["query"]>();
    let selects = 0;
    const instrument = (client: PoolClient) => {
      if (wrapped.has(client)) return;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      wrapped.set(client, client.query);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          if (
            typeof args[0] === "string" &&
            !/^\s*(?:BEGIN|COMMIT|ROLLBACK|RESET)\b/i.test(args[0]) &&
            !/set_config\('app\.tenant_id'/i.test(args[0])
          )
            selects += 1;
          return Reflect.apply(target, receiver, args);
        },
      });
    };
    runtime.on("acquire", instrument);
    try {
      const cp = createChokePoint(runtime);
      const one = await runInTenant(getTenantZeroId(), () => cp.listItemRelations(single.id));
      const oneCount = selects;
      selects = 0;
      const many = await runInTenant(getTenantZeroId(), () => cp.listItemRelations(task.id));
      expect(one).toEqual([
        {
          relationPropertyId: only.id,
          propertyKey: "only",
          targetItemId: person.id,
          targetDatabaseId: people.id,
          metadata: {},
        },
      ]);
      expect(many).toEqual(expected);
      expect(oneCount).toBe(7);
      expect(selects).toBe(oneCount);
    } finally {
      runtime.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
      await runtime.end();
    }
  });

  it("lists a one-directional edge from its source side only, with the target and its database", async () => {
    const files = await chokePoint.createDatabase({ name: "Files" });
    const areas = await chokePoint.createDatabase({ name: "Areas" });
    const { property: area } = await chokePoint.createRelationProperty({
      sourceDatabaseId: files.id,
      key: "area",
      name: "Area",
      targetDatabaseId: areas.id,
    });
    const file = await chokePoint.createItem({ databaseId: files.id, properties: {} });
    const areaItem = await chokePoint.createItem({ databaseId: areas.id, properties: {} });
    await chokePoint.createRelation({ relationPropertyId: area.id, callerItemId: file.id, targetItemId: areaItem.id });

    expect(await chokePoint.listItemRelations(file.id)).toEqual([
      {
        relationPropertyId: area.id,
        propertyKey: "area",
        targetItemId: areaItem.id,
        targetDatabaseId: areas.id,
        metadata: {},
      },
    ]);
    // The Areas database has no property for this edge, so the target side reads nothing.
    expect(await chokePoint.listItemRelations(areaItem.id)).toEqual([]);
  });

  it("reports a paired edge from each end under that end's own property", async () => {
    const { tasks, people, assignedTo, assignedTasks, task, person } = await makePairedRelation();
    await chokePoint.createRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
      metadata: { role: "owner" },
    });

    expect(await chokePoint.listItemRelations(task.id)).toEqual([
      {
        relationPropertyId: assignedTo.id,
        propertyKey: "assignedTo",
        targetItemId: person.id,
        targetDatabaseId: people.id,
        metadata: { role: "owner" },
      },
    ]);
    expect(await chokePoint.listItemRelations(task.id.toUpperCase(), assignedTo.id.toUpperCase())).toEqual([
      {
        relationPropertyId: assignedTo.id,
        propertyKey: "assignedTo",
        targetItemId: person.id,
        targetDatabaseId: people.id,
        metadata: { role: "owner" },
      },
    ]);
    expect(await chokePoint.listItemRelations(person.id)).toEqual([
      {
        relationPropertyId: assignedTasks.id,
        propertyKey: "assignedTasks",
        targetItemId: task.id,
        targetDatabaseId: tasks.id,
        metadata: { role: "owner" },
      },
    ]);
  });

  it("omits an edge whose target item is in the trash, and answers null for a trashed caller", async () => {
    const { people, assignedTo, task, person } = await makePairedRelation();
    await chokePoint.createRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
    });

    await chokePoint.softDeleteItem(people.id, person.id);

    expect(await chokePoint.listItemRelations(task.id)).toEqual([]);
    expect(await chokePoint.listItemRelations(person.id)).toBeNull();
  });

  it("omits an edge whose target database is archived", async () => {
    const { people, assignedTo, task, person } = await makePairedRelation();
    await chokePoint.createRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
    });
    expect(await chokePoint.listItemRelations(task.id)).toHaveLength(1);

    await chokePoint.archiveDatabase(people.id);

    expect(await chokePoint.listItemRelations(task.id)).toEqual([]);
  });

  it("narrows to one property, and rejects a property of another database or a non-relation one", async () => {
    const { tasks, people, assignedTo, assignedTasks, task, person } = await makePairedRelation();
    const { property: watchers } = await chokePoint.createRelationProperty({
      sourceDatabaseId: tasks.id,
      key: "watchers",
      name: "Watchers",
      targetDatabaseId: people.id,
    });
    const observer = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
    });
    await chokePoint.createRelation({
      relationPropertyId: watchers.id,
      callerItemId: task.id,
      targetItemId: observer.id,
    });
    const notes = await chokePoint.createProperty({ databaseId: tasks.id, key: "notes", name: "Notes", type: "text" });

    const narrowed = await chokePoint.listItemRelations(task.id, watchers.id);
    expect(narrowed?.map((entry) => [entry.propertyKey, entry.targetItemId])).toEqual([["watchers", observer.id]]);
    // A uuid-typed id matches whatever its case, as it does in the database.
    expect(await chokePoint.listItemRelations(task.id, watchers.id.toUpperCase())).toEqual(narrowed);

    // `assignedTasks` belongs to People, not to the caller's Tasks database.
    await expect(chokePoint.listItemRelations(task.id, assignedTasks.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(chokePoint.listItemRelations(task.id, assignedTasks.id)).rejects.toMatchObject({
      details: { field: "relationPropertyId" },
    });
    // A text property of the caller's own database is not a relation property.
    await expect(chokePoint.listItemRelations(task.id, notes.id)).rejects.toMatchObject({
      details: { field: "relationPropertyId" },
    });
  });

  it("orders the entries by property key, then by target id", async () => {
    const { tasks, people, assignedTo, task } = await makePairedRelation();
    const { property: watchers } = await chokePoint.createRelationProperty({
      sourceDatabaseId: tasks.id,
      key: "watchers",
      name: "Watchers",
      targetDatabaseId: people.id,
    });
    const first = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    const second = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    const observer = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    for (const person of [first, second]) {
      await chokePoint.createRelation({
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
    }
    await chokePoint.createRelation({
      relationPropertyId: watchers.id,
      callerItemId: task.id,
      targetItemId: observer.id,
    });

    const entries = await chokePoint.listItemRelations(task.id);
    const targetsOfAssignedTo = [first.id, second.id].sort();
    expect(entries?.map((entry) => [entry.propertyKey, entry.targetItemId])).toEqual([
      ...targetsOfAssignedTo.map((id) => ["assignedTo", id]),
      ["watchers", observer.id],
    ]);
  });

  it("lists nothing for an item whose database has no relation property", async () => {
    const notes = await chokePoint.createDatabase({ name: "Notes" });
    const note = await chokePoint.createItem({ databaseId: notes.id, properties: {} });

    expect(await chokePoint.listItemRelations(note.id)).toEqual([]);
  });

  it("lists nothing for a person who has the assigned-tasks property but no edge on it", async () => {
    const { person } = await makePairedRelation();

    expect(await chokePoint.listItemRelations(person.id)).toEqual([]);
  });

  it("reports a self-relation's two directions under their own properties, never under the other one's", async () => {
    const people = await chokePoint.createDatabase({ name: "People" });
    const { property: mentors } = await chokePoint.createRelationProperty({
      sourceDatabaseId: people.id,
      key: "mentors",
      name: "Mentors",
      targetDatabaseId: people.id,
      inverse: { key: "mentoredBy", name: "Mentored By" },
    });
    const mentoredBy = requireProperty(await chokePoint.listProperties(people.id), "mentoredBy");
    const ada = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    const grace = await chokePoint.createItem({ databaseId: people.id, properties: {} });
    await chokePoint.createRelation({ relationPropertyId: mentors.id, callerItemId: ada.id, targetItemId: grace.id });

    expect(await chokePoint.listItemRelations(ada.id)).toEqual([
      {
        relationPropertyId: mentors.id,
        propertyKey: "mentors",
        targetItemId: grace.id,
        targetDatabaseId: people.id,
        metadata: {},
      },
    ]);
    expect(await chokePoint.listItemRelations(grace.id)).toEqual([
      {
        relationPropertyId: mentoredBy.id,
        propertyKey: "mentoredBy",
        targetItemId: ada.id,
        targetDatabaseId: people.id,
        metadata: {},
      },
    ]);
  });

  it("treats a relation property whose definition is gone as having no edges", async () => {
    const files = await chokePoint.createDatabase({ name: "Files" });
    const areas = await chokePoint.createDatabase({ name: "Areas" });
    const { property: area } = await chokePoint.createRelationProperty({
      sourceDatabaseId: files.id,
      key: "area",
      name: "Area",
      targetDatabaseId: areas.id,
    });
    const file = await chokePoint.createItem({ databaseId: files.id, properties: {} });
    const areaItem = await chokePoint.createItem({ databaseId: areas.id, properties: {} });
    await chokePoint.createRelation({ relationPropertyId: area.id, callerItemId: file.id, targetItemId: areaItem.id });

    // Raw SQL, because no choke-point write can remove a definition under a live relation property.
    // The edges cascade with the definition.
    const definitionId = area.config.relationDefinitionId;
    if (typeof definitionId !== "string") throw new Error("expected the relation property to name its definition");
    await pool.query("DELETE FROM relation_definitions WHERE id = $1", [definitionId]);

    expect(await chokePoint.listItemRelations(file.id)).toEqual([]);
  });

  it("answers null for an unknown item", async () => {
    expect(await chokePoint.listItemRelations(randomUUID())).toBeNull();
  });
});
