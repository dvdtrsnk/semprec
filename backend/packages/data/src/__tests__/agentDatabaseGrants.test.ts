import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { assertAgentDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { removeAgentDatabaseGrant, setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { getAccess, type AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  assertRelationCreatableWithClient,
  assertRelationTargetLinkableWithClient,
  createRelationIfAbsentWithClient,
} from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID, PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow } from "../types.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };
const FAR_FUTURE_CUTOFF_MS = 60_000;

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let tenantId: string;
let health: DatabaseRow;
let tasks: DatabaseRow;
let projectsDatabase: DatabaseRow;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantId, fn);
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(dataPool, fn));
}

/** An agent run's writer: the identity `writerIdentityOf` derives for a run credential. */
function agent(projectItemId: string): WriterIdentity {
  return { writerKind: "agent", agentRunId: randomUUID(), agentProjectItemId: projectItemId };
}

function setGrant(projectItemId: string, databaseId: string, access: AgentDatabaseAccess) {
  return inTransaction((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access }));
}

function newProject(): Promise<string> {
  return inTenant(() => createTestProjectItem(dataPool));
}

/** A user-created database with a title and a text property. */
async function newUserDatabase(name = "Notes"): Promise<DatabaseRow> {
  return inTenant(async () => {
    const database = await cp.createDatabase({ name });
    await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    await cp.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
    return database;
  });
}

function newHealthRecord(name = "Private diagnosis"): Promise<ItemRow> {
  return inTenant(() => cp.createItem({ databaseId: health.id, properties: { name } }));
}

