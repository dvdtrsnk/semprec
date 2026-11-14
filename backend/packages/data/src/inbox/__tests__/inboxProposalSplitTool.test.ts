import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createUser } from "../../auth/usersStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { resolveModuleAgentToolsForRun } from "../../agentTools/moduleAgentTools.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { claimSempMessage, finishSempMessageTurn, startSempMessageTurn } from "../../semp/sempMessagesStore.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createInboxProposalSplitTool, inboxProposalSplitArgsSchema } from "../inboxAgentTools.js";
import { lockInboxSource } from "../inboxSourceGuard.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createSemprecTickAction } from "../inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../proposalActions.js";

/** The fields of a refusal the split tool answers for a failed check of the write. */
const refusalSchema = z.object({
  status: z.number(),
  error: z.string(),
  message: z.string(),
  field: z.string().optional(),
});
const successSchema = z.object({
  proposalId: z.string().uuid(),
  siblingProposalIds: z.array(z.string().uuid()),
  split: z.literal(true),
  version: z.string(),
});
const storedCardSchema = z.object({
  proposal: z.object({ entityKind: z.string(), target: z.string(), properties: z.record(z.string(), z.unknown()) }),
  aiVersion: z.number(),
  status: z.string(),
  splitFromProposalId: z.string().optional(),
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
const NOT_FOUND = { error: true, result: "Proposal not found" };

interface ThreadFixture {
  tenant: string;
  projectId: string;
  sourceId: string;
  cardId: string;
  threadId: string;
  runId: string;
  /** The assistant message the run's turn is answering, `running` and stamped with the run. */
  messageId: string;
  tasksId: string;
  eventsId: string;
  proposalsId: string;
}

describe("inbox.proposal.split agent tool (issue #1939)", () => {
  let admin: Pool;
  let runtime: Pool;
  let owner: string;
  let foreign: string;
  let events: InboxCardsInvalidationEvent[];

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
    for (const tenant of [owner, foreign]) {
      await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenant, () => seedSystem(runtime));
    }
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
    if (errors.length) throw new AggregateError(errors, "Split tool fixture cleanup failed", { cause: errors[0] });
  });

  /**
   * An Inbox item whose card the tick created and the user revised into the Tasks proposal `Buy milk and renew the
   * passport`, and an item thread with a run whose turn is `running`, as the queued Semp turn leaves it.
   */
  async function createCardThread(tenant: string): Promise<ThreadFixture> {
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
        // An empty capture leaves the tick's card without a model call, as in the revise tool test.
        createInboxItemWithClient(client, { inboxDatabaseId, date: "2026-11-14", time: "12:00", text: "" }),
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
      const turn = await withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          subject: { inboxItemId: source.id, proposalId: cardId },
          text: "Split this into two items",
          context: [],
          hasContext: false,
        }),
      );
      const run = await createAgentRun(runtime, {
        projectItemId: dbs.inbox.ownerProjectItemId,
        threadId: turn.threadId,
        triggeredBy: "user",
        unit: "session",
        task: "Split this into two items",
      });
      await withTransaction(runtime, async (client) => {
        expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
        await startSempMessageTurn(client, turn.assistantMessageId, run.id, "1");
      });
      // The fixture's own card writes are not what a test observes.
      events.length = 0;
      return {
        tenant,
        projectId: dbs.inbox.ownerProjectItemId,
        sourceId: source.id,
        cardId,
        threadId: turn.threadId,
        runId: run.id,
        messageId: turn.assistantMessageId,
        tasksId,
        eventsId: dbs.events.id,
        proposalsId,
      };
    });
  }

  /** The stored card and its version, read through the runtime role inside the tenant. */
  async function readCard(fixture: ThreadFixture, cardId = fixture.cardId) {
    return runInTenant(fixture.tenant, async () => {
      const row = await runtime.query<{ properties: unknown; updated_at: Date }>(
        "SELECT properties, updated_at FROM items WHERE id = $1",
        [cardId],
      );
      const stored = row.rows[0];
      if (!stored) throw new Error("Card is missing");
      return { properties: stored.properties, updatedAt: stored.updated_at.toISOString() };
    });
  }

  async function countItems(fixture: ThreadFixture, databaseId: string): Promise<number> {
    return runInTenant(fixture.tenant, async () => {
      const rows = await runtime.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND deleted_at IS NULL",
        [databaseId],
      );
      return rows.rows[0]?.count ?? -1;
    });
  }

  /** What a refused or failed split must leave behind: the card, every card of the database, the edges and no target item. */
  async function snapshot(fixture: ThreadFixture) {
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

  const tool = () => createInboxProposalSplitTool(runtime);
  const callRaw = (fixture: ThreadFixture, args: unknown, runId = fixture.runId) =>
    runInTenant(fixture.tenant, () => tool()(runId, args));
  /** The call as the model makes it: `ifVersion` is the card's current version, unless the test names one. */
  const call = async (fixture: ThreadFixture, args: Record<string, unknown>, runId = fixture.runId) => {
    if ("ifVersion" in args) return callRaw(fixture, args, runId);
    const version = await readCard(fixture, String(args.proposalId)).then(
      (card) => card.updatedAt,
      () => "no-such-version",
    );
    return callRaw(fixture, { ...args, ifVersion: version }, runId);
  };

  it("splits the thread's card into two: the thread and the message come from the run, and nothing is created in a target database", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, { proposalId: fixture.cardId, cards: taskCards(fixture), message: "Two items" });

    expect(result.error).toBe(false);
    const answer = successSchema.parse(JSON.parse(result.result));
    expect(answer.proposalId).toBe(fixture.cardId);
    expect(answer.siblingProposalIds).toHaveLength(1);
    expect(answer.version).toBe((await readCard(fixture)).updatedAt);
    const siblingId = answer.siblingProposalIds[0];
    if (!siblingId) throw new Error("Missing sibling");
    const primary = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(primary.proposal.properties).toEqual({ name: "Buy milk" });
    expect(primary.splitFromProposalId).toBeUndefined();
    expect(primary.history.at(-1)).toEqual({
      author: "ai",
      message: "Two items",
      kind: "threadRevision",
      threadId: fixture.threadId,
      messageId: fixture.messageId,
    });
    const sibling = storedCardSchema.parse((await readCard(fixture, siblingId)).properties);
    expect(sibling).toMatchObject({
      status: "proposed",
      aiVersion: 1,
      splitFromProposalId: fixture.cardId,
      proposal: { entityKind: "database", target: fixture.tasksId, properties: { name: "Renew the passport" } },
    });
    expect(sibling.history).toEqual([
      {
        author: "ai",
        message: "Two items",
        kind: "threadRevision",
        threadId: fixture.threadId,
        messageId: fixture.messageId,
      },
    ]);
    const edge = await runInTenant(owner, () =>
      runtime.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM item_relations
          WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)`,
        [siblingId, fixture.sourceId],
      ),
    );
    expect(edge.rows[0]?.count).toBe(1);
    const after = await snapshot(fixture);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.cards).toHaveLength(before.cards.length + 1);
    expect(events).toEqual([
      { op: "updated", cardId: fixture.cardId },
      { op: "created", cardId: siblingId },
    ]);
  });

  it("splits a source whose siblings go to different databases", async () => {
    const fixture = await createCardThread(owner);

    const result = await call(fixture, {
      proposalId: fixture.cardId,
      cards: [
        { entityKind: "database", target: fixture.tasksId, properties: { name: "Buy milk" } },
        {
          entityKind: "database",
          target: fixture.eventsId,
          properties: { name: "Passport appointment", type: "meeting", date: "2026-11-20" },
        },
      ],
    });

    expect(result.error).toBe(false);
    const siblingId = successSchema.parse(JSON.parse(result.result)).siblingProposalIds[0];
    if (!siblingId) throw new Error("Missing sibling");
    const sibling = storedCardSchema.parse((await readCard(fixture, siblingId)).properties);
    expect(sibling.proposal.target).toBe(fixture.eventsId);
  });

  it("rejects arguments that are not the strict shape, including a thread or message of the model's own, without touching the card", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);
    const cards = taskCards(fixture);
    const valid = { proposalId: fixture.cardId, ifVersion: (await readCard(fixture)).updatedAt, cards };
    const manyCards = Array.from({ length: 11 }, (_, index) => ({
      entityKind: "database",
      target: fixture.tasksId,
      properties: { name: `Card ${index}` },
    }));

    for (const args of [
      { ...valid, threadId: fixture.threadId },
      { ...valid, messageId: fixture.messageId },
      { ...valid, extra: true },
      { proposalId: valid.proposalId, cards },
      { ...valid, ifVersion: "" },
      { ...valid, proposalId: "not-a-uuid" },
      { ...valid, cards: cards.slice(0, 1) },
      { ...valid, cards: [] },
      { ...valid, cards: manyCards },
      { ...valid, cards: [cards[0], { ...cards[1], extra: true }] },
      { ...valid, cards: [cards[0], { ...cards[1], entityKind: "unknown" }] },
      { ...valid, cards: [cards[0], { ...cards[1], target: "" }] },
      { ...valid, cards: [cards[0], { target: fixture.tasksId, properties: {} }] },
      { ...valid, message: "" },
      { ...valid, message: "x".repeat(2001) },
      { proposalId: fixture.cardId },
      null,
    ]) {
      expect(await callRaw(fixture, args)).toEqual({ error: true, result: "Invalid arguments" });
    }
    expect(inboxProposalSplitArgsSchema.safeParse(valid).success).toBe(true);
    expect(inboxProposalSplitArgsSchema.safeParse({ ...valid, cards: manyCards.slice(0, 10) }).success).toBe(true);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("answers a card of the same tenant that is not the thread's own, a card or run of another tenant and a missing card alike", async () => {
    const own = await createCardThread(owner);
    const other = await createCardThread(owner);
    const outsider = await createCardThread(foreign);
    const beforeOwn = await snapshot(own);
    const beforeOther = await snapshot(other);
    const beforeOutsider = await snapshot(outsider);

    const missing = await call(own, { proposalId: randomUUID(), cards: taskCards(own) });
    const otherThread = await call(own, { proposalId: other.cardId, cards: taskCards(own) });
    const otherTenantCard = await call(own, { proposalId: outsider.cardId, cards: taskCards(own) });
    const otherTenantRun = await call(own, { proposalId: own.cardId, cards: taskCards(own) }, outsider.runId);

    for (const answer of [missing, otherThread, otherTenantCard, otherTenantRun]) expect(answer).toEqual(NOT_FOUND);
    expect(await snapshot(own)).toEqual(beforeOwn);
    expect(await snapshot(other)).toEqual(beforeOther);
    expect(await snapshot(outsider)).toEqual(beforeOutsider);
    expect(events).toEqual([]);
  });

  it("answers an error result and writes nothing when the run has no running reply in its thread", async () => {
    const fixture = await createCardThread(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        expect(
          await finishSempMessageTurn(client, fixture.messageId, { status: "done", text: "Done", lastEventId: "1" }),
        ).toBe(true);
      }),
    );
    const before = await snapshot(fixture);

    const result = await call(fixture, { proposalId: fixture.cardId, cards: taskCards(fixture) });

    expect(result).toEqual({ error: true, result: "The call is not part of a running Semp reply" });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("refuses a confirmed card with an error result, creates no card and leaves the card unchanged", async () => {
    const fixture = await createCardThread(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: fixture.proposalsId }, fixture.cardId),
      ),
    );
    const before = await snapshot(fixture);
    events.length = 0;

    const result = await call(fixture, { proposalId: fixture.cardId, cards: taskCards(fixture) });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({
      status: 400,
      error: "validation_failed",
      field: "status",
    });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);
  });

  it("refuses an invalid envelope in the second entry with an error result, creates no card and leaves the first entry's card unchanged", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, {
      proposalId: fixture.cardId,
      cards: [taskCards(fixture)[0], { entityKind: "database", target: fixture.tasksId, properties: { notAKey: "x" } }],
    });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({ status: 400, error: "validation_failed" });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);
  });

  it("refuses a split composed from a card the user changed since, and accepts it again from the version the answer carries", async () => {
    const fixture = await createCardThread(owner);
    const seen = (await readCard(fixture)).updatedAt;
    // The card moves on after the model read it, as a user edit does.
    await runInTenant(owner, () =>
      withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: fixture.proposalsId }, fixture.cardId, {
          entityKind: "database",
          target: fixture.tasksId,
          properties: { name: "Buy oat milk" },
        }),
      ),
    );
    const before = await snapshot(fixture);
    events.length = 0;

    const stale = await callRaw(fixture, { proposalId: fixture.cardId, ifVersion: seen, cards: taskCards(fixture) });

    expect(stale.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(stale.result))).toMatchObject({
      status: 409,
      error: "version_conflict",
      field: "ifVersion",
    });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);

    const current = await callRaw(fixture, {
      proposalId: fixture.cardId,
      ifVersion: before.cards.find((card) => card.id === fixture.cardId)?.updated_at,
      cards: taskCards(fixture),
    });
    expect(current.error).toBe(false);
  });

  it.each([
    ["a property value", (cards: ReturnType<typeof taskCards>) => ({ cards: withName(cards, "bad\u0000value") })],
    [
      "a property key",
      (cards: ReturnType<typeof taskCards>) => ({
        cards: [cards[0], { ...cards[1], properties: { "bad\u0000key": "x" } }],
      }),
    ],
    [
      "a target",
      (cards: ReturnType<typeof taskCards>) => ({ cards: [cards[0], { ...cards[1], target: "bad\u0000" }] }),
    ],
    ["the message", (cards: ReturnType<typeof taskCards>) => ({ cards, message: "bad\u0000" })],
  ])("refuses a NUL character in %s as a validation error and writes nothing", async (_label, change) => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, { proposalId: fixture.cardId, ...change(taskCards(fixture)) });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({ status: 400, field: "cards" });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("refuses to split a sibling card, which the thread owns through the same source, and writes nothing", async () => {
    const fixture = await createCardThread(owner);
    const first = await call(fixture, { proposalId: fixture.cardId, cards: taskCards(fixture) });
    const { siblingProposalIds } = successSchema.parse(JSON.parse(first.result));
    const siblingId = siblingProposalIds[0];
    if (!siblingId) throw new Error("Missing sibling");
    const before = await snapshot(fixture);
    events.length = 0;

    const result = await call(fixture, { proposalId: siblingId, cards: taskCards(fixture) });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({ status: 400, field: "proposalId" });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);
  });

  it("is a registered module tool of the Inbox, run without approval, whose strict schema and own-card rule hold through the registry", async () => {
    const fixture = await createCardThread(owner);
    const other = await createCardThread(owner);
    const registry = await loadFullModuleRegistry();
    const otherBefore = await readCard(other);

    await runInTenant(owner, async () => {
      const tools = await resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectId);
      const split = tools.find((entry) => entry.name === "inbox.proposal.split");
      if (!split) throw new Error("inbox.proposal.split is missing from the registry");
      expect(split.requiresApproval).toBe(false);
      expect(split.riskClass).toBe("write");
      expect(split.argumentSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(
        split.acceptsArguments({ proposalId: fixture.cardId, ifVersion: "v", cards: taskCards(fixture), extra: true }),
      ).toBe(false);

      const refused = await split.invoke({
        proposalId: other.cardId,
        ifVersion: (await readCard(other)).updatedAt,
        cards: taskCards(other),
      });
      expect(refused).toEqual(NOT_FOUND);
      const done = await split.invoke({
        proposalId: fixture.cardId,
        ifVersion: (await readCard(fixture)).updatedAt,
        cards: taskCards(fixture),
      });
      expect(done.error).toBe(false);
    });
    expect(storedCardSchema.parse((await readCard(fixture)).properties).proposal.properties).toEqual({
      name: "Buy milk",
    });
    expect(await readCard(other)).toEqual(otherBefore);
  });

  /** Waits until a statement that starts with `prefix` is blocked on a lock; `pg_stat_activity.query` is cut at 1024 bytes. */
  async function waitForLockWait(prefix: string): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const activity = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> pg_backend_pid()
         ) AS waiting`,
        [`${prefix}%`],
      );
      if (activity.rows[0]?.waiting === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  /** Holds the source open in a transaction, optionally removing the card's source edge in it, until `release` runs. */
  function holdSource(fixture: ThreadFixture, removeEdge: boolean) {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => {};
    const heldSource = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = runInTenant(fixture.tenant, () =>
      withTransaction(runtime, async (client) => {
        await lockInboxSource(client, fixture.sourceId);
        held();
        await released;
        if (removeEdge) await removeSourceEdge(client, fixture);
      }),
    );
    return { heldSource, holder, release: () => release() };
  }

  async function removeSourceEdge(client: PoolClient, fixture: ThreadFixture) {
    const edge = await client.query<{ property_id: string }>(
      `SELECT property.id AS property_id
         FROM properties property JOIN databases proposals ON proposals.id = property.database_id
        WHERE proposals.owner_module_id = 'processingProposals' AND property.key = 'sourceInbox'`,
    );
    const relationPropertyId = edge.rows[0]?.property_id;
    if (!relationPropertyId) throw new Error("Missing sourceInbox property");
    const deleted = await deleteRelationWithClient(
      client,
      { relationPropertyId, callerItemId: fixture.cardId, targetItemId: fixture.sourceId },
      { ownerProcess: "processingProposals" },
    );
    expect(deleted).not.toBeNull();
  }

  it("waits for the source that a writer holds before it proves the card's edge, and a removal of the edge made meanwhile neither waits for the split nor deadlocks with it", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);
    // The holder takes the source, as an association removal does, and only then deletes the edge.
    const { heldSource, holder, release } = holdSource(fixture, true);
    await heldSource;

    const attempt = call(fixture, { proposalId: fixture.cardId, cards: taskCards(fixture) });
    // The split holds the card and waits for the source, and it holds no lock on the edge the holder is about to delete.
    const waiting = await waitForLockWait("SELECT i.id FROM items i JOIN databases d");
    release();
    await holder;

    expect(waiting).toBe(true);
    expect(await attempt).toEqual(NOT_FOUND);
    expect(await snapshot(fixture)).toEqual({ ...before, edges: before.edges - 1 });
  });

  it("waits for an open removal of the card's source link and then answers the card as missing, writing nothing", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removed: () => void = () => {};
    const removalDone = new Promise<void>((resolve) => {
      removed = resolve;
    });
    const removal = runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        await removeSourceEdge(client, fixture);
        removed();
        await released;
      }),
    );
    await removalDone;

    const attempt = call(fixture, { proposalId: fixture.cardId, cards: taskCards(fixture) });
    // The removal holds the source, so the call waits for it before it reads the edge.
    const waiting = await waitForLockWait("SELECT i.id FROM items i JOIN databases d");
    release();
    await removal;

    expect(waiting).toBe(true);
    expect(await attempt).toEqual(NOT_FOUND);
    expect(await snapshot(fixture)).toEqual({ ...before, edges: before.edges - 1 });
    expect(events).toEqual([]);
  });
});

/** Two valid Tasks cards for the thread's source. */
function taskCards(fixture: ThreadFixture) {
  return [
    { entityKind: "database", target: fixture.tasksId, properties: { name: "Buy milk" } },
    { entityKind: "database", target: fixture.tasksId, properties: { name: "Renew the passport" } },
  ];
}

/** `cards` with the name of the second one replaced. */
function withName(cards: ReturnType<typeof taskCards>, name: string) {
  return [cards[0], { ...cards[1], properties: { name } }];
}
