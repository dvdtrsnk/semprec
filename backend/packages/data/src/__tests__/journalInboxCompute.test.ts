import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
} from "../inbox/proposalActions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../inbox/journalInboxCompute.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import type { JournalInboxItemSummary } from "../inbox/journalInboxCompute.js";

let pool: Pool;
let chokePoint: ChokePoint;
let viewTypeRegistry: ViewTypeRegistry;
let computedKeyRegistry: ComputedKeyRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) });
}

describe("Journal Inbox-list computed cache (issue #106)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    computedKeyRegistry = createComputedKeyRegistry();
    chokePoint = createChokePoint(pool, computedKeyRegistry, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry, computedKeyRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function findProposalForItem(itemId: string) {
    return withTransaction(pool, async (client) => {
      const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(
        client,
        sourceInboxProperty!.id,
      );
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
      if (edges.length === 0) return null;
      const proposalItemId = relationsStore.otherSide(edges[0]!, itemId);
      return itemsStore.getItemById(client, proposalsId, proposalItemId);
    });
  }

  async function runTick(itemId: string, computeProposal: ComputeSemprecProposalFn): Promise<void> {
    const handler = createSemprecTickAction(pool, computeProposal);
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId },
    );
  }

  async function captureItem(text: string, typeId?: string) {
    return withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text,
        type: typeId,
      }),
    );
  }

  async function journalDayIdFor(itemId: string): Promise<string> {
    return withTransaction(pool, async (client) => {
      const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty!.id);
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
      return relationsStore.otherSide(edges[0]!, itemId);
    });
  }

  async function computedInboxItems(journalDayItemId: string): Promise<JournalInboxItemSummary[] | undefined> {
    const day = await chokePoint.getItem(journalId, journalDayItemId);
    return day?.computed[JOURNAL_INBOX_COMPUTED_KEY] as JournalInboxItemSummary[] | undefined;
  }

  it("registers the 'journal-inbox' view type with a validated config schema", async () => {
    const definition = viewTypeRegistry.get(JOURNAL_INBOX_VIEW_TYPE);
    expect(definition).toBeTruthy();
    expect(definition!.configSchema!.safeParse({}).success).toBe(false);
    expect(definition!.configSchema!.safeParse({ inboxDatabaseId: inboxId }).success).toBe(false);
    const item = await captureItem("Buy milk");
    const dayId = await journalDayIdFor(item.id);
    expect(definition!.configSchema!.safeParse({ inboxDatabaseId: inboxId, journalDayItemId: dayId }).success).toBe(
      true,
    );
  });

  it("declares its computed key so a colliding regular property is refused", async () => {
    await expect(
      chokePoint.createProperty({
        databaseId: journalId,
        key: JOURNAL_INBOX_COMPUTED_KEY,
        name: "Inbox items",
        type: "text",
      }),
    ).rejects.toThrow();
  });

  it("caches the day's Inbox items after capture", async () => {
    const item = await captureItem("Buy milk");
    const dayId = await journalDayIdFor(item.id);

    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({
      id: item.id,
      date: "2026-08-28",
      time: "09:00",
      text: "Buy milk",
      type: null,
      status: null,
    });
  });

  it("only lists the items related to the matching day", async () => {
    const itemA = await captureItem("Day one item");
    const itemB = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-29",
        time: "09:00",
        text: "Day two item",
      }),
    );
    const dayA = await journalDayIdFor(itemA.id);
    const dayB = await journalDayIdFor(itemB.id);
    expect(dayA).not.toBe(dayB);

    await drainQueue();

    const itemsA = await computedInboxItems(dayA);
    const itemsB = await computedInboxItems(dayB);
    expect(itemsA!.map((i) => i.id)).toEqual([itemA.id]);
    expect(itemsB!.map((i) => i.id)).toEqual([itemB.id]);
  });

  it("includes the item's type once it is recognized, after a tick", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);

    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items![0]!.type).toMatchObject({ id: type.id, name: "Task", emoji: "☑️" });
    expect(items![0]!.status).toBe("proposed");
  });

  it("updates the cached status after a proposal is confirmed", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));

    const proposal = (await findProposalForItem(item.id))!;
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items![0]!.status).toBe("confirmed");
  });

  it("updates the cached status after a proposal is rejected", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await captureItem("A thought", type.id);
    const dayId = await journalDayIdFor(item.id);
    // The Inbox item type itself stands in for a "page" target — the proposal computation is stubbed anyway.
    await runTick(item.id, async () => ({ target: type.id, properties: { flavour: "paragraph" } }));

    const proposal = (await findProposalForItem(item.id))!;
    await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items![0]!.status).toBe("rejected");
  });

  it("updates the cached status after a proposal is revised", async () => {
    // No type given: the tick puts the source item's proposal into 'needsClarification'.
    const item = await captureItem("A thought");
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => {
      throw new Error("computeProposal should not be called for an untyped item");
    });
    const proposal = (await findProposalForItem(item.id))!;
    expect(proposal.properties.status).toBe("needsClarification");
    await drainQueue();
    expect((await computedInboxItems(dayId))![0]!.status).toBe("needsClarification");

    // The Inbox item itself stands in for a "page" target — revise only needs an existing item id.
    await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
        message: "Resolved manually",
        entityKind: "pageContent",
        target: item.id,
        properties: { flavour: "paragraph" },
      }),
    );
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items![0]!.status).toBe("proposed");
  });

  it("drops a deleted Inbox item from the cached day list", async () => {
    const item = await captureItem("Buy milk");
    const dayId = await journalDayIdFor(item.id);
    await drainQueue();
    expect(await computedInboxItems(dayId)).toHaveLength(1);

    await chokePoint.softDeleteItem(inboxId, item.id);
    await runTick(item.id, async () => ({ properties: {} }));
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items).toEqual([]);
  });
});
