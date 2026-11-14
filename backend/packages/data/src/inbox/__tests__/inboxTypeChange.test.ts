import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { runOnce, type TaskList } from "@semprec/queue";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { heartbeatFireJobKey } from "../../scheduler/schedulerStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  INBOX_ITEM_TYPES_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../../seed/inboxPipelineKeys.js";
import {
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { ChokePointError } from "../../errors.js";
import type { ItemRow } from "../../types.js";
import { createChangeInboxItemTypeRouteHandler } from "../inboxRouteHandlers.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";
import { changeInboxItemTypeWithClient } from "../inboxTypeChange.js";
import { createInboxTypeWithClient, type CreateInboxTypeInput } from "../inboxTypesStore.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  updateProposalValuesWithClient,
} from "../proposalActions.js";

/**
 * Issue gh-1947: `PUT /api/inbox/items/:id/type`, through the route's handler and the production writers. Everything
 * runs on a `semprec_data` pool inside a tenant, so row-level security applies to the writes and to every lookup of
 * the route; the queue is read through the superuser pool, which sees the jobs of every tenant. The tick runs through
 * `createSemprecTickAction` with a stub model call, as the other tick tests do.
 */

let admin: Pool;
let pool: Pool;

/** What a test needs to know of one tenant's seeded Inbox pipeline. */
interface Pipeline {
  tenant: string;
  inboxId: string;
  typesId: string;
  proposalsId: string;
  tasksId: string;
  typeDefinitionId: string;
  sourceInboxDefinitionId: string;
  /** The seeded `semprec.tick` heartbeat of the Inbox database that watches `update`. */
  updateHeartbeatId: string;
}

async function pipelineOf(tenant: string): Promise<Pipeline> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
      const types = await getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
      const proposals = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      const tasks = await getDatabaseByModuleId(client, "tasks");
      if (!inbox || !types || !proposals || !tasks) throw new Error("The Inbox pipeline was not seeded");
      const definitionOf = async (databaseId: string, key: string): Promise<string> => {
        const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
        const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
        if (!definition) throw new Error(`No relation '${key}' in database ${databaseId}`);
        return definition.id;
      };
      const heartbeat = await client.query<{ id: string }>(
        `SELECT id FROM project_heartbeats
         WHERE rule ->> 'kind' = 'onItemEvent' AND rule ->> 'databaseId' = $1 AND rule ->> 'event' = 'update'`,
        [inbox.id],
      );
      if (!heartbeat.rows[0]) throw new Error("The Inbox 'update' heartbeat was not seeded");
      return {
        tenant,
        inboxId: inbox.id,
        typesId: types.id,
        proposalsId: proposals.id,
        tasksId: tasks.id,
        typeDefinitionId: await definitionOf(inbox.id, "type"),
        sourceInboxDefinitionId: await definitionOf(proposals.id, "sourceInbox"),
        updateHeartbeatId: heartbeat.rows[0].id,
      };
    }),
  );
}

function inTenant<T>(p: Pipeline, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(p.tenant, () => withTransaction(pool, work));
}

type TypeFixture = Pick<CreateInboxTypeInput, "processingMethod" | "targetDatabase" | "status">;

const TASK_TYPE: TypeFixture = { processingMethod: "database", targetDatabase: "tasks" };
const EVENT_TYPE: TypeFixture = { processingMethod: "database", targetDatabase: "events" };
const PAGE_TYPE: TypeFixture = { processingMethod: "pageContent" };

async function createType(p: Pipeline, name: string, fixture: TypeFixture): Promise<string> {
  const type = await inTenant(p, (client) =>
    createInboxTypeWithClient(client, {
      inboxItemTypesDatabaseId: p.typesId,
      name,
      emoji: "x",
      status: "active",
      ...fixture,
    }),
  );
  return type.id;
}

/** Captures one Inbox item through the production Inbox writer, with its type edge when `typeId` is given. */
async function capture(p: Pipeline, text: string, typeId?: string): Promise<string> {
  const item = await inTenant(p, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: p.inboxId,
      date: "2026-10-16",
      time: "09:00",
      text,
      type: typeId,
    }),
  );
  return item.id;
}

