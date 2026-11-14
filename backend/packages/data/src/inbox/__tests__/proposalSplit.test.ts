import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../../errors.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { lockInboxSource } from "../inboxSourceGuard.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createSemprecTickAction } from "../inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../proposalActions.js";
import {
  MAX_SPLIT_CARDS,
  splitInboxSourceWithClient,
  type SplitCardInput,
  type SplitInboxSourceResult,
} from "../proposalSplit.js";

const storedCardSchema = z.object({
  kind: z.string(),
  proposal: z.object({ entityKind: z.string(), target: z.string(), properties: z.record(z.string(), z.unknown()) }),
  aiProposal: z.object({ entityKind: z.string(), target: z.string(), properties: z.record(z.string(), z.unknown()) }),
  aiVersion: z.number(),
  status: z.string(),
  splitFromProposalId: z.string().optional(),
  fingerprint: z.string().nullable().optional(),
  resultItemId: z.string().optional(),
  userEditedKeys: z.array(z.string()).optional(),
  history: z.array(
    z.object({
      author: z.string(),
      message: z.string(),
      kind: z.string().optional(),
      threadId: z.string().optional(),
      messageId: z.string().optional(),
    }),
  ),
});

interface CardFixture {
  tenant: string;
  sourceId: string;
  cardId: string;
  proposalsId: string;
  tasksId: string;
  eventsId: string;
}

