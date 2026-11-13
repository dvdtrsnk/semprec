import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { AiGatewayFailedError } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createInboxTypeWithClient } from "../inboxTypesStore.js";
import { publishInboxCardChange } from "../inboxCardsRealtime.js";
import { confirmProposalWithClient, rejectProposalWithClient } from "../proposalActions.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("inboxCards invalidations from the writers of Processing proposals cards (issue #1811)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let events: InboxCardsInvalidationEvent[];

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    events = [];
    setInboxCardsInvalidationHook((event) => events.push(event));
  });

  afterEach(() => {
    setInboxCardsInvalidationHook(() => {});
  });

  async function createTypedItem(text = "Buy milk"): Promise<string> {
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
        text,
        type: type.id,
      }),
    );
    return item.id;
  }

  /** An Inbox item with no type, which the tick turns into a card that needs clarification. */
  async function createUntypedItem(): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );
    return item.id;
  }

  function tick(itemId: string, computeProposal: ComputeSemprecProposalFn, isFinalAttempt = false): Promise<void> {
    return createSemprecTickAction(pool, computeProposal)(
      {
        inboxDatabaseId: inboxId,
        inboxItemTypesDatabaseId: typesId,
        processingProposalsDatabaseId: proposalsId,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId, isFinalAttempt },
    );
  }

  const proposes: ComputeSemprecProposalFn = async () => ({ properties: { name: "Buy milk" } });
  const failsWithBudget: ComputeSemprecProposalFn = async () => {
    throw new AiGatewayFailedError("budget_exceeded");
  };

  async function cardOf(itemId: string) {
    return withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
      const edges = await relationsStore.listRelationsForItem(client, definition!.id, itemId);
      const card = edges[0]
        ? await itemsStore.getItemById(client, proposalsId, relationsStore.otherSide(edges[0], itemId))
        : null;
      if (!card) throw new Error("Expected a card for the Inbox item");
      return card;
    });
  }

  async function editText(itemId: string, text: string): Promise<void> {
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch: { text } }),
    );
  }

  describe("publishInboxCardChange", () => {
    it("announces the card once, after the transaction committed", async () => {
      const cardId = randomUUID();

      await withTransaction(pool, async (client) => {
        publishInboxCardChange(client, cardId, "updated");
        expect(events).toEqual([]);
      });

      expect(events).toEqual([{ op: "updated", cardId }]);
    });

    it("announces nothing when the transaction rolls back", async () => {
      await expect(
        withTransaction(pool, async (client) => {
          publishInboxCardChange(client, randomUUID(), "created");
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(events).toEqual([]);
    });

    it("keeps the committed write and the result when the hook throws", async () => {
      setInboxCardsInvalidationHook(() => {
        throw new Error("publisher down");
      });

      const result = await withTransaction(pool, async (client) => {
        publishInboxCardChange(client, randomUUID(), "closed");
        return "committed";
      });

      expect(result).toBe("committed");
    });
  });

  describe("the tick", () => {
    it("announces a card it creates as created", async () => {
      const itemId = await createTypedItem();

      await tick(itemId, proposes);

      const card = await cardOf(itemId);
      expect(card.properties.status).toBe("proposed");
      expect(events).toEqual([{ op: "created", cardId: card.id }]);
    });

    it("announces a card it revises after the source changed as updated", async () => {
      const itemId = await createTypedItem();
      await tick(itemId, proposes);
      events.length = 0;
      await editText(itemId, "Buy milk and eggs");

      await tick(itemId, proposes);

      const card = await cardOf(itemId);
      expect(events).toEqual([{ op: "updated", cardId: card.id }]);
    });

    it("announces nothing when the fingerprint is unchanged and the tick writes nothing", async () => {
      const itemId = await createTypedItem();
      await tick(itemId, proposes);
      events.length = 0;

      await tick(itemId, async () => {
        throw new Error("computeProposal must not run for an unchanged source");
      });

      expect(events).toEqual([]);
    });

    it("announces a card that needs clarification as created, and as updated when it is written again", async () => {
      const itemId = await createUntypedItem();

      await tick(itemId, async () => ({ properties: {}, candidates: [] }));
      const card = await cardOf(itemId);
      expect(card.properties.status).toBe("needsClarification");
      expect(events).toEqual([{ op: "created", cardId: card.id }]);

      events.length = 0;
      await editText(itemId, "Buy milk and eggs");
      await tick(itemId, async () => ({ properties: {}, candidates: [] }));
      expect(events).toEqual([{ op: "updated", cardId: card.id }]);
    });

    it("announces a compute failure that creates the card as created", async () => {
      const itemId = await createTypedItem();

      await tick(itemId, failsWithBudget);

      const card = await cardOf(itemId);
      expect(card.properties.status).toBe("computeFailed");
      expect(events).toEqual([{ op: "created", cardId: card.id }]);
    });

    it("announces a compute failure on an existing card as updated", async () => {
      const itemId = await createTypedItem();
      await tick(itemId, proposes);
      const proposed = await cardOf(itemId);
      events.length = 0;
      await editText(itemId, "Buy milk and eggs");

      await tick(itemId, failsWithBudget, true);

      const card = await cardOf(itemId);
      expect(card.id).toBe(proposed.id);
      expect(card.properties.status).toBe("computeFailed");
      expect(events).toEqual([{ op: "updated", cardId: card.id }]);
    });

    it("announces nothing when a compute failure is stale because the source changed during the call", async () => {
      const itemId = await createTypedItem();

      await tick(
        itemId,
        async () => {
          await editText(itemId, "Buy milk and eggs");
          throw new AiGatewayFailedError("budget_exceeded");
        },
        true,
      );

      expect(events).toEqual([]);
    });

    it("announces a card whose source was deleted as updated, and as updated again when the source is restored", async () => {
      const itemId = await createTypedItem();
      await tick(itemId, proposes);
      const card = await cardOf(itemId);
      events.length = 0;

      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
      await tick(itemId, async () => {
        throw new Error("computeProposal must not run for a deleted source");
      });
      expect((await cardOf(itemId)).properties.status).toBe("invalid");
      expect(events).toEqual([{ op: "updated", cardId: card.id }]);

      events.length = 0;
      await withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, itemId));
      await tick(itemId, async () => {
        throw new Error("computeProposal must not run for an unchanged source");
      });
      expect((await cardOf(itemId)).properties.status).toBe("proposed");
      expect(events).toEqual([{ op: "updated", cardId: card.id }]);
    });

    it("announces nothing for the deleted source of a card that was already confirmed", async () => {
      const itemId = await createTypedItem();
      await tick(itemId, proposes);
      const card = await cardOf(itemId);
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id),
      );
      events.length = 0;

      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
      await tick(itemId, async () => {
        throw new Error("computeProposal must not run for a deleted source");
      });

      expect(events).toEqual([]);
    });
  });

  describe("the card actions", () => {
    async function proposedCard(): Promise<string> {
      const itemId = await createTypedItem();
      await tick(itemId, proposes);
      const card = await cardOf(itemId);
      events.length = 0;
      return card.id;
    }

    it("announces a confirmed card as closed", async () => {
      const cardId = await proposedCard();

      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );

      expect(events).toEqual([{ op: "closed", cardId }]);
    });

    it("announces nothing when the confirm is repeated on a confirmed card", async () => {
      const cardId = await proposedCard();
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );
      events.length = 0;

      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );

      expect(events).toEqual([]);
    });

    it("announces nothing when a confirm is refused", async () => {
      const itemId = await createUntypedItem();
      await tick(itemId, async () => ({ properties: {}, candidates: [] }));
      const card = await cardOf(itemId);
      events.length = 0;

      await expect(
        withTransaction(pool, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id),
        ),
      ).rejects.toThrow("Cannot confirm a proposal in status 'needsClarification'");

      expect(events).toEqual([]);
    });

    it("announces nothing when the transaction of a confirm rolls back", async () => {
      const cardId = await proposedCard();

      await expect(
        withTransaction(pool, async (client) => {
          await confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(events).toEqual([]);
    });

    it("announces a rejected card as closed", async () => {
      const cardId = await proposedCard();

      await withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );

      expect(events).toEqual([{ op: "closed", cardId }]);
    });

    it("announces nothing when the reject is repeated on a rejected card", async () => {
      const cardId = await proposedCard();
      await withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );
      events.length = 0;

      await withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );

      expect(events).toEqual([]);
    });

    it("announces nothing when a reject is refused because the card was confirmed", async () => {
      const cardId = await proposedCard();
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      );
      events.length = 0;

      await expect(
        withTransaction(pool, (client) =>
          rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
        ),
      ).rejects.toThrow("Cannot reject a proposal that has already been confirmed");

      expect(events).toEqual([]);
    });
  });
});
