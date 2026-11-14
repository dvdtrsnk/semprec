import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import {
  AiGatewayFailedError,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { resolveModuleAgentToolsForRun } from "../../agentTools/moduleAgentTools.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { ValidationError } from "../../errors.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
import { createMailDraftUpdateRouteHandler } from "../../mail/mailDraftRouteHandlers.js";
import { createMailDraftCreateTool, createMailDraftUpdateTool } from "../../mail/mailAgentTools.js";
import { ensureFolderItem } from "../../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { writeMailboxAddresses } from "../../mail/mailboxAddresses.js";
import { reindexPersonEmails } from "../../mail/personEmailIndexStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTestProjectItem } from "../../testSupport/projectFixtures.js";
import { createNewEmailAgentRunDependencies } from "../../mail/newEmailAgentRun.js";
import { coreAgentRunAction, type RunAgentFn } from "../actions.js";
import { createAnswerExpectedGate } from "../answerExpectedFilter.js";

const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const STRANGER = { name: "Stranger", address: "stranger@example.test" };
const NO_USAGE = { inputTokens: 1, outputTokens: 1 };

interface MailTenant {
  tenantId: string;
  userId: string;
  mailProjectId: string;
  mailboxId: string;
  draftsFolderId: string;
  inboxId: string;
  heartbeatId: string;
  actionConfig: Record<string, unknown>;
}

interface Receive {
  subject?: string;
  bodyText?: string;
  from?: { name: string; address: string };
  references?: string[];
  bulk?: boolean;
  date?: Date;
}

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let tenant: MailTenant;
let other: MailTenant;

function inTenant<T>(t: MailTenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, fn);
}

/** A tenant with the mail module, a mailbox with Inbox and Drafts, Petr as a known person and the seeded `newEmail` heartbeat. */
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
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const folderProperties = await cp.listProperties(db("folders").id);
    const mailboxRelation = folderProperties.find((row) => row.key === "mailbox");
    if (!mailboxRelation) throw new Error("Missing the folder-mailbox relation");
    const mailProjectId = db("mailboxes").ownerProjectItemId;
    if (!mailProjectId) throw new Error("The mail databases have no owner project");
    const heartbeats = await runtime.query<{ id: string; action_config: unknown }>(
      "SELECT id, action_config FROM project_heartbeats WHERE name = 'newEmail'",
    );
    const heartbeat = heartbeats.rows[0];
    if (!heartbeat) throw new Error("The newEmail heartbeat was not seeded");
    const person = await cp.createItem({ databaseId: db("people").id, properties: { name: PETR.name } });
    return withTransaction(runtime, async (client) => {
      await reindexPersonEmails(client, person.id, [PETR.address]);
      const mailbox = await createItemWithClient(client, {
        databaseId: db("mailboxes").id,
        properties: { name: "Personal", provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes").id,
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
      });
      const folder = (specialPurpose: string) =>
        ensureFolderItem(client, {
          foldersDatabaseId: db("folders").id,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: mailboxRelation.id,
          providerId: specialPurpose.toUpperCase(),
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      return {
        tenantId,
        userId: user.id,
        mailProjectId,
        mailboxId: mailbox.id,
        draftsFolderId: await folder("drafts"),
        inboxId: await folder("inbox"),
        heartbeatId: heartbeat.id,
        actionConfig: z.record(z.string(), z.unknown()).parse(heartbeat.action_config),
      };
    });
  });
}

