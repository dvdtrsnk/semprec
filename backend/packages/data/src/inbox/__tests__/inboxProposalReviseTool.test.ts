import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createUser } from "../../auth/usersStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { resolveModuleAgentToolsForRun } from "../../agentTools/moduleAgentTools.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { claimSempMessage, finishSempMessageTurn, startSempMessageTurn } from "../../semp/sempMessagesStore.js";
import { createSempChatThread, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createInboxProposalReviseTool, inboxProposalReviseArgsSchema } from "../inboxAgentTools.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createSemprecTickAction } from "../inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../proposalActions.js";

/** The fields of a refusal the revise tool answers for a failed check of the write. */
const refusalSchema = z.object({
  status: z.number(),
  error: z.string(),
  message: z.string(),
  field: z.string().optional(),
});
const successSchema = z.object({ proposalId: z.string().uuid(), revised: z.literal(true), version: z.string() });
const storedCardSchema = z.object({
  proposal: z.object({ entityKind: z.string(), target: z.string(), properties: z.record(z.string(), z.unknown()) }),
  aiProposal: z.object({ entityKind: z.string(), target: z.string() }).optional(),
  status: z.string(),
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
  inboxId: string;
  eventsId: string;
}

describe("inbox.proposal.revise agent tool (issue #1906)", () => {
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
    if (errors.length) throw new AggregateError(errors, "Revise tool fixture cleanup failed", { cause: errors[0] });
  });

  /**
   * An Inbox item whose card the tick created, revised by the user into a Tasks proposal `Buy milk` (unless
   * `withEnvelope` is false, which leaves the card as the tick made it: needing clarification and with no envelope),
   * and an item thread with a run whose turn is `running`, as the queued Semp turn leaves it.
   */
  async function createCardThread(tenant: string, withEnvelope = true): Promise<ThreadFixture> {
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
        createInboxItemWithClient(client, { inboxDatabaseId, date: "2026-11-06", time: "12:00", text: "" }),
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
      if (withEnvelope) {
        await withTransaction(runtime, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
            message: "Filed under Tasks",
            entityKind: "database",
            target: tasksId,
            properties: { name: "Buy milk" },
          }),
        );
      }
      const turn = await withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          subject: { inboxItemId: source.id, proposalId: cardId },
          text: "It is something else",
          context: [],
          hasContext: false,
        }),
      );
      const run = await createAgentRun(runtime, {
        projectItemId: dbs.inbox.ownerProjectItemId,
        threadId: turn.threadId,
        triggeredBy: "user",
        unit: "session",
        task: "It is something else",
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
        inboxId: dbs.inbox.id,
        eventsId: dbs.events.id,
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

  /** What a refused or failed revision must leave behind: the card, the target databases and no invalidation. */
  async function snapshot(fixture: ThreadFixture) {
    return {
      card: await readCard(fixture),
      tasks: await countItems(fixture, fixture.tasksId),
      events: await countItems(fixture, fixture.eventsId),
    };
  }

  const tool = () => createInboxProposalReviseTool(runtime);
  const callRaw = (fixture: ThreadFixture, args: unknown, runId = fixture.runId) =>
    runInTenant(fixture.tenant, () => tool()(runId, args));
  /**
   * The tool's call as the model makes it: `ifVersion` is the card's current version, which the model copies from the
   * card context, unless the test names one. A card that is not readable gets a version that matches nothing.
   */
  const call = async (fixture: ThreadFixture, args: unknown, runId = fixture.runId) => {
    if (typeof args === "object" && args !== null && "proposalId" in args && !("ifVersion" in args)) {
      const version = await readCard(fixture, String(args.proposalId)).then(
        (card) => card.updatedAt,
        () => "no-such-version",
      );
      return callRaw(fixture, { ...args, ifVersion: version }, runId);
    }
    return callRaw(fixture, args, runId);
  };

  it("revises an open card: the envelope is replaced and history gains an AI threadRevision entry", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, {
      proposalId: fixture.cardId,
      properties: { name: "Buy oat milk" },
      message: "It is oat milk",
    });

    expect(result.error).toBe(false);
    expect(successSchema.parse(JSON.parse(result.result))).toEqual({
      proposalId: fixture.cardId,
      revised: true,
      version: (await readCard(fixture)).updatedAt,
    });
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.proposal).toEqual({
      entityKind: "database",
      target: fixture.tasksId,
      properties: { name: "Buy oat milk" },
    });
    expect(after.aiProposal).toMatchObject({ entityKind: "database", target: fixture.tasksId });
    expect(after.status).toBe("proposed");
    expect(after.history.at(-1)).toEqual({
      author: "ai",
      message: "It is oat milk",
      kind: "threadRevision",
      threadId: fixture.threadId,
      messageId: fixture.messageId,
    });
    expect(after.history).toHaveLength(storedCardSchema.parse(before.card.properties).history.length + 1);
    // Nothing is created in a target database.
    expect(await countItems(fixture, fixture.tasksId)).toBe(before.tasks);
    expect(await countItems(fixture, fixture.eventsId)).toBe(before.events);
  });

  it("turns the card into an Event proposal when the instruction says it is an event, and creates nothing in a target database", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, {
      proposalId: fixture.cardId,
      entityKind: "database",
      target: fixture.eventsId,
      properties: { name: "Buy milk", type: "meeting", date: "2026-11-20" },
      message: "It is an event, not a task",
    });

    expect(result.error).toBe(false);
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.proposal).toEqual({
      entityKind: "database",
      target: fixture.eventsId,
      properties: { name: "Buy milk", type: "meeting", date: "2026-11-20" },
    });
    expect(after.history.at(-1)).toMatchObject({
      author: "ai",
      kind: "threadRevision",
      threadId: fixture.threadId,
      messageId: fixture.messageId,
    });
    expect(await countItems(fixture, fixture.tasksId)).toBe(before.tasks);
    expect(await countItems(fixture, fixture.eventsId)).toBe(before.events);
  });

  it("applies the rules of a thread revision to the user's edited values: a changed key stays the user's, an untouched one stays protected", async () => {
    const fixture = await createCardThread(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!proposals) throw new Error("Missing proposals database");
        await updateProposalValuesWithClient(client, { processingProposalsDatabaseId: proposals.id }, fixture.cardId, {
          set: { primary: { name: "Koupit mléko" } },
        });
      }),
    );
    const storedKeys = z.object({
      userOverrides: z.record(z.string(), z.record(z.string(), z.unknown())),
      userEditedKeys: z.array(z.string()),
      aiProposal: z.object({ properties: z.record(z.string(), z.unknown()) }),
    });

    const untouched = await call(fixture, {
      proposalId: fixture.cardId,
      properties: { name: "Koupit mléko", description: "Oat milk" },
    });
    expect(untouched.error).toBe(false);
    const afterUntouched = storedKeys.parse((await readCard(fixture)).properties);
    expect(afterUntouched.userOverrides).toEqual({ primary: { name: "Koupit mléko" } });
    expect(afterUntouched.userEditedKeys).toEqual(["primary.name"]);
    expect(afterUntouched.aiProposal.properties).toEqual({ name: "Buy milk", description: "Oat milk" });

    const changed = await call(fixture, {
      proposalId: fixture.cardId,
      properties: { name: "Koupit ovesné mléko", description: "Oat milk" },
    });
    expect(changed.error).toBe(false);
    const afterChanged = storedKeys.parse((await readCard(fixture)).properties);
    expect(afterChanged.userOverrides).toEqual({ primary: { name: "Koupit ovesné mléko" } });
    expect(afterChanged.userEditedKeys).toEqual(["primary.name"]);
    expect(storedCardSchema.parse((await readCard(fixture)).properties).proposal.properties).toEqual({
      name: "Koupit ovesné mléko",
      description: "Oat milk",
    });
  });

  it("refuses a revision composed from a card that the user edited since, keeps the user's value, and accepts it again from the version the answer carries", async () => {
    const fixture = await createCardThread(owner);
    const seen = (await readCard(fixture)).updatedAt;
    // The user edits the title while the turn is still working from the card it read.
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!proposals) throw new Error("Missing proposals database");
        await updateProposalValuesWithClient(client, { processingProposalsDatabaseId: proposals.id }, fixture.cardId, {
          set: { primary: { name: "Koupit mléko" } },
        });
      }),
    );
    const before = await snapshot(fixture);
    events.length = 0;

    const stale = await callRaw(fixture, {
      proposalId: fixture.cardId,
      ifVersion: seen,
      properties: { name: "Buy milk", description: "Oat milk" },
    });

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
      ifVersion: before.card.updatedAt,
      properties: { name: "Koupit mléko", description: "Oat milk" },
    });
    expect(current.error).toBe(false);
    const stored = z
      .object({ userOverrides: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .parse((await readCard(fixture)).properties);
    expect(stored.userOverrides).toEqual({ primary: { name: "Koupit mléko" } });

    // A second revision of the same turn names the version the first one answered.
    const { version } = successSchema.parse(JSON.parse(current.result));
    const again = await callRaw(fixture, {
      proposalId: fixture.cardId,
      ifVersion: version,
      properties: { name: "Koupit mléko", description: "Oat milk, 1 l" },
    });
    expect(again.error).toBe(false);
    const replay = await callRaw(fixture, {
      proposalId: fixture.cardId,
      ifVersion: version,
      properties: { name: "Koupit mléko", description: "Replayed" },
    });
    expect(replay.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(replay.result))).toMatchObject({ status: 409, error: "version_conflict" });
  });

  it("keeps an edited value that the revised envelope leaves out, and clears it only for an explicit null", async () => {
    const fixture = await createCardThread(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!proposals) throw new Error("Missing proposals database");
        await updateProposalValuesWithClient(client, { processingProposalsDatabaseId: proposals.id }, fixture.cardId, {
          set: { primary: { description: "Typed note" } },
        });
      }),
    );
    const storedKeys = z.object({
      userOverrides: z.record(z.string(), z.record(z.string(), z.unknown())),
      userEditedKeys: z.array(z.string()),
    });

    const partial = await call(fixture, { proposalId: fixture.cardId, properties: { name: "Buy oat milk" } });

    expect(partial.error).toBe(false);
    const afterPartial = (await readCard(fixture)).properties;
    expect(storedKeys.parse(afterPartial)).toEqual({
      userOverrides: { primary: { description: "Typed note" } },
      userEditedKeys: ["primary.description"],
    });
    expect(storedCardSchema.parse(afterPartial).proposal.properties).toEqual({
      name: "Buy oat milk",
      description: "Typed note",
    });

    const cleared = await call(fixture, {
      proposalId: fixture.cardId,
      properties: { name: "Buy oat milk", description: null },
    });

    expect(cleared.error).toBe(false);
    const afterCleared = (await readCard(fixture)).properties;
    expect(storedKeys.parse(afterCleared).userEditedKeys).toEqual(["primary.description"]);
    expect(storedCardSchema.parse(afterCleared).proposal.properties).toEqual({
      name: "Buy oat milk",
      description: null,
    });
  });

  it("changes the kind and the target when the arguments name them", async () => {
    const fixture = await createCardThread(owner);

    const result = await call(fixture, {
      proposalId: fixture.cardId,
      entityKind: "pageContent",
      target: fixture.projectId,
      properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
    });

    expect(result.error).toBe(false);
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.proposal).toEqual({
      entityKind: "pageContent",
      target: fixture.projectId,
      properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
    });
    expect(await countItems(fixture, fixture.tasksId)).toBe(0);
  });

  it("writes the default assistant text when the call carries no message", async () => {
    const fixture = await createCardThread(owner);

    const result = await call(fixture, { proposalId: fixture.cardId, properties: { name: "Buy oat milk" } });

    expect(result.error).toBe(false);
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.history.at(-1)).toMatchObject({
      author: "ai",
      message: "Revised by assistant.",
      kind: "threadRevision",
    });
  });

  it("records the message of the running turn when the run has answered earlier messages of the thread", async () => {
    const fixture = await createCardThread(owner);
    // The first turn is done; a second message of the same thread starts a new turn that reuses the run.
    const second = await runInTenant(owner, async () => {
      await withTransaction(runtime, async (client) => {
        expect(
          await finishSempMessageTurn(client, fixture.messageId, { status: "done", text: "Done", lastEventId: "1" }),
        ).toBe(true);
      });
      const turn = await withTransaction(runtime, (client) =>
        sendSempMessage(client, {
          threadId: fixture.threadId,
          text: "And now?",
          context: [],
          hasContext: false,
        }),
      );
      await withTransaction(runtime, async (client) => {
        expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
        await startSempMessageTurn(client, turn.assistantMessageId, fixture.runId, "2");
      });
      return turn.assistantMessageId;
    });
    expect(second).not.toBe(fixture.messageId);

    const result = await call(fixture, { proposalId: fixture.cardId, properties: { name: "Buy oat milk" } });

    expect(result.error).toBe(false);
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.history.at(-1)).toMatchObject({ threadId: fixture.threadId, messageId: second });
  });

  it.each([
    ["confirmed", confirmProposalWithClient],
    ["rejected", rejectProposalWithClient],
  ] as const)("refuses a %s card with an error result and leaves the envelope unchanged", async (status, decide) => {
    const fixture = await createCardThread(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!proposals) throw new Error("Missing proposals database");
        await decide(client, { processingProposalsDatabaseId: proposals.id }, fixture.cardId);
      }),
    );
    const before = await snapshot(fixture);
    expect(storedCardSchema.parse(before.card.properties).status).toBe(status);
    events.length = 0;

    const result = await call(fixture, { proposalId: fixture.cardId, properties: { name: "Too late" } });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({
      status: 400,
      error: "validation_failed",
      field: "status",
    });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);
  });

  it.each([
    [
      "a property the target database does not have",
      (f: ThreadFixture) => ({ entityKind: "database", target: f.tasksId, properties: { notAKey: "x" } }),
    ],
    [
      "a target that is not a writable database",
      (f: ThreadFixture) => ({ entityKind: "database", target: f.inboxId, properties: {} }),
    ],
  ])("returns an error and writes nothing for an invalid envelope: %s", async (_label, envelopeOf) => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, { proposalId: fixture.cardId, ...envelopeOf(fixture) });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({ status: 400, error: "validation_failed" });
    expect(await snapshot(fixture)).toEqual(before);
    expect(events).toEqual([]);
  });

  it("answers a card of the same tenant that is not the thread's own exactly as it answers a missing card", async () => {
    const own = await createCardThread(owner);
    const other = await createCardThread(owner);
    const missing = await call(own, { proposalId: randomUUID(), properties: { name: "x" } });
    expect(missing).toEqual(NOT_FOUND);
    const beforeOwn = await snapshot(own);
    const beforeOther = await snapshot(other);

    const attempt = await call(own, {
      proposalId: other.cardId,
      properties: { name: "Changed from the other thread" },
    });

    expect(attempt).toEqual(missing);
    expect(await snapshot(own)).toEqual(beforeOwn);
    expect(await snapshot(other)).toEqual(beforeOther);
    expect(events).toEqual([]);
  });

  it("answers a card of another tenant, and a run of another tenant, as it answers a missing card", async () => {
    const own = await createCardThread(owner);
    const other = await createCardThread(foreign);
    const beforeOwn = await snapshot(own);
    const beforeOther = await snapshot(other);

    const foreignCard = await call(own, { proposalId: other.cardId, properties: { name: "x" } });
    const foreignRun = await call(own, { proposalId: own.cardId, properties: { name: "x" } }, other.runId);

    expect(foreignCard).toEqual(NOT_FOUND);
    expect(foreignRun).toEqual(NOT_FOUND);
    expect(await snapshot(own)).toEqual(beforeOwn);
    expect(await snapshot(other)).toEqual(beforeOther);
  });

  it("answers a tenant that has no Processing proposals database as it answers a missing card", async () => {
    const unseeded = await createTestTenant(admin);

    const result = await runInTenant(unseeded, () =>
      tool()(randomUUID(), { proposalId: randomUUID(), ifVersion: "no-such-version", properties: { name: "x" } }),
    );

    expect(result).toEqual(NOT_FOUND);
  });

  it("refuses a run that is in a chat thread and a run that has no thread, even for an existing card", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);
    const { chatRunId, plainRunId } = await runInTenant(owner, async () => {
      const chatThreadId = await withTransaction(runtime, (client) => createSempChatThread(client));
      const chat = await createAgentRun(runtime, {
        projectItemId: fixture.projectId,
        threadId: chatThreadId,
        triggeredBy: "user",
        unit: "session",
        task: "Chat",
      });
      const plain = await createAgentRun(runtime, {
        projectItemId: fixture.projectId,
        triggeredBy: "user",
        task: "No thread",
      });
      return { chatRunId: chat.id, plainRunId: plain.id };
    });

    const args = { proposalId: fixture.cardId, properties: { name: "x" } };
    expect(await call(fixture, args, chatRunId)).toEqual(NOT_FOUND);
    expect(await call(fixture, args, plainRunId)).toEqual(NOT_FOUND);
    expect(await call(fixture, args, randomUUID())).toEqual(NOT_FOUND);
    expect(await snapshot(fixture)).toEqual(before);
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

    const result = await call(fixture, { proposalId: fixture.cardId, properties: { name: "x" } });

    expect(result).toEqual({ error: true, result: "The call is not part of a running Semp reply" });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("needs the kind and the target of a card that has no proposal yet, and says which is missing", async () => {
    const fixture = await createCardThread(owner, false);
    const before = await snapshot(fixture);

    const both = await call(fixture, { proposalId: fixture.cardId, properties: { name: "x" } });
    const kindOnly = await call(fixture, {
      proposalId: fixture.cardId,
      entityKind: "database",
      properties: { name: "x" },
    });
    const targetOnly = await call(fixture, {
      proposalId: fixture.cardId,
      target: fixture.tasksId,
      properties: { name: "x" },
    });

    expect(both.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(both.result))).toMatchObject({ status: 400, field: "entityKind" });
    expect(refusalSchema.parse(JSON.parse(kindOnly.result))).toMatchObject({ status: 400, field: "target" });
    expect(refusalSchema.parse(JSON.parse(targetOnly.result))).toMatchObject({ status: 400, field: "entityKind" });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("refuses a card whose stored envelope has a kind this release does not know, with or without the kind in the call", async () => {
    const fixture = await createCardThread(owner);
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!proposals) throw new Error("Missing proposals database");
        // Historical state a newer release wrote: the card owner's own keys, set to a kind this release cannot run.
        const unknown = { entityKind: "widget", target: fixture.tasksId, properties: {} };
        await updateItemWithClient(
          client,
          {
            databaseId: proposals.id,
            itemId: fixture.cardId,
            propertiesPatch: { proposal: unknown, aiProposal: unknown },
          },
          { allowedSystemKeys: ["proposal", "aiProposal"] },
        );
      }),
    );
    const before = await snapshot(fixture);

    const defaulted = await call(fixture, { proposalId: fixture.cardId, properties: { name: "x" } });
    const explicit = await call(fixture, {
      proposalId: fixture.cardId,
      entityKind: "database",
      target: fixture.tasksId,
      properties: { name: "x" },
    });

    for (const result of [defaulted, explicit]) {
      expect(result.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({ status: 409, field: "entityKind" });
    }
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("gives such a card its first envelope when the arguments name the whole destination", async () => {
    const fixture = await createCardThread(owner, false);

    const result = await call(fixture, {
      proposalId: fixture.cardId,
      entityKind: "database",
      target: fixture.tasksId,
      properties: { name: "Buy milk" },
    });

    expect(result.error).toBe(false);
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.status).toBe("proposed");
    expect(after.history.at(-1)).toMatchObject({ author: "ai", kind: "threadRevision", messageId: fixture.messageId });
  });

  it("rejects arguments that are not the strict shape without touching the card", async () => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);
    const valid = { proposalId: fixture.cardId, ifVersion: before.card.updatedAt, properties: { name: "x" } };

    for (const args of [
      { ...valid, extra: true },
      { proposalId: valid.proposalId, properties: valid.properties },
      { ...valid, ifVersion: "" },
      { ...valid, ifVersion: 7 },
      { ...valid, proposalId: "not-a-uuid" },
      { ...valid, entityKind: "unknown" },
      { ...valid, target: "" },
      { ...valid, message: "" },
      { ...valid, message: "x".repeat(2001) },
      { proposalId: fixture.cardId },
      { ...valid, properties: ["not", "an", "object"] },
      { ...valid, threadId: fixture.threadId },
      null,
    ]) {
      expect(await callRaw(fixture, args)).toEqual({ error: true, result: "Invalid arguments" });
    }
    expect(inboxProposalReviseArgsSchema.safeParse(valid).success).toBe(true);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it.each([
    ["properties", { properties: { name: "bad\u0000value" } }],
    ["properties", { properties: { "bad\u0000key": "x" } }],
    ["properties", { properties: { name: ["nested", { deeper: "bad\u0000" }] } }],
    ["target", { target: "bad\u0000", properties: { name: "x" } }],
    ["message", { message: "bad\u0000", properties: { name: "x" } }],
  ] as const)("refuses a NUL character in %s as a validation error that names the field", async (field, change) => {
    const fixture = await createCardThread(owner);
    const before = await snapshot(fixture);

    const result = await call(fixture, { proposalId: fixture.cardId, ...change });

    expect(result.error).toBe(true);
    expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({ status: 400, field });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("publishes the card's invalidation once, after the revision commits, and none for a refusal", async () => {
    const fixture = await createCardThread(owner);
    await call(fixture, { proposalId: fixture.cardId, properties: { notAKey: "x" } });
    expect(events).toEqual([]);

    const result = await call(fixture, { proposalId: fixture.cardId, properties: { name: "Buy oat milk" } });

    expect(result.error).toBe(false);
    expect(events).toEqual([{ op: "updated", cardId: fixture.cardId }]);
  });

  it("is a registered module tool of the Inbox, run without approval, whose strict schema and own-card rule hold through the registry", async () => {
    const fixture = await createCardThread(owner);
    const other = await createCardThread(owner);
    const registry = await loadFullModuleRegistry();

    await runInTenant(owner, async () => {
      const tools = await resolveModuleAgentToolsForRun(runtime, registry, fixture.runId, fixture.projectId);
      const revise = tools.find((entry) => entry.name === "inbox.proposal.revise");
      if (!revise) throw new Error("inbox.proposal.revise is missing from the registry");
      expect(revise.requiresApproval).toBe(false);
      expect(revise.riskClass).toBe("write");
      expect(revise.argumentSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(revise.acceptsArguments({ proposalId: fixture.cardId, properties: {}, extra: true })).toBe(false);

      const refused = await revise.invoke({
        proposalId: other.cardId,
        ifVersion: (await readCard(other)).updatedAt,
        properties: { name: "x" },
      });
      expect(refused).toEqual(NOT_FOUND);
      const revised = await revise.invoke({
        proposalId: fixture.cardId,
        ifVersion: (await readCard(fixture)).updatedAt,
        properties: { name: "Through the registry" },
      });
      expect(revised.error).toBe(false);
    });
    const after = storedCardSchema.parse((await readCard(fixture)).properties);
    expect(after.proposal.properties).toEqual({ name: "Through the registry" });
  });

  it("waits for a removal of the card's source link that is still open, and then refuses the card", async () => {
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
        removed();
        await released;
      }),
    );
    await removalDone;

    const attempt = call(fixture, { proposalId: fixture.cardId, properties: { name: "Late" } });
    // The call is blocked on a lock in the statement that reads the edge, which only its FOR SHARE clause can wait on.
    // `pg_stat_activity.query` is cut at 1024 bytes, so the statement is recognized by its first words.
    const deadline = Date.now() + 10_000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const activity = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT source.id AS source_id, card.id AS card_id%' AND pid <> pg_backend_pid()
         ) AS waiting`,
      );
      waiting = activity.rows[0]?.waiting === true;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await removal;

    expect(waiting).toBe(true);
    expect(await attempt).toEqual(NOT_FOUND);
    expect(await snapshot(fixture)).toEqual(before);
  });
});
