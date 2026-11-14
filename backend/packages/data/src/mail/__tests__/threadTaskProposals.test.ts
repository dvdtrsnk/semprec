// Issue gh-2035: `mail.thread.proposeTask` writes one Processing proposals card of kind `mailThread` and its `sourceThread`
// edge, never a task. The tool is driven as a session drives it (`resolveModuleAgentToolsForRun`) and, where the session
// would refuse the arguments before the handler runs, through its factory. Every read and write runs on the runtime role
// pool inside a tenant, so row-level security applies.
import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../../agentTools/moduleAgentTools.js";
import { createUser } from "../../auth/usersStore.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
} from "../../inbox/proposalActions.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createMailThread, reassignThread, upsertMailMessageMeta } from "../mailMessageMetaStore.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS } from "../ingest.js";
import { createMailThreadProposeTaskTool, type MailAgentTool } from "../mailAgentTools.js";

const TOOL = "mail.thread.proposeTask";

const answerSchema = z.object({ proposalId: z.uuid(), status: z.string() });
const refusalSchema = z.looseObject({ status: z.number(), error: z.string(), field: z.string().optional() });
const cardSchema = z.looseObject({
  kind: z.string(),
  status: z.string(),
  proposal: z.looseObject({
    entityKind: z.string(),
    target: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  aiProposal: z.looseObject({
    entityKind: z.string(),
    target: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  aiVersion: z.number(),
  history: z.array(z.looseObject({ author: z.string(), message: z.string() })),
});

interface ToolResult {
  error: boolean;
  result: string;
}

interface Thread {
  threadId: string;
  itemId: string;
}

interface MailTenant {
  tenantId: string;
  userId: string;
  mailProjectId: string;
  proposalsDatabaseId: string;
  tasksDatabaseId: string;
  threadsDatabaseId: string;
}

let admin: Pool;
let runtime: Pool;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let tenant: MailTenant;
let other: MailTenant;
let cardEvents: InboxCardsInvalidationEvent[];

function inTenant<T>(t: MailTenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, fn);
}

async function seededTenant(): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<{ owner_module_id: string; id: string; owner_project_item_id: string | null }>(
      "SELECT owner_module_id, id, owner_project_item_id FROM databases WHERE owner_module_id IS NOT NULL",
    );
    const database = (moduleId: string) => {
      const found = rows.find((row) => row.owner_module_id === moduleId);
      if (!found) throw new Error(`Missing ${moduleId}`);
      return found;
    };
    const mailProjectId = database("mailboxes").owner_project_item_id;
    if (!mailProjectId) throw new Error("The mail databases have no owner project");
    return {
      tenantId,
      userId: user.id,
      mailProjectId,
      proposalsDatabaseId: database("processingProposals").id,
      tasksDatabaseId: database("tasks").id,
      threadsDatabaseId: database("threads").id,
    };
  });
}

/** A mail thread and its Threads item, through the production thread writer. */
async function newThread(t: MailTenant, subject?: string): Promise<Thread> {
  return inTenant(t, () =>
    withTransaction(runtime, async (client) => {
      const thread = await createMailThread(client, subject);
      const { rows } = await client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
        thread.id,
      ]);
      if (!rows[0]) throw new Error("Missing thread item");
      return { threadId: thread.id, itemId: rows[0].item_id };
    }),
  );
}

async function runOf(t: MailTenant, projectItemId: string | null = t.mailProjectId): Promise<string> {
  return inTenant(t, async () => {
    const run = await createAgentRun(runtime, {
      projectItemId,
      userId: t.userId,
      triggeredBy: "user",
      task: "mail",
      threadId: null,
    });
    return run.id;
  });
}

async function toolFor(t: MailTenant, runId: string): Promise<ResolvedModuleAgentTool> {
  const tools = await inTenant(t, () => resolveModuleAgentToolsForRun(runtime, registry, runId, t.mailProjectId));
  const tool = tools.find((candidate) => candidate.name === TOOL);
  if (!tool) throw new Error(`The run has no tool ${TOOL}`);
  return tool;
}

