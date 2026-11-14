import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRun, type AgentRunRow } from "../../agentRuns/agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { SYSTEM_WRITER } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { generatePermissionManifest } from "../../manifest/permissionManifest.js";
import { decideAndEnqueueApprovalRequest } from "../../mcp/approvalDecisionAction.js";
import { handleApprovalRequestExecuteTask } from "../../mcp/approvalRequestExecution.js";
import { listApprovalRequestsQueue } from "../../mcp/approvalRequestsQueue.js";
import {
  claimApprovalRequestExecution,
  createPendingApprovalRequest,
  getApprovalRequest,
  type ApprovalRequest,
  type MailSendApprovalRequestPayload,
} from "../../mcp/approvalRequestsStore.js";
import { logger } from "../../mcp/logger.js";
import { approvalNotificationBody } from "../../notifications/approvalNotificationBody.js";
import { approvalNotificationLinkHref } from "../../notifications/approvalNotificationLink.js";
import { writeNotification } from "../../notifications/notify.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createSempChatThread } from "../../sempThreads/sempThreadsStore.js";
import {
  recordingTransport,
  sendAdapters,
  transportFor,
  type RecordingTransport,
} from "../../testSupport/mailSendFakes.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getOrCreateTickThread,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createActionRegistry, CORE_AGENT_RUN_ACTION_ID } from "../../scheduler/actions.js";
import { createCoreTaskList } from "../../worker.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import {
  createMailDraftCreateRouteHandler,
  createMailDraftDiscardRouteHandler,
  createMailDraftSendRouteHandler,
  createMailDraftUpdateRouteHandler,
} from "../mailDraftRouteHandlers.js";
import { prepareSend } from "../mailDraftSendInput.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";
import { upsertMailMessageMeta } from "../mailMessageMetaStore.js";
import { computeMailDraftHash } from "../mailSendApproval.js";
import type { MailTransportFactory } from "../mailTransport.js";
import { MailRecipientRejectedError } from "../providerTypes.js";
import { MailDraftAlreadySentError, MailDraftNotEditableError } from "../draft.js";
import { sendDraftEmail, type MailSendAdapterFactory, type SendEmailInput } from "../send.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let approvalAnnouncements: string[];

const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const JANA = { name: "", address: "jana@example.test" };
const SECRET = { name: "Skrytá", address: "hidden@example.test" };
const SUBJECT = "Smlouva o dílo";
const BODY = "Dobrý den,\nposílám smlouvu k podpisu.";
const MAILBOX_NAME = "Personal";

interface MailFixture {
  tenant: string;
  userId: string;
  mailboxId: string;
  draftsFolderId: string;
  /** The thread of one received message, the Threads item of that thread, and the received message. */
  threadId: string;
  threadItemId: string;
  receivedId: string;
}

const userByTenant = new Map<string, string>();

function inT<T>(fn: () => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, fn);
}

const ctx = (params: Record<string, string>, body: unknown) => ({
  params,
  body,
  identity: { user: { id: randomUUID(), locale: "en" } },
});

