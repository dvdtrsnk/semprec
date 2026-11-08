import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runOnce } from "@semprec/queue";
import { bindToTenantZero, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
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
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { JOURNAL_INBOX_COMPUTED_KEY, recomputeJournalInboxDay } from "../inbox/journalInboxCompute.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import type { JournalInboxItemSummary } from "../inbox/journalInboxCompute.js";
import { AiGatewayFailedError } from "@semprec/shared";

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
    chokePoint = bindToTenantZero(createChokePoint(pool, computedKeyRegistry, viewTypeRegistry));
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry, computedKeyRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
  });

  afterEach(() => {
    setInvalidationHook(() => undefined);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function findProposalForItem(itemId: string) {
    return inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
        const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(
          client,
          sourceInboxProperty!.id,
        );
        const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
        if (edges.length === 0) return null;
        const proposalItemId = relationsStore.otherSide(edges[0]!, itemId);
        return itemsStore.getItemById(client, proposalsId, proposalItemId);
      }),
    );
  }

  async function runTick(itemId: string, computeProposal: ComputeSemprecProposalFn): Promise<void> {
    const handler = createSemprecTickAction(pool, computeProposal);
    await inTenantZero(() =>
      handler(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId },
      ),
    );
  }

  async function captureItem(text: string, typeId?: string) {
    return inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text,
          type: typeId,
        }),
      ),
    );
  }

  async function journalDayIdFor(itemId: string): Promise<string> {
    return inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
        const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(
          client,
          journalDayProperty!.id,
        );
        const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
        return relationsStore.otherSide(edges[0]!, itemId);
      }),
    );
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
    const itemB = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-29",
          time: "09:00",
          text: "Day two item",
        }),
      ),
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
    const type = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      ),
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
    const type = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      ),
    );
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));

    const proposal = (await findProposalForItem(item.id))!;
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    );
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items![0]).toMatchObject({ status: "confirmed", processing: "confirmed", proposalSummary: null });
  });

  it("updates the cached status after a proposal is rejected", async () => {
    const type = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Thought",
          emoji: "💭",
          processingMethod: "pageContent",
        }),
      ),
    );
    const item = await captureItem("A thought", type.id);
    const dayId = await journalDayIdFor(item.id);
    // The Inbox item type itself stands in for a "page" target — the proposal computation is stubbed anyway.
    await runTick(item.id, async () => ({ target: type.id, properties: { flavour: "paragraph" } }));

    const proposal = (await findProposalForItem(item.id))!;
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    );
    await drainQueue();

    const items = await computedInboxItems(dayId);
    expect(items![0]).toMatchObject({ status: "rejected", processing: "rejected", proposalSummary: null });
  });

  it("updates the cached status after a proposal is revised", async () => {
    // No type given: the tick puts the source item's proposal into 'needsClarification'.
    const item = await captureItem("A thought");
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => {
      return { properties: {}, candidates: [] };
    });
    const proposal = (await findProposalForItem(item.id))!;
    expect(proposal.properties.status).toBe("needsClarification");
    await drainQueue();
    expect((await computedInboxItems(dayId))![0]!.status).toBe("needsClarification");

    // The Inbox item itself stands in for a "page" target — revise only needs an existing item id.
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Resolved manually",
          entityKind: "pageContent",
          target: item.id,
          properties: { flavour: "paragraph" },
        }),
      ),
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

  describe("recomputeJournalInboxDay publication", () => {
    function captureEvents(): InvalidationEvent[] {
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        events.push(event);
      });
      return events;
    }

    it("publishes exactly one item invalidation carrying the committed updatedAt", async () => {
      const item = await captureItem("Buy milk");
      const dayId = await journalDayIdFor(item.id);
      const events = captureEvents();

      await recomputeJournalInboxDay(pool, dayId);

      const day = await chokePoint.getItem(journalId, dayId);
      expect(events).toEqual([
        { scope: "item", databaseId: journalId, itemId: dayId, op: "update", updatedAt: day!.updatedAt },
      ]);
      expect((await computedInboxItems(dayId))?.map((entry) => entry.id)).toEqual([item.id]);
    });

    it("rejects and publishes nothing when the COMMIT fails, then or from a later transaction", async () => {
      const item = await captureItem("Buy milk");
      const dayId = await journalDayIdFor(item.id);
      const before = await computedInboxItems(dayId);
      const events = captureEvents();

      const commitFailingPool: Pool = {
        connect: async () => {
          const client = await pool.connect();
          const originalQuery = client.query.bind(client);
          const originalRelease = client.release.bind(client);
          client.query = ((...args: Parameters<PoolClient["query"]>) => {
            if (args[0] === "COMMIT") return Promise.reject(new Error("commit failed"));
            return originalQuery(...args);
          }) as PoolClient["query"];
          // Force pg to discard the client so the intercepted COMMIT never reaches the idle queue.
          client.release = (err?: Error | boolean) => {
            originalRelease(err instanceof Error ? err : new Error("discard client contaminated by commitFailingPool"));
          };
          return client;
        },
      } as unknown as Pool;

      await expect(recomputeJournalInboxDay(commitFailingPool, dayId)).rejects.toThrow("commit failed");
      expect(events).toEqual([]);
      expect(await computedInboxItems(dayId)).toEqual(before);

      await inTenantZero(() => withTransaction(pool, async () => undefined));
      expect(events).toEqual([]);
    });

    it("resolves without publishing when the day item does not exist", async () => {
      const events = captureEvents();

      await expect(recomputeJournalInboxDay(pool, randomUUID())).resolves.toBeUndefined();

      expect(events).toEqual([]);
    });
  });

  describe("processing state and proposal summary (issue #1489)", () => {
    let filesId: string;
    let projectsId: string;
    let areasId: string;

    beforeEach(async () => {
      filesId = await databaseIdFor("files");
      projectsId = await databaseIdFor("projects");
      areasId = await databaseIdFor("areas");
    });

    async function createType(name: string, emoji: string, targetDatabase: "tasks" | "files"): Promise<string> {
      const type = await inTenantZero(() =>
        withTransaction(pool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name,
            emoji,
            processingMethod: "database",
            targetDatabase,
          }),
        ),
      );
      return type.id;
    }

    /** A two-operation answer: the primary Files create carries `relations`, the second step is a follow-up. */
    function filesComputation(relations: Record<string, string[]>): ComputeSemprecProposalFn {
      return async () => ({
        properties: {},
        operations: [
          { op: "create", database: "files", alias: "file", properties: { name: "Invoice" }, relations },
          { op: "create", database: "tasks", alias: "payment", properties: { name: "Pay invoice" } },
        ],
      });
    }

    async function cardIdFor(itemId: string): Promise<string> {
      const card = await findProposalForItem(itemId);
      if (!card) throw new Error(`No Processing proposal card for Inbox item ${itemId}`);
      return card.id;
    }

    /**
     * Sets a card's `proposal` directly. The tick cannot store these envelopes (a page target, an unknown kind, a
     * primary update step written by hand), so the test checks how the summary reads them.
     */
    async function setCardProposal(cardId: string, proposal: unknown): Promise<void> {
      const { rows } = await pool.query<{ id: string }>(
        "UPDATE items SET properties = jsonb_set(properties, '{proposal}', $2::jsonb) WHERE id = $1 RETURNING id",
        [cardId, JSON.stringify(proposal)],
      );
      expect(rows).toHaveLength(1);
    }

    /** Sets a card's `status` directly: no production path writes `computing` yet, so the display rule is checked on that state. */
    async function setCardStatus(cardId: string, status: string): Promise<void> {
      const { rows } = await pool.query<{ id: string }>(
        "UPDATE items SET properties = jsonb_set(properties, '{status}', $2::jsonb) WHERE id = $1 RETURNING id",
        [cardId, JSON.stringify(status)],
      );
      expect(rows).toHaveLength(1);
    }

    it("is pending for an item with no card yet", async () => {
      const item = await captureItem("Buy milk");
      const dayId = await journalDayIdFor(item.id);

      await drainQueue();

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry).toMatchObject({ status: null, processing: "pending", proposalSummary: null });
    });

    it("is pending while the card is computing, with no summary", async () => {
      const item = await captureItem("Buy milk", await createType("Task", "☑️", "tasks"));
      const dayId = await journalDayIdFor(item.id);
      await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
      await setCardStatus(await cardIdFor(item.id), "computing");

      await recomputeJournalInboxDay(pool, dayId);

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry).toMatchObject({ status: "computing", processing: "pending", proposalSummary: null });
    });

    it("is failed when the card's computation failed, with no summary", async () => {
      const item = await captureItem("Buy milk", await createType("Task", "☑️", "tasks"));
      const dayId = await journalDayIdFor(item.id);

      await runTick(item.id, async () => {
        throw new AiGatewayFailedError("budget_exceeded");
      });
      await drainQueue();

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry).toMatchObject({ status: "computeFailed", processing: "failed", proposalSummary: null });
    });

    it("summarises a proposed Files card: target database, project, area and the follow-up step", async () => {
      const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Renovation" } });
      const area = await chokePoint.createItem({ databaseId: areasId, properties: { name: "Home" } });
      const item = await captureItem("Invoice scan", await createType("File", "📄", "files"));
      const dayId = await journalDayIdFor(item.id);

      await runTick(item.id, filesComputation({ projects: [project.id], area: [area.id] }));
      await drainQueue();

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry).toMatchObject({ status: "proposed", processing: "proposed" });
      expect(entry.proposalSummary).toEqual({
        entityKind: "database",
        documentKind: null,
        targetDatabaseKey: "files",
        targetItemId: null,
        targetItemName: null,
        projectItemId: project.id,
        projectName: "Renovation",
        areaItemId: area.id,
        areaName: "Home",
        followUps: [{ databaseKey: "tasks", name: "Pay invoice", amount: null, currency: null }],
      });
    });

    it("leaves the area unknown when the Files card names only a project", async () => {
      const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Renovation" } });
      const item = await captureItem("Invoice scan", await createType("File", "📄", "files"));
      const dayId = await journalDayIdFor(item.id);

      await runTick(item.id, filesComputation({ projects: [project.id] }));
      await drainQueue();

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry.proposalSummary).toMatchObject({
        projectItemId: project.id,
        projectName: "Renovation",
        areaItemId: null,
        areaName: null,
      });
    });

    it("summarises a single-step proposal with no project, area or follow-up", async () => {
      const item = await captureItem("Buy milk", await createType("Task", "☑️", "tasks"));
      const dayId = await journalDayIdFor(item.id);

      await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
      await drainQueue();

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry.proposalSummary).toEqual({
        entityKind: "database",
        documentKind: null,
        targetDatabaseKey: "tasks",
        targetItemId: null,
        targetItemName: null,
        projectItemId: null,
        projectName: null,
        areaItemId: null,
        areaName: null,
        followUps: [],
      });
    });

    it("gives an empty summary for a stored envelope of an unknown kind", async () => {
      const item = await captureItem("Buy milk", await createType("Task", "☑️", "tasks"));
      const dayId = await journalDayIdFor(item.id);
      await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
      await setCardProposal(await cardIdFor(item.id), {
        entityKind: "futureKind",
        target: randomUUID(),
        properties: {},
      });

      await recomputeJournalInboxDay(pool, dayId);

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry.proposalSummary).toEqual({
        entityKind: null,
        documentKind: null,
        targetDatabaseKey: null,
        targetItemId: null,
        targetItemName: null,
        projectItemId: null,
        projectName: null,
        areaItemId: null,
        areaName: null,
        followUps: [],
      });
    });

    it("reads a page target and its database from a stored pageContent envelope", async () => {
      const item = await captureItem("Buy milk", await createType("Task", "☑️", "tasks"));
      const dayId = await journalDayIdFor(item.id);
      const page = await chokePoint.createItem({ databaseId: filesId, properties: { name: "Scan" } });
      await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
      await setCardProposal(await cardIdFor(item.id), { entityKind: "pageContent", target: page.id, properties: {} });

      await recomputeJournalInboxDay(pool, dayId);

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry.proposalSummary).toMatchObject({
        entityKind: "pageContent",
        targetItemId: page.id,
        targetItemName: "Scan",
        targetDatabaseKey: "files",
      });
    });

    it("uses a target's declared title instead of an unrelated name property", async () => {
      const item = await captureItem("Buy milk", await createType("Task", "☑️", "tasks"));
      const dayId = await journalDayIdFor(item.id);
      const database = await chokePoint.createDatabase({ name: "Custom pages" });
      await chokePoint.createProperty({ databaseId: database.id, key: "headline", name: "Headline", type: "title" });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const page = await chokePoint.createItem({
        databaseId: database.id,
        properties: { headline: "Actual title", name: "Different name" },
      });
      await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
      await setCardProposal(await cardIdFor(item.id), { entityKind: "pageContent", target: page.id, properties: {} });

      await recomputeJournalInboxDay(pool, dayId);

      expect((await computedInboxItems(dayId))![0]!.proposalSummary).toMatchObject({
        targetItemId: page.id,
        targetItemName: "Actual title",
      });
    });

    it("reads the existing item of a primary update step as the target", async () => {
      const item = await captureItem("Invoice scan", await createType("File", "📄", "files"));
      const dayId = await journalDayIdFor(item.id);
      const existing = await chokePoint.createItem({ databaseId: filesId, properties: { name: "Scan" } });
      await runTick(item.id, async () => ({ properties: { name: "Invoice" } }));
      await setCardProposal(await cardIdFor(item.id), {
        entityKind: "database",
        target: filesId,
        properties: { name: "Scan" },
        operations: [
          { ref: "primary", op: "update", itemId: existing.id, role: "primary", properties: { name: "Scan" } },
        ],
      });

      await recomputeJournalInboxDay(pool, dayId);

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry.proposalSummary).toMatchObject({
        entityKind: "database",
        targetDatabaseKey: "files",
        targetItemId: existing.id,
        targetItemName: "Scan",
      });
    });

    it("reads the amount and currency that a follow-up step carries", async () => {
      const item = await captureItem("Invoice scan", await createType("File", "📄", "files"));
      const dayId = await journalDayIdFor(item.id);
      await runTick(item.id, async () => ({ properties: { name: "Invoice" } }));
      // No seeded database has an `amount` property, so the follow-up is written as the summary reads it.
      await setCardProposal(await cardIdFor(item.id), {
        entityKind: "database",
        target: filesId,
        properties: { name: "Invoice" },
        operations: [
          { ref: "primary", op: "create", databaseKey: "files", role: "primary", properties: { name: "Invoice" } },
          {
            ref: "payment",
            op: "create",
            databaseKey: "tasks",
            role: "secondary",
            properties: { name: "Pay invoice", amount: 250, currency: "CZK" },
          },
        ],
      });

      await recomputeJournalInboxDay(pool, dayId);

      const entry = (await computedInboxItems(dayId))![0]!;
      expect(entry.proposalSummary?.followUps).toEqual([
        { databaseKey: "tasks", name: "Pay invoice", amount: 250, currency: "CZK" },
      ]);
    });
  });
});