/** Calls the tool as a session does: the arguments are parsed against its schema before the handler runs. */
async function propose(t: MailTenant, runId: string, args: unknown): Promise<ToolResult> {
  const tool = await toolFor(t, runId);
  const { result, error } = await inTenant(t, () => tool.invoke(args));
  return { error, result };
}

function answerOf(result: ToolResult) {
  expect(result.error, result.result).toBe(false);
  return answerSchema.parse(JSON.parse(result.result));
}

function refusalOf(result: ToolResult) {
  expect(result.error).toBe(true);
  return refusalSchema.parse(JSON.parse(result.result));
}

/** What the tenant holds that a proposal could add to, as counts the runtime role reads under its own scope. */
async function writtenState(t: MailTenant) {
  return inTenant(t, async () => {
    const count = async (sql: string, params: unknown[] = []) =>
      (await runtime.query<{ n: number }>(sql, params)).rows[0]?.n;
    return {
      cards: await count("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [t.proposalsDatabaseId]),
      tasks: await count("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [t.tasksDatabaseId]),
      edges: await count("SELECT count(*)::int AS n FROM item_relations WHERE tenant_id = app_tenant_default()"),
    };
  });
}

async function cardOf(t: MailTenant, cardId: string) {
  const { rows } = await inTenant(t, () =>
    runtime.query<{ properties: unknown }>("SELECT properties FROM items WHERE id = $1", [cardId]),
  );
  return cardSchema.parse(rows[0]?.properties);
}

/** The ids at the other end of the card's `sourceThread` edge. */
async function sourceThreadsOf(t: MailTenant, cardId: string): Promise<string[]> {
  const { rows } = await inTenant(t, () =>
    runtime.query<{ other: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
         FROM item_relations r
         JOIN relation_definitions d ON d.id = r.relation_definition_id AND d.tenant_id = r.tenant_id
         JOIN properties p ON p.id = d.property_id_a AND p.tenant_id = d.tenant_id
        WHERE p.key = 'sourceThread' AND (r.item_a = $1 OR r.item_b = $1)`,
      [cardId],
    ),
  );
  return rows.map((row) => row.other);
}

/** The cards of the tenant that came from a thread's item, whatever their status. */
async function cardIdsOfThread(t: MailTenant, threadItemId: string): Promise<string[]> {
  const { rows } = await inTenant(t, () =>
    runtime.query<{ card: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS card
         FROM item_relations r
         JOIN relation_definitions d ON d.id = r.relation_definition_id AND d.tenant_id = r.tenant_id
         JOIN properties p ON p.id = d.property_id_a AND p.tenant_id = d.tenant_id
        WHERE p.key = 'sourceThread' AND (r.item_a = $1 OR r.item_b = $1)
        ORDER BY 1`,
      [threadItemId],
    ),
  );
  return rows.map((row) => row.card);
}

describe("mail.thread.proposeTask (issue gh-2035)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    other = await seededTenant();
    cardEvents = [];
    setInboxCardsInvalidationHook((event) => cardEvents.push(event));
  });

  afterEach(() => {
    setInboxCardsInvalidationHook(() => {});
  });

  it("creates one proposed mailThread card with the task's name and a sourceThread edge, and no task", async () => {
    const thread = await newThread(tenant, "Invoice 2026-11");
    const runId = await runOf(tenant);

    const answer = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Pay the invoice" }));

    expect(answer.status).toBe("proposed");
    const card = await cardOf(tenant, answer.proposalId);
    expect(card).toMatchObject({
      kind: "mailThread",
      status: "proposed",
      proposal: { entityKind: "database", target: tenant.tasksDatabaseId, properties: { name: "Pay the invoice" } },
      aiProposal: { entityKind: "database", target: tenant.tasksDatabaseId, properties: { name: "Pay the invoice" } },
      aiVersion: 1,
    });
    expect(Object.keys(card.proposal.properties)).toEqual(["name"]);
    expect(card.history).toHaveLength(1);
    expect(card.history[0]).toMatchObject({ author: "ai" });
    expect(card.history[0]?.message).toContain("Invoice 2026-11");
    expect(await sourceThreadsOf(tenant, answer.proposalId)).toEqual([thread.itemId]);
    // One card and one edge: the proposal wrote no task and no Threads.tasks edge.
    expect(await writtenState(tenant)).toEqual({ cards: 1, tasks: 0, edges: 1 });
    expect(cardEvents).toEqual([{ op: "created", cardId: answer.proposalId }]);
  });

  it("states no subject in the history of a thread that has none", async () => {
    const thread = await newThread(tenant);
    const runId = await runOf(tenant);

    const answer = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Call back" }));

    const message = (await cardOf(tenant, answer.proposalId)).history[0]?.message;
    expect(message).toBe('Proposed the task "Call back" from a mail thread.');
  });

  it("states no subject in the history of a thread whose latest message has a blank subject", async () => {
    const thread = await newThread(tenant, "Hint that a live message overrides");
    await inTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const {
          rows: [emails],
        } = await client.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'emails'");
        if (!emails) throw new Error("Missing Emails database");
        const email = await createItemWithClient(
          client,
          { databaseId: emails.id, properties: { name: "   " } },
          { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
        );
        await upsertMailMessageMeta(client, {
          itemId: email.id,
          mailboxItemId: null,
          messageId: `<${randomUUID()}@example.test>`,
          threadId: thread.threadId,
          envelope: {},
        });
      }),
    );
    const runId = await runOf(tenant);

    const answer = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Call back" }));

    const message = (await cardOf(tenant, answer.proposalId)).history[0]?.message;
    expect(message).toBe('Proposed the task "Call back" from a mail thread.');
  });

  it("stores the name trimmed and accepts one of exactly 500 characters", async () => {
    const thread = await newThread(tenant, "Long");
    const runId = await runOf(tenant);
    const name = "x".repeat(500);

    const answer = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: `  ${name}\n` }));

    expect((await cardOf(tenant, answer.proposalId)).proposal.properties.name).toBe(name);
  });

  it("returns the existing card for the same name, trimmed and case folded, and creates no second one", async () => {
    const thread = await newThread(tenant, "Offer");
    const runId = await runOf(tenant);
    const first = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));
    cardEvents = [];

    const second = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "  SEND THE offer " }));

    expect(second).toEqual(first);
    expect(await cardIdsOfThread(tenant, thread.itemId)).toEqual([first.proposalId]);
    expect(await writtenState(tenant)).toEqual({ cards: 1, tasks: 0, edges: 1 });
    expect(cardEvents).toEqual([]);
  });

  it("creates a second card for a different name of the same thread", async () => {
    const thread = await newThread(tenant, "Offer");
    const runId = await runOf(tenant);
    const first = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));

    const second = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Call the buyer" }));

    expect(second.proposalId).not.toBe(first.proposalId);
    expect(await cardIdsOfThread(tenant, thread.itemId)).toEqual([first.proposalId, second.proposalId].sort());
    expect(await writtenState(tenant)).toEqual({ cards: 2, tasks: 0, edges: 2 });
  });

  it("creates a card of the same name for another thread", async () => {
    const first = await newThread(tenant, "One");
    const second = await newThread(tenant, "Two");
    const runId = await runOf(tenant);
    const a = answerOf(await propose(tenant, runId, { threadId: first.threadId, name: "Reply" }));

    const b = answerOf(await propose(tenant, runId, { threadId: second.threadId, name: "Reply" }));

    expect(b.proposalId).not.toBe(a.proposalId);
    expect(await sourceThreadsOf(tenant, a.proposalId)).toEqual([first.itemId]);
    expect(await sourceThreadsOf(tenant, b.proposalId)).toEqual([second.itemId]);
  });

  describe("a card that is no longer open proposed is not a duplicate", () => {
    const config = () => ({ processingProposalsDatabaseId: tenant.proposalsDatabaseId });

    it("when the user rejected it", async () => {
      const thread = await newThread(tenant, "Offer");
      const runId = await runOf(tenant);
      const first = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));
      await inTenant(tenant, () =>
        withTransaction(runtime, (client) => rejectProposalWithClient(client, config(), first.proposalId)),
      );

      const second = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));

      expect(second.proposalId).not.toBe(first.proposalId);
      expect((await cardOf(tenant, second.proposalId)).status).toBe("proposed");
    });

    it("when the user confirmed it, and the confirm created the task of the thread", async () => {
      const thread = await newThread(tenant, "Offer");
      const runId = await runOf(tenant);
      const first = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));
      await inTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          confirmProposalWithClient(client, config(), first.proposalId, undefined, tenant.userId),
        ),
      );
      expect((await writtenState(tenant)).tasks).toBe(1);

      const second = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));

      expect(second.proposalId).not.toBe(first.proposalId);
      expect((await cardOf(tenant, first.proposalId)).status).toBe("confirmed");
    });

    it("when it is in the Trash", async () => {
      const thread = await newThread(tenant, "Offer");
      const runId = await runOf(tenant);
      const first = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));
      await inTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          itemDeleteWithClient(client, tenant.proposalsDatabaseId, first.proposalId, {
            queueAffinity: createActionQueueAffinity(),
          }),
        ),
      );

      const second = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));

      expect(second.proposalId).not.toBe(first.proposalId);
    });
  });

  it("compares the name the card holds now: a card the user renamed is not a duplicate of the old name", async () => {
    const thread = await newThread(tenant, "Offer");
    const runId = await runOf(tenant);
    const first = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));
    await inTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        reviseProposalWithClient(
          client,
          { processingProposalsDatabaseId: tenant.proposalsDatabaseId },
          first.proposalId,
          {
            message: "Rename",
            entityKind: "database",
            target: tenant.tasksDatabaseId,
            properties: { name: "Send the new offer" },
          },
          tenant.userId,
        ),
      ),
    );

    const renamed = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "send the new offer" }));
    const original = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Send the offer" }));

    expect(renamed.proposalId).toBe(first.proposalId);
    expect(original.proposalId).not.toBe(first.proposalId);
  });

  it("links the card of a merged-away thread id to the thread that absorbed it, and finds that thread's card by either id", async () => {
    const loser = await newThread(tenant, "Old");
    const winner = await newThread(tenant, "New");
    await inTenant(tenant, () =>
      withTransaction(runtime, (client) => reassignThread(client, loser.threadId, winner.threadId)),
    );
    const runId = await runOf(tenant);

    const viaLoser = answerOf(await propose(tenant, runId, { threadId: loser.threadId, name: "Follow up" }));
    const viaWinner = answerOf(await propose(tenant, runId, { threadId: winner.threadId, name: "Follow up" }));

    expect(await sourceThreadsOf(tenant, viaLoser.proposalId)).toEqual([winner.itemId]);
    expect(viaWinner).toEqual(viaLoser);
    expect(await writtenState(tenant)).toEqual({ cards: 1, tasks: 0, edges: 1 });
  });

  it("answers the same 404 for an unknown thread and another tenant's thread, and writes nothing in either tenant", async () => {
    const foreign = await newThread(other, "Not yours");
    const runId = await runOf(tenant);
    const beforeOwn = await writtenState(tenant);
    const beforeForeign = await writtenState(other);

    const unknown = refusalOf(await propose(tenant, runId, { threadId: randomUUID(), name: "Task" }));
    const foreignAnswer = refusalOf(await propose(tenant, runId, { threadId: foreign.threadId, name: "Task" }));
    // The Threads item id is not a thread id either.
    const itemId = refusalOf(await propose(tenant, runId, { threadId: foreign.itemId, name: "Task" }));

    expect(unknown).toMatchObject({ status: 404 });
    expect(foreignAnswer).toEqual(unknown);
    expect(itemId).toEqual(unknown);
    expect(await writtenState(tenant)).toEqual(beforeOwn);
    expect(await writtenState(other)).toEqual(beforeForeign);
  });

  it("keeps the cards of two tenants apart: each tenant's thread gets its own card and neither sees the other's", async () => {
    const own = await newThread(tenant, "Mine");
    const foreign = await newThread(other, "Theirs");

    const a = answerOf(await propose(tenant, await runOf(tenant), { threadId: own.threadId, name: "Same name" }));
    const b = answerOf(await propose(other, await runOf(other), { threadId: foreign.threadId, name: "Same name" }));

    expect(b.proposalId).not.toBe(a.proposalId);
    expect(await sourceThreadsOf(tenant, a.proposalId)).toEqual([own.itemId]);
    expect(await sourceThreadsOf(other, b.proposalId)).toEqual([foreign.itemId]);
    expect(await writtenState(tenant)).toEqual({ cards: 1, tasks: 0, edges: 1 });
    expect(await writtenState(other)).toEqual({ cards: 1, tasks: 0, edges: 1 });
  });

  it("answers 404 for a thread whose Threads item is in the Trash and writes nothing", async () => {
    const thread = await newThread(tenant, "Gone");
    const runId = await runOf(tenant);
    await inTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        itemDeleteWithClient(client, tenant.threadsDatabaseId, thread.itemId, {
          queueAffinity: createActionQueueAffinity(),
        }),
      ),
    );
    const before = await writtenState(tenant);

    const refusal = refusalOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Task" }));

    expect(refusal).toMatchObject({ status: 404 });
    expect(await writtenState(tenant)).toEqual(before);
  });

  describe("refuses arguments that are not valid and writes nothing", () => {
    let propose: MailAgentTool;

    beforeEach(() => {
      propose = createMailThreadProposeTaskTool(runtime);
    });

    const invalid: Array<[string, (threadId: string) => unknown, string | undefined]> = [
      ["an empty name", (threadId) => ({ threadId, name: "" }), "name"],
      ["a name of blanks only", (threadId) => ({ threadId, name: " \t\n " }), "name"],
      ["a name of 501 characters", (threadId) => ({ threadId, name: "x".repeat(501) }), "name"],
      ["a name that holds U+0000", (threadId) => ({ threadId, name: "a\u0000b" }), "name"],
      ["a name that holds an unpaired surrogate", (threadId) => ({ threadId, name: "a\ud800b" }), "name"],
      ["a name that is not text", (threadId) => ({ threadId, name: 7 }), "name"],
      ["no name", (threadId) => ({ threadId }), "name"],
      ["a thread id that is not a uuid", () => ({ threadId: "not-a-uuid", name: "Task" }), "threadId"],
      [
        "a due date, which the tool does not take",
        (threadId) => ({ threadId, name: "Task", date: "2026-12-01" }),
        undefined,
      ],
      ["arguments that are not an object", () => "Task", undefined],
    ];

    it.each(invalid)("%s", async (_label, makeArgs, field) => {
      const thread = await newThread(tenant, "Offer");
      const runId = await runOf(tenant);
      const before = await writtenState(tenant);

      const result = await inTenant(tenant, () => propose(runId, makeArgs(thread.threadId)));

      expect(result.error).toBe(true);
      expect(refusalSchema.parse(JSON.parse(result.result))).toMatchObject({
        status: 400,
        error: "validation_failed",
        ...(field === undefined ? {} : { field }),
      });
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("and the session refuses the same arguments before the handler runs", async () => {
      const thread = await newThread(tenant, "Offer");
      const runId = await runOf(tenant);
      const tool = await toolFor(tenant, runId);

      expect(tool.acceptsArguments({ threadId: thread.threadId, name: "Task" })).toBe(true);
      expect(tool.acceptsArguments({ threadId: thread.threadId, name: "" })).toBe(false);
      expect(tool.acceptsArguments({ threadId: thread.threadId, name: "x".repeat(501) })).toBe(false);
      expect(tool.acceptsArguments({ threadId: thread.threadId, name: "Task", date: "2026-12-01" })).toBe(false);
    });
  });

  it("refuses an unknown run with 404 and a run without a project with 403, and writes nothing", async () => {
    const thread = await newThread(tenant, "Offer");
    const handler = createMailThreadProposeTaskTool(runtime);
    const projectless = await runOf(tenant, null);
    const before = await writtenState(tenant);

    const unknown = await inTenant(tenant, () => handler(randomUUID(), { threadId: thread.threadId, name: "Task" }));
    const withoutProject = await inTenant(tenant, () =>
      handler(projectless, { threadId: thread.threadId, name: "Task" }),
    );

    expect(refusalSchema.parse(JSON.parse(unknown.result))).toMatchObject({ status: 404 });
    expect(refusalSchema.parse(JSON.parse(withoutProject.result))).toMatchObject({ status: 403 });
    expect(unknown.error && withoutProject.error).toBe(true);
    expect(await writtenState(tenant)).toEqual(before);
  });

  it("creates one card when two calls for the same thread and name run at once", async () => {
    const thread = await newThread(tenant, "Offer");
    const handler = createMailThreadProposeTaskTool(runtime);
    const runs = [await runOf(tenant), await runOf(tenant)];

    const results = await Promise.all(
      runs.map((runId) =>
        inTenant(tenant, () => handler(runId, { threadId: thread.threadId, name: "Send the offer" })),
      ),
    );

    const answers = results.map((result) => answerOf(result));
    expect(answers[1]).toEqual(answers[0]);
    expect(await cardIdsOfThread(tenant, thread.itemId)).toEqual([answers[0]?.proposalId]);
    expect(await writtenState(tenant)).toEqual({ cards: 1, tasks: 0, edges: 1 });
  });

  it("writes a card that the user can confirm: the confirm creates the task of the thread and the card stays unconfirmed until then", async () => {
    const thread = await newThread(tenant, "Invoice");
    const runId = await runOf(tenant);
    const answer = answerOf(await propose(tenant, runId, { threadId: thread.threadId, name: "Pay the invoice" }));
    expect((await writtenState(tenant)).tasks).toBe(0);

    await inTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        confirmProposalWithClient(
          client,
          { processingProposalsDatabaseId: tenant.proposalsDatabaseId },
          answer.proposalId,
          undefined,
          tenant.userId,
        ),
      ),
    );

    expect((await cardOf(tenant, answer.proposalId)).status).toBe("confirmed");
    const { rows } = await inTenant(tenant, () =>
      runtime.query<{ name: string }>(
        `SELECT t.properties->>'name' AS name
           FROM item_relations r
           JOIN relation_definitions d ON d.id = r.relation_definition_id AND d.tenant_id = r.tenant_id
           JOIN properties p ON p.id = d.property_id_a AND p.tenant_id = d.tenant_id AND p.key = 'tasks'
           JOIN items t ON t.id = r.item_b AND t.tenant_id = r.tenant_id
          WHERE r.item_a = $1`,
        [thread.itemId],
      ),
    );
    expect(rows).toEqual([{ name: "Pay the invoice" }]);
  });

  describe("the tool in the module registry", () => {
    it("is offered to a run of the mail project, and not to a run that lacks the capability mail.taskProposal", async () => {
      const runId = await runOf(tenant);

      const granted = await inTenant(tenant, () =>
        resolveModuleAgentToolsForRun(runtime, registry, runId, tenant.mailProjectId),
      );
      const withoutCapability = await inTenant(tenant, () =>
        resolveModuleAgentToolsForRun(runtime, registry, runId, tenant.mailProjectId, new Set(["mail.read"])),
      );

      expect(granted.map((tool) => tool.name)).toContain(TOOL);
      expect(withoutCapability.map((tool) => tool.name)).not.toContain(TOOL);
      expect(withoutCapability.map((tool) => tool.name)).toContain("mail.thread.get");
      const tool = granted.find((candidate) => candidate.name === TOOL);
      expect(tool).toMatchObject({ requiresApproval: false, riskClass: "write" });
    });
  });
});
