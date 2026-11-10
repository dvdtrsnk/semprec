import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import {
  registerItemCreateHook,
  registerItemUpdateHook,
  registerRelationEdgeDeleteHook,
  registerRelationEdgeWriteHook,
} from "../chokePoint/hooks.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  assertRelationCreatableWithClient,
  createRelationWithClient,
  updateRelationWithClient,
} from "../chokePoint/relationOps.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../inbox/proposalActions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";

let pool: Pool;
let chokePoint: ChokePoint;

// Hooks cannot be unregistered; these recorders stay registered for this file's process only and
// are emptied before each test.
const createdBy: WriterIdentity[] = [];
const updatedBy: WriterIdentity[] = [];
const edgesBy: WriterIdentity[] = [];
const edgeDeletesBy: WriterIdentity[] = [];

const AGENT: WriterIdentity = {
  writerKind: "agent",
  agentRunId: "00000000-0000-4000-8000-000000000001",
  agentProjectItemId: "00000000-0000-4000-8000-000000000002",
  onBehalfOfUserId: "00000000-0000-4000-8000-000000000003",
};
const MCP_CLIENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: AGENT.onBehalfOfUserId! };
const USER: WriterIdentity = { writerKind: "user" };

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function relationFixture() {
  const a = await chokePoint.createDatabase({ name: "A" });
  const b = await chokePoint.createDatabase({ name: "B" });
  await chokePoint.createProperty({ databaseId: a.id, key: "title", name: "Title", type: "text" });
  const { property } = await chokePoint.createRelationProperty({
    sourceDatabaseId: a.id,
    key: "bs",
    name: "Bs",
    targetDatabaseId: b.id,
  });
  const itemA = await chokePoint.createItem({ databaseId: a.id, properties: {} });
  const itemB = await chokePoint.createItem({ databaseId: b.id, properties: {} });
  const edge = { relationPropertyId: property.id, callerItemId: itemA.id, targetItemId: itemB.id };
  return { a, itemA, edge };
}

describe("writer identity threaded into item and relation writes (issue #1415)", () => {
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
    registerRelationEdgeDeleteHook(async (context) => {
      edgeDeletesBy.push(context.writer);
    });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    createdBy.length = 0;
    updatedBy.length = 0;
    edgesBy.length = 0;
    edgeDeletesBy.length = 0;
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("an item create and update that pass no writer reach the hooks as the system writer", async () => {
    const db = await chokePoint.createDatabase({ name: "Notes" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "a" } });
    await chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "b" } });

    expect(createdBy).toEqual([SYSTEM_WRITER]);
    expect(updatedBy).toEqual([SYSTEM_WRITER]);
  });

  it("the createItem and updateItem facade methods carry the supplied writer into their hooks", async () => {
    const db = await chokePoint.createDatabase({ name: "Notes" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    const item = await chokePoint.createItem(
      { databaseId: db.id, properties: { title: "a" } },
      undefined,
      undefined,
      USER,
    );
    await chokePoint.updateItem(
      { databaseId: db.id, itemId: item.id, propertiesPatch: { title: "b" } },
      undefined,
      undefined,
      AGENT,
    );

    expect(createdBy).toEqual([USER]);
    expect(updatedBy).toEqual([AGENT]);
  });

  it("the WithClient item writes carry the writer, and an MCP client on a human session has no run ids", async () => {
    const db = await chokePoint.createDatabase({ name: "Notes" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: db.id, properties: { title: "a" } }, { writer: MCP_CLIENT }),
    );
    await withTransaction(pool, (client) =>
      updateItemWithClient(
        client,
        { databaseId: db.id, itemId: item.id, propertiesPatch: { title: "b" } },
        { writer: MCP_CLIENT },
      ),
    );

    expect(createdBy).toEqual([MCP_CLIENT]);
    expect(updatedBy).toEqual([MCP_CLIENT]);
    expect(createdBy[0]).not.toHaveProperty("agentRunId");
  });

  it("an idempotent create replay runs no create hook, so it records no writer", async () => {
    const db = await chokePoint.createDatabase({ name: "Notes" });
    const input = { databaseId: db.id, properties: {}, idempotencyKey: "same-key" };
    await chokePoint.createItem(input, undefined, undefined, USER);
    await chokePoint.createItem(input, undefined, undefined, AGENT);

    expect(createdBy).toEqual([USER]);
  });

  it("relation create and update default to the system writer and carry a supplied one into the edge hook", async () => {
    const { edge } = await relationFixture();

    await chokePoint.createRelation(edge);
    await chokePoint.createRelation(edge, AGENT);
    await chokePoint.updateRelation({ ...edge, metadata: { note: 1 } });
    await chokePoint.updateRelation({ ...edge, metadata: { note: 2 } }, USER);

    expect(edgesBy).toEqual([SYSTEM_WRITER, AGENT, SYSTEM_WRITER, USER]);
  });

  it("the WithClient relation writes keep their positional context and take the writer after it", async () => {
    const { edge } = await relationFixture();

    await withTransaction(pool, async (client) => {
      await createRelationWithClient(client, edge, undefined, AGENT);
      await updateRelationWithClient(client, { ...edge, metadata: { note: 1 } }, undefined, MCP_CLIENT);
      await assertRelationCreatableWithClient(client, edge, undefined, USER);
    });

    expect(edgesBy).toEqual([AGENT, MCP_CLIENT, USER]);
  });

  it("relation delete, item delete and restore accept a writer and still perform the write", async () => {
    const { a, itemA, edge } = await relationFixture();
    await chokePoint.createRelation(edge);

    expect(await chokePoint.deleteRelation(edge, AGENT)).not.toBeNull();
    // Delete reaches the delete seam with the writer, and never the metadata-validating write hooks.
    expect(edgeDeletesBy).toEqual([AGENT]);
    expect(edgesBy).toEqual([SYSTEM_WRITER]);
    expect(await chokePoint.softDeleteItem(a.id, itemA.id, undefined, AGENT)).toMatchObject({ id: itemA.id });
    expect((await chokePoint.restoreItem(a.id, itemA.id, undefined, AGENT))?.deletedAt).toBeNull();
  });

  it("Inbox capture and the Semp tick write as the system writer", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const proposalsId = await databaseIdFor("processingProposals");
    createdBy.length = 0;
    updatedBy.length = 0;

    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await createSemprecTickAction(pool, async () => ({ properties: { name: "Buy milk" } }))(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );

    expect(createdBy.length).toBeGreaterThan(0);
    expect(createdBy.every((writer) => writer.writerKind === "system")).toBe(true);
    expect(updatedBy.every((writer) => writer.writerKind === "system")).toBe(true);
  });

  it("confirming an Inbox proposal writes the target item, the relation edge and the proposal update as the user", async () => {
    await seedSystem(pool, createViewTypeRegistry());
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const proposalsId = await databaseIdFor("processingProposals");
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await createSemprecTickAction(pool, async () => ({ properties: { name: "Buy milk" } }))(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    const proposalId = await withTransaction(pool, async (client) => {
      const sourceInbox = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox!.id);
      const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, item.id);
      return relationsStore.otherSide(edge!, item.id);
    });
    expect((await withTransaction(pool, (c) => itemsStore.getItemById(c, proposalsId, proposalId)))?.id).toBe(
      proposalId,
    );
    createdBy.length = 0;
    updatedBy.length = 0;
    edgesBy.length = 0;

    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
    );

    expect(createdBy).toEqual([USER]);
    expect(updatedBy).toEqual([USER]);
  });
});