/** Ingests one message into the Inbox the way the sync worker does and answers the Emails item. */
async function receive(t: MailTenant, options: Receive = {}): Promise<string> {
  return inTenant(t, async () => {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    const emailProperties = await cp.listProperties(db("emails"));
    const property = (key: string) => {
      const found = emailProperties.find((row) => row.key === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    const { itemId } = await withTransaction(runtime, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: db("emails"),
        filesDatabaseId: db("files"),
        folderRelationPropertyId: property("folder"),
        attachmentsRelationPropertyId: property("attachments"),
        mailboxItemId: t.mailboxId,
        folderItemId: t.inboxId,
        messageId: `<${randomUUID()}@example.test>`,
        subject: options.subject ?? "Offer",
        date: options.date ?? new Date("2026-10-01T09:00:00Z"),
        envelope: { from: options.from ?? PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
        bodyText: options.bodyText ?? "Can you send me the offer?",
        references: options.references,
        ...(options.bulk ? { bulkHeaders: { precedence: "bulk" } } : {}),
        attachments: [],
        storage: new LocalFsBlobStorageWriter(storageRoot),
        storageKeyPrefix: "answer-expected-fixtures",
      }),
    );
    return itemId;
  });
}

interface ThreadRef {
  threadId: string;
  threadItemId: string;
  messageId: string;
}

async function threadOf(t: MailTenant, emailItemId: string): Promise<ThreadRef> {
  const { rows } = await admin.query<{ thread_id: string; item_id: string; message_id: string }>(
    `SELECT m.thread_id, t.item_id, m.message_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id
     WHERE m.tenant_id = $1 AND m.item_id = $2`,
    [t.tenantId, emailItemId],
  );
  const row = rows[0];
  if (!row) throw new Error("The message has no thread");
  return { threadId: row.thread_id, threadItemId: row.item_id, messageId: row.message_id };
}

/** A gateway that answers as `answer` says and keeps every input it was given. */
function stubGateway(answer: (input: AiGatewayCompletionInput) => Promise<AiGatewayCompletionResult>): {
  gateway: AiGatewayClientPort;
  calls: AiGatewayCompletionInput[];
} {
  const calls: AiGatewayCompletionInput[] = [];
  return {
    calls,
    gateway: {
      complete: async (input) => {
        calls.push(input);
        return answer(input);
      },
    },
  };
}

const expectsReply = (value: boolean) => async (): Promise<AiGatewayCompletionResult> => ({
  content: { expectsReply: value },
  usage: NO_USAGE,
});

interface AgentCall {
  task: string;
  projectItemId: string;
}

const draftViewSchema = z.looseObject({ id: z.uuid(), updatedAt: z.string() });

/**
 * The agent of the tests: what a model that follows the task does. A task that names an open draft updates it with
 * `mail.draft.update`, a task that asks for a reply draft creates it with `mail.draft.create`, through the tool handlers.
 */
function draftingAgent(calls: AgentCall[], drafts: z.infer<typeof draftViewSchema>[] = []): RunAgentFn {
  return async ({ agentRunId, task, projectItemId }) => {
    calls.push({ task, projectItemId });
    const update = /mail\.draft\.update \(draftId ([0-9a-f-]{36})\)/.exec(task);
    const create = /mail\.draft\.create \(mode reply, threadId ([0-9a-f-]{36})\)/.exec(task);
    const answer =
      update?.[1] !== undefined
        ? await createMailDraftUpdateTool(runtime)(agentRunId, {
            draftId: update[1],
            body: `Updated answer ${calls.length}`,
          })
        : create?.[1] !== undefined
          ? await createMailDraftCreateTool(runtime)(agentRunId, {
              mode: "reply",
              threadId: create[1],
              body: `Answer ${calls.length}`,
            })
          : { error: true, result: "The task names no draft action" };
    if (answer.error) throw new Error(answer.result);
    drafts.push(draftViewSchema.parse(JSON.parse(answer.result)));
    return { result: "drafted" };
  };
}

/** Fires the seeded `newEmail` heartbeat for `itemId` as the scheduler does for an item event. */
function fire(t: MailTenant, itemId: string, gateway: AiGatewayClientPort | undefined, runAgent: RunAgentFn) {
  const action = coreAgentRunAction(runtime, runAgent, createNewEmailAgentRunDependencies(runtime, gateway));
  return inTenant(t, () =>
    action(t.actionConfig, { heartbeatId: t.heartbeatId, projectItemId: t.mailProjectId, itemId }),
  );
}

interface RunRow {
  id: string;
  project_item_id: string;
  task: string;
  status: string;
}

async function runsOf(t: MailTenant): Promise<RunRow[]> {
  const { rows } = await admin.query<RunRow>(
    "SELECT id, project_item_id, task, status FROM agent_runs WHERE tenant_id = $1 ORDER BY started_at, id",
    [t.tenantId],
  );
  return rows;
}

async function errorNotificationsOf(t: MailTenant): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND kind = 'agent_run_error'",
    [t.tenantId],
  );
  return rows[0]?.n ?? 0;
}