describe("splitInboxSourceWithClient (issue #1939)", () => {
  let admin: Pool;
  let runtime: Pool;
  let owner: string;
  let foreign: string;
  let events: InboxCardsInvalidationEvent[];
  const threadId = randomUUID();
  const messageId = randomUUID();

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    owner = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const tenant of [owner, foreign]) await runInTenant(tenant, () => seedSystem(runtime));
  });
  beforeEach(() => {
    events = [];
    setInboxCardsInvalidationHook((event) => events.push(event));
  });
  afterEach(() => {
    setInboxCardsInvalidationHook(() => {});
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    for (const pool of [runtime, admin]) {
      try {
        await pool?.end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Split fixture cleanup failed", { cause: errors[0] });
  });

  /**
   * An Inbox item whose card the tick created and the user revised into the Tasks proposal `Buy milk and renew the
   * passport`, so that it is `proposed` with an envelope.
   */
  async function createCard(tenant: string): Promise<CardFixture> {
    return runInTenant(tenant, async () => {
      const dbs = await withTransaction(runtime, async (client) => ({
        inbox: await getDatabaseByModuleId(client, "inbox"),
        types: await getDatabaseByModuleId(client, "inboxItemTypes"),
        proposals: await getDatabaseByModuleId(client, "processingProposals"),
        tasks: await getDatabaseByModuleId(client, "tasks"),
        events: await getDatabaseByModuleId(client, "events"),
      }));
      if (!dbs.inbox?.ownerProjectItemId || !dbs.types || !dbs.proposals || !dbs.tasks || !dbs.events) {
        throw new Error("Missing Inbox setup");
      }
      const inboxDatabaseId = dbs.inbox.id;
      const source = await withTransaction(runtime, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId,
          date: "2026-11-14",
          time: "12:00",
          // An empty capture leaves the tick's card without a model call, as in the revise tool test.
          text: "",
        }),
      );
      const tick = createSemprecTickAction(runtime, async () => {
        throw new Error("Unexpected model computation");
      });
      await tick(
        {
          inboxDatabaseId: dbs.inbox.id,
          inboxItemTypesDatabaseId: dbs.types.id,
          processingProposalsDatabaseId: dbs.proposals.id,
        },
        { heartbeatId: randomUUID(), projectItemId: dbs.inbox.ownerProjectItemId, itemId: source.id },
      );
      const cards = await runtime.query<{ id: string }>(
        `SELECT card.id FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
          WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
        [dbs.proposals.id, source.id],
      );
      const cardId = cards.rows[0]?.id;
      if (cards.rows.length !== 1 || !cardId) throw new Error("Missing tick-produced card");
      const proposalsId = dbs.proposals.id;
      const tasksId = dbs.tasks.id;
      await withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
          message: "Filed under Tasks",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk and renew the passport" },
        }),
      );
      events.length = 0;
      return { tenant, sourceId: source.id, cardId, proposalsId, tasksId, eventsId: dbs.events.id };
    });
  }

  const taskCard = (fixture: CardFixture, name: string): SplitCardInput => ({
    entityKind: "database",
    target: fixture.tasksId,
    properties: { name },
  });
  const twoCards = (fixture: CardFixture): SplitCardInput[] => [
    taskCard(fixture, "Buy milk"),
    taskCard(fixture, "Renew the passport"),
  ];

  /** Runs the action in its own transaction under the fixture's tenant, as the thread's request does. */
  function split(
    fixture: CardFixture,
    cards: SplitCardInput[],
    extra: { proposalId?: string; subjectItemId?: string; ifVersion?: string; message?: string; tenant?: string } = {},
  ): Promise<SplitInboxSourceResult> {
    return runInTenant(extra.tenant ?? fixture.tenant, () =>
      withTransaction(runtime, (client) =>
        splitInboxSourceWithClient(
          client,
          { processingProposalsDatabaseId: fixture.proposalsId },
          {
            proposalId: extra.proposalId ?? fixture.cardId,
            subjectItemId: extra.subjectItemId ?? fixture.sourceId,
            threadId,
            messageId,
            cards,
            ...(extra.ifVersion === undefined ? {} : { ifVersion: extra.ifVersion }),
            ...(extra.message === undefined ? {} : { message: extra.message }),
          },
        ),
      ),
    );
  }

  async function countItems(fixture: CardFixture, databaseId: string): Promise<number> {
    return runInTenant(fixture.tenant, async () => {
      const rows = await runtime.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND deleted_at IS NULL",
        [databaseId],
      );
      return rows.rows[0]?.count ?? -1;
    });
  }

  /** Every Processing proposals row of the tenant as stored, and the number of edges, read through the runtime role. */
  async function snapshot(fixture: CardFixture) {
    return runInTenant(fixture.tenant, async () => {
      const cards = await runtime.query<{ id: string; properties: unknown; updated_at: Date }>(
        "SELECT id, properties, updated_at FROM items WHERE database_id = $1 ORDER BY id",
        [fixture.proposalsId],
      );
      const edges = await runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations");
      return {
        cards: cards.rows.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() })),
        edges: edges.rows[0]?.count ?? -1,
        tasks: await countItems(fixture, fixture.tasksId),
        events: await countItems(fixture, fixture.eventsId),
      };
    });
  }

  async function readCard(fixture: CardFixture, cardId: string) {
    return runInTenant(fixture.tenant, async () => {
      const row = await runtime.query<{ properties: unknown; updated_at: Date }>(
        "SELECT properties, updated_at FROM items WHERE id = $1",
        [cardId],
      );
      const stored = row.rows[0];
      if (!stored) throw new Error("Card is missing");
      return { card: storedCardSchema.parse(stored.properties), updatedAt: stored.updated_at.toISOString() };
    });
  }

  /** The ids of the cards the `sourceInbox` edges of the source lead to. */
  async function cardsOfSource(fixture: CardFixture): Promise<string[]> {
    return runInTenant(fixture.tenant, async () => {
      const rows = await runtime.query<{ id: string }>(
        `SELECT card.id FROM items card
           JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
          WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)
          ORDER BY card.id`,
        [fixture.proposalsId, fixture.sourceId],
      );
      return rows.rows.map((row) => row.id);
    });
  }

  const proposalsConfig = (fixture: CardFixture) => ({ processingProposalsDatabaseId: fixture.proposalsId });

  it("turns one source into two cards: the primary is revised, the sibling is linked to the source and marked, and nothing is created in a target database", async () => {
    const fixture = await createCard(owner);
    const before = await snapshot(fixture);
    const primaryBefore = await readCard(fixture, fixture.cardId);

    const result = await split(fixture, twoCards(fixture), { message: "Two separate things" });

    expect(result.primary.id).toBe(fixture.cardId);
    expect(result.siblings).toHaveLength(1);
    const siblingId = result.siblings[0]?.id;
    if (!siblingId) throw new Error("Missing sibling");
    expect((await cardsOfSource(fixture)).sort()).toEqual([fixture.cardId, siblingId].sort());

    const primary = await readCard(fixture, fixture.cardId);
    expect(primary.card.status).toBe("proposed");
    expect(primary.card.splitFromProposalId).toBeUndefined();
    expect(primary.card.proposal.properties).toEqual({ name: "Buy milk" });
    expect(primary.card.aiProposal.properties).toEqual({ name: "Buy milk" });
    expect(primary.card.aiVersion).toBe(primaryBefore.card.aiVersion + 1);
    expect(primary.card.history).toHaveLength(primaryBefore.card.history.length + 1);
    expect(primary.card.history.at(-1)).toEqual({
      author: "ai",
      message: "Two separate things",
      kind: "threadRevision",
      threadId,
      messageId,
    });

    const sibling = await readCard(fixture, siblingId);
    expect(sibling.card).toMatchObject({
      kind: "inbox",
      status: "proposed",
      aiVersion: 1,
      splitFromProposalId: fixture.cardId,
    });
    const envelope = { entityKind: "database", target: fixture.tasksId, properties: { name: "Renew the passport" } };
    expect(sibling.card.proposal).toEqual(envelope);
    expect(sibling.card.aiProposal).toEqual(envelope);
    expect(sibling.card.history).toEqual([
      { author: "ai", message: "Two separate things", kind: "threadRevision", threadId, messageId },
    ]);
    // Nothing is created in any target database, and exactly one card and one edge were added.
    const after = await snapshot(fixture);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.cards).toHaveLength(before.cards.length + 1);
    expect(after.edges).toBe(before.edges + 1);
  });

  it("gives every card a default history text when the call carries no message", async () => {
    const fixture = await createCard(owner);

    const result = await split(fixture, [...twoCards(fixture), taskCard(fixture, "Call mom")]);

    expect(result.siblings).toHaveLength(2);
    expect((await readCard(fixture, fixture.cardId)).card.history.at(-1)?.message).toBe(
      "Split the source into 3 cards.",
    );
    for (const sibling of result.siblings) {
      expect((await readCard(fixture, sibling.id)).card.history.map((entry) => entry.message)).toEqual([
        "Created by splitting the source.",
      ]);
    }
  });

  it("splits into the most cards the decision allows, the primary card and nine siblings", async () => {
    const fixture = await createCard(owner);
    const cards = Array.from({ length: MAX_SPLIT_CARDS }, (_, index) => taskCard(fixture, `Card ${index}`));

    const result = await split(fixture, cards);

    expect(result.siblings).toHaveLength(MAX_SPLIT_CARDS - 1);
    expect(await cardsOfSource(fixture)).toHaveLength(MAX_SPLIT_CARDS);
    const names = await Promise.all(
      result.siblings.map(async (sibling) => (await readCard(fixture, sibling.id)).card.proposal.properties.name),
    );
    expect(names).toEqual(cards.slice(1).map((card) => card.properties.name));
  });

  it("refuses more cards than the decision allows and fewer than two, and writes nothing", async () => {
    const fixture = await createCard(owner);
    const before = await snapshot(fixture);

    const tooMany = await split(
      fixture,
      Array.from({ length: MAX_SPLIT_CARDS + 1 }, (_, index) => taskCard(fixture, `Card ${index}`)),
    ).catch((error: unknown) => error);
    const single = await split(fixture, [taskCard(fixture, "Only one")]).catch((error: unknown) => error);
    const none = await split(fixture, []).catch((error: unknown) => error);

    for (const error of [tooMany, single, none]) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "cards" } });
    }
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);
  });

  it("refuses a split of a confirmed or a rejected primary card and creates and changes nothing", async () => {
    const confirmed = await createCard(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, (client) =>
        confirmProposalWithClient(client, proposalsConfig(confirmed), confirmed.cardId),
      ),
    );
    const rejected = await createCard(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, (client) =>
        rejectProposalWithClient(client, proposalsConfig(rejected), rejected.cardId),
      ),
    );

    for (const fixture of [confirmed, rejected]) {
      const before = await snapshot(fixture);
      events.length = 0;

      const error = await split(fixture, twoCards(fixture)).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "status" } });
      expect(await snapshot(fixture)).toEqual(before);
      expect(events).toEqual([]);
    }
  });

  it("refuses an invalid envelope in any entry, creates no card and leaves the primary unchanged even when the caller commits", async () => {
    const fixture = await createCard(owner);
    const before = await snapshot(fixture);
    const invalid: SplitCardInput = { entityKind: "database", target: fixture.tasksId, properties: { notAKey: "x" } };

    for (const cards of [
      [taskCard(fixture, "Buy milk"), invalid],
      [taskCard(fixture, "Buy milk"), taskCard(fixture, "Renew the passport"), invalid],
      [invalid, taskCard(fixture, "Renew the passport")],
    ]) {
      // The caller swallows the refusal and commits: a rollback is not what keeps the primary card unchanged.
      let refusal: unknown;
      await runInTenant(owner, () =>
        withTransaction(runtime, async (client) => {
          try {
            await splitInboxSourceWithClient(client, proposalsConfig(fixture), {
              proposalId: fixture.cardId,
              subjectItemId: fixture.sourceId,
              threadId,
              messageId,
              cards,
            });
          } catch (error) {
            refusal = error;
          }
        }),
      );

      expect(refusal).toBeInstanceOf(ValidationError);
      expect(await snapshot(fixture)).toEqual(before);
    }
    expect(events).toEqual([]);
  });

  it("refuses a sibling envelope that names a target that is not a database, without writing", async () => {
    const fixture = await createCard(owner);
    const before = await snapshot(fixture);

    const error = await split(fixture, [
      taskCard(fixture, "Buy milk"),
      { entityKind: "database", target: randomUUID(), properties: { name: "Nowhere" } },
    ]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("keeps the other cards unaffected when a sibling is confirmed or rejected", async () => {
    const fixture = await createCard(owner);
    const { siblings } = await split(fixture, [...twoCards(fixture), taskCard(fixture, "Call mom")]);
    const [first, second] = siblings;
    if (!first || !second) throw new Error("Missing siblings");
    const primaryBefore = await readCard(fixture, fixture.cardId);
    const secondBefore = await readCard(fixture, second.id);
    const tasksBefore = await countItems(fixture, fixture.tasksId);

    await runInTenant(owner, () =>
      withTransaction(runtime, (client) => confirmProposalWithClient(client, proposalsConfig(fixture), first.id)),
    );

    expect((await readCard(fixture, first.id)).card.status).toBe("confirmed");
    expect(await countItems(fixture, fixture.tasksId)).toBe(tasksBefore + 1);
    expect(await readCard(fixture, fixture.cardId)).toEqual(primaryBefore);
    expect(await readCard(fixture, second.id)).toEqual(secondBefore);

    await runInTenant(owner, () =>
      withTransaction(runtime, (client) => rejectProposalWithClient(client, proposalsConfig(fixture), second.id)),
    );

    expect((await readCard(fixture, second.id)).card.status).toBe("rejected");
    expect((await readCard(fixture, first.id)).card.status).toBe("confirmed");
    expect(await readCard(fixture, fixture.cardId)).toEqual(primaryBefore);
    expect(await countItems(fixture, fixture.tasksId)).toBe(tasksBefore + 1);
  });

  it("refuses to split a sibling card, whose primary card is the only one a split may revise", async () => {
    const fixture = await createCard(owner);
    const { siblings } = await split(fixture, twoCards(fixture));
    const sibling = siblings[0];
    if (!sibling) throw new Error("Missing sibling");
    const before = await snapshot(fixture);

    const error = await split(fixture, twoCards(fixture), { proposalId: sibling.id }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "proposalId" } });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("splits a primary card that was split before: the new siblings point at the same primary card", async () => {
    const fixture = await createCard(owner);
    const first = await split(fixture, twoCards(fixture));

    const second = await split(fixture, twoCards(fixture));

    expect(await cardsOfSource(fixture)).toHaveLength(3);
    for (const sibling of [...first.siblings, ...second.siblings]) {
      expect((await readCard(fixture, sibling.id)).card.splitFromProposalId).toBe(fixture.cardId);
    }
  });

  it("answers a card whose source is another Inbox item exactly as a missing card, and writes nothing", async () => {
    const fixture = await createCard(owner);
    const other = await createCard(owner);
    const before = await snapshot(fixture);

    const wrongSubject = await split(fixture, twoCards(fixture), { subjectItemId: other.sourceId }).catch(
      (caught: unknown) => caught,
    );
    const missing = await split(fixture, twoCards(fixture), { proposalId: randomUUID() }).catch(
      (caught: unknown) => caught,
    );

    expect(wrongSubject).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("answers a subject that is no live Inbox item exactly as a missing card", async () => {
    const fixture = await createCard(owner);
    const before = await snapshot(fixture);

    const notInbox = await split(fixture, twoCards(fixture), { subjectItemId: fixture.cardId }).catch(
      (caught: unknown) => caught,
    );
    const unknown = await split(fixture, twoCards(fixture), { subjectItemId: randomUUID() }).catch(
      (caught: unknown) => caught,
    );

    for (const error of [notInbox, unknown]) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ message: `Processing proposal ${fixture.cardId} not found` });
    }
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("takes the source before the card's source edge: a removal of the edge by the holder of the source neither waits for the split nor deadlocks with it", async () => {
    const fixture = await createCard(owner);
    const before = await snapshot(fixture);
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => {};
    const heldSource = new Promise<void>((resolve) => {
      held = resolve;
    });
    // The holder takes the source, as an association removal does, and deletes the edge only after the split waits.
    const holder = runInTenant(fixture.tenant, () =>
      withTransaction(runtime, async (client) => {
        await lockInboxSource(client, fixture.sourceId);
        held();
        await released;
        const property = await client.query<{ id: string }>(
          "SELECT id FROM properties WHERE database_id = $1 AND key = 'sourceInbox'",
          [fixture.proposalsId],
        );
        const relationPropertyId = property.rows[0]?.id;
        if (!relationPropertyId) throw new Error("Missing sourceInbox property");
        const deleted = await deleteRelationWithClient(
          client,
          { relationPropertyId, callerItemId: fixture.cardId, targetItemId: fixture.sourceId },
          { ownerProcess: "processingProposals" },
        );
        expect(deleted).not.toBeNull();
      }),
    );
    await heldSource;

    const attempt = split(fixture, twoCards(fixture)).catch((caught: unknown) => caught);
    // `pg_stat_activity.query` is cut at 1024 bytes, so the statement is recognized by its first words.
    const deadline = Date.now() + 10_000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const activity = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT i.id FROM items i JOIN databases d%' AND pid <> pg_backend_pid()
         ) AS waiting`,
      );
      waiting = activity.rows[0]?.waiting === true;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;

    expect(waiting).toBe(true);
    expect(await attempt).toBeInstanceOf(NotFoundError);
    expect(await snapshot(fixture)).toEqual({ ...before, edges: before.edges - 1 });
  });

  it("does not reach a card of another tenant through the runtime role", async () => {
    const own = await createCard(owner);
    const other = await createCard(foreign);
    const beforeOwn = await snapshot(own);
    const beforeOther = await snapshot(other);

    const error = await split(own, twoCards(own), { tenant: foreign }).catch((caught: unknown) => caught);
    const crossed = await split(other, twoCards(other), { proposalId: own.cardId }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(crossed).toBeInstanceOf(NotFoundError);
    expect(await snapshot(own)).toEqual(beforeOwn);
    expect(await snapshot(other)).toEqual(beforeOther);
  });

  it("refuses a primary card the user edited after the version the split was composed from, and accepts the current version", async () => {
    const fixture = await createCard(owner);
    const seen = (await readCard(fixture, fixture.cardId)).updatedAt;
    await runInTenant(owner, () =>
      withTransaction(runtime, (client) =>
        updateProposalValuesWithClient(client, proposalsConfig(fixture), fixture.cardId, {
          set: { primary: { name: "Koupit mléko" } },
        }),
      ),
    );
    const before = await snapshot(fixture);
    events.length = 0;

    const stale = await split(fixture, twoCards(fixture), { ifVersion: seen }).catch((caught: unknown) => caught);

    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale).toMatchObject({ status: 409, code: "version_conflict" });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);

    const current = (await readCard(fixture, fixture.cardId)).updatedAt;
    const result = await split(fixture, twoCards(fixture), { ifVersion: current });
    expect(result.siblings).toHaveLength(1);
  });

  it("announces the changed primary card and each new sibling once, after the commit, and nothing for a refusal", async () => {
    const fixture = await createCard(owner);
    await split(fixture, [
      taskCard(fixture, "Buy milk"),
      { ...taskCard(fixture, "x"), properties: { notAKey: 1 } },
    ]).catch(() => undefined);
    expect(events).toEqual([]);

    const { siblings } = await split(fixture, [...twoCards(fixture), taskCard(fixture, "Call mom")]);

    expect(events).toEqual([
      { op: "updated", cardId: fixture.cardId },
      ...siblings.map((sibling) => ({ op: "created", cardId: sibling.id })),
    ]);
  });
});
