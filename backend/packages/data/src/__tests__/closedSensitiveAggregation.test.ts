import "../domainWriteHooks.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { listClosedSensitiveDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { removeAgentDatabaseGrant, setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import type { RelationExpansionOptions } from "../chokePoint/relationExpansion.js";
import { ConflictError, ForbiddenError } from "../errors.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { recomputeRollupCell } from "../rollup/recompute.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  AREAS_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow, PropertyRow } from "../types.js";

// Seeding the system databases of a tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 180_000;
const FORBIDDEN = { status: 403, code: "forbidden" };
const HIDDEN_ROLLUP = { value: null, hidden: true };

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let tenantId: string;
let health: DatabaseRow;
let projects: DatabaseRow;
let healthRelation: PropertyRow;
let tasksRelation: PropertyRow;
let healthCount: PropertyRow;
let taskCount: PropertyRow;
let holder: ItemRow;
let otherProject: ItemRow;
let diagnosis: ItemRow;
let unrelatedRecord: ItemRow;
let task: ItemRow;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantId, fn);
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(dataPool, fn));
}

function setGrant(projectItemId: string, databaseId: string, access: AgentDatabaseAccess) {
  return inTransaction((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access }));
}

/** The Projects item of an agent run that has no grant for any database. */
function newAgentProject(): Promise<string> {
  return inTenant(() => createTestProjectItem(dataPool));
}

async function propertyOf(database: DatabaseRow, key: string): Promise<PropertyRow> {
  const property = (await inTransaction((client) => listPropertiesByDatabase(client, database.id))).find(
    (candidate) => candidate.key === key,
  );
  if (!property) throw new Error(`Property ${key} of ${database.id} is missing`);
  return property;
}

async function systemDatabase(moduleId: string, pool: Pool = dataPool, scope: string = tenantId): Promise<DatabaseRow> {
  const database = await runInTenant(scope, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`System database ${moduleId} is missing`);
  return database;
}

function ids(page: { items: ItemRow[] }): string[] {
  return page.items.map((item) => item.id);
}

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

const relationContains = (property: string, value: string) => ({ type: "relation_contains", property, value });

/** The database query of an agent run's project (`reader`) or, without one, of a person. */
function queryDatabase(
  input: { filter?: unknown; sort?: unknown; includeCount?: boolean },
  reader?: string,
  databaseId = projects.id,
) {
  return inTenant(() => cp.queryDatabaseItems(databaseId, input, undefined, reader));
}

function queryView(viewId: string, input: { filter?: unknown; sort?: unknown }, reader?: string) {
  return inTenant(() => cp.queryViewItems(viewId, input, undefined, reader));
}

/** Records the rollup cell of an item the way the recompute job does, without running the worker. */
function recompute(property: PropertyRow, item: ItemRow) {
  return inTenant(() => recomputeRollupCell(dataPool, property.id, item.id));
}