interface DraftRow {
  email_item_id: string;
  thread_id: string;
  mode: string;
  created_by: string;
  last_edited_by: string;
  in_reply_to: string | null;
  source_email_item_id: string | null;
}

async function draftsOf(t: MailTenant): Promise<DraftRow[]> {
  const { rows } = await admin.query<DraftRow>(
    `SELECT email_item_id, thread_id, mode, created_by, last_edited_by, in_reply_to, source_email_item_id
     FROM mail_drafts WHERE tenant_id = $1 ORDER BY created_at`,
    [t.tenantId],
  );
  return rows;
}

/** The person edits the draft in the compose window: the draft route with the version the person read. */
async function userEdits(t: MailTenant, draft: z.infer<typeof draftViewSchema>): Promise<void> {
  const result = await inTenant(t, () =>
    createMailDraftUpdateRouteHandler(runtime)({
      params: { id: draft.id },
      body: { ifVersion: draft.updatedAt, body: "Edited by the user" },
      identity: { user: { id: t.userId } },
    }),
  );
  expect(result.status).toBe(200);
}

/** Sets the thread's project through the choke point relation write, as a person does in the thread's detail. */
async function setThreadProject(t: MailTenant, thread: ThreadRef, projectItemId: string): Promise<void> {
  await inTenant(t, async () => {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const threads = databases.find((row) => row.ownerModuleId === "threads");
    if (!threads) throw new Error("Missing the Threads database");
    const project = (await cp.listProperties(threads.id)).find((row) => row.key === "project");
    if (!project) throw new Error("Missing Threads.project");
    await cp.createRelation({
      relationPropertyId: project.id,
      callerItemId: thread.threadItemId,
      targetItemId: projectItemId,
    });
  });
}