/** A mailbox "Personal" with Drafts, Sent and Inbox folders and one received message in `tenantId`. */
async function setupMail(tenantId: string): Promise<MailFixture> {
  const userId = userByTenant.get(tenantId);
  if (userId === undefined) throw new Error("Missing user");
  return inT(async () => {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    const emailProperties = await cp.listProperties(db("emails"));
    const folderProperties = await cp.listProperties(db("folders"));
    const property = (properties: typeof emailProperties, key: string) => {
      const found = properties.find((row) => row.key === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    return withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: db("mailboxes"),
        properties: { name: MAILBOX_NAME, provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes"),
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
      });
      const folder = (specialPurpose: string) =>
        ensureFolderItem(client, {
          foldersDatabaseId: db("folders"),
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: property(folderProperties, "mailbox"),
          providerId: specialPurpose.toUpperCase(),
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      const draftsFolderId = await folder("drafts");
      await folder("sent");
      const inboxId = await folder("inbox");
      const received = await ingestEmailMessage(client, {
        emailsDatabaseId: db("emails"),
        filesDatabaseId: db("files"),
        folderRelationPropertyId: property(emailProperties, "folder"),
        attachmentsRelationPropertyId: property(emailProperties, "attachments"),
        mailboxItemId: mailbox.id,
        folderItemId: inboxId,
        messageId: "<received@example.test>",
        subject: "Nabídka na web",
        date: new Date("2026-10-01T09:00:00Z"),
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
        bodyHtml: "<p>Dobrý den</p>",
        attachments: [],
        storage: new LocalFsBlobStorageWriter(storageRoot),
        storageKeyPrefix: "send-approval-fixtures",
      });
      const thread = await client.query<{ thread_id: string; item_id: string | null }>(
        `SELECT t.id AS thread_id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id
          WHERE m.item_id = $1`,
        [received.itemId],
      );
      const row = thread.rows[0];
      if (!row?.item_id) throw new Error("The received message has no thread item");
      return {
        tenant: tenantId,
        userId,
        mailboxId: mailbox.id,
        draftsFolderId,
        threadId: row.thread_id,
        threadItemId: row.item_id,
        receivedId: received.itemId,
      };
    });
  }, tenantId);
}

interface DraftRef {
  id: string;
  /** The Emails item's `updatedAt` as the draft routes hand it out: the `ifVersion` of the next edit. */
  updatedAt: string;
}

/** A draft of the fixture's mailbox made through the real create route; `overrides` replace fields of the body. */
async function newDraft(f: MailFixture, overrides: Record<string, unknown> = {}): Promise<DraftRef> {
  const created = await inT(
    () =>
      createMailDraftCreateRouteHandler(runtime)(
        ctx(
          {},
          {
            mailboxId: f.mailboxId,
            from: OWN_ADDRESS,
            to: [PETR],
            cc: [JANA],
            bcc: [SECRET],
            subject: SUBJECT,
            body: BODY,
            ...overrides,
          },
        ),
      ),
    f.tenant,
  );
  expect(created.status).toBe(201);
  return { id: created.body.id, updatedAt: created.body.updatedAt };
}

/** The draft written by Semp's own writer shape: a reply to the received message of the fixture. */
const replyTo = (f: MailFixture) => ({ threadId: f.threadId, mode: "reply", sourceEmailId: f.receivedId });

async function editDraft(f: MailFixture, draft: DraftRef, fields: Record<string, unknown>): Promise<void> {
  const updated = await inT(
    () => createMailDraftUpdateRouteHandler(runtime)(ctx({ id: draft.id }, { ifVersion: draft.updatedAt, ...fields })),
    f.tenant,
  );
  expect(updated.status).toBe(200);
}

interface RunOptions {
  triggeredBy?: "user" | "heartbeat" | "mcp";
  projectItemId?: string;
  heartbeatId?: string;
  threadId?: string;
}

/** An agent run of the fixture's user, in a fresh project that has no permission unless `projectItemId` says otherwise. */
async function newRun(f: MailFixture, options: RunOptions = {}): Promise<AgentRunRow> {
  return inT(async () => {
    const projectItemId = options.projectItemId ?? (await createTestProjectItem(runtime));
    return createAgentRun(runtime, {
      triggeredBy: options.triggeredBy ?? "user",
      task: "send the draft",
      userId: f.userId,
      projectItemId,
      ...(options.heartbeatId === undefined ? {} : { heartbeatId: options.heartbeatId }),
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    });
  }, f.tenant);
}

/** Raw SQL: the server operator grants `emailSendAutonomous` on a project by direct database access, no API writes it. */
async function grantAutonomousSend(projectItemId: string): Promise<void> {
  await admin.query(
    `UPDATE items SET properties = properties || '{"emailSendAutonomous": true}'::jsonb WHERE id = $1`,
    [projectItemId],
  );
  const manifest = await inT(() =>
    withTransaction(runtime, (client) => generatePermissionManifest(client, projectItemId)),
  );
  expect(manifest.capabilities.email.send.autonomous).toBe(true);
}

function adaptersFor(transport: RecordingTransport): MailSendAdapterFactory {
  return sendAdapters(transportFor(transport));
}

/** What a send by an agent does: reads the draft as the composition root would, and calls `sendDraftEmail` as the run. */
async function agentSend(
  f: MailFixture,
  draftId: string,
  run: AgentRunRow,
  toolCallId?: string,
): Promise<ApprovalRequest> {
  return inT(async () => {
    const { input, moduleIds } = await withTransaction(runtime, (client) => prepareSend(client, draftId));
    return sendDraftEmail(
      runtime,
      {
        ...input,
        actor: { type: "ai_agent", agentRunId: run.id, ...(toolCallId === undefined ? {} : { toolCallId }) },
      },
      moduleIds,
      adaptersFor(recordingTransport()),
    );
  }, f.tenant);
}

function decide(f: MailFixture, requestId: string, decision: "approved" | "rejected") {
  return inT(
    () =>
      withTransaction(runtime, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: requestId,
          decision,
          decidedByUserId: f.userId,
        }),
      ),
    f.tenant,
  );
}

function deliver(f: MailFixture, requestId: string, adapters?: MailSendAdapterFactory, pool: Pool = runtime) {
  return inT(
    () => handleApprovalRequestExecuteTask(pool, { approvalRequestId: requestId }, undefined, undefined, adapters),
    f.tenant,
  );
}

async function reload(f: MailFixture, requestId: string): Promise<ApprovalRequest> {
  const request = await inT(
    () => withTransaction(runtime, (client) => getApprovalRequest(client, requestId)),
    f.tenant,
  );
  if (!request) throw new Error("Request vanished");
  return request;
}

async function counts(tenantId: string): Promise<{ requests: number; claims: number; notifications: number }> {
  const { rows } = await admin.query<{ requests: number; claims: number; notifications: number }>(
    `SELECT (SELECT count(*)::int FROM approval_requests WHERE tenant_id = $1) AS requests,
            (SELECT count(*)::int FROM mail_message_meta WHERE tenant_id = $1 AND message_id NOT LIKE '<received@%') AS claims,
            (SELECT count(*)::int FROM notifications WHERE tenant_id = $1) AS notifications`,
    [tenantId],
  );
  return rows[0] ?? { requests: -1, claims: -1, notifications: -1 };
}

