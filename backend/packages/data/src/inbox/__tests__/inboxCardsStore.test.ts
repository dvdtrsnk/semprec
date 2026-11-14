import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { createAgentRun, type AgentRunRow } from "../../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest, decideApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { provisionTenant } from "../../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createMarkdownPageContentProposal } from "../../testSupport/pageProposalFixtures.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { createTranscriptEventCard, matchTranscriptToEvent } from "../../transcription/transcriptEventMatch.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createInboxTypeWithClient } from "../inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";
import {
  confirmProposalWithClient,
  recomputeProposalWithClient,
  rejectProposalWithClient,
} from "../proposalActions.js";
import { createInboxCardsCountRouteHandler, createInboxCardsRouteHandler } from "../inboxRouteHandlers.js";
import {
  COMPUTING_TIMEOUT_MS,
  INBOX_CARDS_LIMIT,
  countOpenInboxCards,
  isComputingTimedOut,
  listInboxCards,
  type InboxCard,
  type InboxCardList,
} from "../inboxCardsStore.js";
import type { ProposalStep } from "../proposalEnvelope.js";
import type { ItemRow } from "../../types.js";

// Each test seeds the system databases and a handful of cards; the bulk tests create hundreds of rows.
const BULK_TEST_TIMEOUT_MS = 120_000;

let adminPool: Pool;
let ownerId: string;
let inboxId: string;
let typesId: string;
let proposalsId: string;
let taskTypeId: string;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
    moduleId,
  ]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** Lists the stack of `pool` in tenant zero for `userId`; the read runs in one managed transaction, as the route does. */
function listCards(pool: Pool, userId: string, locale = "en"): Promise<InboxCardList> {
  return inTenantZero(() => withTransaction(pool, (client) => listInboxCards(client, { ownerUserId: userId, locale })));
}

/** The number of open Inbox cards of `userId` read through `pool` in tenant zero, in one managed transaction, as the route does. */
function countCards(pool: Pool, userId: string): Promise<number> {
  return inTenantZero(() => withTransaction(pool, (client) => countOpenInboxCards(client, { ownerUserId: userId })));
}

function cardIds(list: InboxCardList): string[] {
  return list.cards.map((card) => card.cardId);
}

function cardOf(list: InboxCardList, cardId: string): InboxCard {
  const card = list.cards.find((candidate) => candidate.cardId === cardId);
  if (!card) throw new Error(`Card ${cardId} is not in the list`);
  return card;
}

const TASK_COMPUTATION: ComputeSemprecProposalFn = async (input) => ({
  properties: { name: input.sourceItem.properties.text },
});

/** An Inbox item of the Task type and the Processing proposals card the tick makes for it. */
async function proposedCard(
  text: string,
  options: {
    when?: { date: string; time: string };
    compute?: ComputeSemprecProposalFn;
    typeId?: string;
  } = {},
): Promise<{ itemId: string; cardId: string }> {
  const { when = { date: "2026-08-28", time: "09:00" }, compute = TASK_COMPUTATION, typeId = taskTypeId } = options;
  return inTenantZero(async () => {
    const item = await withTransaction(adminPool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, ...when, text, type: typeId }),
    );
    await createSemprecTickAction(adminPool, compute)(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    const { rows } = await adminPool.query<{ id: string }>(
      `SELECT p.id FROM items p JOIN item_relations r ON r.item_a = p.id AND r.item_b = $2 WHERE p.database_id = $1`,
      [proposalsId, item.id],
    );
    if (!rows[0]) throw new Error("The tick stored no card");
    return { itemId: item.id, cardId: rows[0].id };
  });
}

/**
 * A transcript of a recording that overlaps an occurrence of a recurring Event that has no item yet, and the card the
 * match step makes for it: a link to the occurrence by its synthetic id (issue gh-1850).
 */
async function occurrenceCard(): Promise<{ transcriptId: string; cardId: string; occurrenceId: string }> {
  return inTenantZero(() =>
    withTransaction(adminPool, async (client) => {
      const series = await createItemWithClient(client, {
        databaseId: await databaseIdFor("events"),
        properties: {
          name: "Standup",
          type: "standup",
          date: "2026-10-12",
          timeFrom: "09:00",
          timeTo: "09:30",
          recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
        },
      });
      const transcriptsId = await databaseIdFor("transcripts");
      const transcript = await createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { date: "2026-10-14T07:01:00.000Z" } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await itemsStore.writeComputed(client, transcriptsId, transcript.id, "segments", [
        { speaker: "SPEAKER_00", text: "Good morning everyone." },
      ]);
      await itemsStore.writeComputed(client, transcriptsId, transcript.id, "durationSeconds", 1200);
      const match = await matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 1200 });
      if (typeof match === "string" || match.outcome !== "ambiguous") throw new Error("Expected an ambiguous match");
      const { cardId } = await createTranscriptEventCard(client, {
        transcriptId: transcript.id,
        candidates: match.candidates,
        recommendation: null,
      });
      return { transcriptId: transcript.id, cardId, occurrenceId: `${series.id}@2026-10-14` };
    }),
  );
}

/**
 * `count` proposed cards with no source and no envelope, written through the choke point. The tick makes a card in
 * about half a second, too slow for the volume of the limit tests, which look at the number of cards and not at
 * what a card holds.
 */
async function bareProposedCards(count: number): Promise<void> {
  await inTenantZero(() =>
    withTransaction(adminPool, async (client) => {
      for (let n = 0; n < count; n += 1) {
        await createItemWithClient(
          client,
          { databaseId: proposalsId, properties: { kind: "inbox", status: "proposed", proposal: null } },
          { allowedSystemKeys: ["kind", "status", "proposal"] },
        );
      }
    }),
  );
}

/** Soft-deletes the source Inbox item and runs the tick again, which makes the card `invalid` for a deleted source. */
async function invalidateBySourceDeletion(itemId: string): Promise<void> {
  await inTenantZero(async () => {
    await withTransaction(adminPool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
    await createSemprecTickAction(adminPool, async () => {
      throw new Error("The tick must not compute a card whose source was deleted");
    })(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId },
    );
  });
}

/**
 * Sets a card's stored `status` directly. `computing` has no producer yet, and `needsClarification` is
 * produced only by the model's recognition, which the tick of these tests does not run.
 */
async function setCardStatus(cardId: string, status: string): Promise<void> {
  const { rows } = await adminPool.query<{ id: string }>(
    "UPDATE items SET properties = jsonb_set(properties, '{status}', $2::jsonb) WHERE id = $1 RETURNING id",
    [cardId, JSON.stringify(status)],
  );
  expect(rows).toHaveLength(1);
}

/** A pending approval request of a new run started by `triggeredBy`, a delegated run below it when `delegated`. */
async function approvalFrom(
  triggeredBy: AgentRunRow["triggeredBy"],
  options: { delegated?: boolean } = {},
): Promise<string> {
  return inTenantZero(async () => {
    const root = await createAgentRun(adminPool, { triggeredBy, task: "probe" });
    const run = options.delegated
      ? await createAgentRun(adminPool, { triggeredBy: "supervisor", task: "delegated", parentRunId: root.id })
      : root;
    const request = await createPendingApprovalRequest(adminPool, {
      agentRunId: run.id,
      toolName: "send_email",
      riskClass: "outbound",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "a@b.com" } },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    return request.id;
  });
}

