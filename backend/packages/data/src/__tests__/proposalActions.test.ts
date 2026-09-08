import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
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
import { createDocStore, type DocStore } from "../docs/docStore.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let docStore: DocStore;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("Processing proposal confirm/reject/revise (issue #105)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;
  let tasksId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
    tasksId = await databaseIdFor("tasks");
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
      const proposalItemId = relationsStore.otherSide(edges[0], itemId);
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

  async function createDatabaseProposal(text = "Buy milk") {
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
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    await runTick(item.id, async () => ({ properties: { name: text } }));
    return (await findProposalForItem(item.id))!;
  }

  async function createPageContentProposal(text = "A thought") {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    // The Inbox item type itself stands in for a "page" target here — confirm only needs an existing item id.
    await runTick(item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: text } },
    }));
    return { proposal: (await findProposalForItem(item.id))!, targetPageId: type.id };
  }

  it("confirm on a 'database' proposal creates the target item, locks confirmed, and records resultItemId/resultLabel", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    expect(typeof confirmed.properties.resultItemId).toBe("string");
    expect(confirmed.properties.resultLabel).toBe("Buy milk");
    const history = confirmed.properties.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ author: "user" });

    const createdTask = await withTransaction(pool, (client) =>
      itemsStore.getItemById(client, tasksId, confirmed.properties.resultItemId as string),
    );
    expect(createdTask).toBeTruthy();
    expect(createdTask!.properties.name).toBe("Buy milk");
  });

  it("confirm is idempotent under retry: a second confirm does not create a second target item", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const first = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const second = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
    expect(second.updatedAt).toBe(first.updatedAt);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(1);
  });

  it("confirm on a 'pageContent' proposal appends the block and locks confirmed", async () => {
    const { proposal, targetPageId } = await createPageContentProposal("A thought");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    expect(confirmed.properties.resultItemId).toBe(targetPageId);

    const block = await docStore.getBlock(targetPageId, proposal.id);
    expect(block).toMatchObject({ "sys:flavour": "paragraph", content: "A thought" });
  });

  it("confirm refuses a needsClarification proposal (no computed envelope)", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(item.id, async () => {
      throw new Error("must not be called");
    });
    const proposal = (await findProposalForItem(item.id))!;

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/Cannot confirm a proposal in status 'needsClarification'/);
  });

  it("confirm refuses an already-rejected proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/Cannot confirm a proposal in status 'rejected'/);
  });

  it("reject locks rejected and writes no target", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const rejected = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, "Not needed"),
    );

    expect(rejected.properties.status).toBe("rejected");
    expect(rejected.properties.resultItemId).toBeUndefined();
    const history = rejected.properties.history as Array<Record<string, unknown>>;
    expect(history[1]).toMatchObject({ author: "user", message: "Not needed" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(0);
  });

  it("reject is idempotent under retry", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const first = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const second = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("reject refuses an already-confirmed proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/already been confirmed/);
  });

  it("revise can switch a proposal from 'database' to 'pageContent' atomically and records the message", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const pageTarget = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );

    const revised = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
        message: "Actually this is a note",
        entityKind: "pageContent",
        target: pageTarget.id,
        properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
      }),
    );

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: pageTarget.id,
      properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
    });
    const history = revised.properties.history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Actually this is a note" });
  });

  it("revise transitions a 'needsClarification' proposal (no type at all) to 'proposed' with a valid envelope", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(item.id, async () => {
      throw new Error("computeProposal must not be called for an untyped item");
    });
    const needsClarification = (await findProposalForItem(item.id))!;
    expect(needsClarification.properties.status).toBe("needsClarification");

    const revised = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, needsClarification.id, {
        message: "Filed this under Tasks myself",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
      }),
    );

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
    });
    const history = revised.properties.history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Filed this under Tasks myself" });
  });

  it("revise refuses a locked (confirmed) proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "too late",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk again" },
        }),
      ),
    ).rejects.toThrow(/Cannot revise a locked proposal/);
  });

  it("revise validates the replacement envelope against current destination state", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "typo fix",
          entityKind: "database",
          target: tasksId,
          properties: { notAKey: "x" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("revise cannot retarget a proposal at Inbox or Inbox item types — the agent's grant excludes them even via a user-supplied envelope (issue #105 review fix)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "retarget to Inbox",
          entityKind: "database",
          target: inboxId,
          properties: {},
        }),
      ),
    ).rejects.toThrow(/not a writable target database/);

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "retarget to Inbox item types",
          entityKind: "database",
          target: typesId,
          properties: {},
        }),
      ),
    ).rejects.toThrow(/not a writable target database/);

    // The proposal must be untouched by the rejected revise attempts — still pointed at Tasks.
    const untouched = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
    expect((untouched!.properties.proposal as { target: string }).target).toBe(tasksId);
  });
});

afterAll(async () => {
  await pool?.end();
});
