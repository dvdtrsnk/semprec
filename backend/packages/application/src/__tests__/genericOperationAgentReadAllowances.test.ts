import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  allowItemsForTurn,
  clearForRun,
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  insertValueLink,
  seedSystem,
  withTransaction,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
  type ItemRow,
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
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let pool: Pool;
let chokePoint: ChokePoint;
let health: DatabaseRow;
let projectsDatabase: DatabaseRow;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);

interface Agent {
  actor: AuthenticatedActor;
  runId: string;
  projectItemId: string;
}

async function setGrant(agent: Agent, database: DatabaseRow, access: AgentDatabaseAccess) {
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [agent.projectItemId, database.id, access],
    ),
  );
}

/** A run credential's actor: a run of a Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(projectItemId?: string): Promise<Agent> {
  const project =
    projectItemId ?? (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId: project, triggeredBy: "user", task: "allowances" });
  return {
    actor: { userId: run.actorUserId, runId: run.id, agentProjectItemId: project },
    runId: run.id,
    projectItemId: project,
  };
}

const allow = (agent: Agent, items: ItemRow[]) =>
  withTransaction(pool, (client) =>
    allowItemsForTurn(
      client,
      agent.runId,
      items.map((item) => item.id),
    ),
  );

const clear = (agent: Agent) => withTransaction(pool, (client) => clearForRun(client, agent.runId));

const newRecord = (name: string) => chokePoint.createItem({ databaseId: health.id, properties: { name } });

const get = (agent: Agent, item: ItemRow) =>
  gateway().invoke("item.get", agent.actor, ALL_CAPABILITIES, { itemId: item.id });

describe("one-turn read allowances through the generic operation gateway (issue #1849)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createTenantZeroUser(pool);
    const databases = await inTenantZero(async () => ({
      health: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords")),
      projects: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects")),
    }));
    if (!databases.health || !databases.projects) throw new Error("System databases are missing");
    health = databases.health;
    projectsDatabase = databases.projects;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("lets item.get read the attached health record without a grant, refuses another record of the same database, and refuses the attached one again once the allowances are cleared", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const [attached, sibling] = [await newRecord("Attached"), await newRecord("Sibling")];

      await expect(get(agent, attached)).rejects.toMatchObject(FORBIDDEN);
      await allow(agent, [attached]);
      expect((await get(agent, attached)).properties.name).toBe("Attached");
      await expect(get(agent, sibling)).rejects.toMatchObject(FORBIDDEN);

      expect(await clear(agent)).toBe(1);
      await expect(get(agent, attached)).rejects.toMatchObject(FORBIDDEN);
    });
  });

  it("does not open the item for another run, not even of the same project", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const sameProject = await newAgent(agent.projectItemId);
      const attached = await newRecord("Attached");
      await allow(agent, [attached]);

      expect((await get(agent, attached)).id).toBe(attached.id);
      await expect(get(sameProject, attached)).rejects.toMatchObject(FORBIDDEN);
    });
  });

  it("answers 403 to item.patch of the attached item without a write grant, with or without a read grant, and patches it with a write grant", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const attached = await newRecord("Before");
      await allow(agent, [attached]);
      const patch = () =>
        gateway().invoke("item.patch", agent.actor, ALL_CAPABILITIES, {
          itemId: attached.id,
          properties: { name: "After" },
          ifVersion: attached.updatedAt,
        });

      await expect(patch()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(agent, health, "read");
      await expect(patch()).rejects.toMatchObject(FORBIDDEN);
      expect((await chokePoint.findItem(attached.id))?.properties.name).toBe("Before");

      await setGrant(agent, health, "write");
      expect((await patch()).properties.name).toBe("After");
    });
  });

  it("opens only item.get for the attached item: the database, its relation list and the item delete stay refused", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const attached = await newRecord("Attached");
      await allow(agent, [attached]);

      expect((await get(agent, attached)).id).toBe(attached.id);
      await expect(
        gateway().invoke("database.query", agent.actor, ALL_CAPABILITIES, { databaseId: health.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        gateway().invoke("relation.list", agent.actor, ALL_CAPABILITIES, { itemId: attached.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        gateway().invoke("item.delete", agent.actor, ALL_CAPABILITIES, { itemId: attached.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      expect((await chokePoint.findItem(attached.id))?.deletedAt).toBeNull();
    });
  });

  it("returns a relation target in an unreadable database as { id, hidden: true } and a target in a readable database in full", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const notes = await chokePoint.createDatabase({ name: "Switched off journal" });
      await chokePoint.createProperty({ databaseId: notes.id, key: "name", name: "Name", type: "title" });
      const readable = await chokePoint.createDatabase({ name: "Readable people" });
      await chokePoint.createProperty({ databaseId: readable.id, key: "name", name: "Name", type: "title" });
      const toRecord = await chokePoint.createRelationProperty({
        sourceDatabaseId: notes.id,
        key: "records",
        name: "Records",
        targetDatabaseId: health.id,
      });
      const toReadable = await chokePoint.createRelationProperty({
        sourceDatabaseId: notes.id,
        key: "people",
        name: "People",
        targetDatabaseId: readable.id,
      });
      const attached = await chokePoint.createItem({ databaseId: notes.id, properties: { name: "Attached note" } });
      const record = await newRecord("Hidden title");
      const person = await chokePoint.createItem({ databaseId: readable.id, properties: { name: "Open person" } });
      await chokePoint.createRelation({
        relationPropertyId: toRecord.property.id,
        callerItemId: attached.id,
        targetItemId: record.id,
      });
      await chokePoint.createRelation({
        relationPropertyId: toReadable.property.id,
        callerItemId: attached.id,
        targetItemId: person.id,
      });
      await setGrant(agent, notes, "none");
      await allow(agent, [attached]);

      const read = await gateway().invoke("item.get", agent.actor, ALL_CAPABILITIES, {
        itemId: attached.id,
        include: { relations: { records: [], people: [] } },
      });
      expect(read.relations?.records).toEqual([{ id: record.id, hidden: true }]);
      expect(read.relations?.people).toMatchObject([{ id: person.id, title: "Open person" }]);
      expect(JSON.stringify(read.relations)).not.toContain("Hidden title");
    });
  });

  /** A user-created database with a title, an item in it and an inherited `projects` link on that item. */
  async function linkedItem(name: string, sources: ItemRow[]) {
    const database = await chokePoint.createDatabase({ name });
    await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: `${name} item` } });
    await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: item.id,
        propertyKey: "projects",
        ruleKey: "allowanceTest",
        sources: sources.map((source) => ({ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" })),
      }),
    );
    return { database, item };
  }

  it("leaves a link source in an unreadable database out of item.get with include links, and names a source in a readable one", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const hiddenSource = await newRecord("Hidden source title");
      const readableDatabase = await chokePoint.createDatabase({ name: "Readable sources" });
      await chokePoint.createProperty({ databaseId: readableDatabase.id, key: "name", name: "Name", type: "title" });
      const readableSource = await chokePoint.createItem({
        databaseId: readableDatabase.id,
        properties: { name: "Open source" },
      });
      const { database, item } = await linkedItem("Switched off notes", [hiddenSource, readableSource]);
      await setGrant(agent, database, "none");
      await allow(agent, [item]);

      for (const include of [["links"], { links: true }] as const) {
        const read = await gateway().invoke("item.get", agent.actor, ALL_CAPABILITIES, { itemId: item.id, include });
        expect(read.links?.projects?.sources).toMatchObject([{ itemId: readableSource.id, title: "Open source" }]);
        expect(read.links?.projects?.sources).toHaveLength(1);
        expect(JSON.stringify(read.links)).not.toContain("Hidden source title");
        expect(JSON.stringify(read.links)).not.toContain(hiddenSource.id);
      }
      // A person reads the source in full.
      const asPerson = await chokePoint.getValueLinksForItems([item.id]);
      expect(asPerson.get(item.id)?.projects?.sources).toHaveLength(2);
    });
  });

  it("leaves a link source in an unreadable database out of database.query with include links", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const hiddenSource = await newRecord("Hidden queried title");
      const { database, item } = await linkedItem("Readable notes", [hiddenSource]);

      const page = await gateway().invoke("database.query", agent.actor, ALL_CAPABILITIES, {
        databaseId: database.id,
        include: ["links"],
      });
      expect(page.items.map((entry) => entry.id)).toEqual([item.id]);
      expect(page.items[0]?.links?.projects?.sources).toEqual([]);
      expect(JSON.stringify(page.items)).not.toContain("Hidden queried title");
    });
  });
});
