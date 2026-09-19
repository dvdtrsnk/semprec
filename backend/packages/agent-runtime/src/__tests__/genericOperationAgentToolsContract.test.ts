import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
  type ChokePoint,
  type ItemRow,
  type PropertyRow,
  type ViewRow,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { GENERIC_OPERATION_NAMES, OPERATION_METADATA, type GenericOperationName } from "@semprec/shared";
import { createGenericOperationAgentTools } from "../tools/generic/genericOperationAgentTools.js";

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry: ModuleRegistry = await loadFullModuleRegistry();
const DESTRUCTIVE_OPERATIONS: readonly GenericOperationName[] = GENERIC_OPERATION_NAMES.filter(
  (operation) => OPERATION_METADATA[operation].requiresApproval,
);

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
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
  itemA: ItemRow;
  itemB: ItemRow;
  view: ViewRow;
  viewActor: { type: "ai_agent"; agentProjectItemId: string };
  targetDatabase: { id: string };
  targetItem: ItemRow;
  relationProperty: PropertyRow;
}

/**
 * Creates the view (and its initial membership) as the same `ai_agent` actor every case in this
 * file dispatches through — required by `assertViewWritable` (issue #87), which rejects an agent
 * actor's patch/membership write to a view it did not itself create, regardless of capability
 * grant.
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
  const itemA = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Arrival" } });
  const itemB = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune" } });
  const view = await chokePoint.createView(
    { type: "list", name: "Collection", config: { membership: "manual" } },
    viewActor,
  );
  await chokePoint.addViewItem({ viewId: view.id, itemId: itemA.id, position: 0, actor: viewActor });

  const targetDatabase = await chokePoint.createDatabase({ name: "AgentTools Contract Targets" });
  const targetItem = await chokePoint.createItem({ databaseId: targetDatabase.id, properties: {} });
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

  return { database, property, itemA, itemB, view, viewActor, targetDatabase, targetItem, relationProperty };
}

interface Case {
  args: (fx: Fixtures) => unknown;
  /** State a case needs already in place before its own operation runs, applied directly through `chokePoint` rather than through the tool under test — mirrors `mcpGenericOperationsContract.test.ts`'s own `prepare` hook. */
  prepare?: (fx: Fixtures) => Promise<void>;
}

/**
 * One AgentTool call per operation in the closed 28-operation catalog, mirroring
 * `genericOperationsContract.test.ts`'s REST pattern and `mcpGenericOperationsContract.test.ts`'s
 * MCP pattern one adapter over (the code-review finding on issue #220's diff: parameterized
 * contract tests across all 28 operations were missing for the AgentTool adapter). Every
 * destructive operation is expected to return the synthetic-success/pending-approval result
 * `genericOperationAgentTools.test.ts` already covers for `view.delete` alone — this file extends
 * that coverage to the other four destructive operations, plus dispatch coverage for the 23
 * non-destructive ones.
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
  "property.create": { args: (fx) => ({ databaseId: fx.database.id, key: "score", name: "Score", type: "number" }) },
  "property.patch": { args: (fx) => ({ propertyId: fx.property.id, patch: { name: "New Title" } }) },
  "property.delete": { args: (fx) => ({ propertyId: fx.property.id }) },
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
  "item.create": { args: (fx) => ({ databaseId: fx.database.id, properties: { title: "Contract Item" } }) },
  "item.patch": {
    args: (fx) => ({ itemId: fx.itemA.id, properties: { title: "Updated" }, ifVersion: fx.itemA.updatedAt }),
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
  "relation.delete": {
    args: (fx) => ({
      relationPropertyId: fx.relationProperty.id,
      callerItemId: fx.itemA.id,
      targetItemId: fx.targetItem.id,
    }),
  },
};

describe("generic operation AgentTools contract (issue #220)", () => {
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

  it("has exactly one contract case per operation in the closed catalog", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  for (const operation of GENERIC_OPERATION_NAMES) {
    const isDestructive = DESTRUCTIVE_OPERATIONS.includes(operation);
    it(`${isDestructive ? "queues an approval request for" : "dispatches"} ${operation} through the AgentTool adapter`, async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, {
        projectItemId,
        triggeredBy: "user",
        task: `contract test ${operation}`,
      });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);
      const fx = await buildFixtures(projectItemId);
      const testCase = CASES[operation];
      await testCase.prepare?.(fx);

      const outcome = await tools[operation](run.id, testCase.args(fx));

      if (isDestructive) {
        expect(outcome.error).toBe(false);
        expect(outcome.result).toContain("requires human approval");
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1`,
          [run.id],
        );
        expect(rows[0]!.count).toBe(1);
      } else {
        expect(outcome.error).toBe(false);
      }
    });
  }

  /**
   * The AgentTool-adapter equivalents of the parity cases the code-review finding on issue #220's
   * diff called out by name (`database_archived`, relation type/config patch rejection, relation
   * direct `relationPropertyId` supply) — REST already covers `database_archived`/patch rejection
   * in `itemsHandler.test.ts`/`propertiesHandler.test.ts`, and `genericOperationAgentTools.test.ts`
   * already covers actor-schema spoofing for this adapter.
   */
  describe("issue #220 parity: database_archived, relation patch rejection, relation direct supply", () => {
    it("surfaces database_archived (issue #83) as a ChokePointError-shaped result for a write against an archived database", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "archived db write" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);
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
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);
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
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);
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
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);
      const fx = await buildFixtures(projectItemId);

      // REST resolves a relation route's `:propertyKey` segment against the caller item's own
      // database and 404s for no match. AgentTools has no route layer: it takes
      // `relationPropertyId` directly and the choke point rejects a syntactically valid id that
      // doesn't name a relation property, rather than resolving it.
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
