import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  recomputeRollupCell,
  seedSystem,
  withTransaction,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
  type ItemRow,
  type PropertyRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";

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
const HIDDEN_ROLLUP = { value: null, hidden: true };
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let pool: Pool;
let chokePoint: ChokePoint;
let health: DatabaseRow;
let projectsDatabase: DatabaseRow;
let userId: string;
let healthCount: PropertyRow;
let holder: ItemRow;
let diagnosis: ItemRow;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);
const human = (): AuthenticatedActor => ({ userId, restSession: true });

async function setGrant(actor: AuthenticatedActor, database: DatabaseRow, access: AgentDatabaseAccess) {
  if (actor.agentProjectItemId === undefined) throw new Error("Not an agent actor");
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [actor.agentProjectItemId, database.id, access],
    ),
  );
}

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "closed aggregation" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

const byHealthRecord = () => ({ type: "relation_contains", property: "healthRecords", value: diagnosis.id });

describe("agent filters and rollups over health records through the generic operation gateway (issue #2000)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const databases = await inTenantZero(async () => ({
      health: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords")),
      projects: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects")),
    }));
    if (!databases.health || !databases.projects) throw new Error("System databases are missing");
    health = databases.health;
    projectsDatabase = databases.projects;

    // A fixture the API cannot produce: the schema of a system database is locked until a code-level migration
    // changes it, and Projects has no rollup. The test pool unlocks it so the rollup is created through the choke point.
    await pool.query("UPDATE databases SET schema_locked = false WHERE id = $1", [projectsDatabase.id]);
    await inTenantZero(async () => {
      healthCount = await chokePoint.createProperty({
        databaseId: projectsDatabase.id,
        key: "healthRecordCount",
        name: "Health record count",
        type: "rollup",
        config: { relationPropertyKey: "healthRecords", aggregation: "count" },
      });
      holder = await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: { name: "Holder" } });
      diagnosis = await chokePoint.createItem({ databaseId: health.id, properties: { name: "Private diagnosis" } });
      const relation = (await chokePoint.listProperties(projectsDatabase.id)).find(
        (property) => property.key === "healthRecords",
      );
      if (!relation) throw new Error("Projects.healthRecords is missing");
      await chokePoint.createRelation({
        relationPropertyId: relation.id,
        callerItemId: holder.id,
        targetItemId: diagnosis.id,
      });
      // The recompute job is not run by this test: the cell is recorded the way the job does.
      await recomputeRollupCell(pool, healthCount.id, holder.id);
    });
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("answers 403 forbidden to database.query and view.query filtered by a relation into health records without a grant and returns the matching rows with a read grant, while a human is unchanged", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const view = await chokePoint.createView({
        databaseId: projectsDatabase.id,
        type: "table",
        name: "Linked to the diagnosis",
        config: { filter: byHealthRecord() },
      });
      const reads = {
        "database.query": (actor: AuthenticatedActor) =>
          gateway().invoke("database.query", actor, ALL_CAPABILITIES, {
            databaseId: projectsDatabase.id,
            filter: byHealthRecord(),
          }),
        "view.query": (actor: AuthenticatedActor) =>
          gateway().invoke("view.query", actor, ALL_CAPABILITIES, { viewId: view.id }),
      };
      for (const [operation, read] of Object.entries(reads)) {
        await expect(read(agent), operation).rejects.toMatchObject(FORBIDDEN);
        expect(
          (await read(human())).items.map((item) => item.id),
          operation,
        ).toContain(holder.id);
      }

      await setGrant(agent, health, "read");
      for (const [operation, read] of Object.entries(reads)) {
        expect(
          (await read(agent)).items.map((item) => item.id),
          operation,
        ).toContain(holder.id);
      }
    });
  });

  it("answers 403 forbidden to item.count filtered by a relation into health records or by a rollup over them without a grant, and counts with a read grant and for a human", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const count = (actor: AuthenticatedActor, filter?: unknown) =>
        gateway().invoke("item.count", actor, ALL_CAPABILITIES, {
          items: [{ databaseId: projectsDatabase.id, ...(filter === undefined ? {} : { filter }) }],
        });
      const byRelation = byHealthRecord();
      const byRollup = { type: "gt", property: healthCount.key, value: 0 };

      await expect(count(agent, byRelation)).rejects.toMatchObject(FORBIDDEN);
      await expect(count(agent, byRollup)).rejects.toMatchObject(FORBIDDEN);
      expect((await count(human(), byRelation))[0]?.count).toBe(1);
      expect((await count(human(), byRollup))[0]?.count).toBe(1);
      // A count that filters nothing over a sensitive database stays as it was: this source does not decide it.
      expect((await count(agent))[0]?.count).toBeGreaterThanOrEqual(1);

      await setGrant(agent, health, "read");
      expect((await count(agent, byRelation))[0]?.count).toBe(1);
      expect((await count(agent, byRollup))[0]?.count).toBe(1);
    });
  });

  it("hides the rollup over health records in item.get and database.query for an agent, returns it in full to a human and with a read grant, and refuses a sort by it", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const computedOf = (item: { computed: Record<string, unknown> }) => item.computed[healthCount.key];
      const get = (actor: AuthenticatedActor) =>
        gateway().invoke("item.get", actor, ALL_CAPABILITIES, { itemId: holder.id });
      const query = async (actor: AuthenticatedActor) => {
        const page = await gateway().invoke("database.query", actor, ALL_CAPABILITIES, {
          databaseId: projectsDatabase.id,
        });
        const found = page.items.find((item) => item.id === holder.id);
        if (!found) throw new Error("The holder is missing from the page");
        return found;
      };
      const sortedByRollup = (actor: AuthenticatedActor) =>
        gateway().invoke("database.query", actor, ALL_CAPABILITIES, {
          databaseId: projectsDatabase.id,
          sort: [{ property: healthCount.key, direction: "desc" }],
        });

      expect(computedOf(await get(agent))).toEqual(HIDDEN_ROLLUP);
      expect(computedOf(await query(agent))).toEqual(HIDDEN_ROLLUP);
      await expect(sortedByRollup(agent)).rejects.toMatchObject(FORBIDDEN);
      expect(computedOf(await get(human()))).toBe(1);
      await expect(sortedByRollup(human())).resolves.toBeDefined();

      await setGrant(agent, health, "read");
      await expect(sortedByRollup(agent)).resolves.toBeDefined();
      expect(computedOf(await get(agent))).toBe(1);
    });
  });

  it("answers 403 forbidden to item.count grouped by the relation into health records without a grant, and groups with a read grant and for a human", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const grouped = (actor: AuthenticatedActor) =>
        gateway().invoke("item.count", actor, ALL_CAPABILITIES, {
          items: [{ databaseId: projectsDatabase.id, groupBy: "healthRecords" }],
        });
      const countOf = (answer: Awaited<ReturnType<typeof grouped>>) =>
        answer[0]?.groups?.find((group) => group.key === diagnosis.id)?.count;

      await expect(grouped(agent)).rejects.toMatchObject(FORBIDDEN);
      expect(countOf(await grouped(human()))).toBe(1);

      await setGrant(agent, health, "read");
      expect(countOf(await grouped(agent))).toBe(1);
    });
  });

  it("answers 403 forbidden to database.facets filtered by, or listing, the relation into health records without a grant, and answers with a read grant and for a human", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const facets = (actor: AuthenticatedActor, input: { facets: string[]; filter?: unknown }) =>
        gateway().invoke("database.facets", actor, ALL_CAPABILITIES, { databaseId: projectsDatabase.id, ...input });
      const filtered = { facets: ["status"], filter: byHealthRecord() };
      const listing = { facets: ["healthRecords"] };

      await expect(facets(agent, filtered)).rejects.toMatchObject(FORBIDDEN);
      await expect(facets(agent, listing)).rejects.toMatchObject(FORBIDDEN);
      expect((await facets(human(), filtered))[0]?.all).toBe(1);
      expect((await facets(human(), listing))[0]?.values.map((entry) => entry.value)).toContain(diagnosis.id);

      await setGrant(agent, health, "read");
      expect((await facets(agent, filtered))[0]?.all).toBe(1);
      expect((await facets(agent, listing))[0]?.values.map((entry) => entry.value)).toContain(diagnosis.id);
    });
  });

  it("hides the rollup over health records in the item an agent creates and patches, and returns it in full to a human and with a read grant", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const computedOf = (item: { computed: Record<string, unknown> }) => item.computed[healthCount.key];
      const patch = async (actor: AuthenticatedActor) => {
        const { updatedAt } = await gateway().invoke("item.get", human(), ALL_CAPABILITIES, { itemId: holder.id });
        return gateway().invoke("item.patch", actor, ALL_CAPABILITIES, {
          itemId: holder.id,
          properties: { name: "Holder" },
          ifVersion: updatedAt,
        });
      };

      expect(computedOf(await patch(agent))).toEqual(HIDDEN_ROLLUP);
      expect(computedOf(await patch(human()))).toBe(1);

      const own = await gateway().invoke("item.create", agent, ALL_CAPABILITIES, {
        databaseId: projectsDatabase.id,
        properties: { name: "By the agent" },
      });
      expect(computedOf(own)).toEqual(HIDDEN_ROLLUP);

      await setGrant(agent, health, "read");
      expect(computedOf(await patch(agent))).toBe(1);
    });
  });
});