/** The draft is as it was made: no claim, no `sent_at`, still linked to Drafts. */
async function expectDraftUntouched(f: MailFixture, draftId: string): Promise<void> {
  const row = await admin.query<{ sent_at: Date | null }>("SELECT sent_at FROM mail_drafts WHERE email_item_id = $1", [
    draftId,
  ]);
  expect(row.rows).toEqual([{ sent_at: null }]);
  const claim = await admin.query("SELECT 1 FROM mail_message_meta WHERE item_id = $1", [draftId]);
  expect(claim.rows).toHaveLength(0);
  const inDrafts = await admin.query(
    `SELECT 1 FROM item_relations WHERE tenant_id = $1 AND $2 IN (item_a, item_b) AND $3 IN (item_a, item_b)`,
    [f.tenant, draftId, f.draftsFolderId],
  );
  expect(inDrafts.rows).toHaveLength(1);
}

async function sentAtOf(draftId: string): Promise<Date | null> {
  const { rows } = await admin.query<{ sent_at: Date | null }>(
    "SELECT sent_at FROM mail_drafts WHERE email_item_id = $1",
    [draftId],
  );
  return rows[0]?.sent_at ?? null;
}

describe("approval of a mail send by an agent (issue gh-1913)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-send-approval-"));
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    userByTenant.clear();
    for (const id of [tenant, foreign]) {
      await inT(() => seedSystem(runtime), id);
      userByTenant.set(
        id,
        (await createUser(admin, { tenantId: id, email: `${randomUUID()}@example.test`, passwordHash: "unused" })).id,
      );
    }
    approvalAnnouncements = [];
    setInvalidationHook((event: InvalidationEvent) => {
      if (event.scope === "approvalRequest") approvalAnnouncements.push(event.approvalRequestId);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe("creating the request", () => {
    it("creates one pending outbound request that records the draft hash and the payload, and sends nothing", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const run = await newRun(f);
      const { input } = await inT(() => withTransaction(runtime, (client) => prepareSend(client, draft.id)));

      const request = await agentSend(f, draft.id, run);

      const hash = computeMailDraftHash(input);
      expect(request).toMatchObject({
        agentRunId: run.id,
        toolName: "mail.draft.send",
        riskClass: "outbound",
        status: "pending",
        executionStatus: "not_approved",
        toolCallId: null,
        payload: {
          draftId: draft.id,
          draftHash: hash,
          mailboxId: f.mailboxId,
          to: [PETR],
          subject: SUBJECT,
          body: BODY,
        },
        resourceSnapshot: { kind: "mail_draft", resourceId: draft.id, sha256: hash },
        description: { key: "approval.emailSend", params: { mailboxName: MAILBOX_NAME, recipientCount: 3 } },
      });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // The Cc and Bcc recipients are in the hash only, not in the payload.
      expect(JSON.stringify(request.payload)).not.toContain(SECRET.address);
      await expectDraftUntouched(f, draft.id);
      expect(approvalAnnouncements).toEqual([request.id]);
    });

    it("writes one approval_pending notification whose rendered body names the mailbox and the recipient count only", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);

      const request = await agentSend(f, draft.id, await newRun(f));

      const { rows } = await admin.query<{
        user_id: string;
        kind: string;
        source_table: string;
        source_id: string;
        body: string | null;
        link_href: string | null;
      }>("SELECT user_id, kind, source_table, source_id, body, link_href FROM notifications WHERE tenant_id = $1", [
        tenant,
      ]);
      expect(rows).toEqual([
        {
          user_id: f.userId,
          kind: "approval_pending",
          source_table: "approval_requests",
          source_id: request.id,
          // The user's locale is Czech by default: the body is the Czech template filled with the description.
          body: `Odeslat e-mail ze schránky „${MAILBOX_NAME}“. Příjemců: 3. Semp tuto akci nedokáže vrátit zpět.`,
          link_href: `?page=semp-chats&tab=semp&approvalRequestId=${request.id}`,
        },
      ]);
      for (const value of [PETR.address, PETR.name, JANA.address, SECRET.address, SECRET.name, SUBJECT, "smlouvu"]) {
        expect(JSON.stringify([rows, request.description])).not.toContain(value);
      }
    });

    it.each([
      ["seed/i18n/en.json", "en"],
      ["seed/i18n/cs.json", "cs"],
      ["notifications/i18n/en.json", "en"],
      ["notifications/i18n/cs.json", "cs"],
    ])("renders the template of %s with the mailbox and the count, and no recipient and no subject", async (file) => {
      const catalog = z
        .record(z.string(), z.string())
        .parse(JSON.parse(await readFile(new URL(`../../${file}`, import.meta.url), "utf8")));
      const template = catalog["approval.emailSend"];
      expect(template).toBeDefined();
      expect([...(template ?? "").matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()).toEqual([
        "mailboxName",
        "recipientCount",
      ]);

      const rendered = (template ?? "").replace("{mailboxName}", MAILBOX_NAME).replace("{recipientCount}", "3");

      expect(rendered).toContain(MAILBOX_NAME);
      expect(rendered).toContain("3");
      expect(rendered).not.toContain("{");
    });

    it("shows a source of kind chat, tick or mcp and no argument value in the queue entry", async () => {
      const f = await setupMail(tenant);
      const chatThreadId = await inT(() => withTransaction(runtime, (client) => createSempChatThread(client)));
      const emailProject = await admin.query<{ id: string }>(
        `SELECT id FROM items WHERE tenant_id = $1 AND properties ->> 'name' = 'Email'`,
        [tenant],
      );
      const heartbeat = await inT(() =>
        withTransaction(runtime, async (client) => {
          const created = await createHeartbeat(client, {
            projectItemId: emailProject.rows[0]?.id ?? "",
            name: "Weekly mail",
            rule: { kind: "weekly", days: ["sun"], at: "21:00" },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "Answer mail" },
          });
          return { id: created.id, threadId: (await getOrCreateTickThread(client, created.id)).id };
        }),
      );
      const runs = {
        chat: await newRun(f, { threadId: chatThreadId }),
        tick: await newRun(f, { triggeredBy: "heartbeat", heartbeatId: heartbeat.id, threadId: heartbeat.threadId }),
        mcp: await newRun(f, { triggeredBy: "mcp" }),
      };

      for (const kind of ["chat", "tick", "mcp"] as const) {
        const draft = await newDraft(f);
        const request = await agentSend(f, draft.id, runs[kind]);
        const queue = await inT(() =>
          withTransaction(runtime, (client) => listApprovalRequestsQueue(client, f.userId, "en")),
        );
        const entry = queue.find((candidate) => candidate.id === request.id);
        expect(entry).toMatchObject({
          toolName: "mail.draft.send",
          riskClass: "outbound",
          source: { kind },
          safeSummary: { kind: "moduleTool", toolName: "mail.draft.send" },
          description: { key: "approval.emailSend", params: { mailboxName: MAILBOX_NAME, recipientCount: 3 } },
        });
        for (const value of [PETR.address, SECRET.address, SUBJECT, "smlouvu"]) {
          expect(JSON.stringify(entry)).not.toContain(value);
        }
      }
    });

    it("describes the stored draft whatever the caller supplies in the rest of its input", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const run = await newRun(f);

      const request = await inT(async () => {
        const { input, moduleIds } = await withTransaction(runtime, (client) => prepareSend(client, draft.id));
        const claimed: SendEmailInput = {
          ...input,
          to: [{ address: "attacker@example.test" }],
          subject: "Something else",
          bodyText: "Not the draft",
        };
        return sendDraftEmail(
          runtime,
          { ...claimed, actor: { type: "ai_agent", agentRunId: run.id } },
          moduleIds,
          adaptersFor(recordingTransport()),
        );
      });

      expect(request.payload).toMatchObject({ draftId: draft.id, to: [PETR], subject: SUBJECT, body: BODY });
      expect(JSON.stringify(request.payload)).not.toContain("attacker@example.test");
    });

    it("returns the pending request of the draft instead of creating a second one, whichever run asks", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);

      const first = await agentSend(f, draft.id, await newRun(f));
      approvalAnnouncements.length = 0;
      const second = await agentSend(f, draft.id, await newRun(f, { triggeredBy: "mcp" }));

      expect(second.id).toBe(first.id);
      expect(await counts(tenant)).toMatchObject({ requests: 1, notifications: 1 });
      expect(approvalAnnouncements).toEqual([]);
    });

    it("creates one request for two concurrent calls for the same draft", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const runs = [await newRun(f), await newRun(f)];

      const results = await Promise.all(runs.map((run) => agentSend(f, draft.id, run)));

      expect(results[1]?.id).toBe(results[0]?.id);
      expect((await counts(tenant)).requests).toBe(1);
    });

    it("creates a new request for the draft once the earlier one was decided", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const first = await agentSend(f, draft.id, await newRun(f));
      await decide(f, first.id, "rejected");

      const second = await agentSend(f, draft.id, await newRun(f));

      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("pending");
    });

    it("returns the request a repeated tool call created before and a new one for a call without a tool call id", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const run = await newRun(f);
      const first = await agentSend(f, draft.id, run, "call_1");
      await decide(f, first.id, "rejected");

      const repeated = await agentSend(f, draft.id, run, "call_1");
      const separate = await agentSend(f, draft.id, run);

      expect(first.toolCallId).toBe("call_1");
      expect(repeated.id).toBe(first.id);
      expect(repeated.status).toBe("rejected");
      expect(separate.id).not.toBe(first.id);
      expect(separate.toolCallId).toBeNull();
    });

    it("refuses a draft of another tenant like an unknown draft, and creates nothing in either tenant", async () => {
      const f = await setupMail(tenant);
      const g = await setupMail(foreign);
      const draft = await newDraft(f);
      const foreignRun = await newRun(g);

      await expect(agentSend(g, draft.id, foreignRun)).rejects.toMatchObject({ name: "NotFoundError" });
      await expect(agentSend(g, randomUUID(), foreignRun)).rejects.toMatchObject({ name: "NotFoundError" });

      expect(await counts(tenant)).toMatchObject({ requests: 0, notifications: 0 });
      expect(await counts(foreign)).toMatchObject({ requests: 0, notifications: 0 });
    });

    it("refuses a sent draft, a plain Emails item without a draft row and a draft without a recipient, and creates nothing", async () => {
      const f = await setupMail(tenant);
      const run = await newRun(f);
      const sent = await newDraft(f);
      await inT(
        () =>
          createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adaptersFor(recordingTransport()) } })(
            ctx({ id: sent.id }, undefined),
          ),
        f.tenant,
      );
      const noRecipient = await newDraft(f, { to: [], cc: [], bcc: [] });

      await expect(agentSend(f, sent.id, run)).rejects.toBeInstanceOf(MailDraftAlreadySentError);
      await expect(agentSend(f, noRecipient.id, run)).rejects.toMatchObject({ name: "ValidationError" });
      await expect(agentSend(f, f.receivedId, run)).rejects.toBeInstanceOf(MailDraftNotEditableError);

      expect((await counts(tenant)).requests).toBe(0);
    });
  });

  describe("no permission lets an agent send without approval", () => {
    it("creates a request and sends nothing for a run in a project without the permission", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const run = await newRun(f);
      const transport = recordingTransport();

      const request = await agentSend(f, draft.id, run);
      await deliver(f, request.id, adaptersFor(transport));

      // Nothing was approved, so the delivery of the job finds a pending request and does nothing.
      expect(transport.sent).toHaveLength(0);
      expect((await reload(f, request.id)).status).toBe("pending");
      await expectDraftUntouched(f, draft.id);
    });

    it("creates a request with risk class outbound for a run whose project has emailSendAutonomous, and sends nothing until it is approved", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const projectItemId = await inT(() => createTestProjectItem(runtime));
      await grantAutonomousSend(projectItemId);
      const run = await newRun(f, { projectItemId });
      const transport = recordingTransport();

      const request = await agentSend(f, draft.id, run);

      expect(request).toMatchObject({ riskClass: "outbound", status: "pending" });
      expect(transport.sent).toHaveLength(0);
      await expectDraftUntouched(f, draft.id);

      await decide(f, request.id, "approved");
      await deliver(f, request.id, adaptersFor(transport));

      expect(transport.sent).toHaveLength(1);
      expect(await sentAtOf(draft.id)).toBeInstanceOf(Date);
    });

    it("creates a request when the draft's thread was moved into a project that has the permission by Semp's sorting", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f, replyTo(f));
      const permitted = await inT(() => createTestProjectItem(runtime));
      await grantAutonomousSend(permitted);
      await inT(async () => {
        const cp = createChokePoint(runtime);
        const threadProject = (await cp.listProperties(await databaseIdOf("threads"))).find(
          (property) => property.key === "project",
        );
        if (!threadProject) throw new Error("Missing Threads.project");
        await cp.createRelation(
          { relationPropertyId: threadProject.id, callerItemId: f.threadItemId, targetItemId: permitted },
          SYSTEM_WRITER,
        );
      });
      const transport = recordingTransport();

      const request = await agentSend(f, draft.id, await newRun(f));

      expect(request).toMatchObject({ riskClass: "outbound", status: "pending" });
      expect(transport.sent).toHaveLength(0);
      await expectDraftUntouched(f, draft.id);
    });

    it("creates a request for a run of a newEmail heartbeat whose project has the permission", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const heartbeat = await admin.query<{ id: string; project_item_id: string }>(
        `SELECT id, project_item_id FROM project_heartbeats WHERE tenant_id = $1 AND name = 'newEmail'`,
        [tenant],
      );
      const row = heartbeat.rows[0];
      if (!row) throw new Error("Missing the newEmail heartbeat");
      await grantAutonomousSend(row.project_item_id);
      const run = await newRun(f, {
        triggeredBy: "heartbeat",
        heartbeatId: row.id,
        projectItemId: row.project_item_id,
      });
      const transport = recordingTransport();

      const request = await agentSend(f, draft.id, run);

      expect(request).toMatchObject({ riskClass: "outbound", status: "pending" });
      expect(transport.sent).toHaveLength(0);
      await expectDraftUntouched(f, draft.id);
    });
  });

  describe("a user or a human session sends as before", () => {
    it("sends without an approval request through sendDraftEmail as a user and through the send route", async () => {
      const f = await setupMail(tenant);
      const viaFunction = await newDraft(f);
      const viaRoute = await newDraft(f);
      const transport = recordingTransport();

      const sent = await inT(async () => {
        const { input, moduleIds } = await withTransaction(runtime, (client) => prepareSend(client, viaFunction.id));
        return sendDraftEmail(runtime, input, moduleIds, adaptersFor(transport));
      });
      const answer = await inT(() =>
        createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adaptersFor(transport) } })(
          ctx({ id: viaRoute.id }, undefined),
        ),
      );

      expect(sent.itemId).toBe(viaFunction.id);
      expect(answer.status).toBe(200);
      expect(transport.sent).toHaveLength(2);
      expect(await counts(tenant)).toMatchObject({ requests: 0, notifications: 0 });
    });
  });

  describe("executing the approved request", () => {
    it("sends the draft exactly once after the approval, however often the job is delivered", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      const transport = recordingTransport();

      await deliver(f, request.id, adaptersFor(transport));
      await deliver(f, request.id, adaptersFor(transport));

      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.envelope).toEqual({
        from: OWN_ADDRESS,
        recipients: [PETR.address, JANA.address, SECRET.address],
      });
      const settled = await reload(f, request.id);
      expect(settled).toMatchObject({ status: "approved", executionStatus: "succeeded", executionError: false });
      const result = z
        .object({ emailId: z.string(), threadId: z.string(), sentAt: z.string() })
        .parse(JSON.parse(z.string().parse(settled.executionResult)));
      expect(result.emailId).toBe(draft.id);
      expect(await sentAtOf(draft.id)).toBeInstanceOf(Date);
    });

    it("sends once for two concurrent deliveries", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      const transport = recordingTransport();

      const settled = await Promise.allSettled([
        deliver(f, request.id, adaptersFor(transport)),
        deliver(f, request.id, adaptersFor(transport)),
      ]);

      expect(transport.sent).toHaveLength(1);
      // A delivery that finds the claim held and young is retried by the queue; that is its only way to fail.
      for (const outcome of settled) {
        if (outcome.status === "rejected") expect(String(outcome.reason)).toContain("still in flight");
      }
      expect((await reload(f, request.id)).executionStatus).toBe("succeeded");
    });

    it("ends in conflict and sends nothing when the draft was changed after the request was made", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      await editDraft(f, draft, { subject: "Changed after the request" });
      const transport = recordingTransport();

      await deliver(f, request.id, adaptersFor(transport));

      expect(transport.sent).toHaveLength(0);
      expect(await reload(f, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionError: true,
        executionResult: { outcomeKind: "sourceChanged" },
      });
      expect(await sentAtOf(draft.id)).toBeNull();
    });

    it("ends in conflict when the draft changes between the first read of the executor and its claim", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      const transport = recordingTransport();
      let edited = false;
      // A pool whose read of the mailbox's sync state, the step between the executor's read of the draft and the
      // claim of the send, first edits the draft through its own route.
      const racing = new Proxy(runtime, {
        get(target, property) {
          if (property === "query") {
            return async (...args: Parameters<Pool["query"]>) => {
              const text = args[0];
              if (!edited && typeof text === "string" && text.includes("FROM mail_account_sync_state")) {
                edited = true;
                await editDraft(f, draft, { body: "Changed between the read and the claim" });
              }
              return target.query(...args);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await deliver(f, request.id, adaptersFor(transport), racing);

      expect(edited).toBe(true);
      expect(transport.sent).toHaveLength(0);
      expect(await reload(f, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionResult: { outcomeKind: "sourceChanged" },
      });
      await expectDraftUntouched(f, draft.id);
    });

    it("ends in conflict and sends nothing when the draft was discarded or already sent after the approval", async () => {
      const f = await setupMail(tenant);
      const discarded = await newDraft(f);
      const sentByUser = await newDraft(f);
      const run = await newRun(f);
      const discardedRequest = await agentSend(f, discarded.id, run);
      const sentRequest = await agentSend(f, sentByUser.id, run);
      await decide(f, discardedRequest.id, "approved");
      await decide(f, sentRequest.id, "approved");
      await inT(() => createMailDraftDiscardRouteHandler(runtime)(ctx({ id: discarded.id }, undefined)));
      const userTransport = recordingTransport();
      await inT(() =>
        createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adaptersFor(userTransport) } })(
          ctx({ id: sentByUser.id }, undefined),
        ),
      );
      const transport = recordingTransport();

      await deliver(f, discardedRequest.id, adaptersFor(transport));
      await deliver(f, sentRequest.id, adaptersFor(transport));

      expect(transport.sent).toHaveLength(0);
      expect(userTransport.sent).toHaveLength(1);
      for (const id of [discardedRequest.id, sentRequest.id]) {
        expect(await reload(f, id)).toMatchObject({
          executionStatus: "conflict",
          executionResult: { outcomeKind: "sourceChanged" },
        });
      }
    });

    it("ends in conflict when another send holds the claim of the draft, and sends nothing", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      // A send that has claimed the draft and not finished: `sendDraftEmail` writes this row before it calls the provider.
      await inT(() =>
        withTransaction(runtime, (client) =>
          upsertMailMessageMeta(client, {
            itemId: draft.id,
            mailboxItemId: f.mailboxId,
            messageId: "<other-send@example.test>",
            envelope: { from: { address: OWN_ADDRESS }, to: [PETR] },
          }),
        ),
      );
      const transport = recordingTransport();

      await deliver(f, request.id, adaptersFor(transport));

      expect(transport.sent).toHaveLength(0);
      expect(await reload(f, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionResult: { outcomeKind: "sourceChanged" },
      });
      expect(await sentAtOf(draft.id)).toBeNull();
    });

    it("ends in a failed outcome when the provider fails, logs the class name only and leaves the draft sendable", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const failing = recordingTransport({
        send: async () => {
          throw new MailRecipientRejectedError();
        },
      });

      await deliver(f, request.id, adaptersFor(failing));

      expect(await reload(f, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionError: true,
        executionResult: { outcomeKind: "callFailed" },
      });
      // The error's class name, and no code: its code is not an upper-case identifier. Nothing of the draft is logged.
      expect(error).toHaveBeenCalledWith(
        { errorName: "MailRecipientRejectedError", approvalRequestId: request.id },
        "Approved mail send failed",
      );
      await expectDraftUntouched(f, draft.id);
    });

    it("ends in an error outcome and sends nothing in a worker that has no mail send adapters", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");

      await deliver(f, request.id, undefined);

      expect(await reload(f, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionResult: { outcomeKind: "toolUnavailable" },
      });
      await expectDraftUntouched(f, draft.id);
    });

    it("sends through the task list of the worker when it is given mail send transports, and refuses without them", async () => {
      const f = await setupMail(tenant);
      const withTransports = await agentSend(f, (await newDraft(f)).id, await newRun(f));
      const withoutTransports = await agentSend(f, (await newDraft(f)).id, await newRun(f));
      const transport = recordingTransport();
      const storage = new LocalFsBlobStorageWriter(storageRoot);
      const handlerOf = (mailSendTransports?: MailTransportFactory) => {
        const handler = createCoreTaskList(
          runtime,
          createActionRegistry(),
          undefined, // libraryMetadataFetcher
          undefined, // mailSyncAdapters
          storage, // mailBlobStorage
          undefined, // legacyRawMimeFetcher
          undefined, // moduleRegistry
          undefined, // pushSenders
          undefined, // genericOperationApprovalReplay
          storage, // filesBlobStorage
          undefined, // tenantBlobStorageDirs
          undefined, // titleGateway
          mailSendTransports,
        )[CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE];
        if (!handler) throw new Error("approvalExecute is not registered");
        return handler;
      };

      // `decide` enqueues the approvalExecute job of an approved request in the request's tenant.
      await decide(f, withTransports.id, "approved");
      await runOnce({
        pgPool: runtime,
        taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handlerOf(transportFor(transport)) },
      });
      await decide(f, withoutTransports.id, "approved");
      await runOnce({ pgPool: runtime, taskList: { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: handlerOf() } });

      expect(transport.sent).toHaveLength(1);
      expect((await reload(f, withTransports.id)).executionStatus).toBe("succeeded");
      expect(await reload(f, withoutTransports.id)).toMatchObject({
        executionStatus: "conflict",
        executionResult: { outcomeKind: "toolUnavailable" },
      });
    });
  });

  describe("recovering a stuck claim", () => {
    it("settles a claim that outlived its delivery as a conflict and sends nothing", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      // The delivery that made this claim died before it recorded an outcome.
      await inT(
        () => withTransaction(runtime, (client) => claimApprovalRequestExecution(client, request.id)),
        f.tenant,
      );
      // Raw SQL: no write path ages a claim; the sweep treats a claim older than ten minutes as one that died.
      await admin.query("UPDATE approval_requests SET executed_at = now() - interval '11 minutes' WHERE id = $1", [
        request.id,
      ]);
      const transport = recordingTransport();

      await deliver(f, request.id, adaptersFor(transport));

      expect(transport.sent).toHaveLength(0);
      expect(await reload(f, request.id)).toMatchObject({
        executionStatus: "conflict",
        executionResult: { outcomeKind: "staleClaim" },
      });
      await expectDraftUntouched(f, draft.id);
    });

    it("leaves a young claim to its delivery and retries later, sending nothing", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      await decide(f, request.id, "approved");
      await inT(
        () => withTransaction(runtime, (client) => claimApprovalRequestExecution(client, request.id)),
        f.tenant,
      );
      const transport = recordingTransport();

      await expect(deliver(f, request.id, adaptersFor(transport))).rejects.toThrow("still in flight");

      expect(transport.sent).toHaveLength(0);
      expect((await reload(f, request.id)).executionStatus).toBe("queued");
    });
  });

  describe("rejecting and superseding", () => {
    it("leaves the draft unchanged when the request is rejected, and sends nothing when the job is delivered", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const request = await agentSend(f, draft.id, await newRun(f));
      const transport = recordingTransport();

      await decide(f, request.id, "rejected");
      await deliver(f, request.id, adaptersFor(transport));

      expect(await reload(f, request.id)).toMatchObject({ status: "rejected", executionStatus: "not_approved" });
      expect(transport.sent).toHaveLength(0);
      await expectDraftUntouched(f, draft.id);
    });

    /** A second pending request for the draft: a state `requestMailSendApproval` never produces, so the store writes it. */
    async function secondPendingRequest(f: MailFixture, draftId: string, run: AgentRunRow): Promise<ApprovalRequest> {
      const first = await reload(f, (await listPendingIds(f, draftId))[0] ?? "");
      if (!isMailSendPayload(first.payload)) throw new Error("Not a mail send request");
      // The request and the notification that creating one writes, as one transaction, like the production creation.
      return inT(
        () =>
          withTransaction(runtime, async (client) => {
            const created = await createPendingApprovalRequest(client, {
              agentRunId: run.id,
              toolName: first.toolName,
              riskClass: first.riskClass,
              payload: first.payload,
              resourceSnapshot: first.resourceSnapshot,
              description: first.description,
            });
            await writeNotification(client, {
              userId: f.userId,
              kind: "approval_pending",
              ...approvalNotificationBody(created),
              linkHref: approvalNotificationLinkHref("chat", created.id),
              sourceTable: "approval_requests",
              sourceId: created.id,
              transitionInstance: created.id,
            });
            return created;
          }),
        f.tenant,
      );
    }

    async function listPendingIds(f: MailFixture, draftId: string): Promise<string[]> {
      const { rows } = await admin.query<{ id: string }>(
        `SELECT id FROM approval_requests WHERE tenant_id = $1 AND status = 'pending' AND payload ->> 'draftId' = $2
          ORDER BY requested_at`,
        [f.tenant, draftId],
      );
      return rows.map((row) => row.id);
    }

    function isMailSendPayload(payload: ApprovalRequest["payload"]): payload is MailSendApprovalRequestPayload {
      return "draftHash" in payload;
    }

    it.each(["approved", "rejected"] as const)(
      "closes the other pending request of the draft as superseded when one is %s, and it never executes",
      async (decision) => {
        const f = await setupMail(tenant);
        const draft = await newDraft(f);
        const otherDraft = await newDraft(f);
        const run = await newRun(f);
        const decided = await agentSend(f, draft.id, run);
        const other = await secondPendingRequest(f, draft.id, run);
        const unrelated = await agentSend(f, otherDraft.id, run);
        const transport = recordingTransport();
        approvalAnnouncements.length = 0;

        await decide(f, decided.id, decision);

        const closed = await reload(f, other.id);
        expect(closed).toMatchObject({
          status: "rejected",
          decidedBy: null,
          executionStatus: "not_approved",
          executionResult: { supersededBy: decided.id },
        });
        expect(closed.decidedAt).not.toBeNull();
        expect((await reload(f, unrelated.id)).status).toBe("pending");
        expect(approvalAnnouncements).toContain(other.id);
        const resolved = await admin.query<{ resolved: boolean }>(
          "SELECT resolved_at IS NOT NULL AS resolved FROM notifications WHERE source_id = $1",
          [other.id],
        );
        expect(resolved.rows).toEqual([{ resolved: true }]);

        await deliver(f, other.id, adaptersFor(transport));
        if (decision === "approved") await deliver(f, decided.id, adaptersFor(transport));
        expect(transport.sent).toHaveLength(decision === "approved" ? 1 : 0);
      },
    );

    it("decides a request of another kind without closing any mail send request", async () => {
      const f = await setupMail(tenant);
      const draft = await newDraft(f);
      const run = await newRun(f);
      const mailRequest = await agentSend(f, draft.id, run);
      const other = await inT(
        () =>
          createPendingApprovalRequest(runtime, {
            agentRunId: run.id,
            toolName: "send_email",
            riskClass: "outbound",
            payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
            resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          }),
        f.tenant,
      );

      await decide(f, other.id, "rejected");

      expect((await reload(f, mailRequest.id)).status).toBe("pending");
    });
  });

  describe("the draft hash", () => {
    const base: SendEmailInput = {
      mailboxItemId: "mailbox-1",
      draftItemId: "draft-1",
      actor: { type: "user" },
      from: { address: "me@example.test" },
      to: [{ name: "Petr", address: "petr@example.test" }],
      cc: [{ address: "jana@example.test" }],
      bcc: [{ address: "hidden@example.test" }],
      subject: "Subject",
      bodyText: "Body",
      attachments: [{ filename: "a.pdf", contentType: "application/pdf", blobId: "blob-1" }],
    };

    it("is a SHA-256 that does not change for the same draft, with or without absent optional members", () => {
      const { cc, bcc, attachments, bodyText, ...bare } = base;
      void cc;
      void bcc;
      void attachments;
      void bodyText;

      expect(computeMailDraftHash(base)).toBe(computeMailDraftHash({ ...base }));
      expect(computeMailDraftHash(bare)).toBe(
        computeMailDraftHash({ ...bare, cc: [], bcc: [], attachments: [], bodyText: "" }),
      );
    });

    const changes: Array<[string, Partial<SendEmailInput>]> = [
      ["the mailbox", { mailboxItemId: "mailbox-2" }],
      ["the sender", { from: { address: "other@example.test" } }],
      ["the sender's name", { from: { name: "Me", address: "me@example.test" } }],
      ["a To recipient", { to: [{ name: "Petr", address: "petr2@example.test" }] }],
      ["a To recipient's name", { to: [{ name: "Petra", address: "petr@example.test" }] }],
      ["a Cc recipient", { cc: [] }],
      ["a Bcc recipient", { bcc: [{ address: "other-hidden@example.test" }] }],
      ["the subject", { subject: "Another subject" }],
      ["the body", { bodyText: "Another body" }],
      [
        "the file name of an attachment",
        { attachments: [{ filename: "b.pdf", contentType: "application/pdf", blobId: "blob-1" }] },
      ],
      [
        "the content type of an attachment",
        { attachments: [{ filename: "a.pdf", contentType: "text/plain", blobId: "blob-1" }] },
      ],
      [
        "the blob of an attachment",
        { attachments: [{ filename: "a.pdf", contentType: "application/pdf", blobId: "blob-2" }] },
      ],
      ["the attachments", { attachments: [] }],
    ];
    it.each(changes)("changes with %s", (_name, change) => {
      expect(computeMailDraftHash({ ...base, ...change })).not.toBe(computeMailDraftHash(base));
    });
  });
});

async function databaseIdOf(moduleId: string): Promise<string> {
  const database = (await createChokePoint(runtime).listDatabases()).find((row) => row.ownerModuleId === moduleId);
  if (!database) throw new Error(`Missing database ${moduleId}`);
  return database.id;
}
