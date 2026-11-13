import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  insertValueLink,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";
import { writerIdentityOf } from "../genericApplicationService.js";

const metadataResolver: CollectionMetadataResolver = {
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

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const FORBIDDEN = { status: 403, code: "forbidden" };
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const SECRET = "Secret diagnosis xyz";

let pool: Pool;
let chokePoint: ChokePoint;
let health: DatabaseRow;
let sleepNights: DatabaseRow;
let tasks: DatabaseRow;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);

/** `/mcp` on the user's own token: no run credential, so no project, and the external-client marker. */
const external = (): AuthenticatedActor => ({ userId, externalClient: true });
/** The same user over REST. */
const rest = (): AuthenticatedActor => ({ userId, restSession: true });
/** An actor of the generic gateway that is neither a REST session nor marked: it is not checked. */
const unmarked = (): AuthenticatedActor => ({ userId });

const newRecord = (name = SECRET) => chokePoint.createItem({ databaseId: health.id, properties: { name } });

async function newUserDatabase(name: string): Promise<DatabaseRow> {
  const database = await chokePoint.createDatabase({ name });
  await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
  return database;
}

/** The refusal of a call, as the error it raised, for a look at what it carries. */
async function refusal(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be refused");
}

describe("an external client on /mcp through the generic operation gateway (issue #1998)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const databases = await inTenantZero(async () => ({
      health: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords")),
      sleepNights: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "sleepNights")),
      tasks: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks")),
    }));
    if (!databases.health || !databases.sleepNights || !databases.tasks) {
      throw new Error("System databases are missing");
    }
    health = databases.health;
    sleepNights = databases.sleepNights;
    tasks = databases.tasks;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("marks the actor's writer only when the actor carries the marker, and never a REST session", () => {
    expect(writerIdentityOf(external())).toEqual({
      writerKind: "agent",
      onBehalfOfUserId: userId,
      externalClient: true,
    });
    expect(writerIdentityOf(unmarked())).toEqual({ writerKind: "agent", onBehalfOfUserId: userId });
    expect(writerIdentityOf(rest())).toEqual({ writerKind: "user" });
  });

  it("answers 403 forbidden to item.get, database.query, view.query and relation.list of a sensitive database, while REST reads the same record", async () => {
    await inTenantZero(async () => {
      const record = await newRecord();
      const view = await chokePoint.createView({ databaseId: health.id, type: "table", name: "All records" });
      const reads = {
        "item.get": (actor: AuthenticatedActor) =>
          gateway().invoke("item.get", actor, ALL_CAPABILITIES, { itemId: record.id }),
        "database.query": (actor: AuthenticatedActor) =>
          gateway().invoke("database.query", actor, ALL_CAPABILITIES, { databaseId: health.id }),
        "view.query": (actor: AuthenticatedActor) =>
          gateway().invoke("view.query", actor, ALL_CAPABILITIES, { viewId: view.id }),
        "relation.list": (actor: AuthenticatedActor) =>
          gateway().invoke("relation.list", actor, ALL_CAPABILITIES, { itemId: record.id }),
      };

      for (const [operation, read] of Object.entries(reads)) {
        await expect(read(external()), operation).rejects.toMatchObject(FORBIDDEN);
        await expect(read(rest()), operation).resolves.toBeDefined();
        await expect(read(unmarked()), operation).resolves.toBeDefined();
      }
      expect((await reads["item.get"](rest())).properties.name).toBe(SECRET);
    });
  });

  it("refuses database.query of the sleep nights database", async () => {
    await inTenantZero(async () => {
      expect(sleepNights.sensitive).toBe(true);
      await expect(
        gateway().invoke("database.query", external(), ALL_CAPABILITIES, { databaseId: sleepNights.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        gateway().invoke("database.query", rest(), ALL_CAPABILITIES, { databaseId: sleepNights.id }),
      ).resolves.toBeDefined();
    });
  });

  it("keeps a non-sensitive system database and a user-created database readable and writable", async () => {
    await inTenantZero(async () => {
      expect(tasks.sensitive).toBe(false);
      const userDatabase = await newUserDatabase("External notes");
      const created = await gateway().invoke("item.create", external(), ALL_CAPABILITIES, {
        databaseId: userDatabase.id,
        properties: { name: "From an external client" },
      });
      expect(created.properties.name).toBe("From an external client");
      expect((await gateway().invoke("item.get", external(), ALL_CAPABILITIES, { itemId: created.id })).id).toBe(
        created.id,
      );
      const queried = await gateway().invoke("database.query", external(), ALL_CAPABILITIES, {
        databaseId: userDatabase.id,
      });
      expect(queried.items.map((item) => item.id)).toContain(created.id);
      expect((await gateway().invoke("database.get", external(), ALL_CAPABILITIES, { databaseId: tasks.id })).id).toBe(
        tasks.id,
      );
      const taskQuery = await gateway().invoke("database.query", external(), ALL_CAPABILITIES, {
        databaseId: tasks.id,
      });
      expect(taskQuery.items).toBeDefined();
    });
  });

  it("refuses database.get of a sensitive database and leaves the sensitive databases out of database.list, while user-created databases are listed", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Listed notes");
      await expect(
        gateway().invoke("database.get", external(), ALL_CAPABILITIES, { databaseId: health.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      expect((await gateway().invoke("database.get", rest(), ALL_CAPABILITIES, { databaseId: health.id })).id).toBe(
        health.id,
      );

      const listed = await gateway().invoke("database.list", external(), ALL_CAPABILITIES, { limit: 200 });
      const ids = listed.items.map((database) => database.id);
      expect(ids).toContain(open.id);
      expect(ids).toContain(tasks.id);
      expect(ids).not.toContain(health.id);
      expect(ids).not.toContain(sleepNights.id);

      const forPerson = await gateway().invoke("database.list", rest(), ALL_CAPABILITIES, { limit: 200 });
      expect(forPerson.items.map((database) => database.id)).toEqual(
        expect.arrayContaining([health.id, sleepNights.id, open.id]),
      );
    });
  });

  it("refuses item.create, item.patch, item.delete and item.restore in a sensitive database and writes nothing", async () => {
    await inTenantZero(async () => {
      const record = await newRecord("Before");
      const trashed = await newRecord("Trashed");
      await chokePoint.softDeleteItem(health.id, trashed.id);
      const countBefore = (await chokePoint.listItems(health.id)).items.length;

      await expect(
        gateway().invoke("item.create", external(), ALL_CAPABILITIES, {
          databaseId: health.id,
          properties: { name: "By an external client" },
        }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        gateway().invoke("item.patch", external(), ALL_CAPABILITIES, {
          itemId: record.id,
          properties: { name: "After" },
          ifVersion: record.updatedAt,
        }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        gateway().invoke("item.delete", external(), ALL_CAPABILITIES, { itemId: record.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        gateway().invoke("item.restore", external(), ALL_CAPABILITIES, { itemId: trashed.id }),
      ).rejects.toMatchObject(FORBIDDEN);

      expect((await chokePoint.listItems(health.id)).items).toHaveLength(countBefore);
      expect((await chokePoint.findItem(record.id))?.properties.name).toBe("Before");
      expect((await chokePoint.findItem(record.id))?.deletedAt).toBeNull();
      expect((await chokePoint.findItemIncludingDeleted(trashed.id))?.deletedAt).not.toBeNull();

      // The same user over REST writes to the sensitive database.
      const patched = await gateway().invoke("item.patch", rest(), ALL_CAPABILITIES, {
        itemId: record.id,
        properties: { name: "After" },
        ifVersion: record.updatedAt,
      });
      expect(patched.properties.name).toBe("After");
    });
  });

  it("refuses a relation to or from a sensitive database for put, set and delete and changes no edge", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Linked notes");
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: open.id,
        key: "record",
        name: "Record",
        targetDatabaseId: health.id,
      });
      const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Note" } });
      const record = await newRecord("Linked record");
      const edge = { relationPropertyId: property.id, callerItemId: note.id, targetItemId: record.id };

      await expect(gateway().invoke("relation.put", external(), ALL_CAPABILITIES, edge)).rejects.toMatchObject(
        FORBIDDEN,
      );
      await expect(gateway().invoke("relation.set", external(), ALL_CAPABILITIES, edge)).rejects.toMatchObject(
        FORBIDDEN,
      );
      expect(await chokePoint.listItemRelations(note.id)).toEqual([]);

      await chokePoint.createRelation(edge);
      await expect(gateway().invoke("relation.delete", external(), ALL_CAPABILITIES, edge)).rejects.toMatchObject(
        FORBIDDEN,
      );
      await expect(
        gateway().invoke("relation.set", external(), ALL_CAPABILITIES, { ...edge, targetItemId: null }),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(await chokePoint.listItemRelations(note.id)).toHaveLength(1);

      await gateway().invoke("relation.delete", rest(), ALL_CAPABILITIES, edge);
      expect(await chokePoint.listItemRelations(note.id)).toEqual([]);
    });
  });

  it("allows a relation between two open databases", async () => {
    await inTenantZero(async () => {
      const [first, second] = [await newUserDatabase("First open"), await newUserDatabase("Second open")];
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: first.id,
        key: "other",
        name: "Other",
        targetDatabaseId: second.id,
      });
      const from = await chokePoint.createItem({ databaseId: first.id, properties: { name: "From" } });
      const to = await chokePoint.createItem({ databaseId: second.id, properties: { name: "To" } });
      await gateway().invoke("relation.put", external(), ALL_CAPABILITIES, {
        relationPropertyId: property.id,
        callerItemId: from.id,
        targetItemId: to.id,
      });
      const listed = await gateway().invoke("relation.list", external(), ALL_CAPABILITIES, { itemId: from.id });
      expect(listed).toMatchObject([{ targetItemId: to.id, targetDatabaseId: second.id }]);
    });
  });

  it("returns a relation target in a sensitive database as an id and nothing else, and lists the edge as hidden", async () => {
    await inTenantZero(async () => {
      const open = await newUserDatabase("Source notes");
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: open.id,
        key: "records",
        name: "Records",
        targetDatabaseId: health.id,
      });
      const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Source" } });
      const record = await newRecord("Hidden title");
      await chokePoint.createRelation({
        relationPropertyId: property.id,
        callerItemId: note.id,
        targetItemId: record.id,
      });

      const read = await gateway().invoke("item.get", external(), ALL_CAPABILITIES, {
        itemId: note.id,
        include: { relations: { records: [] } },
      });
      expect(read.relations?.records).toEqual([{ id: record.id, hidden: true }]);
      const asPerson = await gateway().invoke("item.get", rest(), ALL_CAPABILITIES, {
        itemId: note.id,
        include: { relations: { records: [] } },
      });
      expect(asPerson.relations?.records).toMatchObject([{ id: record.id, title: "Hidden title" }]);

      const listed = await gateway().invoke("relation.list", external(), ALL_CAPABILITIES, { itemId: note.id });
      expect(listed).toEqual([
        { relationPropertyId: property.id, propertyKey: "records", targetItemId: record.id, hidden: true },
      ]);
      expect(JSON.stringify([read, listed])).not.toContain("Hidden title");
    });
  });

  it("leaves a link source in a sensitive database out of include links, and refuses link.unlink and link.relink on an item of one", async () => {
    await inTenantZero(async () => {
      const hiddenSource = await newRecord("Hidden source title");
      const open = await newUserDatabase("Linked values");
      const target = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Target" } });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: target.id,
          propertyKey: "projects",
          ruleKey: "externalClientTest",
          sources: [{ kind: "item", sourceItemId: hiddenSource.id, sourcePropertyKey: "name" }],
        }),
      );
      const read = await gateway().invoke("item.get", external(), ALL_CAPABILITIES, {
        itemId: target.id,
        include: ["links"],
      });
      expect(read.links?.projects?.sources).toEqual([]);
      expect(JSON.stringify(read.links)).not.toContain("Hidden source title");
      const asPerson = await chokePoint.getValueLinksForItems([target.id]);
      expect(asPerson.get(target.id)?.projects?.sources).toHaveLength(1);

      const linked = await newRecord("Linked record");
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: linked.id,
          propertyKey: "name",
          ruleKey: "externalClientTest",
          sources: [{ kind: "item", sourceItemId: target.id, sourcePropertyKey: "name" }],
        }),
      );
      const stateBefore = (await chokePoint.getValueLinksForItems([linked.id])).get(linked.id)?.name;
      expect(stateBefore?.valueKind).toBe("inherited");
      for (const operation of ["link.unlink", "link.relink"] as const) {
        await expect(
          gateway().invoke(operation, external(), ALL_CAPABILITIES, { itemId: linked.id, propertyKey: "name" }),
          operation,
        ).rejects.toMatchObject(FORBIDDEN);
      }
      expect((await chokePoint.getValueLinksForItems([linked.id])).get(linked.id)?.name).toEqual(stateBefore);
      // The same user over REST unlinks the item.
      await gateway().invoke("link.unlink", rest(), ALL_CAPABILITIES, { itemId: linked.id, propertyKey: "name" });
      expect((await chokePoint.getValueLinksForItems([linked.id])).get(linked.id)?.name?.valueKind).toBe(
        "inheritedBroken",
      );
    });
  });

  it("refuses a relation edge whose relation property belongs to a sensitive database although its target is open", async () => {
    await inTenantZero(async () => {
      // `healthRecords.tasks` is a user-owned relation from Health records to Tasks.
      const [property] = await chokePoint.findPropertiesByKey(health.id, "tasks", "relation");
      if (!property) throw new Error("The Health records -> Tasks relation property is missing");
      const record = await newRecord("Needs a follow-up");
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { name: "Follow up" } });
      const edge = { relationPropertyId: property.id, callerItemId: record.id, targetItemId: task.id };

      for (const operation of ["relation.put", "relation.set"] as const) {
        await expect(gateway().invoke(operation, external(), ALL_CAPABILITIES, edge), operation).rejects.toMatchObject(
          FORBIDDEN,
        );
      }
      expect(await chokePoint.listItemRelations(record.id)).toEqual([]);

      await chokePoint.createRelation(edge);
      await expect(gateway().invoke("relation.delete", external(), ALL_CAPABILITIES, edge)).rejects.toMatchObject(
        FORBIDDEN,
      );
      expect(await chokePoint.listItemRelations(record.id)).toHaveLength(1);
      await gateway().invoke("relation.delete", rest(), ALL_CAPABILITIES, edge);
      expect(await chokePoint.listItemRelations(record.id)).toEqual([]);
    });
  });

  it("allows relation.set, relation.delete, link.unlink and link.relink for items of open databases", async () => {
    await inTenantZero(async () => {
      const [first, second] = [await newUserDatabase("Allowed source"), await newUserDatabase("Allowed target")];
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: first.id,
        key: "single",
        name: "Single",
        targetDatabaseId: second.id,
        cardinality: "one_to_one",
      });
      const from = await chokePoint.createItem({ databaseId: first.id, properties: { name: "From" } });
      const [one, two] = [
        await chokePoint.createItem({ databaseId: second.id, properties: { name: "One" } }),
        await chokePoint.createItem({ databaseId: second.id, properties: { name: "Two" } }),
      ];
      const edge = { relationPropertyId: property.id, callerItemId: from.id, targetItemId: one.id };
      await gateway().invoke("relation.set", external(), ALL_CAPABILITIES, edge);
      await gateway().invoke("relation.set", external(), ALL_CAPABILITIES, { ...edge, targetItemId: two.id });
      const targets = (await chokePoint.listItemRelations(from.id)) ?? [];
      expect(targets.map((entry) => entry.targetItemId)).toEqual([two.id]);
      await gateway().invoke("relation.delete", external(), ALL_CAPABILITIES, { ...edge, targetItemId: two.id });
      expect(await chokePoint.listItemRelations(from.id)).toEqual([]);

      const source = await chokePoint.createItem({ databaseId: second.id, properties: { name: "Source" } });
      const linked = await chokePoint.createItem({ databaseId: first.id, properties: { name: "Linked" } });
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: linked.id,
          propertyKey: "name",
          ruleKey: "externalClientTest",
          sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" }],
        }),
      );
      expect((await chokePoint.getValueLinksForItems([linked.id])).get(linked.id)?.name?.valueKind).toBe("inherited");
      await gateway().invoke("link.unlink", external(), ALL_CAPABILITIES, { itemId: linked.id, propertyKey: "name" });
      expect((await chokePoint.getValueLinksForItems([linked.id])).get(linked.id)?.name?.valueKind).toBe(
        "inheritedBroken",
      );
      await gateway().invoke("link.relink", external(), ALL_CAPABILITIES, { itemId: linked.id, propertyKey: "name" });
      expect((await chokePoint.getValueLinksForItems([linked.id])).get(linked.id)?.name?.valueKind).toBe("inherited");
    });
  });

  it("carries no value of the item in the refusal", async () => {
    await inTenantZero(async () => {
      const record = await newRecord(SECRET);
      const calls = [
        () => gateway().invoke("item.get", external(), ALL_CAPABILITIES, { itemId: record.id }),
        () => gateway().invoke("database.query", external(), ALL_CAPABILITIES, { databaseId: health.id }),
        () =>
          gateway().invoke("item.patch", external(), ALL_CAPABILITIES, {
            itemId: record.id,
            properties: { name: "x" },
            ifVersion: record.updatedAt,
          }),
      ];
      for (const call of calls) {
        const error = await refusal(call);
        expect(error).toMatchObject(FORBIDDEN);
        expect(
          JSON.stringify({ message: String(error), details: Reflect.get(Object(error), "details") }),
        ).not.toContain("Secret diagnosis");
      }
    });
  });
});