/** Runs the Inbox tick for the item with `compute` as its model call. */
async function tick(p: Pipeline, itemId: string, compute: ComputeSemprecProposalFn): Promise<void> {
  await runInTenant(p.tenant, () =>
    createSemprecTickAction(pool, compute)(
      {
        inboxDatabaseId: p.inboxId,
        inboxItemTypesDatabaseId: p.typesId,
        processingProposalsDatabaseId: p.proposalsId,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId },
    ),
  );
}

const noCandidates: ComputeSemprecProposalFn = async () => ({ properties: {}, candidates: [] });

/** A typed Task item whose first tick stored a `proposed` card; the ids of both and of the type. */
async function proposedTaskItem(p: Pipeline, text = "Buy milk") {
  const typeId = await createType(p, "Task", TASK_TYPE);
  const itemId = await capture(p, text, typeId);
  await tick(p, itemId, async () => ({ properties: { name: text, description: "From the shop" } }));
  const card = await cardOf(p, itemId);
  if (!card) throw new Error("the first tick wrote no card");
  return { typeId, itemId, cardId: card.id };
}

async function cardOf(p: Pipeline, itemId: string): Promise<ItemRow | null> {
  return inTenant(p, async (client) => {
    for (const edge of await relationsStore.listRelationsForItem(client, p.sourceInboxDefinitionId, itemId)) {
      const card = await itemsStore.getItemById(client, p.proposalsId, relationsStore.otherSide(edge, itemId));
      if (card && !card.deletedAt) return card;
    }
    return null;
  });
}

async function requireCard(p: Pipeline, itemId: string): Promise<ItemRow> {
  const card = await cardOf(p, itemId);
  if (!card) throw new Error(`Inbox item ${itemId} has no card`);
  return card;
}

/** The Inbox item a card points at through `sourceInbox`. */
async function sourceOf(p: Pipeline, cardId: string): Promise<string[]> {
  return inTenant(p, async (client) =>
    (await relationsStore.listRelationsForItem(client, p.sourceInboxDefinitionId, cardId)).map((edge) =>
      relationsStore.otherSide(edge, cardId),
    ),
  );
}

async function typeIdsOf(p: Pipeline, itemId: string): Promise<string[]> {
  return inTenant(p, async (client) =>
    (await relationsStore.listRelationsForItem(client, p.typeDefinitionId, itemId)).map((edge) =>
      relationsStore.otherSide(edge, itemId),
    ),
  );
}

const historySchema = z.array(
  z.object({ author: z.string(), message: z.string(), kind: z.string().optional(), at: z.string() }),
);

function historyOf(card: ItemRow) {
  return historySchema.parse(card.properties.history);
}

/** Calls the route's handler as `p`'s tenant on the runtime-role pool. */
function change(p: Pipeline, itemId: string, body: unknown, identity?: { user: { id: string } }) {
  return runInTenant(p.tenant, () =>
    createChangeInboxItemTypeRouteHandler(pool)({ params: { id: itemId }, body, ...(identity ? { identity } : {}) }),
  );
}

const answerSchema = z.object({
  status: z.literal(200),
  body: z.object({ itemId: z.string(), typeId: z.string(), card: z.object({ id: z.string() }).nullable() }),
});

/** What an error tells a caller (status, code, message and details), with `id` replaced, so two refusals can be compared. */
function errorMasking(error: unknown, id: string) {
  if (!(error instanceof ChokePointError)) throw new Error(`Expected a ChokePointError, got ${String(error)}`);
  return JSON.parse(
    JSON.stringify({
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    }).replaceAll(id, "<id>"),
  ) as unknown;
}

/** The jobs of the queue, by key and how often a keyed enqueue replaced it (`revision`). */
async function queuedJobs(): Promise<Array<{ key: string | null; revision: number }>> {
  const { rows } = await admin.query<{ key: string | null; revision: number }>(
    "SELECT key, revision FROM graphile_worker.jobs ORDER BY id",
  );
  return rows;
}

/** Empties the queue through the worker, so that a job enqueued afterwards is a new row. */
async function discardQueuedJobs(): Promise<void> {
  let remaining = Number.POSITIVE_INFINITY;
  for (;;) {
    const { rows } = await admin.query<{ task_identifier: string }>(
      "SELECT task_identifier FROM graphile_worker.jobs ORDER BY id",
    );
    if (rows.length === 0) return;
    if (rows.length >= remaining) throw new Error(`Queued jobs stopped draining: ${JSON.stringify(rows)}`);
    remaining = rows.length;
    const taskList: TaskList = Object.fromEntries(rows.map((row) => [row.task_identifier, async () => {}]));
    await runOnce({ pgPool: admin }, taskList);
  }
}

