import type { CollectionMetadataResolver } from "@alldots/data";
import { randomUUID } from "node:crypto";
import { createItemWithClient, getDatabaseByModuleId, withTransaction } from "@alldots/data";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "@alldots/data/testSupport";
import {
  createAgentRun,
  insertValueLink,
  createUser as createPersistedUser,
  createChokePoint,
  createDocStore,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
  type ChokePoint,
  type ItemRow,
  type PropertyRow,
  type ViewRow,
} from "@alldots/data";
import type { ModuleRegistry } from "@alldots/module-registry";
import {
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  REST_ONLY_OPERATION_NAMES,
  runAsSystem,
  runInTenant,
  type GenericOperationName,
} from "@alldots/shared";
import {
  createGenericOperationAgentTools,
  listGrantedGenericOperationAgentTools,
} from "../tools/generic/genericOperationAgentTools.js";

const testMetadataResolver: CollectionMetadataResolver = {
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

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry: ModuleRegistry = await loadFullModuleRegistry();
const DESTRUCTIVE_OPERATIONS: readonly GenericOperationName[] = GENERIC_OPERATION_NAMES.filter(
  (operation) => OPERATION_METADATA[operation].requiresApproval,
);

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

async function projectsDatabaseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`);
  if (!rows[0]) throw new Error("Projects database was not seeded");
  return rows[0].id;
}

async function createProjectItem(): Promise<string> {
  const projectsDbId = await projectsDatabaseId();
  const item = await chokePoint.createItem({ databaseId: projectsDbId, properties: {} });
  return item.id;
}

interface Fixtures {
  database: { id: string };
  property: PropertyRow;
  /** A multi_select property with one option, the target of the three REST-only option operations. */
  optionProperty: PropertyRow;
  itemA: ItemRow;
  itemB: ItemRow;
  view: ViewRow;
  viewActor: { type: "ai_agent"; agentProjectItemId: string };
  targetDatabase: { id: string };
  targetItem: ItemRow;
  relationProperty: PropertyRow;
  singleRelationProperty: PropertyRow;
  secondTarget: ItemRow;
  /** Present only after the `prepare` of a case that needs an existing page. */
  subpageItemId?: string;
  /** Present with `subpageItemId` after the `prepare` of `page.convertToBlock`. */
  subpageBlockId?: string;
  /** Present only after the `prepare` of `page.replace`. */
  pageEtag?: string;
}

/**
 * Creates the view as the same `ai_agent` actor every case uses: `assertViewWritable` rejects an agent's write to a
 * view it did not create, regardless of grant.
 */
async function buildFixtures(agentProjectItemId: string): Promise<Fixtures> {
  const viewActor = { type: "ai_agent" as const, agentProjectItemId };
  const database = await chokePoint.createDatabase({ name: "AgentTools Contract DB" });
  const property = await chokePoint.createProperty({
    databaseId: database.id,
    key: "title",
    name: "Title",
    type: "text",
  });
  const optionProperty = await chokePoint.createProperty({
    databaseId: database.id,
    key: "tags",
    name: "Tags",
    type: "multi_select",
    config: { options: [{ key: "herbs", label: "Herbs" }] },
  });
  const itemA = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Arrival" } });
  const itemB = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune" } });
  const view = await chokePoint.createView(
    { type: "list", name: "Collection", config: { membership: "manual" } },
    viewActor,
  );
  await chokePoint.addViewItem({ viewId: view.id, itemId: itemA.id, position: 0, actor: viewActor });

  const targetDatabase = await chokePoint.createDatabase({ name: "AgentTools Contract Targets" });
  const targetItem = await chokePoint.createItem({ databaseId: targetDatabase.id, properties: {} });
  const secondTarget = await chokePoint.createItem({ databaseId: targetDatabase.id, properties: {} });
  const { property: relationProperty } = await chokePoint.createRelationProperty({
    sourceDatabaseId: database.id,
    key: "assignedTo",
    name: "Assigned To",
    targetDatabaseId: targetDatabase.id,
    inverse: { key: "assignedFrom", name: "Assigned From" },
  });
  await chokePoint.createRelation({
    relationPropertyId: relationProperty.id,
    callerItemId: itemA.id,
    targetItemId: targetItem.id,
  });
  const { property: singleRelationProperty } = await chokePoint.createRelationProperty({
    sourceDatabaseId: database.id,
    key: "singleTarget",
    name: "Single target",
    targetDatabaseId: targetDatabase.id,
    cardinality: "one_to_one",
  });
  await chokePoint.createRelation({
    relationPropertyId: singleRelationProperty.id,
    callerItemId: itemB.id,
    targetItemId: targetItem.id,
  });

  return {
    database,
    property,
    optionProperty,
    itemA,
    itemB,
    view,
    viewActor,
    targetDatabase,
    targetItem,
    relationProperty,
    singleRelationProperty,
    secondTarget,
  };
}

interface Case {
  args: (fx: Fixtures) => unknown;
  /** Applied directly through `chokePoint`, not through the tool under test. */
  prepare?: (fx: Fixtures) => Promise<void>;
}

/**
 * One AgentTool call per catalog operation, mirroring the REST and MCP contract tests. Destructive operations are
 * expected to return the pending-approval result.
 */
const CASES: Record<GenericOperationName, Case> = {
  "database.list": { args: () => ({}) },
  "database.get": { args: (fx) => ({ databaseId: fx.database.id }) },
  "database.create": { args: () => ({ name: "AgentTools Contract Create" }) },
  "database.patch": { args: (fx) => ({ databaseId: fx.database.id, patch: { name: "Renamed" } }) },
  "database.archive": { args: (fx) => ({ databaseId: fx.database.id }) },
  "database.restore": {
    args: (fx) => ({ databaseId: fx.database.id }),
    prepare: async (fx) => {
      await chokePoint.archiveDatabase(fx.database.id);
    },
  },
  "property.list": { args: (fx) => ({ databaseId: fx.database.id }) },
  "property.get": { args: (fx) => ({ propertyId: fx.property.id }) },
  "property.getByKey": { args: (fx) => ({ databaseId: fx.database.id, key: fx.property.key }) },
  "property.create": { args: (fx) => ({ databaseId: fx.database.id, key: "score", name: "Score", type: "number" }) },
  "property.patch": { args: (fx) => ({ propertyId: fx.property.id, patch: { name: "New Title" } }) },
  "property.delete": { args: (fx) => ({ propertyId: fx.property.id }) },
  // REST-only: valid arguments, so only the gateway's refusal keeps these from running.
  "property.option.add": { args: (fx) => ({ propertyId: fx.optionProperty.id, label: "Spices" }) },
  "property.option.update": {
    args: (fx) => ({ propertyId: fx.optionProperty.id, key: "herbs", label: "Fresh herbs" }),
  },
  "property.option.remove": { args: (fx) => ({ propertyId: fx.optionProperty.id, key: "herbs" }) },
  "view.list": { args: () => ({}) },
  "view.get": { args: (fx) => ({ viewId: fx.view.id }) },
  "view.create": { args: (fx) => ({ databaseId: fx.database.id, type: "table", name: "All rows" }) },
  "view.patch": { args: (fx) => ({ viewId: fx.view.id, patch: { name: "Renamed view" } }) },
  "view.delete": { args: (fx) => ({ viewId: fx.view.id }) },
  "view.query": { args: (fx) => ({ viewId: fx.view.id }) },
  "viewItem.add": { args: (fx) => ({ viewId: fx.view.id, itemId: fx.itemB.id, position: 1 }) },
  "viewItem.remove": { args: (fx) => ({ viewId: fx.view.id, itemId: fx.itemA.id }) },
  "viewItem.reorder": {
    args: (fx) => ({ viewId: fx.view.id, itemId: fx.itemB.id, position: 0 }),
    prepare: async (fx) => {
      await chokePoint.addViewItem({ viewId: fx.view.id, itemId: fx.itemB.id, position: 1, actor: fx.viewActor });
    },
  },
  "item.get": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "item.create": {
    args: (fx) => ({
      databaseId: fx.database.id,
      properties: { title: "Contract Item" },
      relations: [{ propertyKey: fx.relationProperty.key, targetItemIds: [fx.targetItem.id] }],
    }),
  },
  "item.patch": {
    args: (fx) => ({ itemId: fx.itemA.id, properties: { title: "Updated" }, ifVersion: fx.itemA.version }),
  },
  "item.delete": { args: (fx) => ({ itemId: fx.itemB.id }) },
  "item.restore": {
    args: (fx) => ({ itemId: fx.itemB.id }),
    prepare: async (fx) => {
      await chokePoint.softDeleteItem(fx.database.id, fx.itemB.id);
    },
  },
  "database.query": { args: (fx) => ({ databaseId: fx.database.id }) },
  "relation.put": {
    args: (fx) => ({
      relationPropertyId: fx.relationProperty.id,
      callerItemId: fx.itemB.id,
      targetItemId: fx.targetItem.id,
    }),
  },
  "relation.set": {
    args: (fx) => ({
      relationPropertyId: fx.singleRelationProperty.id,
      callerItemId: fx.itemB.id,
      targetItemId: fx.secondTarget.id,
    }),
  },
  "relation.delete": {
    args: (fx) => ({
      relationPropertyId: fx.relationProperty.id,
      callerItemId: fx.itemA.id,
      targetItemId: fx.targetItem.id,
    }),
  },
  "relation.list": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "relation.related": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "link.unlink": {
    args: (fx) => ({ itemId: fx.itemA.id, propertyKey: "title" }),
    prepare: async (fx) => {
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: fx.itemA.id,
          propertyKey: "title",
          ruleKey: "test",
          sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
        }),
      );
    },
  },
  "link.relink": {
    args: (fx) => ({ itemId: fx.itemA.id, propertyKey: "title" }),
    prepare: async (fx) => {
      await withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: fx.itemA.id,
          propertyKey: "title",
          ruleKey: "test",
          state: "broken",
          brokenBy: "user",
          brokenAt: new Date(),
          sources: [{ kind: "item", sourceItemId: fx.itemB.id, sourcePropertyKey: "title" }],
        }),
      );
    },
  },
  "page.ensure": { args: (fx) => ({ itemId: fx.itemA.id }) },
  "page.ensureJournalPeriod": { args: () => ({ type: "week", date: "2026-10-16" }) },
  // Held for approval, even for a period without duplicates.
  "page.mergeJournalDuplicates": { args: () => ({ type: "day", period: "2026-10-16" }) },
  "page.createSubpage": { args: (fx) => ({ parent: { itemId: fx.itemA.id }, title: "Agent subpage" }) },
  "page.duplicate": {
    args: (fx) => ({ pageItemId: fx.subpageItemId }),
    prepare: async (fx) => {
      const created = await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id } }, "user");
      fx.subpageItemId = created.pages[0]?.pageItemId;
    },
  },
  "page.rename": {
    args: (fx) => ({ pageItemId: fx.subpageItemId, title: "Renamed by the agent" }),
    prepare: async (fx) => {
      const created = await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id } }, "user");
      fx.subpageItemId = created.pages[0]?.pageItemId;
    },
  },
  // Held for approval, with the current count of pages the block names.
  "page.convertToBlock": {
    args: (fx) => ({ parentItemId: fx.itemA.id, blockId: fx.subpageBlockId, type: "text", confirmedPageCount: 1 }),
    prepare: async (fx) => {
      const created = await createDocStore(pool).createSubpage({ parent: { itemId: fx.itemA.id } }, "user");
      fx.subpageItemId = created.pages[0]?.pageItemId;
      fx.subpageBlockId = created.pages[0]?.blockId;
    },
  },
  "page.insert": { args: (fx) => ({ itemId: fx.itemA.id, placement: "end", markdown: "Agent text" }) },
  // Held for approval, with the page's current version token.
  "page.replace": {
    args: (fx) => ({ itemId: fx.itemA.id, markdown: "Agent replacement", expectedEtag: fx.pageEtag }),
    prepare: async (fx) => {
      fx.pageEtag = (await createDocStore(pool).readPageMarkdown(fx.itemA.id)).etag;
    },
  },
  "page.changes": { args: (fx) => ({ itemId: fx.itemA.id, since: new Date(Date.now() - 60 * 1000).toISOString() }) },
  "page.get": { args: (fx) => ({ itemId: fx.itemA.id, format: "summary" }) },
  "page.restoreVersion": {
    // The instant sits inside the history `prepare` opens, so only the approval gate stands between the call and the restore.
    args: (fx) => ({ itemId: fx.itemA.id, at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
    prepare: async (fx) => {
      await createDocStore(pool).putBlock(
        fx.itemA.id,
        { id: "b1", flavour: "paragraph", fields: { content: "first" } },
        "user",
      );
      await pool.query(`UPDATE docs SET history_available_from = now() - interval '1 hour' WHERE item_id = $1`, [
        fx.itemA.id,
      ]);
      await pool.query(
        `UPDATE doc_snapshot_history SET represented_at = now() - interval '1 hour'
         WHERE through_update_id = 0 AND doc_id = (SELECT id FROM docs WHERE item_id = $1)`,
        [fx.itemA.id],
      );
    },
  },
  "item.count": { args: (fx) => ({ items: [{ databaseId: fx.database.id, groupBy: fx.relationProperty.key }] }) },
  "database.facets": {
    args: (fx) => ({ databaseId: fx.database.id, facets: [fx.relationProperty.key, fx.optionProperty.key] }),
  },
  // "Arrival" is the title of a fixture item in a user-created collection, which global search never reads.
  search: { args: () => ({ q: "Arrival" }) },
};

describe("generic operation AgentTools contract (issue #220)", () => {
  it("sanitizes Emails.body on the agent item.get tool", async () => {
    const raw = '<p onclick="evil()">safe</p><script>evil()</script><img src="https://tracker.example/pixel">';
    const item = await withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, "emails");
      if (!database) throw new Error("Emails not seeded");
      return createItemWithClient(
        client,
        { databaseId: database.id, properties: { body: raw } },
        { allowedSystemKeys: ["body"] },
      );
    });

    const projectItemId = await createProjectItem();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "read email" });
    const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
    const result = await tools["item.get"](run.id, { itemId: item.id });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain("safe");
    expect(result.result).not.toMatch(/<script|onclick|https:\/\/tracker/i);
  });
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("discovers and invokes the page operations through a persisted project agent, which a sensitive database still refuses (issue #1844)", async () => {
    const projectItemId = await createProjectItem();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "page grants" });
    const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
    const discovered = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver);
    for (const name of ["page.get", "page.ensure", "page.restoreVersion", "page.insert", "page.changes"] as const) {
      expect(discovered).toContain(name);
    }

    const read = await tools["page.get"](run.id, { itemId: projectItemId });
    expect(read.error).toBe(false);
    const written = await tools["page.insert"](run.id, { itemId: projectItemId, placement: "end", markdown: "Hello" });
    expect(written.error).toBe(false);

    const health = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords"));
    if (!health) throw new Error("Health records not seeded");
    const record = await chokePoint.createItem({ databaseId: health.id, properties: { name: "Private diagnosis" } });
    for (const outcome of [
      await tools["page.get"](run.id, { itemId: record.id }),
      await tools["page.insert"](run.id, { itemId: record.id, placement: "end", markdown: "Refused" }),
    ]) {
      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^forbidden:/);
    }
    expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [record.id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM approval_requests WHERE agent_run_id = $1", [run.id])).rows).toHaveLength(
      0,
    );
  });

  it("writes a summary into the Journal week of a date through the AgentTool names page.ensureJournalPeriod and page.insert, authored ai_agent (issue #1861)", async () => {
    const projectItemId = await createProjectItem();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "journal summary" });
    const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
    expect(await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver)).toContain(
      "page.ensureJournalPeriod",
    );

    const ensured = await tools["page.ensureJournalPeriod"](run.id, { type: "week", date: "2026-10-16" });
    expect(ensured.error).toBe(false);
    const week: unknown = JSON.parse(ensured.result);
    if (typeof week !== "object" || week === null || !("itemId" in week) || typeof week.itemId !== "string") {
      throw new Error("Missing itemId in the week");
    }
    const weekItemId = week.itemId;
    expect(week).toMatchObject({ period: "2026-W42" });
    const again = await tools["page.ensureJournalPeriod"](run.id, { type: "week", period: "2026-W42" });
    expect(JSON.parse(again.result)).toMatchObject({ itemId: weekItemId });
    const inserted = await tools["page.insert"](run.id, {
      itemId: weekItemId,
      placement: "end",
      markdown: "Sprint summary",
    });
    expect(inserted.error).toBe(false);

    const authors = await pool.query<{ created_by: string }>(
      `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
      [weekItemId],
    );
    expect(authors.rows.map((row) => row.created_by)).toEqual(["ai_agent"]);
    const refused = await tools["page.ensureJournalPeriod"](run.id, { type: "week", period: "2026-W99" });
    expect(refused.error).toBe(true);
    expect(refused.result).toMatch(/^validation_failed:/);
  });

  it("holds page.mergeJournalDuplicates for a day with two live entries for approval through its AgentTool name and merges nothing (issue #2017)", async () => {
    const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
    if (!journal) throw new Error("Journal not seeded");
    // Two live entries of one period are a state the lazy creation never produces, so the fixture creates them directly.
    const entries: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      const created = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: journal.id, properties: { name: "\u{1F4D3} 2037-05-01", type: "day", period: "2037-05-01" } },
          { allowedSystemKeys: ["name", "type", "period"] },
        ),
      );
      entries.push(created.id);
    }
    const projectItemId = await createProjectItem();
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "journal merge" });
    const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
    expect(await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id, testMetadataResolver)).toContain(
      "page.mergeJournalDuplicates",
    );

    const outcome = await tools["page.mergeJournalDuplicates"](run.id, { type: "day", period: "2037-05-01" });

    expect(outcome.error).toBe(false);
    expect(outcome.result).toContain("requires human approval");
    const requests = await pool.query<{ tool_name: string; status: string; payload: { operationName?: string } }>(
      `SELECT tool_name, status, payload FROM approval_requests WHERE agent_run_id = $1`,
      [run.id],
    );
    expect(requests.rows).toEqual([
      {
        tool_name: "page.mergeJournalDuplicates",
        status: "pending",
        payload: expect.objectContaining({ operationName: "page.mergeJournalDuplicates" }),
      },
    ]);
    const live = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [entries],
    );
    expect(live.rows.map((row) => row.id).sort()).toEqual([...entries].sort());
    const refused = await tools["page.mergeJournalDuplicates"](run.id, { type: "day", period: "2026-02-30" });
    expect(refused.error).toBe(true);
    expect(refused.result).toMatch(/^validation_failed:/);
  });

  it("refuses deletion of a system project and filters it through actual agent tools", async () => {
    const runtime = await createRuntimeRolePool(pool, "alldots_data");
    let failure: { error: unknown } | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      const tenant = await createTestTenant(pool);
      const user = await runAsSystem("test:system-project-agent", () =>
        createPersistedUser(pool, {
          tenantId: tenant,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused-test-hash",
        }),
      );
      await runInTenant(tenant, async () => {
        await seedSystem(runtime, createViewTypeRegistry());
        const cp = createChokePoint(runtime);
        const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
        if (!projects) throw new Error("System databases missing");
        const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Agent" } });
        const run = await createAgentRun(runtime, {
          projectItemId: project.id,
          userId: user.id,
          triggeredBy: "user",
          task: "query Projects",
        });
        const system = (await cp.listItems(projects.id)).items.find((item) => item.properties.systemActive === true);
        if (!system) throw new Error("System project missing");
        const userProject = await cp.createItem({ databaseId: projects.id, properties: { name: "User project" } });
        const tools = createGenericOperationAgentTools(runtime, moduleRegistry, testMetadataResolver);
        const query = await tools["database.query"](run.id, {
          databaseId: projects.id,
          filter: { type: "is_empty", property: "systemActive" },
        });
        expect(query.error).toBe(false);
        const result: unknown = JSON.parse(query.result);
        expect(result).toMatchObject({
          items: expect.arrayContaining([expect.objectContaining({ id: userProject.id })]),
        });
        expect(query.result).not.toContain(system.id);
        const refused = await tools["item.delete"](run.id, { itemId: system.id });
        expect(refused.error).toBe(true);
        expect(refused.result).toMatch(/^forbidden:.*system-active/);
        expect(refused.approvalRequestId).toBeUndefined();
        expect(await cp.getItem(projects.id, system.id)).toEqual(system);
        const approvals = await runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1",
          [run.id],
        );
        expect(approvals.rows[0]?.count).toBe(0);
      });
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await runtime.end();
      } catch (error) {
        cleanupFailure = { error };
      }
    }
    if (failure) {
      if (cleanupFailure) console.error("System project agent fixture cleanup also failed");
      throw failure.error;
    }
    if (cleanupFailure) throw cleanupFailure.error;
  });

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  it("executes relation.set and item.create through AgentTools under tenant RLS", async () => {
    const runtime = await createRuntimeRolePool(pool, "alldots_data");
    let failure: { error: unknown } | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      const role = await runAsSystem("test:verify-runtime-role", () =>
        runtime.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ role_name: "alldots_data", rolsuper: false, rolbypassrls: false }]);
      const ownTenant = await createTestTenant(pool);
      const foreignTenant = await createTestTenant(pool);
      const user = await runAsSystem("test:create-agent-user", () =>
        createPersistedUser(pool, {
          tenantId: ownTenant,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused-test-hash",
        }),
      );
      const cp = createChokePoint(runtime);
      async function fixture(tenantId: string) {
        return runInTenant(tenantId, async () => {
          await seedSystem(runtime, createViewTypeRegistry());
          const source = await cp.createDatabase({ name: "Runtime source" });
          const target = await cp.createDatabase({ name: "Runtime target" });
          const { property } = await cp.createRelationProperty({
            sourceDatabaseId: source.id,
            targetDatabaseId: target.id,
            key: "link",
            name: "Link",
            cardinality: "one_to_one",
          });
          const caller = await cp.createItem({ databaseId: source.id, properties: {} });
          const first = await cp.createItem({ databaseId: target.id, properties: {} });
          const second = await cp.createItem({ databaseId: target.id, properties: {} });
          const third = await cp.createItem({ databaseId: target.id, properties: {} });
          await cp.setRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: first.id });
          return { source, property, caller, first, second, third };
        });
      }
      const own = await fixture(ownTenant);
      const foreign = await fixture(foreignTenant);
      const run = await runInTenant(ownTenant, async () => {
        const projects = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects"));
        if (!projects) throw new Error("Missing projects database");
        const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Runtime agent" } });
        return createAgentRun(runtime, {
          projectItemId: project.id,
          userId: user.id,
          triggeredBy: "user",
          task: "runtime contract",
        });
      });
      const tools = createGenericOperationAgentTools(runtime, moduleRegistry, testMetadataResolver);
      await runInTenant(ownTenant, async () => {
        const moved = await tools["relation.set"](run.id, {
          relationPropertyId: own.property.id,
          callerItemId: own.caller.id,
          targetItemId: own.second.id,
        });
        expect(moved.error).toBe(false);
        expect(moved.approvalRequestId).toBeUndefined();
        expect(await cp.listItemRelations(own.caller.id, own.property.id)).toMatchObject([
          { targetItemId: own.second.id },
        ]);
        const created = await tools["item.create"](run.id, {
          databaseId: own.source.id,
          properties: {},
          relations: [{ propertyKey: "link", targetItemIds: [own.third.id] }],
        });
        expect(created.error).toBe(false);
        expect(created.approvalRequestId).toBeUndefined();
        const parsed: unknown = JSON.parse(created.result);
        if (typeof parsed !== "object" || parsed === null || !("id" in parsed) || typeof parsed.id !== "string")
          throw new Error("Missing created item id");
        expect(await cp.listItemRelations(parsed.id, own.property.id)).toMatchObject([{ targetItemId: own.third.id }]);
      });
      async function snapshot(tenantId: string) {
        return runInTenant(tenantId, async () => {
          const items = await runtime.query<{
            id: string;
            database_id: string;
            properties: unknown;
            computed: unknown;
            deleted_at: Date | null;
            updated_at: Date;
          }>("SELECT id, database_id, properties, computed, deleted_at, updated_at FROM items ORDER BY id");
          const edges = await runtime.query<{ id: string; item_a: string; item_b: string }>(
            "SELECT id, item_a, item_b FROM item_relations ORDER BY id",
          );
          const approvals = await runtime.query<{ id: string; status: string }>(
            "SELECT id, status FROM approval_requests ORDER BY id",
          );
          return { items: items.rows, edges: edges.rows, approvals: approvals.rows };
        });
      }
      const ownBefore = await snapshot(ownTenant);
      const foreignBefore = await snapshot(foreignTenant);
      const missing = randomUUID();
      for (const operation of ["relation.set", "item.create"] as const) {
        const call = (targetItemId: string) =>
          operation === "relation.set"
            ? tools[operation](run.id, {
                relationPropertyId: own.property.id,
                callerItemId: own.caller.id,
                targetItemId,
              })
            : tools[operation](run.id, {
                databaseId: own.source.id,
                properties: {},
                relations: [{ propertyKey: "link", targetItemIds: [targetItemId] }],
              });
        const denied = await runInTenant(ownTenant, () => call(foreign.third.id));
        const absent = await runInTenant(ownTenant, () => call(missing));
        expect(denied.error).toBe(true);
        expect(absent.error).toBe(true);
        expect(denied.result.replaceAll(foreign.third.id, "<target>")).toBe(
          absent.result.replaceAll(missing, "<target>"),
        );
        expect(await snapshot(ownTenant)).toEqual(ownBefore);
        expect(await snapshot(foreignTenant)).toEqual(foreignBefore);
      }
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await runtime.end();
      } catch (error) {
        cleanupFailure = { error };
      }
    }
    if (failure) {
      if (cleanupFailure) console.error("AgentTool runtime fixture cleanup also failed");
      throw failure.error;
    }
    if (cleanupFailure) throw cleanupFailure.error;
  });

  for (const operation of GENERIC_OPERATION_NAMES) {
    // `link.unlink` of the fixture's active value link is flagged by the write itself, so it queues an approval request
    // like a destructive operation.
    const isDestructive = DESTRUCTIVE_OPERATIONS.includes(operation) || operation === "link.unlink";
    it(`${isDestructive ? "queues an approval request for" : "dispatches"} ${operation} through the AgentTool adapter`, async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, {
        projectItemId,
        triggeredBy: "user",
        task: `contract test ${operation}`,
      });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      expect(Object.keys(tools)).toContain("relation.set");
      const fx = await buildFixtures(projectItemId);
      const testCase = CASES[operation];
      await testCase.prepare?.(fx);

      // The approval projection reserves rows of the run's tenant, so a link-ending write runs inside that scope.
      const outcome =
        operation === "link.unlink"
          ? await inTenantZero(() => tools[operation](run.id, testCase.args(fx)))
          : await tools[operation](run.id, testCase.args(fx));

      if (REST_ONLY_OPERATION_NAMES.some((name) => name === operation)) {
        expect(outcome.error).toBe(true);
        expect(outcome.approvalRequestId).toBeUndefined();
        expect(outcome.result).toContain("Unknown operation");
        // The refused call wrote nothing: the option list is as the fixture created it.
        expect((await chokePoint.getProperty(fx.optionProperty.id))?.config).toEqual(fx.optionProperty.config);
      } else if (isDestructive) {
        expect(outcome.error).toBe(false);
        expect(outcome.result).toContain("requires human approval");
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1`,
          [run.id],
        );
        expect(rows[0]!.count).toBe(1);
      } else {
        expect(outcome.error).toBe(false);
        if (operation === "relation.set") {
          const relations = await chokePoint.listItemRelations(fx.itemB.id, fx.singleRelationProperty.id);
          expect(relations).toMatchObject([{ targetItemId: fx.secondTarget.id }]);
        }
        if (operation === "page.createSubpage") {
          // A direct write attributed to the agent: one `ai_agent` update on the parent's page document and no approval
          // request.
          const { rows } = await pool.query<{ created_by: string }>(
            `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id
             WHERE d.item_id = $1 ORDER BY u.id`,
            [fx.itemA.id],
          );
          expect(rows.map((row) => row.created_by)).toEqual(["ai_agent"]);
        }
        if (operation === "page.ensureJournalPeriod") {
          // The week containing the date, named by its canonical key, created for the run's tenant.
          expect(JSON.parse(outcome.result)).toMatchObject({ period: "2026-W42", range: { from: "2026-10-12" } });
        }
        if (operation === "item.count") {
          // Both fixture items are counted; only `itemA` has a target under the grouping relation.
          const counts: unknown = JSON.parse(outcome.result);
          expect(counts).toEqual([
            {
              databaseId: fx.database.id,
              count: 2,
              groups: [
                { key: fx.targetItem.id, count: 1 },
                { key: null, count: 1 },
              ],
            },
          ]);
        }
        if (operation === "database.facets") {
          // Only `itemA` has a target under the relation, and neither fixture item holds a tag.
          const facets: unknown = JSON.parse(outcome.result);
          expect(facets).toEqual([
            {
              property: fx.relationProperty.key,
              all: 2,
              values: [
                { value: fx.targetItem.id, label: "", count: 1 },
                { value: null, count: 1 },
              ],
            },
            { property: fx.optionProperty.key, all: 2, values: [{ value: null, count: 2 }] },
          ]);
        }
        if (operation === "search") {
          // The fixture items sit in a user-created collection, which is not part of global search.
          expect(JSON.parse(outcome.result)).toEqual({ groups: [] });
        }
        if (operation === "page.duplicate" || operation === "page.rename") {
          // The agent's write to the parent's page follows the block `prepare` wrote as the user, and is authored by
          // the agent.
          const { rows } = await pool.query<{ created_by: string }>(
            `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id
             WHERE d.item_id = $1 ORDER BY u.id`,
            [fx.itemA.id],
          );
          expect(rows.map((row) => row.created_by)).toEqual(["user", "ai_agent"]);
        }
        if (operation === "item.create") {
          const { rows } = await pool.query<{ id: string }>(
            "SELECT id FROM items WHERE database_id = $1 AND properties->>'title' = $2",
            [fx.database.id, "Contract Item"],
          );
          expect(rows).toHaveLength(1);
          const created = rows[0];
          if (!created) throw new Error("Expected created item");
          expect(await chokePoint.listItemRelations(created.id, fx.relationProperty.id)).toMatchObject([
            { targetItemId: fx.targetItem.id },
          ]);
        }
        // A non-destructive call runs without an approval request.
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1`,
          [run.id],
        );
        expect(rows[0]!.count).toBe(0);
      }
    });
  }

  /**
   * AgentTool-adapter parity cases: `database_archived`, relation type/config patch rejection, and direct
   * `relationPropertyId` supply.
   */
  describe("issue #220 parity: database_archived, relation patch rejection, relation direct supply", () => {
    it("surfaces database_archived (issue #83) as a ChokePointError-shaped result for a write against an archived database", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "archived db write" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const fx = await buildFixtures(projectItemId);
      await chokePoint.archiveDatabase(fx.database.id);

      const outcome = await tools["item.create"](run.id, {
        databaseId: fx.database.id,
        properties: { title: "Arrival" },
      });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^database_archived:/);
    });

    it("rejects patch.type on a relation property (issue #219)", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "relation patch" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const fx = await buildFixtures(projectItemId);

      const outcome = await tools["property.patch"](run.id, {
        propertyId: fx.relationProperty.id,
        patch: { type: "text" },
      });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toContain("is a relation; type is changed only via its relation definition");
    });

    it("rejects patch.config on a relation property (issue #219)", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "relation patch" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const fx = await buildFixtures(projectItemId);

      const outcome = await tools["property.patch"](run.id, {
        propertyId: fx.relationProperty.id,
        patch: { config: { note: "x" } },
      });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toContain("is a relation; config is changed only via its relation definition");
    });

    it("rejects a non-relation property id supplied directly as relationPropertyId — contrast with REST's key-based route resolution", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "bad relation id" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry, testMetadataResolver);
      const fx = await buildFixtures(projectItemId);

      // AgentTools has no route layer: it takes `relationPropertyId` directly, and the choke point rejects a valid id
      // that names no relation property.
      const outcome = await tools["relation.put"](run.id, {
        relationPropertyId: fx.property.id,
        callerItemId: fx.itemA.id,
        targetItemId: fx.targetItem.id,
      });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toContain("is not a relation property");
    });
  });
});