/** A transcript and the card `matchTranscriptToEvent` makes for it, as the transcription pipeline does. */
async function transcriptCard(name: string, date: string): Promise<{ transcriptId: string; cardId: string }> {
  return inTenantZero(() =>
    withTransaction(adminPool, async (client) => {
      const transcriptsId = await databaseIdFor("transcripts");
      const transcript = await createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name, date } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 60 });
      const { rows } = await client.query<{ id: string }>(
        `SELECT p.id FROM items p JOIN item_relations r ON r.item_a = p.id AND r.item_b = $2 WHERE p.database_id = $1`,
        [proposalsId, transcript.id],
      );
      if (!rows[0]) throw new Error("matchTranscriptToEvent stored no card");
      return { transcriptId: transcript.id, cardId: rows[0].id };
    }),
  );
}

describe("listInboxCards (issue #1807)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    const viewTypeRegistry = createViewTypeRegistry();
    await seedSystem(adminPool, viewTypeRegistry);
    ownerId = (await createTenantZeroUser(adminPool)).id;
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    taskTypeId = (
      await inTenantZero(() =>
        withTransaction(adminPool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name: "Task",
            emoji: "☑️",
            processingMethod: "database",
            targetDatabase: "tasks",
          }),
        ),
      )
    ).id;
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  it("returns an empty stack for a tenant without cards", async () => {
    expect(await listCards(adminPool, ownerId)).toEqual({ cards: [], total: 0 });
  });

  it("orders five cards of different states and kinds by group: approval, proposed, invalid, needsClarification, transcript", async () => {
    // Created in the reverse of the expected order, so the order is not the order of creation.
    const transcript = await transcriptCard("Standup", "2026-08-28T08:00:00.000Z");
    const clarification = await proposedCard("Unclear capture");
    await setCardStatus(clarification.cardId, "needsClarification");
    const invalid = await proposedCard("Deleted capture");
    await invalidateBySourceDeletion(invalid.itemId);
    const proposed = await proposedCard("Buy milk");
    const approval = await approvalFrom("heartbeat");

    const list = await listCards(adminPool, ownerId);

    expect(cardIds(list)).toEqual([approval, proposed.cardId, invalid.cardId, clarification.cardId, transcript.cardId]);
    expect(list.cards.map((card) => [card.source, card.cardKind, card.baseKind, card.status])).toEqual([
      ["approval", "approval", "approval", "pending"],
      ["proposal", "task", "task", "proposed"],
      ["proposal", "invalid", "task", "invalid"],
      ["proposal", "clarify", "clarify", "needsClarification"],
      ["proposal", "transcriptEvent", "event", "proposed"],
    ]);
    expect(list.total).toBe(5);
  });

  it("leaves out confirmed, rejected and deleted cards and the approvals of chat, and the approvals already decided", async () => {
    const open = await proposedCard("Still open");
    const confirmed = await proposedCard("Confirmed one");
    const rejected = await proposedCard("Rejected one");
    const deleted = await proposedCard("Deleted card");
    await inTenantZero(() =>
      withTransaction(adminPool, async (client) => {
        await confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, confirmed.cardId);
        await rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, rejected.cardId);
        await itemsStore.softDeleteItem(client, proposalsId, deleted.cardId);
      }),
    );
    const tickApproval = await approvalFrom("heartbeat");
    await approvalFrom("user");
    const decided = await approvalFrom("heartbeat");
    await inTenantZero(() =>
      withTransaction(adminPool, (client) => decideApprovalRequest(client, decided, "rejected", ownerId)),
    );

    const list = await listCards(adminPool, ownerId);

    expect(cardIds(list)).toEqual([tickApproval, open.cardId]);
    expect(list.total).toBe(2);
  });

  describe("the route handler", () => {
    it("lists the stack of the user and the locale of the session as a 200 body", async () => {
      const card = await proposedCard("Buy milk");
      const approval = await approvalFrom("heartbeat");

      const answer = await inTenantZero(() =>
        createInboxCardsRouteHandler(adminPool)({ identity: { user: { id: ownerId, locale: "cs" } } }),
      );

      if (!("body" in answer)) throw new Error("expected a raw JSON body");
      expect(answer.status).toBe(200);
      const listed = await listCards(adminPool, ownerId, "cs");
      const body = answer.body as { cards: Record<string, unknown>[]; total: number };
      // The handler hands out the store output unchanged except for the additive editorSchema of each card
      // (its content is covered by inboxRouteHandlers.test.ts), so every other field is compared in full.
      expect(body.cards.every((c) => "editorSchema" in c)).toBe(true);
      expect(body.cards.map(({ editorSchema: _editorSchema, ...rest }) => rest)).toEqual(listed.cards);
      expect(body.total).toBe(listed.total);
      expect(answer.body).toMatchObject({
        cards: [{ cardId: approval }, { cardId: card.cardId, targets: [{ databaseKey: "tasks", label: "Úkol" }] }],
        total: 2,
      });
    });

    it("lists no approval of a user who is not the actor of the runs", async () => {
      await approvalFrom("heartbeat");
      const other = (await createTenantZeroUser(adminPool)).id;

      const answer = await inTenantZero(() =>
        createInboxCardsRouteHandler(adminPool)({ identity: { user: { id: other, locale: "en" } } }),
      );

      expect(answer).toEqual({ status: 200, body: { cards: [], total: 0 } });
    });
  });

  describe("order inside a group", () => {
    it("orders proposed cards by the capture date and time of their Inbox item, not by creation", async () => {
      const latest = await proposedCard("Latest", { when: { date: "2026-08-28", time: "10:00" } });
      const sameDayEarlier = await proposedCard("Same day earlier", { when: { date: "2026-08-28", time: "09:00" } });
      const dayBefore = await proposedCard("Day before", { when: { date: "2026-08-27", time: "23:00" } });

      expect(cardIds(await listCards(adminPool, ownerId))).toEqual([
        dayBefore.cardId,
        sameDayEarlier.cardId,
        latest.cardId,
      ]);
    });

    it("orders cards of the same capture time by id", async () => {
      const cards = [await proposedCard("One"), await proposedCard("Two"), await proposedCard("Three")];

      expect(cardIds(await listCards(adminPool, ownerId))).toEqual(cards.map((card) => card.cardId).sort());
    });

    it("orders pending approvals by the time they were requested", async () => {
      const first = await approvalFrom("heartbeat");
      const second = await approvalFrom("mcp");
      const third = await approvalFrom("heartbeat");

      expect(cardIds(await listCards(adminPool, ownerId))).toEqual([first, second, third]);
    });

    it("orders transcript cards by the instant of the transcript date, not by its text", async () => {
      // 08:00Z written with an offset sorts after 09:00Z as text, and before it as an instant.
      const later = await transcriptCard("Later", "2026-08-28T09:00:00.000Z");
      const earlier = await transcriptCard("Earlier", "2026-08-28T10:00:00+02:00");

      expect(cardIds(await listCards(adminPool, ownerId))).toEqual([earlier.cardId, later.cardId]);
    });
  });

  describe("cards being computed", () => {
    it("lists computing and computeFailed cards in the proposals group by capture time and does not count them", async () => {
      const proposed = await proposedCard("Proposed", { when: { date: "2026-08-28", time: "10:00" } });
      const computing = await proposedCard("Computing", { when: { date: "2026-08-28", time: "09:00" } });
      const failed = await proposedCard("Failed", { when: { date: "2026-08-28", time: "08:00" } });
      const invalid = await proposedCard("Invalid", { when: { date: "2026-08-28", time: "07:00" } });
      await invalidateBySourceDeletion(invalid.itemId);
      // `computing` has no producer yet and `computeFailed` is written by a queued job, so both are set directly.
      await setCardStatus(computing.cardId, "computing");
      await setCardStatus(failed.cardId, "computeFailed");
      const approval = await approvalFrom("heartbeat");

      const list = await listCards(adminPool, ownerId);

      expect(list.cards.map((card) => [card.cardId, card.status])).toEqual([
        [approval, "pending"],
        [failed.cardId, "computeFailed"],
        [computing.cardId, "computing"],
        [proposed.cardId, "proposed"],
        [invalid.cardId, "invalid"],
      ]);
      expect(list.total).toBe(3);
    });

    it("has a total of 0 for a stack that holds only cards being computed", async () => {
      const computing = await proposedCard("Computing");
      await setCardStatus(computing.cardId, "computing");

      const list = await listCards(adminPool, ownerId);

      expect(cardIds(list)).toEqual([computing.cardId]);
      expect(list.total).toBe(0);
    });
  });

  describe("a card that stays computing past the timeout (issue gh-2026)", () => {
    const MINUTE_MS = 60_000;

    /** Moves the clock `ms` ahead of the real one. Only `Date` is faked, so the database and the timers of the pools run as they do. */
    function clockAfter(ms: number): void {
      const base = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(base + ms);
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Asks for a new computation of the card through the production action, which stores `computing` with a new `updatedAt`. */
    function sendBack(cardId: string): Promise<ItemRow> {
      return inTenantZero(() =>
        withTransaction(adminPool, (client) =>
          recomputeProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {}),
        ),
      );
    }

    /** What a card's row holds, as `GET /api/items/:id` would read it. */
    async function stored(cardId: string): Promise<{ updatedAt: string; properties: Record<string, unknown> }> {
      const card = await inTenantZero(() =>
        withTransaction(adminPool, (client) => itemsStore.getItemById(client, proposalsId, cardId)),
      );
      if (!card) throw new Error(`card ${cardId} not found`);
      return { updatedAt: card.updatedAt, properties: card.properties };
    }

    it("lists a card that has been computing for less than the timeout as computing, without the timeout flag", async () => {
      const card = await proposedCard("Computing");
      await sendBack(card.cardId);
      clockAfter(COMPUTING_TIMEOUT_MS - MINUTE_MS);

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);

      expect(listed.status).toBe("computing");
      expect(listed).not.toHaveProperty("computeTimedOut");
    });

    it("lists a card that has been computing for longer than the timeout as computeFailed with computeTimedOut, and changes nothing else about it", async () => {
      const card = await proposedCard("Computing");
      await sendBack(card.cardId);
      const before = await stored(card.cardId);
      const fresh = cardOf(await listCards(adminPool, ownerId), card.cardId);
      clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);

      expect(listed).toEqual({ ...fresh, status: "computeFailed", computeTimedOut: true });
      expect(listed.version).toBe(before.updatedAt);
    });

    it("leaves the stored card as it was, uncounted like every computing card", async () => {
      const proposed = await proposedCard("Proposed");
      const card = await proposedCard("Computing");
      await sendBack(card.cardId);
      const before = await stored(card.cardId);
      clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

      const list = await listCards(adminPool, ownerId);

      expect(cardOf(list, card.cardId).status).toBe("computeFailed");
      expect(await stored(card.cardId)).toEqual(before);
      expect(before.properties.status).toBe("computing");
      expect(list.total).toBe(1);
      expect(await countCards(adminPool, ownerId)).toBe(1);
      expect(cardIds(list).sort()).toEqual([proposed.cardId, card.cardId].sort());
    });

    it("answers the card list of the route with the timed-out card as computeFailed, and the count of the route without it", async () => {
      await proposedCard("Proposed");
      const card = await proposedCard("Computing");
      await sendBack(card.cardId);
      clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);

      const listAnswer = await inTenantZero(() =>
        createInboxCardsRouteHandler(adminPool)({ identity: { user: { id: ownerId, locale: "en" } } }),
      );
      const countAnswer = await inTenantZero(() =>
        createInboxCardsCountRouteHandler(adminPool)({ identity: { user: { id: ownerId } } }),
      );

      expect(listAnswer).toMatchObject({
        status: 200,
        body: {
          cards: expect.arrayContaining([
            expect.objectContaining({ cardId: card.cardId, status: "computeFailed", computeTimedOut: true }),
          ]),
          total: 1,
        },
      });
      expect(countAnswer).toEqual({ status: 200, body: { total: 1 } });
    });

    it("lists the card as proposed once a late tick has stored its result", async () => {
      const card = await proposedCard("Buy milk");
      await sendBack(card.cardId);
      clockAfter(COMPUTING_TIMEOUT_MS + MINUTE_MS);
      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).status).toBe("computeFailed");

      await inTenantZero(() =>
        createSemprecTickAction(adminPool, async () => ({ properties: { name: "Buy oat milk" } }))(
          { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
          { heartbeatId: "hb", projectItemId: "proj", itemId: card.itemId },
        ),
      );

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);
      expect(listed.status).toBe("proposed");
      expect(listed).not.toHaveProperty("computeTimedOut");
      expect((await stored(card.cardId)).properties).toMatchObject({
        status: "proposed",
        proposal: { properties: { name: "Buy oat milk" } },
      });
    });

    it("never times out a card that is not computing, however old it is", async () => {
      const proposed = await proposedCard("Proposed", { when: { date: "2026-08-28", time: "09:00" } });
      const failed = await proposedCard("Failed", { when: { date: "2026-08-28", time: "08:00" } });
      await setCardStatus(failed.cardId, "computeFailed");
      const clarification = await proposedCard("Unclear capture");
      await setCardStatus(clarification.cardId, "needsClarification");
      clockAfter(24 * 60 * MINUTE_MS);

      const list = await listCards(adminPool, ownerId);

      expect(list.cards.map((card) => [card.cardId, card.status, "computeTimedOut" in card])).toEqual([
        [failed.cardId, "computeFailed", false],
        [proposed.cardId, "proposed", false],
        [clarification.cardId, "needsClarification", false],
      ]);
    });
  });

  describe("approvals", () => {
    it("lists an approval of a run delegated by a tick and of an MCP client, and not one of chat or of a delegated chat run", async () => {
      const delegatedByTick = await approvalFrom("heartbeat", { delegated: true });
      const fromMcp = await approvalFrom("mcp");
      await approvalFrom("user");
      await approvalFrom("user", { delegated: true });

      const list = await listCards(adminPool, ownerId);

      expect(cardIds(list)).toEqual([delegatedByTick, fromMcp]);
      expect(list.cards.map((card) => card.resolvedSource)).toEqual([
        {
          kind: "run",
          sourceKind: "tick",
          threadId: null,
          threadTitle: null,
          heartbeatId: null,
          heartbeatName: null,
          mcpClientName: null,
        },
        {
          kind: "run",
          sourceKind: "mcp",
          threadId: null,
          threadTitle: null,
          heartbeatId: null,
          heartbeatName: null,
          mcpClientName: null,
        },
      ]);
      expect(list.cards[0]).toMatchObject({
        source: "approval",
        cardKind: "approval",
        baseKind: "approval",
        status: "pending",
        version: null,
        context: null,
        targets: [],
        envelope: null,
      });
    });

    it("lists the approvals of the caller only", async () => {
      const mine = await approvalFrom("heartbeat");
      const other = (await createTenantZeroUser(adminPool)).id;

      expect(cardIds(await listCards(adminPool, ownerId))).toEqual([mine]);
      // The tenant holds one user's runs only (a run takes its actor from the tenant's sole user), so
      // the second user has no run and no approval.
      expect(cardIds(await listCards(adminPool, other))).toEqual([]);
    });
  });

  describe("the resolved source", () => {
    it("carries the text, date, time and type of the Inbox item of a card", async () => {
      const card = await proposedCard("Buy milk", { when: { date: "2026-08-28", time: "09:15" } });

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).resolvedSource).toEqual({
        kind: "inboxItem",
        id: card.itemId,
        text: "Buy milk",
        date: "2026-08-28",
        time: "09:15",
        type: { id: taskTypeId, name: "Task", emoji: "☑️" },
      });
    });

    it("still names the Inbox item of a card that became invalid because the item was deleted", async () => {
      const card = await proposedCard("Deleted capture");
      await invalidateBySourceDeletion(card.itemId);

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);

      expect(listed).toMatchObject({ cardKind: "invalid", baseKind: "task", status: "invalid" });
      expect(listed.resolvedSource).toMatchObject({ kind: "inboxItem", id: card.itemId, text: "Deleted capture" });
    });

    it("has a null type for an Inbox item that has no type", async () => {
      const card = await proposedCard("Untyped now");
      await inTenantZero(async () => {
        const { rows } = await adminPool.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'type'",
          [inboxId],
        );
        await withTransaction(adminPool, (client) =>
          deleteRelationWithClient(client, {
            relationPropertyId: rows[0]!.id,
            callerItemId: card.itemId,
            targetItemId: taskTypeId,
          }),
        );
      });

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).resolvedSource).toMatchObject({
        kind: "inboxItem",
        text: "Untyped now",
        type: null,
      });
    });

    it("carries the id, name and date of the transcript of a transcript card", async () => {
      const card = await transcriptCard("Standup", "2026-08-28T08:00:00.000Z");

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).resolvedSource).toEqual({
        kind: "transcript",
        id: card.transcriptId,
        name: "Standup",
        completedAt: "2026-08-28T08:00:00.000Z",
      });
    });

    it("is null for a card whose source is gone for good", async () => {
      const card = await proposedCard("Purged capture");
      await inTenantZero(async () => {
        // Raw SQL: no API purges an Inbox item that a card still refers to, and the edge goes with the item.
        await adminPool.query("DELETE FROM items WHERE database_id = $1 AND id = $2", [inboxId, card.itemId]);
      });

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).resolvedSource).toBeNull();
    });
  });

  describe("the card fields", () => {
    it("carries the version, the effective envelope and the stored context of a proposal card", async () => {
      const card = await proposedCard("Buy milk");
      const context = { alternatives: [{ eventId: randomUUID() }] };
      // Raw SQL: `context` is written by the transcript producers, and the card of this test is an Inbox card.
      await adminPool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{context}', $2::jsonb) WHERE id = $1",
        [card.cardId, JSON.stringify(context)],
      );
      const stored = await inTenantZero(() =>
        withTransaction(adminPool, (client) => itemsStore.getItemById(client, proposalsId, card.cardId)),
      );

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);

      expect(listed.version).toBe(stored!.updatedAt);
      expect(listed.envelope).toEqual(stored!.properties.proposal);
      expect(listed.envelope).toMatchObject({ entityKind: "database", properties: { name: "Buy milk" } });
      expect(listed.context).toEqual(context);
    });

    it("has a null context when none is stored", async () => {
      const card = await proposedCard("Buy milk");

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).context).toBeNull();
    });

    it("has a null envelope and no targets for a card that has none", async () => {
      const card = await proposedCard("Unclear capture");
      await setCardStatus(card.cardId, "needsClarification");
      await adminPool.query("UPDATE items SET properties = properties || '{\"proposal\": null}'::jsonb WHERE id = $1", [
        card.cardId,
      ]);

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId)).toMatchObject({
        cardKind: "clarify",
        baseKind: "clarify",
        envelope: null,
        targets: [],
      });
    });

    it("returns an envelope of a kind this release does not know as stored, as a clarify card without targets", async () => {
      const card = await proposedCard("From the future");
      const future = { entityKind: "futureKind", target: randomUUID(), properties: {} };
      await adminPool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{proposal}', $2::jsonb) WHERE id = $1",
        [card.cardId, JSON.stringify(future)],
      );

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId)).toMatchObject({
        cardKind: "clarify",
        baseKind: "page",
        envelope: { ...future, unknownKind: true },
        targets: [],
      });
    });
  });

  describe("targets", () => {
    it.each([
      ["en", "Task"],
      ["cs", "Úkol"],
      ["de", "Task"],
    ])("labels the Tasks target of a task card in the locale %s", async (locale, label) => {
      const card = await proposedCard("Buy milk");

      expect(cardOf(await listCards(adminPool, ownerId, locale), card.cardId).targets).toEqual([
        { databaseKey: "tasks", label },
      ]);
    });

    it("keeps the target of an invalid card, labelled by the kind it edits", async () => {
      const card = await proposedCard("Deleted capture");
      await invalidateBySourceDeletion(card.itemId);

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).targets).toEqual([
        { databaseKey: "tasks", label: "Task" },
      ]);
    });

    it("names the Events target of a transcript card", async () => {
      const card = await transcriptCard("Standup", "2026-08-28T08:00:00.000Z");

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId)).toMatchObject({
        cardKind: "transcriptEvent",
        targets: [{ databaseKey: "events", label: "Event" }],
      });
    });

    it("names the Events target of a transcript card that proposes the occurrence of a recurring Event by its synthetic id (issue gh-1850)", async () => {
      const card = await occurrenceCard();

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);

      expect(listed.envelope).toMatchObject({ target: card.occurrenceId });
      expect(listed).toMatchObject({
        cardKind: "transcriptEvent",
        targets: [{ databaseKey: "events", label: "Event" }],
      });
    });

    it("names one target per database of a multi-step proposal, the primary one first", async () => {
      const filesType = await inTenantZero(() =>
        withTransaction(adminPool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name: "File",
            emoji: "📄",
            processingMethod: "database",
            targetDatabase: "files",
          }),
        ),
      );
      const card = await proposedCard("Invoice scan", {
        typeId: filesType.id,
        compute: async () => ({
          properties: {},
          operations: [
            { op: "create", database: "files", alias: "file", properties: { name: "Invoice" } },
            { op: "create", database: "tasks", alias: "payment", properties: { name: "Pay invoice" } },
            { op: "create", database: "tasks", alias: "reminder", properties: { name: "Call the bank" } },
          ],
        }),
      });

      expect(cardOf(await listCards(adminPool, ownerId, "cs"), card.cardId)).toMatchObject({
        cardKind: "file",
        targets: [
          { databaseKey: "files", label: "Soubor" },
          { databaseKey: "tasks", label: "Úkol" },
        ],
      });
    });

    it("names the database of the page a page-content card adds to, labelled as a page", async () => {
      const project = await inTenantZero(async () =>
        withTransaction(adminPool, async (client) =>
          createItemWithClient(client, {
            databaseId: await databaseIdFor("projects"),
            properties: { name: "Kitchen" },
          }),
        ),
      );
      const card = await createMarkdownPageContentProposal(adminPool, { inboxId, typesId, proposalsId }, project.id, {
        markdown: "Measure the room",
        placement: "end",
      });

      expect(cardOf(await listCards(adminPool, ownerId), card.id)).toMatchObject({
        cardKind: "page",
        baseKind: "page",
        targets: [{ databaseKey: "projects", label: "Page" }],
      });
    });

    it("labels the day page of a Journal card as the Journal", async () => {
      const day = await inTenantZero(() =>
        withTransaction(adminPool, async (client) =>
          getOrCreateJournalItem(
            client,
            await databaseIdFor("journal"),
            "day",
            new Date("2026-08-28T12:00:00Z"),
            "UTC",
          ),
        ),
      );
      const card = await createMarkdownPageContentProposal(adminPool, { inboxId, typesId, proposalsId }, day.id, {
        markdown: "Walked the dog",
        placement: "end",
      });

      expect(cardOf(await listCards(adminPool, ownerId, "cs"), card.id)).toMatchObject({
        cardKind: "journal",
        targets: [{ databaseKey: "journal", label: "Deník" }],
      });
    });
  });

  describe("the reason of an invalid card (issue #2027)", () => {
    /** Marks `cardId` invalid with a stored reason through the choke point, as the issue that writes target reasons will. */
    async function invalidateWithReason(cardId: string, reason: Record<string, unknown>): Promise<void> {
      await inTenantZero(() =>
        withTransaction(adminPool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: proposalsId, itemId: cardId, propertiesPatch: { status: "invalid", invalidReason: reason } },
            { allowedSystemKeys: ["status", "invalidReason"] },
          ),
        ),
      );
    }

    async function archivedProjectCard(): Promise<{ cardId: string; projectId: string }> {
      const project = await inTenantZero(async () =>
        withTransaction(adminPool, async (client) =>
          createItemWithClient(client, {
            databaseId: await databaseIdFor("projects"),
            properties: { name: "Kitchen" },
          }),
        ),
      );
      const card = await proposedCard("Order the cabinets");
      await invalidateWithReason(card.cardId, {
        code: "targetArchived",
        field: "project",
        itemId: project.id,
        label: "Kitchen",
      });
      return { cardId: card.cardId, projectId: project.id };
    }

    it.each([
      [
        "cs",
        "Cíl „Kitchen“ byl archivován, takže návrh nemá kam zapsat. Vyberte jiný cíl nebo požádejte Semp o nový výpočet.",
      ],
      [
        "en",
        "The target “Kitchen” was archived, so this proposal has nowhere to go. Choose another target or ask Semp to recompute.",
      ],
    ])(
      "gives the code, field, label and the %s sentence of a task card whose project was archived",
      async (locale, text) => {
        const card = await archivedProjectCard();

        const listed = cardOf(await listCards(adminPool, ownerId, locale), card.cardId);

        expect(listed).toMatchObject({ cardKind: "invalid", baseKind: "task", status: "invalid" });
        expect(listed.invalidReason).toEqual({
          code: "targetArchived",
          field: "project",
          itemId: card.projectId,
          label: "Kitchen",
          text,
        });
      },
    );

    it("falls back to the English sentence for a locale the catalogs do not have", async () => {
      const card = await archivedProjectCard();

      expect(cardOf(await listCards(adminPool, ownerId, "de"), card.cardId).invalidReason?.text).toBe(
        "The target “Kitchen” was archived, so this proposal has nowhere to go. Choose another target or ask Semp to recompute.",
      );
    });

    it("gives the reason of a card that became invalid because its Inbox item was deleted", async () => {
      const card = await proposedCard("Deleted capture");
      await invalidateBySourceDeletion(card.itemId);

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).invalidReason).toEqual({
        code: "sourceDeleted",
        field: "",
        itemId: card.itemId,
        label: "Deleted capture",
        text: "The source Inbox item “Deleted capture” was deleted, so this proposal can no longer be completed.",
      });
    });

    it.each([
      ["cs", "Tento návrh už nelze použít."],
      ["en", "This proposal can no longer be used."],
    ])(
      "gives the unknown reason and the generic %s sentence to a legacy invalid card without a reason",
      async (locale, text) => {
        const card = await proposedCard("Legacy card");
        // Raw SQL: the card predates the stored reason, a state no write produces any more.
        await setCardStatus(card.cardId, "invalid");

        expect(cardOf(await listCards(adminPool, ownerId, locale), card.cardId).invalidReason).toEqual({
          code: "unknown",
          field: "",
          itemId: null,
          label: "",
          text,
        });
      },
    );

    it("gives the unknown reason to an invalid card whose stored reason is of no known shape", async () => {
      const card = await proposedCard("Odd card");
      await invalidateWithReason(card.cardId, { code: "somethingNew", field: "project" });

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).invalidReason).toMatchObject({
        code: "unknown",
        label: "",
        text: "This proposal can no longer be used.",
      });
    });

    it("carries no reason on a card that is not invalid, nor on an approval or a transcript card", async () => {
      const proposed = await proposedCard("Proposed", { when: { date: "2026-08-28", time: "08:00" } });
      const clarification = await proposedCard("Clarify", { when: { date: "2026-08-28", time: "09:00" } });
      await setCardStatus(clarification.cardId, "needsClarification");
      const computing = await proposedCard("Computing", { when: { date: "2026-08-28", time: "10:00" } });
      await setCardStatus(computing.cardId, "computing");
      const failed = await proposedCard("Failed", { when: { date: "2026-08-28", time: "11:00" } });
      await setCardStatus(failed.cardId, "computeFailed");
      const approval = await approvalFrom("heartbeat");
      const transcript = await transcriptCard("Standup", "2026-08-28T08:00:00.000Z");
      // A stored reason does not make a card that is no longer invalid carry it.
      await adminPool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{invalidReason}', $2::jsonb) WHERE id = $1",
        [
          proposed.cardId,
          JSON.stringify({ code: "targetArchived", field: "project", itemId: randomUUID(), label: "X" }),
        ],
      );

      const list = await listCards(adminPool, ownerId);

      expect(list.cards).toHaveLength(6);
      for (const id of [
        approval,
        proposed.cardId,
        clarification.cardId,
        computing.cardId,
        failed.cardId,
        transcript.cardId,
      ]) {
        expect(cardOf(list, id)).not.toHaveProperty("invalidReason");
      }
    });
  });

  describe("what the update steps change (issue #2028)", () => {
    let workId: string;
    let financeId: string;
    let accountingId: string;

    async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
      const databaseId = await databaseIdFor(moduleId);
      return inTenantZero(() =>
        withTransaction(
          adminPool,
          async (client) => (await createItemWithClient(client, { databaseId, properties })).id,
        ),
      );
    }

    /** A proposed card that holds a multi-step envelope with `operations`, the first of which is the primary step. */
    async function stepsCard(operations: ProposalStep[]): Promise<string> {
      const proposal = {
        entityKind: "database",
        target: await databaseIdFor("projects"),
        properties: {},
        operations,
      };
      return inTenantZero(() =>
        withTransaction(
          adminPool,
          async (client) =>
            (
              await createItemWithClient(
                client,
                { databaseId: proposalsId, properties: { kind: "inbox", status: "proposed", proposal } },
                { allowedSystemKeys: ["kind", "status", "proposal"] },
              )
            ).id,
        ),
      );
    }

    function moveToFinance(extra: Partial<ProposalStep> = {}): ProposalStep {
      return {
        ref: "move",
        op: "update",
        itemId: accountingId,
        role: "primary",
        before: { relations: { area: [workId] } },
        after: { relations: { area: [financeId] } },
        ...extra,
      };
    }

    beforeEach(async () => {
      workId = await createItem("areas", { name: "Work" });
      financeId = await createItem("areas", { name: "Finance" });
      accountingId = await createItem("projects", { name: "Accounting", status: "inProgress" });
    });

    it("carries the move of a project from area Work to area Finance on the card GET /api/inbox/cards returns", async () => {
      const cardId = await stepsCard([moveToFinance()]);

      const answer = await inTenantZero(() =>
        createInboxCardsRouteHandler(adminPool)({ identity: { user: { id: ownerId, locale: "en" } } }),
      );

      if (!("body" in answer)) throw new Error("expected a raw JSON body");
      expect(answer.status).toBe(200);
      const { cards } = answer.body as { cards: Array<{ cardId: string; changes?: unknown }> };
      expect(cards.find((card) => card.cardId === cardId)?.changes).toEqual([
        {
          ref: "move",
          itemId: accountingId,
          itemLabel: "Accounting",
          field: "area",
          fieldLabel: "Area",
          from: { value: [workId], labels: ["Work"] },
          to: { value: [financeId], labels: ["Finance"] },
        },
      ]);
    });

    it("carries the canonical keys and the option labels of a status change in the locale of the reader", async () => {
      const cardId = await stepsCard([
        {
          ref: "done",
          op: "update",
          itemId: accountingId,
          role: "primary",
          before: { properties: { status: "inProgress" } },
          after: { properties: { status: "done" } },
        },
      ]);

      const english = cardOf(await listCards(adminPool, ownerId, "en"), cardId).changes;
      const czech = cardOf(await listCards(adminPool, ownerId, "cs"), cardId).changes;

      expect(english).toMatchObject([
        { field: "status", fieldLabel: "Status", from: { value: "inProgress", labels: ["In progress"] } },
      ]);
      expect(english?.[0]?.to).toEqual({ value: "done", labels: ["Done"] });
      expect(czech).toMatchObject([
        { field: "status", fieldLabel: "Stav", from: { value: "inProgress", labels: ["Probíhá"] } },
      ]);
      expect(czech?.[0]?.to).toEqual({ value: "done", labels: ["Hotovo"] });
    });

    it("labels a target that is another step of the same proposal with the title that step would create", async () => {
      const cardId = await stepsCard([
        moveToFinance({ after: { relations: { area: [{ ref: "newArea" }] } } }),
        { ref: "newArea", op: "create", databaseKey: "areas", role: "secondary", properties: { name: "Travel" } },
      ]);

      const changes = cardOf(await listCards(adminPool, ownerId), cardId).changes;

      expect(changes).toMatchObject([
        { field: "area", from: { labels: ["Work"] }, to: { value: [{ ref: "newArea" }], labels: ["Travel"] } },
      ]);
    });

    it("still lists every card when a stored update step names a relation target that is not an id", async () => {
      const bad = await stepsCard([moveToFinance({ before: { relations: { area: ["Work"] } } })]);
      const good = await stepsCard([moveToFinance()]);

      const list = await listCards(adminPool, ownerId);

      expect(cardOf(list, bad).changes).toMatchObject([{ field: "area", from: { value: ["Work"], labels: ["Work"] } }]);
      expect(cardOf(list, good).changes).toMatchObject([{ from: { labels: ["Work"] }, to: { labels: ["Finance"] } }]);
    });

    it("leaves a disabled update step out, and a card whose only update step is disabled carries no changes", async () => {
      const disabledOnly = await stepsCard([
        { ref: "area", op: "create", databaseKey: "areas", role: "primary", properties: { name: "Travel" } },
        moveToFinance({ role: "secondary", enabled: false }),
      ]);
      const mixed = await stepsCard([
        moveToFinance({ ref: "enabledMove" }),
        moveToFinance({
          ref: "disabledMove",
          role: "secondary",
          enabled: false,
          before: { properties: { status: "inProgress" } },
          after: { properties: { status: "done" } },
        }),
      ]);

      const list = await listCards(adminPool, ownerId);

      expect(cardOf(list, disabledOnly)).not.toHaveProperty("changes");
      expect(cardOf(list, mixed).changes?.map((change) => change.ref)).toEqual(["enabledMove"]);
    });

    it("leaves out an optional update step that no active step refers to", async () => {
      const cardId = await stepsCard([
        { ref: "area", op: "create", databaseKey: "areas", role: "primary", properties: { name: "Travel" } },
        moveToFinance({ role: "secondary", optional: true }),
      ]);

      expect(cardOf(await listCards(adminPool, ownerId), cardId)).not.toHaveProperty("changes");
    });

    it("carries no changes on a card without update steps, nor on an approval or a card with no envelope", async () => {
      const single = await proposedCard("Buy milk");
      const creating = await stepsCard([
        { ref: "area", op: "create", databaseKey: "areas", role: "primary", properties: { name: "Travel" } },
      ]);
      const updating = await stepsCard([moveToFinance()]);
      const approval = await approvalFrom("heartbeat");
      await bareProposedCards(1);

      const list = await listCards(adminPool, ownerId);

      expect(list.cards).toHaveLength(5);
      for (const card of list.cards) {
        if (card.cardId === updating) expect(card.changes).toHaveLength(1);
        else expect(card).not.toHaveProperty("changes");
      }
      expect([single.cardId, creating, approval].every((id) => cardOf(list, id))).toBe(true);
    });

    it("names no item of another tenant when a stored step points at one, on the runtime role", async () => {
      const dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
      try {
        const cardId = await stepsCard([moveToFinance()]);
        const otherTenantId = await createTestTenant(adminPool);
        await provisionTenant(dataPool, otherTenantId);
        const otherProposalsId = await runInTenant(otherTenantId, async () => {
          const { rows } = await withTransaction(dataPool, (client) =>
            client.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'processingProposals'"),
          );
          return rows[0]?.id ?? "";
        });
        const otherProjectsId = await runInTenant(otherTenantId, async () => {
          const { rows } = await withTransaction(dataPool, (client) =>
            client.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'"),
          );
          return rows[0]?.id ?? "";
        });
        // The second tenant's card names the first tenant's project and areas, the ids a stolen envelope would hold.
        const foreignCard = await runInTenant(otherTenantId, () =>
          withTransaction(
            dataPool,
            async (client) =>
              (
                await createItemWithClient(
                  client,
                  {
                    databaseId: otherProposalsId,
                    properties: {
                      kind: "inbox",
                      status: "proposed",
                      proposal: {
                        entityKind: "database",
                        target: otherProjectsId,
                        properties: {},
                        operations: [moveToFinance()],
                      },
                    },
                  },
                  { allowedSystemKeys: ["kind", "status", "proposal"] },
                )
              ).id,
          ),
        );

        const asFirstTenant = await inTenantZero(() =>
          withTransaction(dataPool, (client) => listInboxCards(client, { ownerUserId: ownerId, locale: "en" })),
        );
        const asSecondTenant = await runInTenant(otherTenantId, () =>
          withTransaction(dataPool, (client) => listInboxCards(client, { ownerUserId: ownerId, locale: "en" })),
        );

        expect(cardOf(asFirstTenant, cardId).changes?.[0]).toMatchObject({
          itemLabel: "Accounting",
          from: { labels: ["Work"] },
        });
        expect(asSecondTenant.cards.map((card) => card.cardId)).toEqual([foreignCard]);
        expect(cardOf(asSecondTenant, foreignCard).changes).toEqual([
          {
            ref: "move",
            itemId: accountingId,
            itemLabel: accountingId,
            field: "area",
            fieldLabel: "area",
            from: { value: [workId], labels: [workId] },
            to: { value: [financeId], labels: [financeId] },
          },
        ]);
      } finally {
        await dataPool.end();
      }
    });
  });

  describe("the limit", () => {
    it(
      "returns 200 cards and the full total for more than 200 open cards",
      async () => {
        const approvals = [await approvalFrom("heartbeat"), await approvalFrom("mcp")];
        const proposalCount = INBOX_CARDS_LIMIT + 5;
        await bareProposedCards(proposalCount);

        const list = await listCards(adminPool, ownerId);

        expect(list.cards).toHaveLength(INBOX_CARDS_LIMIT);
        expect(cardIds(list).slice(0, 2)).toEqual(approvals);
        expect(list.cards.slice(2).every((card) => card.source === "proposal")).toBe(true);
        expect(list.total).toBe(2 + proposalCount);
      },
      BULK_TEST_TIMEOUT_MS,
    );

    it(
      "returns 200 approvals, no card, and counts every approval and card when the approvals alone pass the limit",
      async () => {
        const approvalCount = INBOX_CARDS_LIMIT + 1;
        const approvals: string[] = [];
        for (let n = 0; n < approvalCount; n += 1) approvals.push(await approvalFrom("heartbeat"));
        await proposedCard("A card below the approvals");

        const list = await listCards(adminPool, ownerId);

        expect(cardIds(list)).toEqual(approvals.slice(0, INBOX_CARDS_LIMIT));
        expect(list.total).toBe(approvalCount + 1);
      },
      BULK_TEST_TIMEOUT_MS,
    );
  });

  describe("a tenant that lacks part of the pipeline", () => {
    it("lists the approvals when the Inbox database is not there", async () => {
      const approval = await approvalFrom("heartbeat");
      // Raw SQL: the API cannot remove a system database; this stands for a tenant seeded before the pipeline.
      await adminPool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'inbox'");

      expect(await listCards(adminPool, ownerId)).toMatchObject({ cards: [{ cardId: approval }], total: 1 });
    });

    it("lists the approvals when the Processing proposals database is not there", async () => {
      const approval = await approvalFrom("heartbeat");
      await adminPool.query(
        "UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'processingProposals'",
      );

      expect(await listCards(adminPool, ownerId)).toMatchObject({ cards: [{ cardId: approval }], total: 1 });
    });

    it("lists the cards without a transcript source when the Transcripts database is not there", async () => {
      const card = await transcriptCard("Standup", "2026-08-28T08:00:00.000Z");
      await adminPool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'transcripts'");

      const listed = cardOf(await listCards(adminPool, ownerId), card.cardId);

      expect(listed.resolvedSource).toBeNull();
      expect(listed.cardKind).toBe("transcriptEvent");
    });

    it("lists the cards with a null type when the Inbox has no type relation", async () => {
      const card = await proposedCard("Buy milk");
      // Raw SQL: the property is system-owned and locked; this stands for a tenant seeded without it.
      await adminPool.query("DELETE FROM properties WHERE database_id = $1 AND key = 'type'", [inboxId]);

      expect(cardOf(await listCards(adminPool, ownerId), card.cardId).resolvedSource).toMatchObject({
        kind: "inboxItem",
        type: null,
      });
    });
  });

  it("leaves out a card that was trashed between the read of the open cards and the read of their rows", async () => {
    const kept = await proposedCard("Kept", { when: { date: "2026-08-28", time: "10:00" } });
    const trashed = await proposedCard("Trashed", { when: { date: "2026-08-28", time: "09:00" } });
    let trashedOnce = false;
    let trashedWasCandidate = false;

    const list = await inTenantZero(() =>
      withTransaction(adminPool, async (client) => {
        const racing = new Proxy(client, {
          get(target, key, receiver) {
            const value: unknown = Reflect.get(target, key, receiver);
            if (key !== "query" || typeof value !== "function") return value;
            return async (...args: unknown[]): Promise<unknown> => {
              const result: unknown = await Reflect.apply(value, target, args);
              const text = typeof args[0] === "string" ? args[0] : "";
              // Only the read of the open cards selects the transcript id (the approvals read has no such
              // column), so the card is trashed after it was listed as a candidate and before its row is read.
              if (!trashedOnce && text.includes("transcript.id AS transcript_item_id")) {
                const rows = (result as { rows: { id: string }[] }).rows;
                trashedWasCandidate = rows.some((row) => row.id === trashed.cardId);
                trashedOnce = true;
                await itemsStore.softDeleteItem(target, proposalsId, trashed.cardId);
              }
              return result;
            };
          },
        });
        return listInboxCards(racing, { ownerUserId: ownerId, locale: "en" });
      }),
    );

    expect(trashedOnce).toBe(true);
    expect(trashedWasCandidate).toBe(true);
    expect(cardIds(list)).toEqual([kept.cardId]);
  });

  describe("countOpenInboxCards (issue #1823)", () => {
    it("equals the total of the list for cards of every state and kind and for approvals", async () => {
      await transcriptCard("Standup", "2026-08-28T08:00:00.000Z");
      const clarification = await proposedCard("Unclear capture");
      await setCardStatus(clarification.cardId, "needsClarification");
      const invalid = await proposedCard("Deleted capture");
      await invalidateBySourceDeletion(invalid.itemId);
      await proposedCard("Buy milk");
      await approvalFrom("heartbeat");
      await approvalFrom("mcp");

      const list = await listCards(adminPool, ownerId);

      expect(await countCards(adminPool, ownerId)).toBe(6);
      expect(list.total).toBe(6);
    });

    it("is 0 for a tenant without cards", async () => {
      expect(await countCards(adminPool, ownerId)).toBe(0);
    });

    it(
      "equals the total of the list also when more than 200 cards are open",
      async () => {
        await approvalFrom("heartbeat");
        await approvalFrom("mcp");
        const proposalCount = INBOX_CARDS_LIMIT + 5;
        await bareProposedCards(proposalCount);

        const list = await listCards(adminPool, ownerId);

        expect(list.cards).toHaveLength(INBOX_CARDS_LIMIT);
        expect(await countCards(adminPool, ownerId)).toBe(2 + proposalCount);
        expect(await countCards(adminPool, ownerId)).toBe(list.total);
      },
      BULK_TEST_TIMEOUT_MS,
    );

    it(
      "equals the total of the list when the approvals alone pass the limit",
      async () => {
        const approvalCount = INBOX_CARDS_LIMIT + 1;
        for (let n = 0; n < approvalCount; n += 1) await approvalFrom("heartbeat");
        await proposedCard("A card below the approvals");

        const list = await listCards(adminPool, ownerId);

        expect(await countCards(adminPool, ownerId)).toBe(approvalCount + 1);
        expect(await countCards(adminPool, ownerId)).toBe(list.total);
      },
      BULK_TEST_TIMEOUT_MS,
    );

    it("is lower by one after a card is confirmed", async () => {
      const confirmed = await proposedCard("Confirmed one");
      await proposedCard("Still open");
      expect(await countCards(adminPool, ownerId)).toBe(2);

      await inTenantZero(() =>
        withTransaction(adminPool, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, confirmed.cardId),
        ),
      );

      expect(await countCards(adminPool, ownerId)).toBe(1);
      expect(await countCards(adminPool, ownerId)).toBe((await listCards(adminPool, ownerId)).total);
    });

    it("does not count a rejected card, a deleted card, the approvals of chat or an approval already decided", async () => {
      await proposedCard("Still open");
      const rejected = await proposedCard("Rejected one");
      const deleted = await proposedCard("Deleted card");
      await inTenantZero(() =>
        withTransaction(adminPool, async (client) => {
          await rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, rejected.cardId);
          await itemsStore.softDeleteItem(client, proposalsId, deleted.cardId);
        }),
      );
      await approvalFrom("heartbeat");
      await approvalFrom("user");
      await approvalFrom("user", { delegated: true });
      const decided = await approvalFrom("heartbeat");
      await inTenantZero(() =>
        withTransaction(adminPool, (client) => decideApprovalRequest(client, decided, "rejected", ownerId)),
      );

      expect(await countCards(adminPool, ownerId)).toBe(2);
      expect(cardIds(await listCards(adminPool, ownerId))).toHaveLength(2);
    });

    it("does not count computing and computeFailed cards that the list returns", async () => {
      const proposed = await proposedCard("Proposed");
      const computing = await proposedCard("Computing");
      const failed = await proposedCard("Failed");
      await setCardStatus(computing.cardId, "computing");
      await setCardStatus(failed.cardId, "computeFailed");

      const list = await listCards(adminPool, ownerId);

      expect(cardIds(list).sort()).toEqual([proposed.cardId, computing.cardId, failed.cardId].sort());
      expect(await countCards(adminPool, ownerId)).toBe(1);
      expect(list.total).toBe(1);
    });

    it("is 0 for a stack that holds only cards being computed", async () => {
      const computing = await proposedCard("Computing");
      await setCardStatus(computing.cardId, "computing");

      expect(await countCards(adminPool, ownerId)).toBe(0);
    });

    it("counts the approvals of the user only", async () => {
      await approvalFrom("heartbeat");
      const other = (await createTenantZeroUser(adminPool)).id;

      expect(await countCards(adminPool, ownerId)).toBe(1);
      expect(await countCards(adminPool, other)).toBe(0);
    });

    it("counts only the approvals when the Inbox database is not there", async () => {
      await approvalFrom("heartbeat");
      await proposedCard("Buy milk");
      await adminPool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'inbox'");

      expect(await countCards(adminPool, ownerId)).toBe(1);
      expect(await countCards(adminPool, ownerId)).toBe((await listCards(adminPool, ownerId)).total);
    });

    it("counts only the approvals when the Processing proposals database is not there", async () => {
      await approvalFrom("heartbeat");
      await proposedCard("Buy milk");
      await adminPool.query(
        "UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'processingProposals'",
      );

      expect(await countCards(adminPool, ownerId)).toBe(1);
      expect(await countCards(adminPool, ownerId)).toBe((await listCards(adminPool, ownerId)).total);
    });

    describe("the route handler", () => {
      it("answers 200 with the total of the session's user, equal to the total of the list", async () => {
        await proposedCard("Buy milk");
        await approvalFrom("heartbeat");
        const computing = await proposedCard("Computing");
        await setCardStatus(computing.cardId, "computing");

        const answer = await inTenantZero(() =>
          createInboxCardsCountRouteHandler(adminPool)({ identity: { user: { id: ownerId } } }),
        );

        expect(answer).toEqual({ status: 200, body: { total: 2 } });
        expect((await listCards(adminPool, ownerId)).total).toBe(2);
      });

      it("counts the cards of the tenant but not the approvals of another actor", async () => {
        await approvalFrom("heartbeat");
        const other = (await createTenantZeroUser(adminPool)).id;
        await proposedCard("Buy milk");

        const answer = await inTenantZero(() =>
          createInboxCardsCountRouteHandler(adminPool)({ identity: { user: { id: other } } }),
        );

        // A proposals card belongs to the tenant and an approval to the actor of its run, so only the card is counted.
        expect(answer).toEqual({ status: 200, body: { total: 1 } });
      });
    });

    describe("tenant isolation", () => {
      let dataPool: Pool;

      beforeAll(async () => {
        dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
      });

      afterAll(async () => {
        await dataPool?.end();
      });

      it(
        "gives a second tenant its own count and never the first tenant's, on the runtime role",
        async () => {
          await proposedCard("First tenant capture");
          await transcriptCard("First tenant transcript", "2026-08-28T08:00:00.000Z");
          await approvalFrom("heartbeat");
          const otherTenantId = await createTestTenant(adminPool);
          await provisionTenant(dataPool, otherTenantId);

          const asFirstTenant = await inTenantZero(() =>
            withTransaction(dataPool, (client) => countOpenInboxCards(client, { ownerUserId: ownerId })),
          );
          // The first tenant's user id is passed on purpose: only the tenant scope can keep its rows out.
          const asSecondTenant = await runInTenant(otherTenantId, () =>
            withTransaction(dataPool, (client) => countOpenInboxCards(client, { ownerUserId: ownerId })),
          );

          expect(asFirstTenant).toBe(3);
          expect(asSecondTenant).toBe(0);
        },
        BULK_TEST_TIMEOUT_MS,
      );
    });
  });

  describe("tenant isolation", () => {
    let dataPool: Pool;

    beforeAll(async () => {
      dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    });

    afterAll(async () => {
      await dataPool?.end();
    });

    it(
      "shows a second tenant none of the cards and approvals of the first, on the runtime role",
      async () => {
        const card = await proposedCard("First tenant capture");
        const transcript = await transcriptCard("First tenant transcript", "2026-08-28T08:00:00.000Z");
        const approval = await approvalFrom("heartbeat");
        const otherTenantId = await createTestTenant(adminPool);
        await provisionTenant(dataPool, otherTenantId);

        const asFirstTenant = await inTenantZero(() =>
          withTransaction(dataPool, (client) => listInboxCards(client, { ownerUserId: ownerId, locale: "en" })),
        );
        // The first tenant's user id is passed on purpose: only the tenant scope can keep its rows out.
        const asSecondTenant = await runInTenant(otherTenantId, () =>
          withTransaction(dataPool, (client) => listInboxCards(client, { ownerUserId: ownerId, locale: "en" })),
        );

        expect(cardIds(asFirstTenant).sort()).toEqual([approval, card.cardId, transcript.cardId].sort());
        expect(asFirstTenant.total).toBe(3);
        expect(asSecondTenant).toEqual({ cards: [], total: 0 });
      },
      BULK_TEST_TIMEOUT_MS,
    );
  });
});