describe("the answer-expected gate and the run project of core.agentRun (issue gh-1941)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-answer-expected-"));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    other = await seededTenant();
  });

  it("seeds the newEmail heartbeat with the sender gate, the answer-expected gate and the thread project resolver", () => {
    expect(tenant.actionConfig).toMatchObject({
      senderKnownFilter: {},
      answerExpectedFilter: {},
      runProject: { resolver: "mailThreadProject" },
    });
  });

  describe("a message that expects an answer", () => {
    it("creates exactly one draft in its thread, a reply with In-Reply-To made by the agent, in the Email project of a thread without a project", async () => {
      const itemId = await receive(tenant);
      const thread = await threadOf(tenant, itemId);
      const { gateway, calls } = stubGateway(expectsReply(true));
      const agentCalls: AgentCall[] = [];

      await fire(tenant, itemId, gateway, draftingAgent(agentCalls));

      const drafts = await draftsOf(tenant);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        thread_id: thread.threadId,
        mode: "reply",
        created_by: "agent",
        last_edited_by: "agent",
        in_reply_to: thread.messageId,
        source_email_item_id: itemId,
      });
      const runs = await runsOf(tenant);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ project_item_id: tenant.mailProjectId, status: "done" });
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.projectItemId).toBe(tenant.mailProjectId);
      expect(agentCalls[0]?.task).toContain(`Triggering item id: ${itemId}`);
      expect(calls).toHaveLength(1);
    });

    it("asks the gateway under its own feature key with no project, a schema and the newest messages cut to a fixed size", async () => {
      const subject = "Question about the offer";
      let previous: string | undefined;
      let last = "";
      for (let index = 1; index <= 7; index += 1) {
        last = await receive(tenant, {
          subject,
          bodyText: `Message ${index}. ${"x".repeat(3000)}`,
          references: previous === undefined ? undefined : [previous],
          date: new Date(`2026-10-0${index}T09:00:00Z`),
        });
        previous = (await threadOf(tenant, last)).messageId;
      }
      const { gateway, calls } = stubGateway(expectsReply(true));

      await fire(tenant, last, gateway, draftingAgent([]));

      expect(calls).toHaveLength(1);
      const input = calls[0];
      expect(input).toMatchObject({ projectItemId: null, operation: "mailAnswerExpected", temperature: 0 });
      expect(input?.responseSchema).toMatchObject({ required: ["expectsReply"], additionalProperties: false });
      const content = input?.messages[0]?.content;
      if (typeof content !== "string") throw new Error("The conversation is not text");
      expect(content).toContain(`Subject: ${subject}`);
      expect(content).toContain(`Petr Novák <${PETR.address}>`);
      // The five newest messages, each cut to 1500 characters: message 2 and older are left out.
      for (const index of [3, 4, 5, 6, 7]) expect(content).toContain(`Message ${index}.`);
      for (const index of [1, 2]) expect(content).not.toContain(`Message ${index}.`);
      expect(content.length).toBeLessThan(5 * 1500 + 600);
    });

    it("updates the open draft of the thread for a second message, the task naming it, while the user has not edited it", async () => {
      const first = await receive(tenant, { subject: "Offer" });
      const firstRef = await threadOf(tenant, first);
      const drafts: z.infer<typeof draftViewSchema>[] = [];
      const agentCalls: AgentCall[] = [];
      const { gateway } = stubGateway(expectsReply(true));
      await fire(tenant, first, gateway, draftingAgent(agentCalls, drafts));
      const second = await receive(tenant, {
        subject: "Re: Offer",
        bodyText: "And what about the price?",
        references: [firstRef.messageId],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      expect((await threadOf(tenant, second)).threadId).toBe(firstRef.threadId);

      await fire(tenant, second, gateway, draftingAgent(agentCalls, drafts));

      const rows = await draftsOf(tenant);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ created_by: "agent", last_edited_by: "agent", source_email_item_id: first });
      expect(agentCalls[1]?.task).toContain(`mail.draft.update (draftId ${drafts[0]?.id})`);
      expect(agentCalls[1]?.task).toContain("do not create another draft");
      expect(drafts[1]?.id).toBe(drafts[0]?.id);
      expect(await runsOf(tenant)).toHaveLength(2);
    });

    it("starts the run in the project of the thread when the thread has one", async () => {
      const itemId = await receive(tenant);
      const thread = await threadOf(tenant, itemId);
      const projectId = await inTenant(tenant, () => createTestProjectItem(runtime));
      await setThreadProject(tenant, thread, projectId);
      const { gateway } = stubGateway(expectsReply(true));
      const agentCalls: AgentCall[] = [];

      await fire(tenant, itemId, gateway, draftingAgent(agentCalls));

      expect((await runsOf(tenant)).map((run) => run.project_item_id)).toEqual([projectId]);
      expect(agentCalls.map((call) => call.projectItemId)).toEqual([projectId]);
    });

    it("offers the run of a thread in an ordinary project no mail tool, while the run of the Email project has all five (the limit of issue gh-1941)", async () => {
      const itemId = await receive(tenant);
      const thread = await threadOf(tenant, itemId);
      const projectId = await inTenant(tenant, () => createTestProjectItem(runtime));
      await setThreadProject(tenant, thread, projectId);
      const registry = await loadFullModuleRegistry();
      const { gateway } = stubGateway(expectsReply(true));
      await fire(tenant, itemId, gateway, draftingAgent([]));
      const [projectRun] = await runsOf(tenant);
      const mailNames = async (runId: string, project: string) =>
        (await inTenant(tenant, () => resolveModuleAgentToolsForRun(runtime, registry, runId, project)))
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("mail."))
          .sort();
      const emailRun = await inTenant(tenant, () =>
        createAgentRun(runtime, {
          projectItemId: tenant.mailProjectId,
          userId: tenant.userId,
          triggeredBy: "heartbeat",
          task: "mail",
        }),
      );

      expect(projectRun?.project_item_id).toBe(projectId);
      // The run belongs to the thread's project, and a tool is offered by the project that owns the mail databases.
      expect(await mailNames(projectRun?.id ?? "", projectId)).toEqual([]);
      expect(await mailNames(emailRun.id, tenant.mailProjectId)).toEqual([
        "mail.draft.create",
        "mail.draft.send",
        "mail.draft.update",
        "mail.thread.get",
        "mail.thread.proposeTask",
      ]);
    });

    it("runs the retry of a failed run in the project of that run, not in the heartbeat's", async () => {
      const itemId = await receive(tenant);
      const thread = await threadOf(tenant, itemId);
      const projectId = await inTenant(tenant, () => createTestProjectItem(runtime));
      await setThreadProject(tenant, thread, projectId);
      const { gateway } = stubGateway(expectsReply(true));
      await expect(
        fire(tenant, itemId, gateway, () => Promise.reject(new Error("the session failed"))),
      ).rejects.toThrow("the session failed");
      const [failed] = await runsOf(tenant);
      if (!failed) throw new Error("No run was started");
      expect(failed).toMatchObject({ project_item_id: projectId, status: "error" });
      const agentCalls: AgentCall[] = [];

      await inTenant(tenant, () =>
        coreAgentRunAction(runtime, async ({ task, projectItemId }) => {
          agentCalls.push({ task, projectItemId });
        })(tenant.actionConfig, {
          heartbeatId: tenant.heartbeatId,
          projectItemId: tenant.mailProjectId,
          retryOfRunId: failed.id,
        }),
      );

      expect(agentCalls.map((call) => call.projectItemId)).toEqual([projectId]);
      expect((await runsOf(tenant)).map((run) => run.project_item_id)).toEqual([projectId, projectId]);
    });

    it("starts the run in the Email project when the project of the thread is in the Trash", async () => {
      const itemId = await receive(tenant);
      const thread = await threadOf(tenant, itemId);
      const projectId = await inTenant(tenant, () => createTestProjectItem(runtime));
      await setThreadProject(tenant, thread, projectId);
      await inTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const projects = (await cp.listDatabases()).find((row) => row.ownerModuleId === "projects");
        if (!projects) throw new Error("Missing the Projects database");
        await cp.softDeleteItem(projects.id, projectId);
      });
      const { gateway } = stubGateway(expectsReply(true));

      await fire(tenant, itemId, gateway, draftingAgent([]));

      expect((await runsOf(tenant)).map((run) => run.project_item_id)).toEqual([tenant.mailProjectId]);
    });
  });

  describe("a message that gets no draft", () => {
    it("starts no run and writes no error when the gateway says no answer is expected", async () => {
      const itemId = await receive(tenant, { bodyText: "Thanks, that is all." });
      const { gateway, calls } = stubGateway(expectsReply(false));
      const agentCalls: AgentCall[] = [];

      await fire(tenant, itemId, gateway, draftingAgent(agentCalls));

      expect(calls).toHaveLength(1);
      expect(agentCalls).toEqual([]);
      expect(await runsOf(tenant)).toEqual([]);
      expect(await errorNotificationsOf(tenant)).toBe(0);
      expect(await draftsOf(tenant)).toEqual([]);
    });

    it("starts no run and writes no error when the tenant's AI budget is used up", async () => {
      const itemId = await receive(tenant);
      const { gateway, calls } = stubGateway(() => Promise.reject(new AiGatewayFailedError("budget_exceeded")));

      await fire(tenant, itemId, gateway, draftingAgent([]));

      expect(calls).toHaveLength(1);
      expect(await runsOf(tenant)).toEqual([]);
      expect(await errorNotificationsOf(tenant)).toBe(0);
      expect(await draftsOf(tenant)).toEqual([]);
    });

    it.each([
      ["an answer that does not fit the schema", async () => ({ content: { expectsReply: "yes" }, usage: NO_USAGE })],
      ["an answer with a further key", async () => ({ content: { expectsReply: true, why: "x" }, usage: NO_USAGE })],
      ["no object at all", async () => ({ content: null, usage: NO_USAGE })],
      ["the gateway's own invalid_response", () => Promise.reject(new AiGatewayFailedError("invalid_response"))],
    ])("starts no run and writes no error for %s", async (_name, answer) => {
      const itemId = await receive(tenant);
      const { gateway, calls } = stubGateway(answer);

      await fire(tenant, itemId, gateway, draftingAgent([]));

      expect(calls).toHaveLength(1);
      expect(await runsOf(tenant)).toEqual([]);
      expect(await errorNotificationsOf(tenant)).toBe(0);
    });

    it("lets any other gateway failure propagate to the queue and starts no run", async () => {
      const itemId = await receive(tenant);
      const { gateway } = stubGateway(() => Promise.reject(new AiGatewayFailedError("timeout")));

      await expect(fire(tenant, itemId, gateway, draftingAgent([]))).rejects.toMatchObject({ reason: "timeout" });

      expect(await runsOf(tenant)).toEqual([]);
      expect(await errorNotificationsOf(tenant)).toBe(0);
    });

    it("never asks the gateway for a newsletter or for a message from an unknown address", async () => {
      const newsletter = await receive(tenant, { bulk: true, subject: "Weekly news" });
      const unknown = await receive(tenant, { from: STRANGER, subject: "Hello" });
      const { gateway, calls } = stubGateway(expectsReply(true));

      await fire(tenant, newsletter, gateway, draftingAgent([]));
      await fire(tenant, unknown, gateway, draftingAgent([]));

      expect(calls).toEqual([]);
      expect(await runsOf(tenant)).toEqual([]);
      expect(await errorNotificationsOf(tenant)).toBe(0);
    });

    it("starts no run for a message that is no longer the newest incoming message of its thread, and does not ask the gateway", async () => {
      const first = await receive(tenant, { subject: "Offer" });
      const firstRef = await threadOf(tenant, first);
      const second = await receive(tenant, {
        subject: "Re: Offer",
        references: [firstRef.messageId],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      const { gateway, calls } = stubGateway(expectsReply(true));
      const agentCalls: AgentCall[] = [];

      await fire(tenant, first, gateway, draftingAgent(agentCalls));

      expect(calls).toEqual([]);
      expect(agentCalls).toEqual([]);
      expect(await runsOf(tenant)).toEqual([]);

      await fire(tenant, second, gateway, draftingAgent(agentCalls));

      expect(calls).toHaveLength(1);
      expect(await runsOf(tenant)).toHaveLength(1);
      expect(await draftsOf(tenant)).toHaveLength(1);
    });

    it("starts no second run for a message the thread already holds a draft for, and does not ask the gateway", async () => {
      const itemId = await receive(tenant);
      const { gateway, calls } = stubGateway(expectsReply(true));
      await fire(tenant, itemId, gateway, draftingAgent([]));
      expect(calls).toHaveLength(1);

      await fire(tenant, itemId, gateway, draftingAgent([]));

      expect(calls).toHaveLength(1);
      expect(await runsOf(tenant)).toHaveLength(1);
      expect(await draftsOf(tenant)).toHaveLength(1);
    });

    it("never overwrites a draft the user edited: no further run starts for the thread and the gateway is not asked", async () => {
      const first = await receive(tenant, { subject: "Offer" });
      const firstRef = await threadOf(tenant, first);
      const drafts: z.infer<typeof draftViewSchema>[] = [];
      const { gateway, calls } = stubGateway(expectsReply(true));
      await fire(tenant, first, gateway, draftingAgent([], drafts));
      const draft = drafts[0];
      if (!draft) throw new Error("The agent made no draft");
      await userEdits(tenant, draft);
      const second = await receive(tenant, {
        subject: "Re: Offer",
        references: [firstRef.messageId],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      const agentCalls: AgentCall[] = [];

      await fire(tenant, second, gateway, draftingAgent(agentCalls));

      expect(calls).toHaveLength(1);
      expect(agentCalls).toEqual([]);
      expect(await runsOf(tenant)).toHaveLength(1);
      expect(await draftsOf(tenant)).toMatchObject([{ email_item_id: draft.id, last_edited_by: "user" }]);
    });

    it("does not overwrite a draft the user edits after the run started: the update tool of the run is refused and the user's text stays", async () => {
      const first = await receive(tenant, { subject: "Offer" });
      const firstRef = await threadOf(tenant, first);
      const drafts: z.infer<typeof draftViewSchema>[] = [];
      const { gateway } = stubGateway(expectsReply(true));
      await fire(tenant, first, gateway, draftingAgent([], drafts));
      const draft = drafts[0];
      if (!draft) throw new Error("The agent made no draft");
      const second = await receive(tenant, {
        subject: "Re: Offer",
        references: [firstRef.messageId],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      const answers: { error: boolean; result: string }[] = [];

      // The run passed both plans (the draft was the agent's); the user saves an edit before the agent writes.
      await fire(tenant, second, gateway, async ({ agentRunId }) => {
        await userEdits(tenant, draft);
        answers.push(
          await createMailDraftUpdateTool(runtime)(agentRunId, {
            draftId: draft.id,
            body: "The agent's second answer",
          }),
        );
        return { result: "tried" };
      });

      expect(answers).toHaveLength(1);
      expect(answers[0]?.error).toBe(true);
      expect(JSON.parse(answers[0]?.result ?? "{}")).toMatchObject({ status: 409, error: "mail_draft_edited_by_user" });
      const { rows } = await admin.query<{ body: string }>(
        "SELECT properties->>'body' AS body FROM items WHERE id = $1",
        [draft.id],
      );
      expect(rows[0]?.body).toBe("Edited by the user");
      expect(await draftsOf(tenant)).toMatchObject([{ email_item_id: draft.id, last_edited_by: "user" }]);
    });

    it("starts no run when a newer message arrives while the gateway is asked", async () => {
      const first = await receive(tenant, { subject: "Offer" });
      const firstRef = await threadOf(tenant, first);
      const { gateway, calls } = stubGateway(async () => {
        await receive(tenant, {
          subject: "Re: Offer",
          references: [firstRef.messageId],
          date: new Date("2026-10-02T09:00:00Z"),
        });
        return { content: { expectsReply: true }, usage: NO_USAGE };
      });

      await fire(tenant, first, gateway, draftingAgent([]));

      expect(calls).toHaveLength(1);
      expect(await runsOf(tenant)).toEqual([]);
      expect(await draftsOf(tenant)).toEqual([]);
    });

    it("starts no run when the user edits the thread's draft while the gateway is asked", async () => {
      const first = await receive(tenant, { subject: "Offer" });
      const firstRef = await threadOf(tenant, first);
      const drafts: z.infer<typeof draftViewSchema>[] = [];
      await fire(tenant, first, stubGateway(expectsReply(true)).gateway, draftingAgent([], drafts));
      const draft = drafts[0];
      if (!draft) throw new Error("The agent made no draft");
      const second = await receive(tenant, {
        subject: "Re: Offer",
        references: [firstRef.messageId],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      const { gateway, calls } = stubGateway(async () => {
        await userEdits(tenant, draft);
        return { content: { expectsReply: true }, usage: NO_USAGE };
      });

      await fire(tenant, second, gateway, draftingAgent([]));

      expect(calls).toHaveLength(1);
      expect(await runsOf(tenant)).toHaveLength(1);
      expect(await draftsOf(tenant)).toMatchObject([{ email_item_id: draft.id, last_edited_by: "user" }]);
    });

    it("reads a message of another tenant as no message at all: no gateway call and no run in either tenant", async () => {
      const foreign = await receive(other);
      const { gateway, calls } = stubGateway(expectsReply(true));

      await fire(tenant, foreign, gateway, draftingAgent([]));

      expect(calls).toEqual([]);
      expect(await runsOf(tenant)).toEqual([]);
      expect(await runsOf(other)).toEqual([]);
    });
  });

  describe("the configuration", () => {
    it("fails, with no run, when the heartbeat turns the gate on and the composition has no gate", async () => {
      const itemId = await receive(tenant);

      await expect(fire(tenant, itemId, undefined, draftingAgent([]))).rejects.toThrow(
        "No answer-expected gate is configured for this action",
      );

      expect(await runsOf(tenant)).toEqual([]);
    });

    it("fails with a validation error, with no run, when the heartbeat names a run project resolver the composition lacks", async () => {
      const itemId = await receive(tenant);
      const { gateway, calls } = stubGateway(expectsReply(true));
      const gate = createAnswerExpectedGate(runtime, gateway);

      await expect(
        inTenant(tenant, () =>
          coreAgentRunAction(runtime, draftingAgent([]), { answerExpectedGate: gate })(tenant.actionConfig, {
            heartbeatId: tenant.heartbeatId,
            projectItemId: tenant.mailProjectId,
            itemId,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(calls).toEqual([]);
      expect(await runsOf(tenant)).toEqual([]);
    });

    it("refuses an answer-expected filter with a setting and a run project that names no resolver, before anything is asked", async () => {
      const itemId = await receive(tenant);
      const { gateway, calls } = stubGateway(expectsReply(true));
      const fireWith = (config: Record<string, unknown>) =>
        inTenant(tenant, () =>
          coreAgentRunAction(
            runtime,
            draftingAgent([]),
            createNewEmailAgentRunDependencies(runtime, gateway),
          )(
            { ...tenant.actionConfig, ...config },
            { heartbeatId: tenant.heartbeatId, projectItemId: tenant.mailProjectId, itemId },
          ),
        );

      await expect(fireWith({ answerExpectedFilter: { threshold: 1 } })).rejects.toBeInstanceOf(ValidationError);
      await expect(fireWith({ runProject: { resolver: "unknown" } })).rejects.toBeInstanceOf(ValidationError);
      await expect(fireWith({ runProject: { resolver: "toString" } })).rejects.toBeInstanceOf(ValidationError);
      await expect(fireWith({ runProject: {} })).rejects.toBeInstanceOf(ValidationError);

      expect(calls).toEqual([]);
      expect(await runsOf(tenant)).toEqual([]);
    });

    it("runs without the gate and in the heartbeat's project when the heartbeat configures neither", async () => {
      const itemId = await receive(tenant);
      const { answerExpectedFilter: _gate, runProject: _project, ...plain } = tenant.actionConfig;
      const agentCalls: AgentCall[] = [];

      await inTenant(tenant, () =>
        coreAgentRunAction(runtime, async ({ task, projectItemId }) => {
          agentCalls.push({ task, projectItemId });
        })(plain, { heartbeatId: tenant.heartbeatId, projectItemId: tenant.mailProjectId, itemId }),
      );

      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]).toMatchObject({ projectItemId: tenant.mailProjectId });
      expect(agentCalls[0]?.task).toBe(`A new message arrived in the Inbox.\nTriggering item id: ${itemId}`);
    });
  });
});
