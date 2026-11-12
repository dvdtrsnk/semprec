import type { CollectionMetadataResolver } from "@semprec/data";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  getTestPool,
  inTenantZero,
  registerItemCreateHook,
  registerItemUpdateHook,
  registerRelationEdgeWriteHook,
  resetDatabase,
  createTenantZeroUser,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type WriterIdentity,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";
import { writerIdentityOf } from "../genericApplicationService.js";

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

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);

// Hooks cannot be unregistered; these recorders stay registered for this file's process only and
// are emptied before each test.
const createdBy: WriterIdentity[] = [];
const updatedBy: WriterIdentity[] = [];
const edgesBy: WriterIdentity[] = [];

async function agentProjectItemId(): Promise<string> {
  const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
  return (await chokePoint.createItem({ databaseId: projects!.id, properties: {} })).id;
}

async function fixture() {
  const a = await chokePoint.createDatabase({ name: "A" });
  const b = await chokePoint.createDatabase({ name: "B" });
  await chokePoint.createProperty({ databaseId: a.id, key: "title", name: "Title", type: "text" });
  const { property } = await chokePoint.createRelationProperty({
    sourceDatabaseId: a.id,
    key: "bs",
    name: "Bs",
    targetDatabaseId: b.id,
  });
  const itemA = await chokePoint.createItem({ databaseId: a.id, properties: { title: "a" } });
  const itemB = await chokePoint.createItem({ databaseId: b.id, properties: {} });
  return { a, itemA, itemB, relationPropertyId: property.id };
}

describe("writer identity derived from the authenticated actor (issue #1415)", () => {
  let userId: string;

  beforeAll(() => {
    registerItemCreateHook(async (context) => {
      createdBy.push(context.writer);
    });
    registerItemUpdateHook(async (context) => {
      updatedBy.push(context.writer);
    });
    registerRelationEdgeWriteHook(async (context) => {
      edgesBy.push(context.writer);
    });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    createdBy.length = 0;
    updatedBy.length = 0;
    edgesBy.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("derives user for a REST session, agent without run ids for a human /mcp session, and agent with both ids for a run", () => {
    expect(writerIdentityOf({ userId, restSession: true })).toEqual({ writerKind: "user" });
    expect(writerIdentityOf({ userId })).toEqual({ writerKind: "agent", onBehalfOfUserId: userId });
    expect(writerIdentityOf({ userId, runId: "run-1", agentProjectItemId: "project-1" })).toEqual({
      writerKind: "agent",
      agentRunId: "run-1",
      agentProjectItemId: "project-1",
      onBehalfOfUserId: userId,
    });
  });

  it("item.patch and item.create reach the hooks as user for a REST session", async () => {
    await inTenantZero(async () => {
      const { a, itemA } = await fixture();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const actor: AuthenticatedActor = { userId, restSession: true };
      createdBy.length = 0;
      updatedBy.length = 0;

      await gateway.invoke("item.create", actor, ALL_CAPABILITIES, { databaseId: a.id, properties: { title: "n" } });
      await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
        itemId: itemA.id,
        properties: { title: "b" },
        ifVersion: itemA.updatedAt,
      });

      expect(createdBy).toEqual([{ writerKind: "user" }]);
      expect(updatedBy).toEqual([{ writerKind: "user" }]);
    });
  });

  it("item.patch and item.create reach the hooks as an agent without run ids, bound to the session's user, for /mcp on a human session", async () => {
    await inTenantZero(async () => {
      const { a, itemA } = await fixture();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const actor: AuthenticatedActor = { userId };
      createdBy.length = 0;
      updatedBy.length = 0;

      await gateway.invoke("item.create", actor, ALL_CAPABILITIES, { databaseId: a.id, properties: { title: "n" } });
      await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
        itemId: itemA.id,
        properties: { title: "b" },
        ifVersion: itemA.updatedAt,
      });

      const expected: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: userId };
      expect(createdBy).toEqual([expected]);
      expect(updatedBy).toEqual([expected]);
      expect(updatedBy[0]).not.toHaveProperty("agentRunId");
      expect(updatedBy[0]).not.toHaveProperty("agentProjectItemId");
    });
  });

  it("item.create on the Journal is refused with 403 for a REST session, a human /mcp session and an agent run, and stores no entry", async () => {
    await inTenantZero(async () => {
      await fixture();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const journal = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
      const projectItemId = await agentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "journal" });
      const agentRun: AuthenticatedActor = {
        userId: run.actorUserId,
        runId: run.id,
        agentProjectItemId: projectItemId,
      };
      const refusal = { status: 403, code: "forbidden", details: { field: "type" } };

      const actors: AuthenticatedActor[] = [{ userId, restSession: true }, { userId }, agentRun];
      for (const actor of actors) {
        await expect(
          gateway.invoke("item.create", actor, ALL_CAPABILITIES, { databaseId: journal!.id, properties: {} }),
        ).rejects.toMatchObject(refusal);
      }

      const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        journal!.id,
      ]);
      expect(rows[0]?.n).toBe(0);
    });
  });

  it("item.patch reaches the hooks as an agent with run id, project item and onBehalfOfUserId for an agent run", async () => {
    await inTenantZero(async () => {
      const { itemA } = await fixture();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const projectItemId = await agentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "patch" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      updatedBy.length = 0;

      await gateway.invoke("item.patch", actor, ALL_CAPABILITIES, {
        itemId: itemA.id,
        properties: { title: "b" },
        ifVersion: itemA.updatedAt,
      });

      expect(updatedBy).toEqual([
        {
          writerKind: "agent",
          agentRunId: run.id,
          agentProjectItemId: projectItemId,
          onBehalfOfUserId: run.actorUserId,
        },
      ]);
    });
  });

  it("relation.put by an agent run reaches the edge write hook with agent and the run id", async () => {
    await inTenantZero(async () => {
      const { itemA, itemB, relationPropertyId } = await fixture();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const projectItemId = await agentProjectItemId();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "link" });
      const actor: AuthenticatedActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
      edgesBy.length = 0;

      await gateway.invoke("relation.put", actor, ALL_CAPABILITIES, {
        relationPropertyId,
        callerItemId: itemA.id,
        targetItemId: itemB.id,
      });

      expect(edgesBy).toEqual([
        {
          writerKind: "agent",
          agentRunId: run.id,
          agentProjectItemId: projectItemId,
          onBehalfOfUserId: run.actorUserId,
        },
      ]);
    });
  });

  it("relation.put by a REST session and by a human /mcp session reach the edge write hook as user and as agent", async () => {
    await inTenantZero(async () => {
      const { itemA, itemB, relationPropertyId } = await fixture();
      const gateway = createGenericOperationGateway(pool, testMetadataResolver);
      const input = { relationPropertyId, callerItemId: itemA.id, targetItemId: itemB.id };
      edgesBy.length = 0;

      await gateway.invoke("relation.put", { userId, restSession: true }, ALL_CAPABILITIES, input);
      await gateway.invoke("relation.put", { userId }, ALL_CAPABILITIES, input);

      expect(edgesBy).toEqual([{ writerKind: "user" }, { writerKind: "agent", onBehalfOfUserId: userId }]);
    });
  });
});