describe("isComputingTimedOut (issue gh-2026)", () => {
  const NOW = new Date("2026-11-14T12:00:00.000Z");
  const card = (status: unknown, updatedAt: string) => ({ properties: { status }, updatedAt });
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it("is 10 minutes, a constant", () => {
    expect(COMPUTING_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("is false for a computing card that was updated less than the timeout ago", () => {
    expect(isComputingTimedOut(card("computing", ago(COMPUTING_TIMEOUT_MS - 1)), NOW)).toBe(false);
  });

  it("is false for a computing card that was updated exactly the timeout ago", () => {
    expect(isComputingTimedOut(card("computing", ago(COMPUTING_TIMEOUT_MS)), NOW)).toBe(false);
  });

  it("is true for a computing card that was updated more than the timeout ago", () => {
    expect(isComputingTimedOut(card("computing", ago(COMPUTING_TIMEOUT_MS + 1)), NOW)).toBe(true);
  });

  it.each(["proposed", "computeFailed", "needsClarification", "invalid", "confirmed", "rejected", undefined])(
    "is false for a card with the status %s, however old",
    (status) => {
      expect(isComputingTimedOut(card(status, ago(24 * 60 * 60 * 1000)), NOW)).toBe(false);
    },
  );

  it("is false for a computing card whose updatedAt is no timestamp", () => {
    expect(isComputingTimedOut(card("computing", "not a timestamp"), NOW)).toBe(false);
  });

  it("is false for a computing card updated after now", () => {
    expect(isComputingTimedOut(card("computing", new Date(NOW.getTime() + 1000).toISOString()), NOW)).toBe(false);
  });
});