describe("filters and rollups over a sensitive database an agent cannot read (issue #2000)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await inTenant(() => seedSystem(dataPool, createViewTypeRegistry()));
    cp = createChokePoint(dataPool);
    health = await systemDatabase(HEALTH_RECORDS_MODULE_ID);
    projects = await systemDatabase(PROJECTS_MODULE_ID);

    // A fixture the API cannot produce: the schema of a system database is locked until a code-level migration
    // changes it, and Projects has no rollup. The superuser pool unlocks it so the rollups below are created through
    // the choke point as a user would create them.
    await adminPool.query("UPDATE databases SET schema_locked = false WHERE id = $1", [projects.id]);
    healthRelation = await propertyOf(projects, "healthRecords");
    tasksRelation = await propertyOf(projects, "tasks");
    healthCount = await inTenant(() =>
      cp.createProperty({
        databaseId: projects.id,
        key: "healthRecordCount",
        name: "Health record count",
        type: "rollup",
        config: { relationPropertyKey: "healthRecords", aggregation: "count" },
      }),
    );
    taskCount = await inTenant(() =>
      cp.createProperty({
        databaseId: projects.id,
        key: "taskCount",
        name: "Task count",
        type: "rollup",
        config: { relationPropertyKey: "tasks", aggregation: "count" },
      }),
    );

    holder = await inTenant(() => cp.createItem({ databaseId: projects.id, properties: { name: "Holder" } }));
    otherProject = await inTenant(() => cp.createItem({ databaseId: projects.id, properties: { name: "Other" } }));
    diagnosis = await inTenant(() =>
      cp.createItem({ databaseId: health.id, properties: { name: "Private diagnosis" } }),
    );
    unrelatedRecord = await inTenant(() =>
      cp.createItem({ databaseId: health.id, properties: { name: "Unrelated record" } }),
    );
    const secondRecord = await inTenant(() =>
      cp.createItem({ databaseId: health.id, properties: { name: "Second record" } }),
    );
    const tasks = await systemDatabase(TASKS_MODULE_ID);
    task = await inTenant(() => cp.createItem({ databaseId: tasks.id, properties: {} }));
    for (const record of [diagnosis, secondRecord]) {
      await inTenant(() =>
        cp.createRelation({ relationPropertyId: healthRelation.id, callerItemId: holder.id, targetItemId: record.id }),
      );
    }
    await inTenant(() =>
      cp.createRelation({ relationPropertyId: tasksRelation.id, callerItemId: holder.id, targetItemId: task.id }),
    );
    for (const property of [healthCount, taskCount]) await recompute(property, holder);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  describe("the closed databases of a project", () => {
    it("lists a sensitive database without a grant, and no longer once the project holds read or write", async () => {
      const project = await newAgentProject();
      const closed = async () =>
        (await inTransaction((client) => listClosedSensitiveDatabaseIds(client, project))).has(health.id);
      const sensitive = await inTransaction(async (client) =>
        (await client.query<{ id: string }>("SELECT id FROM databases WHERE sensitive")).rows.map((row) => row.id),
      );
      expect(sensitive).toContain(health.id);
      // Every sensitive database is closed to a project without a decision, and nothing else is.
      const all = await inTransaction((client) => listClosedSensitiveDatabaseIds(client, project));
      expect([...all].sort()).toEqual([...sensitive].sort());

      expect(await closed()).toBe(true);
      await setGrant(project, health.id, "read");
      expect(await closed()).toBe(false);
      await setGrant(project, health.id, "write");
      expect(await closed()).toBe(false);
      await setGrant(project, health.id, "none");
      expect(await closed()).toBe(true);
    });

    it("never lists a database that is not sensitive, an explicit none decision for it included", async () => {
      const project = await newAgentProject();
      const notes = await inTenant(() => cp.createDatabase({ name: "Notes" }));
      await setGrant(project, notes.id, "none");
      expect(notes.sensitive).toBe(false);
      const closed = await inTransaction((client) => listClosedSensitiveDatabaseIds(client, project));
      expect(closed.has(notes.id)).toBe(false);
      expect(closed.has(health.id)).toBe(true);
    });
  });

  describe("filters on a relation into a closed database", () => {
    it("answers 403 forbidden to a relation_contains filter of an agent without a grant, naming no item content, and returns the matching rows with a read grant", async () => {
      const project = await newAgentProject();
      const filter = relationContains("healthRecords", diagnosis.id);

      const refusal = await queryDatabase({ filter }, project).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(ForbiddenError);
      expect(refusal).toMatchObject(FORBIDDEN);
      if (!(refusal instanceof ForbiddenError)) throw new Error("Expected a ForbiddenError");
      const text = JSON.stringify({ message: refusal.message, details: refusal.details });
      expect(text).not.toContain("Private diagnosis");
      expect(text).not.toContain(diagnosis.id);
      expect(text).not.toContain(holder.id);

      await setGrant(project, health.id, "read");
      const granted = ids(await queryDatabase({ filter }, project));
      expect(granted).toContain(holder.id);
      expect(granted).not.toContain(otherProject.id);
      expect(
        ids(await queryDatabase({ filter: relationContains("healthRecords", unrelatedRecord.id) }, project)),
      ).toEqual([]);
    });

    it("opens the filter with a write grant and leaves a person's filter unchanged without any grant", async () => {
      const project = await newAgentProject();
      await setGrant(project, health.id, "write");
      expect(ids(await queryDatabase({ filter: relationContains("healthRecords", diagnosis.id) }, project))).toContain(
        holder.id,
      );
      const forPerson = ids(await queryDatabase({ filter: relationContains("healthRecords", diagnosis.id) }));
      expect(forPerson).toContain(holder.id);
      expect(forPerson).not.toContain(otherProject.id);
    });

    it("refuses every relation operator, and ones nested in and, or and not", async () => {
      const project = await newAgentProject();
      const conditions = [
        relationContains("healthRecords", diagnosis.id),
        { type: "relation_not_contains", property: "healthRecords", value: diagnosis.id },
        { type: "relation_is_empty", property: "healthRecords" },
        { type: "relation_is_not_empty", property: "healthRecords" },
      ];
      for (const condition of conditions) {
        await expect(queryDatabase({ filter: condition }, project), condition.type).rejects.toMatchObject(FORBIDDEN);
        await expect(queryDatabase({ filter: condition }), `${condition.type} for a person`).resolves.toBeDefined();
      }
      const open = { type: "is_not_empty", property: "name" };
      const closed = relationContains("healthRecords", diagnosis.id);
      for (const nested of [
        { type: "and", nodes: [open, closed] },
        { type: "or", nodes: [open, closed] },
        { type: "not", node: closed },
        { type: "and", nodes: [open, { type: "or", nodes: [open, { type: "not", node: closed }] }] },
      ]) {
        await expect(queryDatabase({ filter: nested }, project), JSON.stringify(nested)).rejects.toMatchObject(
          FORBIDDEN,
        );
      }
    });

    it("refuses a path whose first hop reaches the closed database and one whose second hop does", async () => {
      const project = await newAgentProject();
      const area = await inTenant(async () =>
        cp.createItem({ databaseId: (await systemDatabase(AREAS_MODULE_ID)).id, properties: { name: "Body" } }),
      );
      // Projects.healthRecords then Health records.area: the intermediate items are the closed ones.
      const firstHop = { type: "relation_path_contains", path: ["healthRecords", "area"], value: area.id };
      // Projects.area then Areas.healthRecord: the item the path ends on is the closed one.
      const secondHop = { type: "relation_path_contains", path: ["area", "healthRecord"], value: diagnosis.id };
      await expect(queryDatabase({ filter: firstHop }, project)).rejects.toMatchObject(FORBIDDEN);
      await expect(queryDatabase({ filter: secondHop }, project)).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "read");
      await expect(queryDatabase({ filter: firstHop }, project)).resolves.toBeDefined();
      await expect(queryDatabase({ filter: secondHop }, project)).resolves.toBeDefined();
      await expect(queryDatabase({ filter: secondHop })).resolves.toBeDefined();
    });

    it("leaves a path over open databases, and a filter on a relation into an open database, unchanged for an agent", async () => {
      const project = await newAgentProject();
      const people = await inTenant(async () =>
        cp.createItem({ databaseId: (await systemDatabase(PEOPLE_MODULE_ID)).id, properties: { name: "Ada" } }),
      );
      const openPath = { type: "relation_path_contains", path: ["tasks", "people"], value: people.id };
      await expect(queryDatabase({ filter: openPath }, project)).resolves.toMatchObject({ items: [] });

      const matching = ids(await queryDatabase({ filter: relationContains("tasks", task.id) }, project));
      expect(matching).toContain(holder.id);
      expect(matching).not.toContain(otherProject.id);
      const empty = ids(await queryDatabase({ filter: { type: "relation_is_empty", property: "tasks" } }, project));
      expect(empty).toContain(otherProject.id);
      expect(empty).not.toContain(holder.id);
    });

    it("does not refuse a relation into a user-created database the project has a none decision for", async () => {
      const project = await newAgentProject();
      const notes = await inTenant(() => cp.createDatabase({ name: "Project notes" }));
      const { property } = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: projects.id,
          key: "notes",
          name: "Notes",
          targetDatabaseId: notes.id,
          inverse: { key: "project", name: "Project" },
        }),
      );
      await setGrant(project, notes.id, "none");
      await expect(
        queryDatabase({ filter: { type: "relation_is_not_empty", property: property.key } }, project),
      ).resolves.toBeDefined();
    });
  });

  describe("filters on a rollup over a closed database", () => {
    const rollupConditions = (key: string) => [
      { type: "equals", property: key, value: 2 },
      { type: "not_equals", property: key, value: 2 },
      { type: "gt", property: key, value: 1 },
      { type: "lte", property: key, value: 5 },
      { type: "is_empty", property: key },
      { type: "is_not_empty", property: key },
      { type: "in", property: key, value: ["2"] },
    ];

    it("answers 403 forbidden to a filter on a rollup of health records without a grant and filters with a read grant", async () => {
      const project = await newAgentProject();
      for (const condition of rollupConditions(healthCount.key)) {
        await expect(queryDatabase({ filter: condition }, project), condition.type).rejects.toMatchObject(FORBIDDEN);
      }
      await expect(
        queryDatabase({ filter: { type: "not", node: { type: "gt", property: healthCount.key, value: 1 } } }, project),
      ).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "read");
      const matching = ids(
        await queryDatabase({ filter: { type: "equals", property: healthCount.key, value: 2 } }, project),
      );
      expect(matching).toContain(holder.id);
      expect(matching).not.toContain(otherProject.id);
    });

    it("filters the rollup for a person without a grant, and a rollup over an open database for an agent without one", async () => {
      const forPerson = ids(await queryDatabase({ filter: { type: "equals", property: healthCount.key, value: 2 } }));
      expect(forPerson).toContain(holder.id);

      const project = await newAgentProject();
      for (const condition of rollupConditions(taskCount.key)) {
        await expect(queryDatabase({ filter: condition }, project), condition.type).resolves.toBeDefined();
      }
      const matching = ids(
        await queryDatabase({ filter: { type: "equals", property: taskCount.key, value: 1 } }, project),
      );
      expect(matching).toContain(holder.id);
      expect(matching).not.toContain(otherProject.id);
    });
  });

  describe("view.query", () => {
    it("refuses a view whose stored filter reaches the closed database for an agent and returns it with a read grant and for a person", async () => {
      const project = await newAgentProject();
      const view = await inTenant(() =>
        cp.createView({
          databaseId: projects.id,
          type: "table",
          name: "Linked to the diagnosis",
          config: { filter: relationContains("healthRecords", diagnosis.id) },
        }),
      );
      await expect(queryView(view.id, {}, project)).rejects.toMatchObject(FORBIDDEN);
      expect(ids(await queryView(view.id, {}))).toContain(holder.id);
      await setGrant(project, health.id, "read");
      expect(ids(await queryView(view.id, {}, project))).toContain(holder.id);
    });

    it("refuses a request filter on a view with an open stored filter, and keeps the view's open filter working", async () => {
      const project = await newAgentProject();
      const view = await inTenant(() =>
        cp.createView({
          databaseId: projects.id,
          type: "table",
          name: "With tasks",
          config: { filter: relationContains("tasks", task.id) },
        }),
      );
      expect(ids(await queryView(view.id, {}, project))).toEqual([holder.id]);
      await expect(
        queryView(view.id, { filter: relationContains("healthRecords", diagnosis.id) }, project),
      ).rejects.toMatchObject(FORBIDDEN);
    });

    it("refuses a sort of the view by a closed rollup, in its stored sort and group as in the request", async () => {
      const project = await newAgentProject();
      const sorted = await inTenant(() =>
        cp.createView({
          databaseId: projects.id,
          type: "table",
          name: "Sorted by health records",
          config: { sort: [{ property: healthCount.key, direction: "desc" }] },
        }),
      );
      const grouped = await inTenant(() =>
        cp.createView({
          databaseId: projects.id,
          type: "table",
          name: "Grouped by health records",
          config: { groupBy: healthCount.key },
        }),
      );
      const plain = await inTenant(() => cp.createView({ databaseId: projects.id, type: "table", name: "Plain" }));
      await expect(queryView(sorted.id, {}, project)).rejects.toMatchObject(FORBIDDEN);
      await expect(queryView(grouped.id, {}, project)).rejects.toMatchObject(FORBIDDEN);
      await expect(
        queryView(plain.id, { sort: [{ property: healthCount.key, direction: "asc" }] }, project),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(queryView(sorted.id, {}), "a person").resolves.toBeDefined();

      await setGrant(project, health.id, "read");
      await expect(queryView(sorted.id, {}, project)).resolves.toBeDefined();
    });
  });

  describe("sorting by a rollup over a closed database", () => {
    it("answers 403 forbidden to a sort by it without a grant, as the first key and a later one, and sorts with a read grant", async () => {
      const project = await newAgentProject();
      const byHealth = [{ property: healthCount.key, direction: "desc" }];
      await expect(queryDatabase({ sort: byHealth }, project)).rejects.toMatchObject(FORBIDDEN);
      await expect(
        queryDatabase({ sort: [{ property: "name", direction: "asc" }, ...byHealth] }, project),
      ).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "read");
      const sorted = ids(await queryDatabase({ sort: byHealth }, project));
      expect(sorted.indexOf(holder.id)).toBeLessThan(sorted.indexOf(otherProject.id));
    });

    it("sorts a person's query by it, and an agent's by a rollup over an open database, a property and a system timestamp", async () => {
      const project = await newAgentProject();
      const byHealth = ids(await queryDatabase({ sort: [{ property: healthCount.key, direction: "desc" }] }));
      expect(byHealth.indexOf(holder.id)).toBeLessThan(byHealth.indexOf(otherProject.id));

      for (const sort of [
        [{ property: taskCount.key, direction: "desc" }],
        [{ property: "name", direction: "asc" }],
        [{ system: "createdAt", direction: "asc" }],
      ]) {
        await expect(queryDatabase({ sort }, project), JSON.stringify(sort)).resolves.toBeDefined();
      }
      const byTasks = ids(await queryDatabase({ sort: [{ property: taskCount.key, direction: "desc" }] }, project));
      expect(byTasks.indexOf(holder.id)).toBeLessThan(byTasks.indexOf(otherProject.id));
    });
  });

  describe("choke point reads that take a filter", () => {
    it("refuses a listItems filter on a closed relation for an agent and returns the rows with a read grant and for a person", async () => {
      const project = await newAgentProject();
      const filter = relationContains("healthRecords", diagnosis.id);
      const list = (reader?: string) => inTenant(() => cp.listItems(projects.id, { filter, reader }));
      await expect(list(project)).rejects.toMatchObject(FORBIDDEN);
      expect(ids(await list())).toContain(holder.id);
      await setGrant(project, health.id, "read");
      expect(ids(await list(project))).toContain(holder.id);
    });

    it("refuses an item.count entry that filters on a closed relation or rollup for an agent's project and counts with a read grant, for a person and without the project", async () => {
      const project = await newAgentProject();
      const count = (filter: unknown, agentProjectItemId?: string) =>
        inTenant(() =>
          cp.countItemsBatch([{ databaseId: projects.id, filter }], { resolver: metadataResolver, agentProjectItemId }),
        );
      const byRelation = relationContains("healthRecords", diagnosis.id);
      const byRollup = { type: "equals", property: healthCount.key, value: 2 };
      await expect(count(byRelation, project)).rejects.toMatchObject(FORBIDDEN);
      await expect(count(byRollup, project)).rejects.toMatchObject(FORBIDDEN);
      expect((await count(byRelation))[0]?.count).toBe(1);
      expect((await count(byRollup))[0]?.count).toBe(1);

      expect((await count(relationContains("tasks", task.id), project))[0]?.count).toBe(1);
      expect((await count(undefined, project))[0]?.count).toBeGreaterThanOrEqual(2);

      await setGrant(project, health.id, "read");
      expect((await count(byRelation, project))[0]?.count).toBe(1);
      expect((await count(byRollup, project))[0]?.count).toBe(1);
    });
  });

  describe("item.count grouped by a relation into a closed database", () => {
    const groupedBy = (groupBy: string, agentProjectItemId?: string) =>
      inTenant(() =>
        cp.countItemsBatch([{ databaseId: projects.id, groupBy }], { resolver: metadataResolver, agentProjectItemId }),
      );

    it("refuses the grouping for an agent's project without a grant, with no filter, and groups with a read grant and for a person", async () => {
      const project = await newAgentProject();
      const refusal = await groupedBy("healthRecords", project).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(ForbiddenError);
      expect(refusal).toMatchObject(FORBIDDEN);
      if (!(refusal instanceof ForbiddenError)) throw new Error("Expected a ForbiddenError");
      const text = JSON.stringify({ message: refusal.message, details: refusal.details });
      expect(text).not.toContain(diagnosis.id);
      expect(text).not.toContain("Private diagnosis");

      const forPerson = (await groupedBy("healthRecords"))[0];
      expect(forPerson?.groups?.map((group) => group.key)).toContain(diagnosis.id);

      await setGrant(project, health.id, "read");
      const granted = (await groupedBy("healthRecords", project))[0];
      expect(granted?.groups?.find((group) => group.key === diagnosis.id)?.count).toBe(1);
    });

    it("leaves a grouping by a relation into an open database unchanged for an agent", async () => {
      const project = await newAgentProject();
      const grouped = (await groupedBy("tasks", project))[0];
      expect(grouped?.groups?.find((group) => group.key === task.id)?.count).toBe(1);
    });
  });

  describe("database.facets", () => {
    const facets = (
      input: {
        facets: Parameters<ChokePoint["getDatabaseFacets"]>[0]["facets"];
        filter?: unknown;
        extra?: { open: unknown };
      },
      agentProjectItemId?: string,
    ) => inTenant(() => cp.getDatabaseFacets({ databaseId: projects.id, ...input }, { agentProjectItemId }));

    it("refuses a filter on a relation or a rollup into a closed database, in filter and in extra.open, and answers with a read grant and for a person", async () => {
      const project = await newAgentProject();
      const byRelation = relationContains("healthRecords", diagnosis.id);
      const byRollup = { type: "gt", property: healthCount.key, value: 0 };
      for (const condition of [byRelation, byRollup]) {
        await expect(facets({ facets: ["status"], filter: condition }, project)).rejects.toMatchObject(FORBIDDEN);
        await expect(
          facets({ facets: ["status"], extra: { open: { type: "not", node: condition } } }, project),
        ).rejects.toMatchObject(FORBIDDEN);
      }
      // A facet on a text property stays open to a person, whatever its filter.
      expect((await facets({ facets: ["status"], filter: byRelation }))[0]?.all).toBe(1);

      await setGrant(project, health.id, "read");
      expect((await facets({ facets: ["status"], filter: byRelation }, project))[0]?.all).toBe(1);
      expect((await facets({ facets: ["status"], filter: byRollup }, project))[0]?.all).toBe(1);
    });

    it("refuses a relation facet and a path facet that reach a closed database, in either hop, naming no record", async () => {
      const project = await newAgentProject();
      const refusal = await facets({ facets: ["healthRecords"] }, project).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(ForbiddenError);
      if (!(refusal instanceof ForbiddenError)) throw new Error("Expected a ForbiddenError");
      const text = JSON.stringify({ message: refusal.message, details: refusal.details });
      expect(text).not.toContain("Private diagnosis");
      expect(text).not.toContain(diagnosis.id);

      const firstHop = { path: ["healthRecords", "area"] as [string, string] };
      const secondHop = { path: ["area", "healthRecord"] as [string, string] };
      await expect(facets({ facets: [firstHop] }, project)).rejects.toMatchObject(FORBIDDEN);
      await expect(facets({ facets: [secondHop] }, project)).rejects.toMatchObject(FORBIDDEN);

      const person = (await facets({ facets: ["healthRecords"] }))[0];
      expect(person?.values.map((entry) => entry.value)).toContain(diagnosis.id);

      await setGrant(project, health.id, "read");
      const granted = (await facets({ facets: ["healthRecords"] }, project))[0];
      expect(granted?.values.find((entry) => entry.value === diagnosis.id)?.label).toBe("Private diagnosis");
      await expect(facets({ facets: [firstHop] }, project)).resolves.toBeDefined();
      await expect(facets({ facets: [secondHop] }, project)).resolves.toBeDefined();
    });

    it("leaves a facet over an open database, and a facet with no relation into a closed one, unchanged for an agent", async () => {
      const project = await newAgentProject();
      const tasksFacet = (await facets({ facets: ["tasks"], filter: relationContains("tasks", task.id) }, project))[0];
      expect(tasksFacet?.values.find((entry) => entry.value === task.id)?.count).toBe(1);
      expect((await facets({ facets: ["status"] }, project))[0]?.all).toBeGreaterThanOrEqual(2);
    });
  });

  describe("the item a write returns to an agent writer", () => {
    const agentWriter = (projectItemId: string): WriterIdentity => ({
      writerKind: "agent",
      agentRunId: randomUUID(),
      agentProjectItemId: projectItemId,
    });
    const hidden = (item: ItemRow | null | undefined) => item?.computed[healthCount.key];
    /** The computed values of the current item a version conflict carries. */
    const currentComputed = (error: unknown): Record<string, unknown> | undefined => {
      if (!(error instanceof ConflictError)) throw new Error("Expected a ConflictError");
      const details = error.details as { current?: { computed?: Record<string, unknown> } } | undefined;
      return details?.current?.computed;
    };

    it("hides the rollup over health records in the item an agent creates, patches, deletes and restores, in full to a person and with a read grant", async () => {
      const project = await newAgentProject();
      const writer = agentWriter(project);
      const created = await inTenant(() =>
        cp.createItem({ databaseId: projects.id, properties: { name: "By the agent" } }, undefined, undefined, writer),
      );
      expect(hidden(created)).toEqual(HIDDEN_ROLLUP);
      const createdWithRelations = await inTenant(() =>
        cp.createItemWithRelations(
          { databaseId: projects.id, properties: { name: "By the agent, linked" }, relations: [] },
          undefined,
          undefined,
          writer,
        ),
      );
      expect(hidden(createdWithRelations)).toEqual(HIDDEN_ROLLUP);

      const patch = (actor?: WriterIdentity, ifVersion?: string) =>
        inTenant(() =>
          cp.updateItem(
            { databaseId: projects.id, itemId: holder.id, propertiesPatch: { name: "Holder" }, ifVersion },
            undefined,
            undefined,
            actor,
          ),
        );
      const patched = await patch(writer);
      expect(hidden(patched)).toEqual(HIDDEN_ROLLUP);
      expect(patched.computed[taskCount.key]).toBe(1);
      expect(patched.properties.name).toBe("Holder");
      expect(hidden(await patch())).toBe(2);

      // The current item of a version conflict carries the same computed values.
      const conflict = await patch(writer, "1970-01-01T00:00:00.000Z").then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(conflict).toBeInstanceOf(ConflictError);
      expect(currentComputed(conflict)?.[healthCount.key]).toEqual(HIDDEN_ROLLUP);
      const personConflict = await patch(undefined, "1970-01-01T00:00:00.000Z").then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(currentComputed(personConflict)?.[healthCount.key]).toBe(2);

      const trashed = await inTenant(() => cp.softDeleteItem(projects.id, created.id, undefined, writer));
      expect(hidden(trashed)).toEqual(HIDDEN_ROLLUP);
      const restored = await inTenant(() => cp.restoreItem(projects.id, created.id, undefined, writer));
      expect(hidden(restored)).toEqual(HIDDEN_ROLLUP);

      await setGrant(project, health.id, "read");
      expect(hidden(await patch(writer))).toBe(2);
    });
  });

  describe("rollup values an agent reads", () => {
    const healthValue = (item: ItemRow | null | undefined) => item?.computed[healthCount.key];
    const taskValue = (item: ItemRow | null | undefined) => item?.computed[taskCount.key];

    it("reads the rollup over health records as null with hidden: true in getItem and findItem, in full for a person and with a read grant", async () => {
      const project = await newAgentProject();
      const get = (reader?: string) => inTenant(() => cp.getItem(projects.id, holder.id, undefined, reader));
      const find = (reader?: string) => inTenant(() => cp.findItem(holder.id, undefined, reader));

      expect(healthValue(await get(project))).toEqual(HIDDEN_ROLLUP);
      expect(healthValue(await find(project))).toEqual(HIDDEN_ROLLUP);
      expect(healthValue(await get())).toBe(2);
      expect(healthValue(await find())).toBe(2);
      // A rollup over an open database is not touched.
      expect(taskValue(await get(project))).toBe(1);
      expect(taskValue(await find(project))).toBe(1);

      await setGrant(project, health.id, "read");
      expect(healthValue(await get(project))).toBe(2);
      expect(healthValue(await find(project))).toBe(2);
    });

    it("hides it on an item that has no computed value yet, so a missing value says nothing", async () => {
      const project = await newAgentProject();
      const fresh = await inTenant(() => cp.createItem({ databaseId: projects.id, properties: { name: "Fresh" } }));
      expect(Object.keys(fresh.computed)).not.toContain(healthCount.key);
      const read = await inTenant(() => cp.getItem(projects.id, fresh.id, undefined, project));
      expect(read?.computed[healthCount.key]).toEqual(HIDDEN_ROLLUP);
      const forPerson = await inTenant(() => cp.getItem(projects.id, fresh.id));
      expect(forPerson?.computed[healthCount.key]).toBeUndefined();
    });

    it("hides it in listItems, in database.query and in a filtered view's page, and keeps every other field and item", async () => {
      const project = await newAgentProject();
      const view = await inTenant(() =>
        cp.createView({ databaseId: projects.id, type: "table", name: "All projects" }),
      );
      const pages = {
        listItems: await inTenant(() => cp.listItems(projects.id, { reader: project })),
        queryDatabaseItems: await queryDatabase({}, project),
        queryViewItems: await queryView(view.id, {}, project),
      };
      for (const [name, page] of Object.entries(pages)) {
        const read = page.items.find((item) => item.id === holder.id);
        expect(read?.computed[healthCount.key], name).toEqual(HIDDEN_ROLLUP);
        expect(read?.computed[taskCount.key], name).toBe(1);
        expect(read?.properties.name, name).toBe("Holder");
        expect(ids(page), name).toContain(otherProject.id);
        for (const item of page.items) expect(item.computed[healthCount.key], name).toEqual(HIDDEN_ROLLUP);
      }
      const forPerson = await queryDatabase({});
      expect(forPerson.items.find((item) => item.id === holder.id)?.computed[healthCount.key]).toBe(2);
    });

    it("hides it in a curated view's page that holds the project, and shows it with a read grant", async () => {
      const project = await newAgentProject();
      const curated = await inTenant(() =>
        cp.createView({ type: "list", name: "Mixed", config: { membership: "manual" } }),
      );
      await inTenant(() => cp.addViewItem({ viewId: curated.id, itemId: holder.id, actor: { type: "user" } }));
      const read = (reader?: string) => queryView(curated.id, {}, reader);
      expect((await read(project)).items[0]?.computed[healthCount.key]).toEqual(HIDDEN_ROLLUP);
      expect((await read()).items[0]?.computed[healthCount.key]).toBe(2);
      await setGrant(project, health.id, "read");
      expect((await read(project)).items[0]?.computed[healthCount.key]).toBe(2);
    });

    it("keeps the hidden value when the read expands relations, and hides it again once the grant is removed", async () => {
      const project = await newAgentProject();
      await setGrant(project, health.id, "read");
      const expansion: RelationExpansionOptions = {
        relations: { healthRecords: [], tasks: [] },
        resolver: metadataResolver,
      };
      const granted = await inTenant(() => cp.getItem(projects.id, holder.id, expansion, project));
      expect(healthValue(granted)).toBe(2);

      expect(await inTransaction((client) => removeAgentDatabaseGrant(client, project, health.id))).toBe(true);
      const revoked = await inTenant(() => cp.getItem(projects.id, holder.id, expansion, project));
      expect(healthValue(revoked)).toEqual(HIDDEN_ROLLUP);
      expect(Reflect.get(revoked ?? {}, "relations")).toBeDefined();
    });
  });

  describe("tenant isolation", () => {
    it("decides the closed databases and the refusals per tenant: a grant in another tenant opens nothing here", async () => {
      const otherTenantId = await createTestTenant(adminPool);
      const inOther = <T>(fn: () => Promise<T>) => runInTenant(otherTenantId, fn);
      await inOther(() => seedSystem(dataPool, createViewTypeRegistry()));
      const otherHealth = await systemDatabase(HEALTH_RECORDS_MODULE_ID, dataPool, otherTenantId);
      const otherProjects = await systemDatabase(PROJECTS_MODULE_ID, dataPool, otherTenantId);
      const otherAgent = await inOther(() => createTestProjectItem(dataPool));
      await inOther(() =>
        withTransaction(dataPool, (client) =>
          setAgentDatabaseGrant(client, { projectItemId: otherAgent, databaseId: otherHealth.id, access: "read" }),
        ),
      );

      // The other tenant's agent holds a read grant in its own tenant: its health records are open there.
      const otherClosed = await inOther(() =>
        withTransaction(dataPool, (client) => listClosedSensitiveDatabaseIds(client, otherAgent)),
      );
      expect(otherClosed.has(otherHealth.id)).toBe(false);
      // Another tenant's Health records are not visible here, so they cannot be listed as closed for this agent.
      expect(otherClosed.has(health.id)).toBe(false);
      const otherFilter = { type: "relation_is_not_empty", property: "healthRecords" };
      await expect(
        inOther(() => cp.queryDatabaseItems(otherProjects.id, { filter: otherFilter }, undefined, otherAgent)),
      ).resolves.toBeDefined();

      // The same project id read in this tenant has no grant here: the set is this tenant's, and the filter is refused.
      const closedHere = await inTransaction((client) => listClosedSensitiveDatabaseIds(client, otherAgent));
      expect(closedHere.has(health.id)).toBe(true);
      expect(closedHere.has(otherHealth.id)).toBe(false);
      await expect(queryDatabase({ filter: otherFilter }, otherAgent)).rejects.toMatchObject(FORBIDDEN);

      // A project of the other tenant with no grant: its Health records are closed in its own tenant and this tenant's are
      // not listed there, and the other tenant's database is not listed here, because the row is invisible and not
      // because a grant opened it. These two assertions fail when the tenant scope is missing.
      const bareOtherAgent = await inOther(() => createTestProjectItem(dataPool));
      const bareClosedThere = await inOther(() =>
        withTransaction(dataPool, (client) => listClosedSensitiveDatabaseIds(client, bareOtherAgent)),
      );
      expect(bareClosedThere.has(otherHealth.id)).toBe(true);
      expect(bareClosedThere.has(health.id)).toBe(false);
      const bareClosedHere = await inTransaction((client) => listClosedSensitiveDatabaseIds(client, bareOtherAgent));
      expect(bareClosedHere.has(health.id)).toBe(true);
      expect(bareClosedHere.has(otherHealth.id)).toBe(false);
    });
  });
});
