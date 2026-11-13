import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  isGenericOperationApprovalRequestPayload,
  seedSystem,
  withTransaction,
  ApprovalRequiredError,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
  type ItemRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

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
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);

async function setGrant(actor: AuthenticatedActor, database: DatabaseRow, access: AgentDatabaseAccess) {
  if (actor.agentProjectItemId === undefined) throw new Error("Not an agent actor");
  const projectItemId = actor.agentProjectItemId;
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [projectItemId, database.id, access],
    ),
  );
}

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "grants" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

function newRecord(name = "Private diagnosis"): Promise<ItemRow> {
  return chokePoint.createItem({ databaseId: health.id, properties: { name } });
}

async function newUserDatabase(name: string): Promise<DatabaseRow> {
  const database = await chokePoint.createDatabase({ name });
  await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
  return database;
}

const human = (): AuthenticatedActor => ({ userId, restSession: true });
/** `/mcp` on a human session: no run credential, so no project. */
const mcpHumanSession = (): AuthenticatedActor => ({ userId });

describe("agent access to databases through the generic operation gateway (issue #1810)", () => {
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
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("answers 403 forbidden to item.get, database.query and view.query on a health record database without a grant and succeeds with a read grant, while a human read is unchanged", async () => {
    await inTenantZero(async () => {
      const record = await newRecord();
      const view = await chokePoint.createView({ databaseId: health.id, type: "table", name: "All records" });
      const agent = await newAgent();
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
        await expect(read(agent), operation).rejects.toMatchObject(FORBIDDEN);
        await expect(read(human()), operation).resolves.toBeDefined();
      }

      await setGrant(agent, health, "read");
      expect((await reads["item.get"](agent)).id).toBe(record.id);
      expect((await reads["database.query"](agent)).items.map((entry) => entry.id)).toContain(record.id);
      expect((await reads["view.query"](agent)).items.map((entry) => entry.id)).toContain(record.id);
      expect(await reads["relation.list"](agent)).toEqual([]);
    });
  });

  it("refuses database.get of a database the project may not read and leaves it out of database.list, while user-created databases are listed", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const open = await newUserDatabase("Open notes");
      const switchedOff = await newUserDatabase("Switched off notes");
      await setGrant(agent, switchedOff, "none");

      await expect(
        gateway().invoke("database.get", agent, ALL_CAPABILITIES, { databaseId: health.id }),
      ).rejects.toMatchObject(FORBIDDEN);
      const listed = await gateway().invoke("database.list", agent, ALL_CAPABILITIES, { limit: 200 });
      const ids = listed.items.map((database) => database.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(health.id);
      expect(ids).not.toContain(switchedOff.id);

      const forHuman = await gateway().invoke("database.list", human(), ALL_CAPABILITIES, { limit: 200 });
      expect(forHuman.items.map((database) => database.id)).toEqual(
        expect.arrayContaining([health.id, switchedOff.id]),
      );

      await setGrant(agent, health, "read");
      const got = await gateway().invoke("database.get", agent, ALL_CAPABILITIES, { databaseId: health.id });
      expect(got.id).toBe(health.id);
    });
  });

  it("lets an agent write only with a write grant, and a relation only with write access to both databases", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const record = await newRecord("Before");
      const open = await newUserDatabase("Linked notes");
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: open.id,
        key: "record",
        name: "Record",
        targetDatabaseId: health.id,
      });
      const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Note" } });
      const create = () =>
        gateway().invoke("item.create", agent, ALL_CAPABILITIES, {
          databaseId: health.id,
          properties: { name: "By agent" },
        });
      const patch = () =>
        gateway().invoke("item.patch", agent, ALL_CAPABILITIES, {
          itemId: record.id,
          properties: { name: "After" },
          ifVersion: record.updatedAt,
        });
      const put = () =>
        gateway().invoke("relation.put", agent, ALL_CAPABILITIES, {
          relationPropertyId: property.id,
          callerItemId: note.id,
          targetItemId: record.id,
        });

      await setGrant(agent, health, "read");
      for (const write of [create, patch, put]) await expect(write()).rejects.toMatchObject(FORBIDDEN);
      expect((await chokePoint.findItem(record.id))?.properties.name).toBe("Before");

      await setGrant(agent, health, "write");
      expect((await create()).properties.name).toBe("By agent");
      expect((await patch()).properties.name).toBe("After");
      await put();
      expect(await chokePoint.listItemRelations(note.id)).toHaveLength(1);
    });
  });

  it("keeps a user-created database open without a row, closes it for reads and writes once the project's row is none, and lets the user write freely", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const notes = await newUserDatabase("Project notes");
      const seed = await chokePoint.createItem({ databaseId: notes.id, properties: { name: "Seed" } });
      const create = (actor: AuthenticatedActor, name: string) =>
        gateway().invoke("item.create", actor, ALL_CAPABILITIES, { databaseId: notes.id, properties: { name } });
      const get = (actor: AuthenticatedActor) =>
        gateway().invoke("item.get", actor, ALL_CAPABILITIES, { itemId: seed.id });

      expect((await create(agent, "Agent note")).properties.name).toBe("Agent note");
      expect((await get(agent)).id).toBe(seed.id);

      await setGrant(agent, notes, "none");
      await expect(create(agent, "Refused")).rejects.toMatchObject(FORBIDDEN);
      await expect(get(agent)).rejects.toMatchObject(FORBIDDEN);
      expect((await create(human(), "User note")).properties.name).toBe("User note");
    });
  });

  it("does not run the per-project check for an /mcp call on a human session, which carries no project", async () => {
    await inTenantZero(async () => {
      const actor = mcpHumanSession();
      const record = await newRecord("Read over /mcp");
      expect((await gateway().invoke("item.get", actor, ALL_CAPABILITIES, { itemId: record.id })).id).toBe(record.id);
      const created = await gateway().invoke("item.create", actor, ALL_CAPABILITIES, {
        databaseId: health.id,
        properties: { name: "Written over /mcp" },
      });
      expect(created.properties.name).toBe("Written over /mcp");
      const listed = await gateway().invoke("database.list", actor, ALL_CAPABILITIES, { limit: 200 });
      expect(listed.items.map((database) => database.id)).toContain(health.id);
    });
  });

  describe("approval-gated deletes", () => {
    async function requestId(call: () => Promise<unknown>): Promise<string> {
      try {
        await call();
      } catch (error) {
        if (error instanceof ApprovalRequiredError) return error.details.approvalRequestId;
        throw error;
      }
      throw new Error("Expected the call to ask for approval");
    }

    async function approvedRequest(id: string) {
      await withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: id,
          decision: "approved",
          decidedByUserId: userId,
        }),
      );
      const request = await getApprovalRequest(pool, id);
      if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) {
        throw new Error("Missing generic approval request");
      }
      return { ...request, payload: request.payload };
    }

    const pendingRequests = async () =>
      (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_requests")).rows[0]?.n;

    it("refuses an item.delete of a record the project cannot write before any approval request exists", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const record = await newRecord();
        const before = await pendingRequests();
        await expect(
          gateway().invoke("item.delete", agent, ALL_CAPABILITIES, { itemId: record.id }),
        ).rejects.toMatchObject(FORBIDDEN);
        await setGrant(agent, health, "read");
        await expect(
          gateway().invoke("item.delete", agent, ALL_CAPABILITIES, { itemId: record.id }),
        ).rejects.toMatchObject(FORBIDDEN);
        expect(await pendingRequests()).toBe(before);
        expect((await chokePoint.findItem(record.id))?.deletedAt).toBeNull();
      });
    });

    it("executes an approved item.delete for a project with a write grant and ends it as a conflict, deleting nothing, once the grant was revoked", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        await setGrant(agent, health, "write");
        const granted = await newRecord("Granted");
        const revoked = await newRecord("Revoked");
        const ask = (itemId: string) =>
          requestId(() => gateway().invoke("item.delete", agent, ALL_CAPABILITIES, { itemId }));
        const grantedRequest = await approvedRequest(await ask(granted.id));
        const revokedRequest = await approvedRequest(await ask(revoked.id));

        expect((await replayApprovedGenericOperation(pool, grantedRequest)).error).toBe(false);
        expect(await chokePoint.findItem(granted.id)).toBeNull();

        await setGrant(agent, health, "none");
        expect((await replayApprovedGenericOperation(pool, revokedRequest)).error).toBe(true);
        expect((await getApprovalRequest(pool, revokedRequest.id))?.executionStatus).toBe("conflict");
        expect((await chokePoint.findItem(revoked.id))?.deletedAt).toBeNull();
      });
    });

    it("refuses an item.delete whose cascade reaches a database the project cannot write before any request exists, and ends an approved one as a conflict once that grant is revoked", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const parentDatabase = await newUserDatabase("Cascade parents");
        const parent = await chokePoint.createItem({ databaseId: parentDatabase.id, properties: { name: "Parent" } });
        const nested = await chokePoint.createDatabase({ name: "Cascade nested", parentItemId: parent.id });
        await chokePoint.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" });
        await chokePoint.createItem({ databaseId: nested.id, properties: { name: "Child" } });
        const ask = () =>
          requestId(() => gateway().invoke("item.delete", agent, ALL_CAPABILITIES, { itemId: parent.id }));

        await setGrant(agent, nested, "none");
        const before = await pendingRequests();
        await expect(
          gateway().invoke("item.delete", agent, ALL_CAPABILITIES, { itemId: parent.id }),
        ).rejects.toMatchObject(FORBIDDEN);
        expect(await pendingRequests()).toBe(before);

        await setGrant(agent, nested, "write");
        const request = await approvedRequest(await ask());
        await setGrant(agent, nested, "none");
        expect((await replayApprovedGenericOperation(pool, request)).error).toBe(true);
        expect((await getApprovalRequest(pool, request.id))?.executionStatus).toBe("conflict");
        expect((await chokePoint.findItem(parent.id))?.deletedAt).toBeNull();

        await setGrant(agent, nested, "write");
        const granted = await approvedRequest(await ask());
        expect((await replayApprovedGenericOperation(pool, granted)).error).toBe(false);
        expect(await chokePoint.findItem(parent.id)).toBeNull();
      });
    });

    it("refuses a relation.delete the project cannot write before any approval request exists, and asks for approval with a write grant", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const open = await newUserDatabase("Edge notes");
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: open.id,
          key: "record",
          name: "Record",
          targetDatabaseId: health.id,
        });
        const note = await chokePoint.createItem({ databaseId: open.id, properties: { name: "Note" } });
        const record = await newRecord();
        const input = { relationPropertyId: property.id, callerItemId: note.id, targetItemId: record.id };
        await chokePoint.createRelation(input);

        const before = await pendingRequests();
        await expect(gateway().invoke("relation.delete", agent, ALL_CAPABILITIES, input)).rejects.toMatchObject(
          FORBIDDEN,
        );
        expect(await pendingRequests()).toBe(before);

        await setGrant(agent, health, "write");
        const id = await requestId(() => gateway().invoke("relation.delete", agent, ALL_CAPABILITIES, input));
        expect((await replayApprovedGenericOperation(pool, await approvedRequest(id))).error).toBe(false);
        expect(await chokePoint.listItemRelations(note.id)).toEqual([]);
      });
    });
  });
});