async function systemDatabase(moduleId: string): Promise<DatabaseRow> {
  const database = await inTransaction((client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`System database ${moduleId} is missing`);
  return database;
}

function check(projectItemId: string, databaseId: string, access: "read" | "write", client?: PoolClient) {
  const run = (c: PoolClient) =>
    assertAgentDatabaseAccess(c, { agentProjectItemId: projectItemId, databaseId, access });
  return client ? run(client) : inTransaction(run);
}

const expandedItemSchema = z.object({ relations: z.record(z.string(), z.array(z.unknown())) });

/** The expanded relation targets of an item read made with an expansion; the facade types its result as a plain row. */
function relationsOf(item: ItemRow | null | undefined): Record<string, unknown[]> {
  return expandedItemSchema.parse(item).relations;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("per-database agent grants (issue #1810)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await inTenant(() => seedSystem(dataPool, createViewTypeRegistry()));
    cp = createChokePoint(dataPool);
    health = await systemDatabase(HEALTH_RECORDS_MODULE_ID);
    tasks = await systemDatabase(TASKS_MODULE_ID);
    projectsDatabase = await systemDatabase(PROJECTS_MODULE_ID);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  describe("the access decision", () => {
    it("closes a sensitive database to a project without a grant and opens it with read for reads and write for both", async () => {
      expect(health.sensitive).toBe(true);
      const project = await newProject();
      await expect(check(project, health.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await expect(check(project, health.id, "write")).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "read");
      await check(project, health.id, "read");
      await expect(check(project, health.id, "write")).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "write");
      await check(project, health.id, "read");
      await check(project, health.id, "write");

      await setGrant(project, health.id, "none");
      await expect(check(project, health.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await expect(check(project, health.id, "write")).rejects.toMatchObject(FORBIDDEN);
    });

    it("leaves a user-created database open without a row and closes it with a none row, or its writes with a read row", async () => {
      const project = await newProject();
      const database = await newUserDatabase();
      await check(project, database.id, "read");
      await check(project, database.id, "write");

      await setGrant(project, database.id, "read");
      await check(project, database.id, "read");
      await expect(check(project, database.id, "write")).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, database.id, "none");
      await expect(check(project, database.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await expect(check(project, database.id, "write")).rejects.toMatchObject(FORBIDDEN);

      await inTransaction((client) => removeAgentDatabaseGrant(client, project, database.id));
      await check(project, database.id, "write");
    });

    it("keeps a non-sensitive system database open even when a row names it", async () => {
      const project = await newProject();
      await check(project, tasks.id, "write");
      await setGrant(project, tasks.id, "none");
      await check(project, tasks.id, "read");
      await check(project, tasks.id, "write");
    });

    it("keeps a decision of one project from applying to another", async () => {
      const [first, second] = [await newProject(), await newProject()];
      await setGrant(first, health.id, "write");
      await check(first, health.id, "write");
      await expect(check(second, health.id, "read")).rejects.toMatchObject(FORBIDDEN);
    });

    it("answers not found for a database the tenant does not have", async () => {
      const project = await newProject();
      await expect(check(project, randomUUID(), "read")).rejects.toMatchObject({ status: 404 });
    });

    it("carries no content of an item in a refusal", async () => {
      const project = await newProject();
      const record = await newHealthRecord("Secret diagnosis xyz");
      const refusal = await inTenant(() => cp.findItem(record.id, undefined, project)).catch((error: unknown) => error);
      expect(refusal).toMatchObject(FORBIDDEN);
      expect(
        JSON.stringify({ message: String(refusal), details: Reflect.get(Object(refusal), "details") }),
      ).not.toContain("Secret diagnosis");
    });
  });

  describe("the grants store", () => {
    it("reads null without a decision and the stored access with one, and the admin store replaces and removes it", async () => {
      const project = await newProject();
      const database = await newUserDatabase();
      const read = () => inTransaction((client) => getAccess(client, project, database.id));
      expect(await read()).toBeNull();
      expect(await setGrant(project, database.id, "read")).toBe("read");
      expect(await read()).toBe("read");
      expect(await setGrant(project, database.id, "none")).toBe("none");
      expect(await read()).toBe("none");
      expect(await inTransaction((client) => removeAgentDatabaseGrant(client, project, database.id))).toBe(true);
      expect(await read()).toBeNull();
      expect(await inTransaction((client) => removeAgentDatabaseGrant(client, project, database.id))).toBe(false);
    });

    it("refuses a database of no tenant visible here and stores nothing", async () => {
      const project = await newProject();
      await expect(setGrant(project, randomUUID(), "read")).rejects.toMatchObject({ status: 404 });
      const { rows } = await adminPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_database_grants WHERE project_item_id = $1",
        [project],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  describe("reads", () => {
    it("refuses item.get of a record in a sensitive database to an agent without a grant, opens it with a read grant and leaves a human read unchanged", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      await expect(inTenant(() => cp.findItem(record.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.getItem(health.id, record.id, undefined, project))).rejects.toMatchObject(
        FORBIDDEN,
      );
      expect((await inTenant(() => cp.findItem(record.id)))?.id).toBe(record.id);

      await setGrant(project, health.id, "read");
      expect((await inTenant(() => cp.findItem(record.id, undefined, project)))?.id).toBe(record.id);
      expect((await inTenant(() => cp.getItem(health.id, record.id, undefined, project)))?.id).toBe(record.id);
    });

    it("keeps a missing item not found for an agent", async () => {
      const project = await newProject();
      const database = await newUserDatabase();
      expect(await inTenant(() => cp.findItem(randomUUID(), undefined, project))).toBeNull();
      expect(await inTenant(() => cp.getItem(database.id, randomUUID(), undefined, project))).toBeNull();
    });

    it("refuses an item list of a sensitive database to an agent without a grant and lists it with a read grant", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      await expect(inTenant(() => cp.listItems(health.id, { reader: project }))).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      const page = await inTenant(() => cp.listItems(health.id, { reader: project }));
      expect(page.items.map((item) => item.id)).toContain(record.id);
    });

    it("refuses database.query of a sensitive database to an agent without a grant and answers with a read grant", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      await expect(inTenant(() => cp.queryDatabaseItems(health.id, {}, undefined, project))).rejects.toMatchObject(
        FORBIDDEN,
      );
      await setGrant(project, health.id, "read");
      const page = await inTenant(() => cp.queryDatabaseItems(health.id, {}, undefined, project));
      expect(page.items.map((item) => item.id)).toContain(record.id);
      const human = await inTenant(() => cp.queryDatabaseItems(health.id, {}));
      expect(human.items.map((item) => item.id)).toContain(record.id);
    });

    it("refuses view.query of a view over a sensitive database to an agent without a grant and answers with a read grant", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      const view = await inTenant(() => cp.createView({ databaseId: health.id, type: "table", name: "All records" }));
      await expect(inTenant(() => cp.queryViewItems(view.id, {}, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      const page = await inTenant(() => cp.queryViewItems(view.id, {}, undefined, project));
      expect(page.items.map((item) => item.id)).toContain(record.id);
      const human = await inTenant(() => cp.queryViewItems(view.id, {}));
      expect(human.items.map((item) => item.id)).toContain(record.id);
    });

    it("leaves the items of a database the project may not read out of a curated view's page", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      const open = await newUserDatabase();
      const note = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Open note" } }));
      const curated = await inTenant(() =>
        cp.createView({ type: "list", name: "Mixed", config: { membership: "manual" } }),
      );
      for (const itemId of [record.id, note.id]) {
        await inTenant(() => cp.addViewItem({ viewId: curated.id, itemId, actor: { type: "user" } }));
      }

      const forAgent = await inTenant(() => cp.queryViewItems(curated.id, {}, undefined, project));
      expect(forAgent.items.map((item) => item.id)).toEqual([note.id]);
      const forHuman = await inTenant(() => cp.queryViewItems(curated.id, {}));
      expect(forHuman.items.map((item) => item.id).sort()).toEqual([record.id, note.id].sort());

      await setGrant(project, health.id, "read");
      const granted = await inTenant(() => cp.queryViewItems(curated.id, {}, undefined, project));
      expect(granted.items.map((item) => item.id).sort()).toEqual([record.id, note.id].sort());
    });

    it("counts, pages and ends a curated view over the members the project may read only", async () => {
      const project = await newProject();
      const open = await newUserDatabase();
      const curated = await inTenant(() =>
        cp.createView({ type: "list", name: "Mixed paging", config: { membership: "manual" } }),
      );
      // Position order: hidden, open, hidden, open, hidden, so a page of one cannot end on the hidden members' count.
      const members: ItemRow[] = [];
      for (const [index, databaseId] of [health.id, open.id, health.id, open.id, health.id].entries()) {
        const member = await inTenant(() => cp.createItem({ databaseId, properties: { name: `Member ${index}` } }));
        await inTenant(() => cp.addViewItem({ viewId: curated.id, itemId: member.id, actor: { type: "user" } }));
        members.push(member);
      }
      const readable = [members[1], members[3]].map((member) => member?.id);

      const first = await inTenant(() =>
        cp.queryViewItems(curated.id, { limit: 1, includeCount: true }, undefined, project),
      );
      expect(first.items.map((item) => item.id)).toEqual([readable[0]]);
      expect(first.totalCount).toBe(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await inTenant(() =>
        cp.queryViewItems(
          curated.id,
          { limit: 1, cursor: first.nextCursor ?? undefined, includeCount: true },
          undefined,
          project,
        ),
      );
      expect(second.items.map((item) => item.id)).toEqual([readable[1]]);
      expect(second.totalCount).toBe(2);
      expect(second.nextCursor).toBeNull();

      const inTrash = await inTenant(() =>
        cp.queryViewItems(curated.id, { inTrash: true, includeCount: true }, undefined, project),
      );
      expect(inTrash.totalCount).toBe(2);
      expect(inTrash.items.map((item) => item.id)).toEqual(readable);

      const forHuman = await inTenant(() => cp.queryViewItems(curated.id, { limit: 1, includeCount: true }));
      expect(forHuman.totalCount).toBe(5);
      expect(forHuman.items.map((item) => item.id)).toEqual([members[0]?.id]);
    });

    it("refuses database.get of a database the project may not read and lists the open ones", async () => {
      const project = await newProject();
      const open = await newUserDatabase();
      await expect(inTenant(() => cp.getDatabase(health.id, project))).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.getDatabase(health.id)))?.id).toBe(health.id);
      expect((await inTenant(() => cp.getDatabase(open.id, project)))?.id).toBe(open.id);
      await setGrant(project, health.id, "read");
      expect((await inTenant(() => cp.getDatabase(health.id, project)))?.id).toBe(health.id);
    });

    it("omits the databases the project may not read from database.list and the schema projection", async () => {
      const project = await newProject();
      const open = await newUserDatabase();
      const switchedOff = await newUserDatabase("Switched off");
      await setGrant(project, switchedOff.id, "none");

      const listed = async () => (await inTenant(() => cp.listDatabases(project))).map((database) => database.id);
      const projected = async () =>
        (
          await inTransaction((client) =>
            generateSchemaProjection(client, new ModuleRegistry(() => new Set()), { agentProjectItemId: project }),
          )
        ).databases.map((database) => database.databaseId);

      for (const ids of [await listed(), await projected()]) {
        expect(ids).toContain(open.id);
        expect(ids).toContain(tasks.id);
        expect(ids).not.toContain(health.id);
        expect(ids).not.toContain(switchedOff.id);
      }
      const forHuman = (await inTenant(() => cp.listDatabases())).map((database) => database.id);
      expect(forHuman).toEqual(expect.arrayContaining([health.id, switchedOff.id]));
      const projectedForHuman = (
        await inTransaction((client) => generateSchemaProjection(client, new ModuleRegistry(() => new Set())))
      ).databases.map((database) => database.databaseId);
      expect(projectedForHuman).toContain(health.id);

      await setGrant(project, health.id, "read");
      expect(await listed()).toContain(health.id);
      expect(await projected()).toContain(health.id);
    });

    it("returns a relation target in a database the project may not read as an id and nothing else, also inside a projected relation property", async () => {
      const project = await newProject();
      const source = await newUserDatabase("Source");
      const middle = await newUserDatabase("Middle");
      const toHealth = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "records",
          name: "Records",
          targetDatabaseId: health.id,
        }),
      );
      const toMiddle = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "middles",
          name: "Middles",
          targetDatabaseId: middle.id,
        }),
      );
      const middleToHealth = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: middle.id,
          key: "middleRecords",
          name: "Middle records",
          targetDatabaseId: health.id,
        }),
      );
      const record = await newHealthRecord("Hidden title");
      const sourceView = await inTenant(() => cp.createView({ databaseId: source.id, type: "table", name: "All" }));
      const sourceItem = await inTenant(() => cp.createItem({ databaseId: source.id, properties: { name: "S" } }));
      const middleItem = await inTenant(() => cp.createItem({ databaseId: middle.id, properties: { name: "M" } }));
      for (const [property, caller, target] of [
        [toHealth.property, sourceItem, record],
        [toMiddle.property, sourceItem, middleItem],
        [middleToHealth.property, middleItem, record],
      ] as const) {
        await inTenant(() =>
          cp.createRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: target.id }),
        );
      }
      const resolver = {
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
      const expansion = { relations: { records: [], middles: ["middleRecords"] }, resolver };

      for (const read of [
        () => inTenant(() => cp.findItem(sourceItem.id, expansion, project)),
        () => inTenant(() => cp.getItem(source.id, sourceItem.id, expansion, project)),
        async () =>
          (await inTenant(() => cp.queryDatabaseItems(source.id, {}, expansion, project))).items.find(
            (item) => item.id === sourceItem.id,
          ),
        async () =>
          (await inTenant(() => cp.queryViewItems(sourceView.id, {}, expansion, project))).items.find(
            (item) => item.id === sourceItem.id,
          ),
      ]) {
        const relations = relationsOf(await read());
        expect(relations.records).toEqual([{ id: record.id, hidden: true }]);
        expect(relations.middles).toMatchObject([
          { id: middleItem.id, title: "M", properties: { middleRecords: [{ id: record.id, hidden: true }] } },
        ]);
        expect(JSON.stringify(relations)).not.toContain("Hidden title");
      }

      const human = relationsOf(await inTenant(() => cp.findItem(sourceItem.id, expansion)));
      expect(human.records).toMatchObject([{ id: record.id, title: "Hidden title" }]);

      await setGrant(project, health.id, "read");
      const granted = relationsOf(await inTenant(() => cp.findItem(sourceItem.id, expansion, project)));
      expect(granted.records).toMatchObject([{ id: record.id, title: "Hidden title" }]);
      expect(granted.middles).toMatchObject([
        { properties: { middleRecords: [{ id: record.id, title: "Hidden title" }] } },
      ]);
    });

    it("refuses relation.list of an item in a database the project may not read and lists it with a read grant", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      await expect(inTenant(() => cp.listItemRelations(record.id, undefined, project))).rejects.toMatchObject(
        FORBIDDEN,
      );
      expect(await inTenant(() => cp.listItemRelations(randomUUID(), undefined, project))).toBeNull();
      await setGrant(project, health.id, "read");
      expect(await inTenant(() => cp.listItemRelations(record.id, undefined, project))).toEqual([]);
      expect(await inTenant(() => cp.listItemRelations(record.id))).toEqual([]);
    });

    it("lists an edge to an item in a database the project may not read as its property and the target id only, and in full with a read grant", async () => {
      const project = await newProject();
      const source = await newUserDatabase("Edge source");
      const middle = await newUserDatabase("Edge middle");
      const toHealth = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "records",
          name: "Records",
          targetDatabaseId: health.id,
        }),
      );
      const toMiddle = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "middles",
          name: "Middles",
          targetDatabaseId: middle.id,
        }),
      );
      const record = await newHealthRecord("Hidden title");
      const sourceItem = await inTenant(() => cp.createItem({ databaseId: source.id, properties: { name: "S" } }));
      const middleItem = await inTenant(() => cp.createItem({ databaseId: middle.id, properties: { name: "M" } }));
      await inTenant(() =>
        cp.createRelation({
          relationPropertyId: toHealth.property.id,
          callerItemId: sourceItem.id,
          targetItemId: record.id,
          metadata: { note: "Secret edge note" },
        }),
      );
      await inTenant(() =>
        cp.createRelation({
          relationPropertyId: toMiddle.property.id,
          callerItemId: sourceItem.id,
          targetItemId: middleItem.id,
          metadata: { note: "Open edge note" },
        }),
      );

      const forAgent = await inTenant(() => cp.listItemRelations(sourceItem.id, undefined, project));
      // Ordered by property key, as for a person.
      expect(forAgent).toEqual([
        {
          relationPropertyId: toMiddle.property.id,
          propertyKey: "middles",
          targetItemId: middleItem.id,
          targetDatabaseId: middle.id,
          metadata: { note: "Open edge note" },
        },
        { relationPropertyId: toHealth.property.id, propertyKey: "records", targetItemId: record.id, hidden: true },
      ]);
      expect(JSON.stringify(forAgent)).not.toContain(health.id);
      expect(JSON.stringify(forAgent)).not.toContain("Secret edge note");
      const narrowed = await inTenant(() => cp.listItemRelations(sourceItem.id, toHealth.property.id, project));
      expect(narrowed).toEqual([
        { relationPropertyId: toHealth.property.id, propertyKey: "records", targetItemId: record.id, hidden: true },
      ]);

      const forHuman = await inTenant(() => cp.listItemRelations(sourceItem.id, toHealth.property.id));
      expect(forHuman).toEqual([
        {
          relationPropertyId: toHealth.property.id,
          propertyKey: "records",
          targetItemId: record.id,
          targetDatabaseId: health.id,
          metadata: { note: "Secret edge note" },
        },
      ]);

      await setGrant(project, health.id, "read");
      expect(await inTenant(() => cp.listItemRelations(sourceItem.id, toHealth.property.id, project))).toEqual(
        forHuman,
      );
    });
  });

  describe("item writes", () => {
    it("lets an agent create an item in a sensitive database only with a write grant, and writes nothing when refused", async () => {
      const project = await newProject();
      const before = (await inTenant(() => cp.listItems(health.id))).items.length;
      const create = (name: string, idempotencyKey?: string) =>
        inTenant(() =>
          cp.createItem(
            { databaseId: health.id, properties: { name }, idempotencyKey },
            undefined,
            undefined,
            agent(project),
          ),
        );
      await expect(create("By agent")).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      await expect(create("By agent")).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.listItems(health.id))).items).toHaveLength(before);

      await setGrant(project, health.id, "write");
      const created = await create("By agent");
      expect(created.properties.name).toBe("By agent");
      expect((await inTenant(() => cp.listItems(health.id))).items).toHaveLength(before + 1);
    });

    it("refuses an idempotent replay of a create to an agent without write access", async () => {
      const project = await newProject();
      const key = randomUUID();
      await inTenant(() => cp.createItem({ databaseId: health.id, properties: { name: "Once" }, idempotencyKey: key }));
      await expect(
        inTenant(() =>
          cp.createItem(
            { databaseId: health.id, properties: { name: "Once" }, idempotencyKey: key },
            undefined,
            undefined,
            agent(project),
          ),
        ),
      ).rejects.toMatchObject(FORBIDDEN);
    });

    it("lets an agent patch an item only with a write grant and leaves it unchanged when refused", async () => {
      const project = await newProject();
      const record = await newHealthRecord("Before");
      const patch = () =>
        inTenant(() =>
          cp.updateItem(
            { databaseId: health.id, itemId: record.id, propertiesPatch: { name: "After" } },
            undefined,
            undefined,
            agent(project),
          ),
        );
      await expect(patch()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      await expect(patch()).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(record.id)))?.properties.name).toBe("Before");

      await setGrant(project, health.id, "write");
      await patch();
      expect((await inTenant(() => cp.findItem(record.id)))?.properties.name).toBe("After");
    });

    it("lets an agent delete and restore an item only with a write grant", async () => {
      const project = await newProject();
      const record = await newHealthRecord();
      const trash = () => inTenant(() => cp.softDeleteItem(health.id, record.id, undefined, agent(project)));
      const restore = () => inTenant(() => cp.restoreItem(health.id, record.id, undefined, agent(project)));
      await expect(trash()).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(record.id)))?.deletedAt).toBeNull();

      await setGrant(project, health.id, "write");
      expect((await trash())?.deletedAt).not.toBeNull();

      await setGrant(project, health.id, "none");
      await expect(restore()).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItemIncludingDeleted(record.id)))?.deletedAt).not.toBeNull();

      await setGrant(project, health.id, "write");
      expect((await restore())?.deletedAt).toBeNull();
    });

    it("checks every database a delete or restore cascade reaches", async () => {
      const project = await newProject();
      const parentDatabase = await newUserDatabase("Parents");
      const parent = await inTenant(() => cp.createItem({ databaseId: parentDatabase.id, properties: { name: "P" } }));
      const nested = await inTenant(() => cp.createDatabase({ name: "Nested", parentItemId: parent.id }));
      await inTenant(() => cp.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" }));
      const child = await inTenant(() => cp.createItem({ databaseId: nested.id, properties: { name: "C" } }));
      await setGrant(project, nested.id, "none");

      const trash = () => inTenant(() => cp.softDeleteItem(parentDatabase.id, parent.id, undefined, agent(project)));
      await expect(trash()).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(parent.id)))?.deletedAt).toBeNull();
      expect((await inTenant(() => cp.findItem(child.id)))?.deletedAt).toBeNull();

      await inTenant(() => cp.softDeleteItem(parentDatabase.id, parent.id));
      await expect(
        inTenant(() => cp.restoreItem(parentDatabase.id, parent.id, undefined, agent(project))),
      ).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItemIncludingDeleted(parent.id)))?.deletedAt).not.toBeNull();

      await setGrant(project, nested.id, "write");
      expect(
        (await inTenant(() => cp.restoreItem(parentDatabase.id, parent.id, undefined, agent(project))))?.deletedAt,
      ).toBeNull();
      expect(
        (await inTenant(() => cp.softDeleteItem(parentDatabase.id, parent.id, undefined, agent(project))))?.deletedAt,
      ).not.toBeNull();
    });

    it("lets the user write freely to a user-created database whose row is none for the project, while the agent is refused", async () => {
      const project = await newProject();
      const database = await newUserDatabase();
      const seed = await inTenant(() => cp.createItem({ databaseId: database.id, properties: { name: "Seed" } }));
      const agentWrite = () =>
        inTenant(() =>
          cp.createItem(
            { databaseId: database.id, properties: { name: "Agent" } },
            undefined,
            undefined,
            agent(project),
          ),
        );
      expect((await agentWrite()).properties.name).toBe("Agent");

      await setGrant(project, database.id, "none");
      await expect(agentWrite()).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.findItem(seed.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.queryDatabaseItems(database.id, {}, undefined, project))).rejects.toMatchObject(
        FORBIDDEN,
      );

      const user: WriterIdentity = { writerKind: "user" };
      const created = await inTenant(() =>
        cp.createItem({ databaseId: database.id, properties: { name: "User" } }, undefined, undefined, user),
      );
      expect(created.properties.name).toBe("User");
      await inTenant(() =>
        cp.updateItem(
          { databaseId: database.id, itemId: seed.id, propertiesPatch: { note: "x" } },
          undefined,
          undefined,
          user,
        ),
      );
    });

    it("does not check a person, the system or an agent writer without a project against project grants", async () => {
      const unmarkedAgent: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
      for (const writer of [{ writerKind: "user" } as const, { writerKind: "system" } as const, unmarkedAgent]) {
        const created = await inTenant(() =>
          cp.createItem({ databaseId: health.id, properties: { name: "Unchecked" } }, undefined, undefined, writer),
        );
        expect((await inTenant(() => cp.findItem(created.id)))?.properties.name).toBe("Unchecked");
      }
    });
  });

  describe("relation writes", () => {
    async function relationFixture() {
      const open = await newUserDatabase("Linked");
      const { property } = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: open.id,
          key: "record",
          name: "Record",
          targetDatabaseId: health.id,
          cardinality: "one_to_one",
        }),
      );
      const item = await inTenant(() => cp.createItem({ databaseId: open.id, properties: { name: "Linked item" } }));
      const record = await newHealthRecord();
      const edge = { relationPropertyId: property.id, callerItemId: item.id, targetItemId: record.id };
      return { edge, open };
    }

    it("needs write access to both endpoint databases to put a relation", async () => {
      const project = await newProject();
      const { edge } = await relationFixture();
      const put = () => inTenant(() => cp.createRelation(edge, agent(project)));
      await expect(put()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      await expect(put()).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listItemRelations(edge.callerItemId))).toEqual([]);

      await setGrant(project, health.id, "write");
      await put();
      expect(await inTenant(() => cp.listItemRelations(edge.callerItemId))).toHaveLength(1);
    });

    it("needs write access to the source database as well, when the project's row for it is none", async () => {
      const project = await newProject();
      const { edge, open } = await relationFixture();
      await setGrant(project, health.id, "write");
      await setGrant(project, open.id, "none");
      await expect(inTenant(() => cp.createRelation(edge, agent(project)))).rejects.toMatchObject(FORBIDDEN);
    });

    it("applies the same check to the other edge entry points that take a writer", async () => {
      const project = await newProject();
      const entryPoints: Record<
        string,
        (client: PoolClient, edge: Awaited<ReturnType<typeof relationFixture>>["edge"]) => Promise<void>
      > = {
        createRelationIfAbsentWithClient: async (client, edge) => {
          await createRelationIfAbsentWithClient(client, edge, undefined, agent(project));
        },
        assertRelationCreatableWithClient: (client, edge) =>
          assertRelationCreatableWithClient(client, edge, undefined, agent(project)),
        assertRelationTargetLinkableWithClient: (client, edge) =>
          assertRelationTargetLinkableWithClient(
            client,
            { relationPropertyId: edge.relationPropertyId, targetItemId: edge.targetItemId },
            undefined,
            agent(project),
          ),
      };
      for (const [name, run] of Object.entries(entryPoints)) {
        const { edge } = await relationFixture();
        await setGrant(project, health.id, "read");
        await expect(
          inTransaction((client) => run(client, edge)),
          name,
        ).rejects.toMatchObject(FORBIDDEN);
        expect(await inTenant(() => cp.listItemRelations(edge.callerItemId))).toEqual([]);

        await setGrant(project, health.id, "write");
        await inTransaction((client) => run(client, edge));
      }
    });

    it("needs write access to both endpoint databases to update, set and delete a relation", async () => {
      const project = await newProject();
      const { edge } = await relationFixture();
      await inTenant(() => cp.createRelation(edge));

      const update = () => inTenant(() => cp.updateRelation({ ...edge, metadata: { note: "n" } }, agent(project)));
      const remove = () => inTenant(() => cp.deleteRelation(edge, agent(project)));
      const clear = () => inTenant(() => cp.setRelation({ ...edge, targetItemId: null }, agent(project)));
      await expect(update()).rejects.toMatchObject(FORBIDDEN);
      await expect(remove()).rejects.toMatchObject(FORBIDDEN);
      await expect(clear()).rejects.toMatchObject(FORBIDDEN);
      expect(await inTenant(() => cp.listItemRelations(edge.callerItemId))).toHaveLength(1);

      await setGrant(project, health.id, "write");
      await update();
      await clear();
      expect(await inTenant(() => cp.listItemRelations(edge.callerItemId))).toEqual([]);

      await inTenant(() => cp.createRelation(edge));
      await remove();
      expect(await inTenant(() => cp.listItemRelations(edge.callerItemId))).toEqual([]);
    });
  });

  describe("revoking a grant", () => {
    it("stops a write whose check runs after the revoke and leaves the item unchanged", async () => {
      const project = await newProject();
      const record = await newHealthRecord("Before");
      await setGrant(project, health.id, "write");
      await setGrant(project, health.id, "none");
      await expect(
        inTransaction((client) =>
          updateItemWithClient(
            client,
            { databaseId: health.id, itemId: record.id, propertiesPatch: { name: "After" } },
            { writer: agent(project) },
          ),
        ),
      ).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(record.id)))?.properties.name).toBe("Before");
    });

    it("makes a revoke issued after the check wait for the transaction of the write", async () => {
      const project = await newProject();
      const record = await newHealthRecord("Before");
      await setGrant(project, health.id, "write");

      const checked = deferred();
      const release = deferred();
      const write = inTransaction(async (client) => {
        await updateItemWithClient(
          client,
          { databaseId: health.id, itemId: record.id, propertiesPatch: { name: "After" } },
          { writer: agent(project) },
        );
        checked.resolve();
        await release.promise;
      });
      await checked.promise;

      let revoked = false;
      const revoke = setGrant(project, health.id, "none").then(() => {
        revoked = true;
      });
      // The revoke is blocked on the row the write's check holds `FOR SHARE`: wait until Postgres reports it so.
      const deadline = Date.now() + 15_000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const { rows } = await adminPool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO agent_database_grants%'`,
        );
        blocked = (rows[0]?.n ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      expect(revoked).toBe(false);

      release.resolve();
      await write;
      await revoke;
      expect(revoked).toBe(true);
      expect((await inTenant(() => cp.findItem(record.id)))?.properties.name).toBe("After");
      await expect(check(project, health.id, "write")).rejects.toMatchObject(FORBIDDEN);
    });
  });

  describe("purging a project", () => {
    it("deletes the grants of a purged Projects item and keeps those of another project", async () => {
      const [purged, kept] = [await newProject(), await newProject()];
      const database = await newUserDatabase();
      for (const project of [purged, kept]) await setGrant(project, database.id, "none");
      const read = (project: string) => inTransaction((client) => getAccess(client, project, database.id));

      await inTenant(() => cp.softDeleteItem(projectsDatabase.id, purged));
      const result = await inTenant(() =>
        cp.purgeExpiredTrashSubtree(purged, new Date(Date.now() + FAR_FUTURE_CUTOFF_MS)),
      );
      expect(result.purgedItemIds).toEqual([purged]);
      expect(await read(purged)).toBeNull();
      expect(await read(kept)).toBe("none");
    });
  });

  describe("tenant isolation", () => {
    it("never applies another tenant's grants, and never stores a grant for another tenant's database", async () => {
      const otherTenantId = await createTestTenant(adminPool);
      const inOther = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(otherTenantId, fn);
      const otherDatabase = await inOther(() => cp.createDatabase({ name: "Other notes" }));
      const otherProject = await inOther(() => createTestProjectItem(dataPool));

      const database = await newUserDatabase();
      const project = await newProject();
      await setGrant(project, database.id, "none");
      await inOther(() =>
        withTransaction(dataPool, (client) =>
          setAgentDatabaseGrant(client, { projectItemId: otherProject, databaseId: otherDatabase.id, access: "none" }),
        ),
      );

      // Each tenant's row denies only inside its own tenant.
      await expect(check(project, database.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inOther(() => withTransaction(dataPool, (client) => check(otherProject, otherDatabase.id, "read", client))),
      ).rejects.toMatchObject(FORBIDDEN);

      // A project id from the other tenant carries none of that tenant's decisions here, and the other tenant's database is not found.
      await check(otherProject, database.id, "write");
      await expect(check(project, otherDatabase.id, "read")).rejects.toMatchObject({ status: 404 });
      expect(await inTransaction((client) => getAccess(client, otherProject, otherDatabase.id))).toBeNull();
      await expect(setGrant(project, otherDatabase.id, "none")).rejects.toMatchObject({ status: 404 });
      const { rows } = await adminPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM agent_database_grants WHERE tenant_id = $1 AND database_id = $2",
        [tenantId, otherDatabase.id],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });
});