/** Everything a refused call must leave as it was: the type edges, the card and the queue. */
async function writtenState(p: Pipeline, itemId: string) {
  return { types: await typeIdsOf(p, itemId), card: await cardOf(p, itemId), jobs: await queuedJobs() };
}

describe("PUT /api/inbox/items/:id/type (issue gh-1947)", () => {
  let p: Pipeline;
  let foreign: Pipeline;

  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    const tenant = await createTestTenant(admin);
    const other = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    await runInTenant(other, () => seedSystem(pool));
    p = await pipelineOf(tenant);
    foreign = await pipelineOf(other);
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  describe("choosing a type", () => {
    it("turns a needsClarification card into a computing one with exactly one type edge, queues the tick, and the tick makes it a proposed card of that type from the same source", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk");
      await tick(p, itemId, noCandidates);
      const before = await requireCard(p, itemId);
      expect(before.properties.status).toBe("needsClarification");
      expect(await typeIdsOf(p, itemId)).toEqual([]);
      await discardQueuedJobs();

      const answer = answerSchema.parse(await change(p, itemId, { typeId }));

      expect(answer.body).toEqual({ itemId, typeId, card: { id: before.id } });
      expect(await typeIdsOf(p, itemId)).toEqual([typeId]);
      const computing = await requireCard(p, itemId);
      expect(computing.id).toBe(before.id);
      expect(computing.properties.status).toBe("computing");
      expect(historyOf(computing).slice(0, -1)).toEqual(historyOf(before));
      expect(historyOf(computing).at(-1)).toMatchObject({ author: "user", kind: "typeChosen" });
      expect((await queuedJobs()).map((job) => job.key)).toContain(heartbeatFireJobKey(p.updateHeartbeatId, itemId));

      let calls = 0;
      await tick(p, itemId, async (input) => {
        calls += 1;
        expect(input.type?.id).toBe(typeId);
        expect(input.recognition).toBeFalsy();
        return { properties: { name: "Buy milk" } };
      });

      expect(calls).toBe(1);
      const proposed = await requireCard(p, itemId);
      const envelope = { entityKind: "database", target: p.tasksId, properties: { name: "Buy milk" } };
      expect(proposed.id).toBe(before.id);
      expect(proposed.properties).toMatchObject({ status: "proposed", proposal: envelope, aiProposal: envelope });
      expect(await sourceOf(p, proposed.id)).toEqual([itemId]);
      expect(await typeIdsOf(p, itemId)).toEqual([typeId]);
    });

    it("replaces the type of a typed item, leaving the new type as its only edge", async () => {
      const { itemId, typeId: oldTypeId, cardId } = await proposedTaskItem(p);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);

      await change(p, itemId, { typeId: newTypeId });

      expect(await typeIdsOf(p, itemId)).toEqual([newTypeId]);
      expect(await typeIdsOf(p, itemId)).not.toContain(oldTypeId);
      expect((await requireCard(p, itemId)).id).toBe(cardId);
    });

    it("deletes every type edge of a legacy item that has several, leaving the chosen type as its only edge", async () => {
      const { itemId, typeId: firstTypeId, cardId } = await proposedTaskItem(p);
      const secondTypeId = await createType(p, "Chore", TASK_TYPE);
      const thirdTypeId = await createType(p, "Errand", TASK_TYPE);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      // Raw SQL: the write hook of the type relation refuses a second edge, but items from before it can have several.
      await inTenant(p, async (client) => {
        for (const legacyTypeId of [secondTypeId, thirdTypeId]) {
          await client.query(
            "INSERT INTO item_relations (relation_definition_id, item_a, item_b, metadata) VALUES ($1, $2, $3, '{}'::jsonb)",
            [p.typeDefinitionId, itemId, legacyTypeId],
          );
        }
      });
      expect([...(await typeIdsOf(p, itemId))].sort()).toEqual([firstTypeId, secondTypeId, thirdTypeId].sort());

      await change(p, itemId, { typeId: newTypeId });

      expect(await typeIdsOf(p, itemId)).toEqual([newTypeId]);
      expect((await requireCard(p, itemId)).id).toBe(cardId);
    });

    it("lets the tick recompute a card whose fingerprint is current when the user chose the type it already has", async () => {
      const { itemId, typeId } = await proposedTaskItem(p);
      let calls = 0;

      await change(p, itemId, { typeId });
      await tick(p, itemId, async () => {
        calls += 1;
        return { properties: { name: "Buy oat milk" } };
      });

      expect(calls).toBe(1);
      expect((await requireCard(p, itemId)).properties).toMatchObject({
        status: "proposed",
        proposal: { properties: { name: "Buy oat milk" } },
      });
    });

    it("succeeds without ifVersion for an item that has no card yet, and the tick creates the card", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk");
      await discardQueuedJobs();
      expect(await cardOf(p, itemId)).toBeNull();

      const answer = answerSchema.parse(await change(p, itemId, { typeId }));

      expect(answer.body).toEqual({ itemId, typeId, card: null });
      expect(await typeIdsOf(p, itemId)).toEqual([typeId]);
      expect(await cardOf(p, itemId)).toBeNull();
      expect((await queuedJobs()).map((job) => job.key)).toContain(heartbeatFireJobKey(p.updateHeartbeatId, itemId));

      await tick(p, itemId, async () => ({ properties: { name: "Buy milk" } }));

      const created = await requireCard(p, itemId);
      expect(created.properties.status).toBe("proposed");
      expect(await sourceOf(p, created.id)).toEqual([itemId]);
    });

    it("triggers the Inbox update heartbeat once more than the two edge writes of a replacement do", async () => {
      const { itemId } = await proposedTaskItem(p);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      await discardQueuedJobs();

      await change(p, itemId, { typeId: newTypeId });

      // The edge hook of issue gh-1718 enqueues the tick for the deleted edge and for the created one; every enqueue of
      // the same key replaces the queued job and raises its revision, so the third is the route's own trigger.
      const jobs = (await queuedJobs()).filter((job) => job.key === heartbeatFireJobKey(p.updateHeartbeatId, itemId));
      expect(jobs).toEqual([{ key: heartbeatFireJobKey(p.updateHeartbeatId, itemId), revision: 2 }]);
    });
  });

  describe("the manual values of the card", () => {
    async function editedTitle(text = "Buy milk") {
      const fixture = await proposedTaskItem(p, text);
      await inTenant(p, (client) =>
        updateProposalValuesWithClient(client, { processingProposalsDatabaseId: p.proposalsId }, fixture.cardId, {
          set: { primary: { name: "My own title" } },
        }),
      );
      const edited = await requireCard(p, fixture.itemId);
      expect(edited.properties.userOverrides).toEqual({ primary: { name: "My own title" } });
      expect(edited.properties.userEditedKeys).toEqual(["primary.name"]);
      return fixture;
    }

    it("clears the edited title when the type moves to an event type, and records a typeChosen entry", async () => {
      const { itemId } = await editedTitle();
      const eventTypeId = await createType(p, "Event", EVENT_TYPE);

      await change(p, itemId, { typeId: eventTypeId });

      const card = await requireCard(p, itemId);
      expect(card.properties).toMatchObject({ status: "computing", userOverrides: {}, userEditedKeys: [] });
      expect(historyOf(card).filter((entry) => entry.kind === "typeChosen")).toHaveLength(1);
    });

    it("keeps the edited title for a type with the same destination, because the key exists there, and the tick lays it over the new proposal", async () => {
      const { itemId } = await editedTitle();
      const choreTypeId = await createType(p, "Chore", TASK_TYPE);

      await change(p, itemId, { typeId: choreTypeId });

      const card = await requireCard(p, itemId);
      expect(card.properties).toMatchObject({
        status: "computing",
        userOverrides: { primary: { name: "My own title" } },
        userEditedKeys: ["primary.name"],
      });

      await tick(p, itemId, async () => ({ properties: { name: "Buy milk", description: "A chore" } }));

      expect((await requireCard(p, itemId)).properties).toMatchObject({
        status: "proposed",
        aiProposal: { properties: { name: "Buy milk", description: "A chore" } },
        proposal: { properties: { name: "My own title", description: "A chore" } },
        userEditedKeys: ["primary.name"],
      });
    });

    async function pageCard(text: string) {
      const typeId = await createType(p, "Note", PAGE_TYPE);
      const itemId = await capture(p, text, typeId);
      await tick(p, itemId, noCandidates);
      const card = await requireCard(p, itemId);
      const page = randomUUID();
      const envelope = { entityKind: "pageContent", target: page, properties: { markdown: "From the assistant" } };
      // A page card with a manual value, as a values edit leaves it: the tick's page proposals need a page of the
      // tenant, which this test does not need to build.
      await inTenant(p, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: p.proposalsId,
            itemId: card.id,
            propertiesPatch: {
              status: "proposed",
              aiProposal: envelope,
              proposal: { ...envelope, properties: { markdown: "Mine" } },
              userOverrides: { primary: { markdown: "Mine" } },
              userEditedKeys: ["primary.markdown"],
            },
          },
          { allowedSystemKeys: ["status", "aiProposal", "proposal", "userOverrides", "userEditedKeys"] },
        ),
      );
      return { itemId };
    }

    it("keeps the manual value of a page card when the new type is a page type too, since the key is in the page's properties", async () => {
      const { itemId } = await pageCard("A page card");
      const otherPageTypeId = await createType(p, "Journal note", PAGE_TYPE);

      await change(p, itemId, { typeId: otherPageTypeId });

      expect((await requireCard(p, itemId)).properties).toMatchObject({
        status: "computing",
        userOverrides: { primary: { markdown: "Mine" } },
        userEditedKeys: ["primary.markdown"],
      });
    });

    it("clears the manual value of a page card when the new type processes into a database", async () => {
      const { itemId } = await pageCard("A page card");
      const taskTypeId = await createType(p, "Task", TASK_TYPE);

      await change(p, itemId, { typeId: taskTypeId });

      expect((await requireCard(p, itemId)).properties).toMatchObject({
        status: "computing",
        userOverrides: {},
        userEditedKeys: [],
      });
    });

    it("sends a card without an envelope back with a page type, which has nothing to clear", async () => {
      const itemId = await capture(p, "No envelope yet");
      await tick(p, itemId, noCandidates);
      const pageTypeId = await createType(p, "Note", PAGE_TYPE);

      await change(p, itemId, { typeId: pageTypeId });

      expect((await requireCard(p, itemId)).properties).toMatchObject({
        status: "computing",
        userOverrides: {},
        userEditedKeys: [],
      });
    });

    it("refuses a type whose target database is not available while the card holds an envelope, and writes nothing", async () => {
      const { itemId } = await editedTitle();
      const oldTypeId = (await typeIdsOf(p, itemId))[0]!;
      const choreTypeId = await createType(p, "Chore", TASK_TYPE);
      // Raw SQL: older generic writes accepted any select value, so a type can name a database that is not one.
      await admin.query(
        "UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', '\"legacyUnknown\"') WHERE id = $1",
        [choreTypeId],
      );
      const before = await writtenState(p, itemId);

      await expect(change(p, itemId, { typeId: choreTypeId })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "typeId" },
      });

      expect(await writtenState(p, itemId)).toEqual(before);
      expect(await typeIdsOf(p, itemId)).toEqual([oldTypeId]);
    });

    it("refuses a type whose target database is not available for an item that has no card too, and writes nothing", async () => {
      const itemId = await capture(p, "Buy milk");
      const choreTypeId = await createType(p, "Chore", TASK_TYPE);
      // Raw SQL: older generic writes accepted any select value, so a type can name a database that is not one.
      await admin.query(
        "UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', '\"legacyUnknown\"') WHERE id = $1",
        [choreTypeId],
      );
      expect(await cardOf(p, itemId)).toBeNull();
      const before = await writtenState(p, itemId);

      await expect(change(p, itemId, { typeId: choreTypeId })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "typeId" },
      });

      expect(await writtenState(p, itemId)).toEqual(before);
      expect(await typeIdsOf(p, itemId)).toEqual([]);
    });

    it("leaves the reason of an invalid card behind with its status", async () => {
      const { itemId, cardId } = await proposedTaskItem(p);
      await inTenant(p, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: p.proposalsId,
            itemId: cardId,
            propertiesPatch: {
              status: "invalid",
              invalidReason: { code: "targetArchived", field: "", itemId: randomUUID(), label: "Old" },
            },
          },
          { allowedSystemKeys: ["status", "invalidReason"] },
        ),
      );
      const eventTypeId = await createType(p, "Event", EVENT_TYPE);

      await change(p, itemId, { typeId: eventTypeId });

      const card = await requireCard(p, itemId);
      expect(card.properties.status).toBe("computing");
      expect(card.properties.invalidReason).toBeNull();
    });
  });

  describe("a decided card and the version of the card", () => {
    const decisions = {
      confirmed: (client: PoolClient, p: Pipeline, cardId: string) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: p.proposalsId }, cardId),
      rejected: (client: PoolClient, p: Pipeline, cardId: string) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: p.proposalsId }, cardId),
    };

    it.each(["confirmed", "rejected"] as const)(
      "answers 409 proposal_locked for a %s card and changes nothing",
      async (status) => {
        const { itemId, cardId, typeId: oldTypeId } = await proposedTaskItem(p);
        await inTenant(p, (client) => decisions[status](client, p, cardId));
        const newTypeId = await createType(p, "Event", EVENT_TYPE);
        const before = await writtenState(p, itemId);
        expect(before.card?.properties.status).toBe(status);

        await expect(change(p, itemId, { typeId: newTypeId })).rejects.toMatchObject({
          status: 409,
          code: "proposal_locked",
        });

        expect(await writtenState(p, itemId)).toEqual(before);
        expect(before.types).toEqual([oldTypeId]);
      },
    );

    it("answers 409 version_conflict with the current card for an ifVersion that is not the card's updatedAt, and changes nothing", async () => {
      const { itemId, cardId } = await proposedTaskItem(p);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      await discardQueuedJobs();
      const before = await writtenState(p, itemId);

      await expect(
        change(p, itemId, { typeId: newTypeId, ifVersion: "2000-01-01T00:00:00.000Z" }),
      ).rejects.toMatchObject({
        status: 409,
        code: "version_conflict",
        details: { current: { id: cardId, updatedAt: before.card?.updatedAt } },
      });

      expect(await writtenState(p, itemId)).toEqual(before);
    });

    it("accepts the card's current updatedAt as ifVersion", async () => {
      const { itemId } = await proposedTaskItem(p);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      const { updatedAt } = await requireCard(p, itemId);

      await change(p, itemId, { typeId: newTypeId, ifVersion: updatedAt });

      expect(await typeIdsOf(p, itemId)).toEqual([newTypeId]);
      expect((await requireCard(p, itemId)).properties.status).toBe("computing");
    });

    it("refuses an ifVersion for an item without a card as a validation error on ifVersion, and changes nothing", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk");
      await discardQueuedJobs();
      const before = await writtenState(p, itemId);

      await expect(change(p, itemId, { typeId, ifVersion: "2026-10-16T09:00:00.000Z" })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "ifVersion" },
      });

      expect(await writtenState(p, itemId)).toEqual(before);
    });
  });

  describe("the type", () => {
    async function typedItem() {
      const oldTypeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk", oldTypeId);
      await discardQueuedJobs();
      return { itemId, oldTypeId };
    }

    const unusableTypes: Array<[string, (typeId: string) => Promise<string>]> = [
      ["an id that is no item", async () => randomUUID()],
      ["an archived type", () => createType(p, "Old", { ...PAGE_TYPE, status: "archived" })],
      [
        "a deleted type",
        async () => {
          const typeId = await createType(p, "Gone", PAGE_TYPE);
          await inTenant(p, (client) => itemsStore.softDeleteItem(client, p.typesId, typeId));
          return typeId;
        },
      ],
      ["an item of another database", async (itemId) => itemId],
      ["a type of another tenant", () => createType(foreign, "Foreign type", PAGE_TYPE)],
    ];

    it.each(unusableTypes)("answers 400 on typeId for %s, and the item keeps its type", async (_label, makeTypeId) => {
      const { itemId, oldTypeId } = await typedItem();
      const typeId = await makeTypeId(itemId);
      await discardQueuedJobs();
      const before = await writtenState(p, itemId);

      await expect(change(p, itemId, { typeId })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "typeId" },
      });

      expect(await writtenState(p, itemId)).toEqual(before);
      expect(before.types).toEqual([oldTypeId]);
    });

    it("answers 409 for a type that another transaction is changing, and changes nothing", async () => {
      const { itemId } = await typedItem();
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      const before = await writtenState(p, itemId);
      const holder = await admin.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [newTypeId]);

        await expect(change(p, itemId, { typeId: newTypeId })).rejects.toMatchObject({
          status: 409,
          details: { field: "typeId" },
        });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }

      expect(await writtenState(p, itemId)).toEqual(before);
    });

    it("answers 409 for a card that another transaction holds, and changes nothing", async () => {
      const { itemId, cardId } = await proposedTaskItem(p);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      await discardQueuedJobs();
      const before = await writtenState(p, itemId);
      const holder = await admin.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [cardId]);

        await expect(change(p, itemId, { typeId: newTypeId })).rejects.toMatchObject({
          status: 409,
          details: { field: "type" },
        });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }

      expect(await writtenState(p, itemId)).toEqual(before);
    });
  });

  describe("the item", () => {
    it("answers 404 for an Inbox item of another tenant, as for an id that is no item, and changes nothing there", async () => {
      const foreignItem = await capture(foreign, "Not yours");
      const ownType = await createType(p, "Task", TASK_TYPE);
      await discardQueuedJobs();
      const before = await writtenState(foreign, foreignItem);

      const unknownItem = randomUUID();
      const foreignAnswer = await change(p, foreignItem, { typeId: ownType }).catch((e: unknown) => e);
      const unknownAnswer = await change(p, unknownItem, { typeId: ownType }).catch((e: unknown) => e);

      expect(foreignAnswer).toMatchObject({ status: 404, code: "not_found" });
      expect(unknownAnswer).toMatchObject({ status: 404, code: "not_found" });
      expect(errorMasking(foreignAnswer, foreignItem)).toEqual(errorMasking(unknownAnswer, unknownItem));
      expect(await writtenState(foreign, foreignItem)).toEqual(before);
      expect(before.types).toEqual([]);
    });

    it("answers 404 for a deleted Inbox item and for an item of another database, and changes nothing", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const deleted = await capture(p, "Deleted");
      await inTenant(p, (client) => itemsStore.softDeleteItem(client, p.inboxId, deleted));
      await discardQueuedJobs();
      const before = await writtenState(p, deleted);

      await expect(change(p, deleted, { typeId })).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(change(p, typeId, { typeId })).rejects.toMatchObject({ status: 404, code: "not_found" });

      expect(await writtenState(p, deleted)).toEqual(before);
      expect(await typeIdsOf(p, typeId)).toEqual([]);
    });
  });

  describe("the function", () => {
    it("is a NotFoundError, and writes nothing, when the database it is given has no type relation", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk");
      await discardQueuedJobs();
      const before = await writtenState(p, itemId);

      await expect(
        inTenant(p, (client) =>
          changeInboxItemTypeWithClient(
            client,
            {
              inboxDatabaseId: p.tasksId,
              inboxItemTypesDatabaseId: p.typesId,
              processingProposalsDatabaseId: p.proposalsId,
            },
            { itemId, typeId },
          ),
        ),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });

      expect(await writtenState(p, itemId)).toEqual(before);
    });
  });

  describe("the request", () => {
    it("answers 400 for an id that is not a UUID", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);

      await expect(change(p, "not-a-uuid", { typeId })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "id" },
      });
    });

    it("answers 400 for a body that is no object, has no valid typeId, holds another key or a malformed ifVersion", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk");
      const before = await writtenState(p, itemId);
      const bodies: Array<[unknown, string | undefined]> = [
        [null, undefined],
        [[typeId], undefined],
        [{}, "typeId"],
        [{ typeId: 7 }, "typeId"],
        [{ typeId: "not-a-uuid" }, "typeId"],
        [{ typeId, extra: true }, "extra"],
        [{ typeId, ifVersion: "yesterday" }, "ifVersion"],
        [{ typeId, ifVersion: 7 }, "ifVersion"],
      ];

      for (const [body, field] of bodies) {
        await expect(change(p, itemId, body), JSON.stringify(body)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          ...(field === undefined ? {} : { details: { field } }),
        });
      }

      expect(await writtenState(p, itemId)).toEqual(before);
    });

    it("announces the changed card once the transaction has committed, and announces nothing for a refused change", async () => {
      const { itemId, cardId } = await proposedTaskItem(p);
      const newTypeId = await createType(p, "Event", EVENT_TYPE);
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await expect(change(p, itemId, { typeId: newTypeId, ifVersion: "2000-01-01T00:00:00.000Z" })).rejects.toThrow();
        expect(events).toEqual([]);

        await change(p, itemId, { typeId: newTypeId });
        expect(events).toEqual([{ op: "updated", cardId }]);
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }
    });

    it("announces nothing for an item that has no card", async () => {
      const typeId = await createType(p, "Task", TASK_TYPE);
      const itemId = await capture(p, "Buy milk");
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await change(p, itemId, { typeId });
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }

      expect(events).toEqual([]);
    });
  });
});
