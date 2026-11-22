import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, resolveModuleAgentToolsForUser } from "../../agentTools/moduleAgentTools.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import {
  setAgentRunDeltaHook,
  setInvalidationHook,
  type AgentRunDeltaEvent,
  type InvalidationEvent,
} from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { recordingTransport, sendAdapters, transportFor } from "../../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { createEmailDraftInMailbox, type EmailDraftView } from "../draft.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import {
  createMailDraftCreateUserTool,
  createMailDraftSendUserTool,
  createMailDraftUpdateUserTool,
  createMailThreadGetUserTool,
  type MailUserTool,
} from "../mailAgentTools.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";

const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };

const draftSchema = z.looseObject({
  id: z.uuid(),
  mailboxId: z.uuid(),
  to: z.array(z.looseObject({ address: z.string() })),
  subject: z.string(),
  body: z.string(),
  threadId: z.uuid().nullable(),
  mode: z.string(),
  sourceEmailId: z.uuid().nullable(),
  createdBy: z.string(),
  lastEditedBy: z.string(),
});
const refusalSchema = z.looseObject({ status: z.number(), error: z.string(), message: z.string() });
const threadSchema = z.looseObject({ threadId: z.uuid(), subject: z.string(), messages: z.array(z.unknown()) });
const sentSchema = z.looseObject({
  emailId: z.uuid(),
  threadId: z.uuid(),
  sentAt: z.string(),
  mailbox: z.looseObject({ id: z.uuid(), name: z.string() }),
});

interface ToolResult {
  error: boolean;
  result: string;
}

interface MailTenant {
  tenantId: string;
  userId: string;
  mailProjectId: string;
  mailboxId: string;
  inboxId: string;
}

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let tenant: MailTenant;
let other: MailTenant;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let transport: ReturnType<typeof recordingTransport>;
let invalidations: InvalidationEvent[];
let deltas: AgentRunDeltaEvent[];

function inTenant<T>(t: MailTenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, fn);
}

async function seededTenant(locale: string): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale,
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
    return withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: db("mailboxes").id,
        properties: { name: "Personal", provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes").id,
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
      });
      const folders: Record<string, string> = {};
      for (const specialPurpose of ["drafts", "sent", "inbox"]) {
        folders[specialPurpose] = await ensureFolderItem(client, {
          foldersDatabaseId: db("folders").id,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: mailboxRelation.id,
          providerId: specialPurpose.toUpperCase(),
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      }
      return { tenantId, userId: user.id, mailProjectId, mailboxId: mailbox.id, inboxId: folders.inbox ?? "" };
    });
  });
}

async function receive(t: MailTenant, subject: string): Promise<{ emailId: string; threadId: string }> {
  const emailId = await inTenant(t, async () => {
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
        arrival: "live",
        contentState: "full",
        emailsDatabaseId: db("emails"),
        filesDatabaseId: db("files"),
        folderRelationPropertyId: property("folder"),
        attachmentsRelationPropertyId: property("attachments"),
        mailboxItemId: t.mailboxId,
        folderItemId: t.inboxId,
        messageId: `<${randomUUID()}@example.test>`,
        subject,
        date: new Date("2026-10-01T09:00:00Z"),
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
        bodyText: "Hello",
        attachments: [],
        storage: new LocalFsBlobStorageWriter(storageRoot),
        storageKeyPrefix: "mail-mcp-tool-fixtures",
      }),
    );
    return itemId;
  });
  const { rows } = await inTenant(t, () =>
    runtime.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
      [emailId],
    ),
  );
  const threadId = rows[0]?.thread_id;
  if (!threadId) throw new Error("Missing thread");
  return { emailId, threadId };
}

async function userDraft(t: MailTenant, overrides: { to?: (typeof PETR)[] } = {}): Promise<EmailDraftView> {
  return inTenant(t, () =>
    withTransaction(runtime, (client) =>
      createEmailDraftInMailbox(
        client,
        {
          mailboxItemId: t.mailboxId,
          from: OWN_ADDRESS,
          to: overrides.to ?? [PETR],
          cc: [],
          bcc: [],
          subject: "My subject",
          body: "My text",
          threadId: null,
          mode: "new",
          sourceEmailItemId: null,
        },
        { writer: { writerKind: "user" }, actingUserId: t.userId },
      ),
    ),
  );
}

async function call(t: MailTenant, tool: MailUserTool, args: unknown): Promise<ToolResult> {
  return inTenant(t, () => tool(t.userId, args));
}

function draftOf(result: ToolResult) {
  expect(result.error, result.result).toBe(false);
  return draftSchema.parse(JSON.parse(result.result));
}

function refusalOf(result: ToolResult) {
  expect(result.error).toBe(true);
  return refusalSchema.parse(JSON.parse(result.result));
}

interface DraftTrace {
  created_by: string;
  last_edited_by: string;
  agent_run_id: string | null;
  sent_at: Date | null;
  claims: number;
}

async function traceOf(draftId: string): Promise<DraftTrace> {
  const { rows } = await admin.query<DraftTrace>(
    `SELECT d.created_by, d.last_edited_by, d.agent_run_id, d.sent_at,
            (SELECT count(*)::int FROM mail_message_meta m WHERE m.item_id = d.email_item_id) AS claims
     FROM mail_drafts d WHERE d.email_item_id = $1`,
    [draftId],
  );
  const row = rows[0];
  if (!row) throw new Error("Missing draft row");
  return row;
}

async function countOf(table: "mail_drafts" | "approval_requests", t: MailTenant): Promise<number> {
  // `table` is one of the two literals of the union, so the interpolation cannot inject.
  const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
    t.tenantId,
  ]);
  return rows[0]?.n ?? 0;
}

describe("the mail tools of a human /mcp session and of a run credential (issue gh-1956)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    registry = await loadFullModuleRegistry();
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-mcp-tools-"));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant("cs");
    other = await seededTenant("en");
    transport = recordingTransport();
    invalidations = [];
    deltas = [];
    setInvalidationHook((event) => {
      invalidations.push(event);
    });
    setAgentRunDeltaHook(async (event) => {
      deltas.push(event);
    });
  });

  afterEach(() => {
    setInvalidationHook(() => {});
    setAgentRunDeltaHook(async () => {});
  });

  describe("resolveModuleAgentToolsForUser on the full registry", () => {
    it("offers the five mail tools and the four calendar tools that declare mcp, and no other module tool, whatever their capability", async () => {
      const tools = await resolveModuleAgentToolsForUser(runtime, registry, tenant.userId, {});

      expect(tools.map((tool) => tool.name)).toEqual([
        "mail.thread.get",
        "mail.search",
        "mail.draft.create",
        "mail.draft.update",
        "mail.draft.send",
        // The calendar read and write tools. The write tools are gated for a run, so a session gets them only through their
        // `mcp` declaration.
        "calendar.timeline",
        "calendar.respondToInvitation",
        "calendar.placeTaskInEvent",
        "calendar.removeTaskFromEvent",
      ]);
    });
  });

  describe("resolveModuleAgentToolsForRun for a run credential (mcpExposure, issue gh-1956)", () => {
    async function runOf(t: MailTenant, projectItemId: string): Promise<string> {
      return inTenant(t, async () => {
        const run = await createAgentRun(runtime, { projectItemId, userId: t.userId, triggeredBy: "mcp", task: "mcp" });
        return run.id;
      });
    }
    async function mailNames(t: MailTenant, runId: string, projectItemId: string, listed: string[]) {
      const tools = await inTenant(t, () =>
        resolveModuleAgentToolsForRun(runtime, registry, runId, projectItemId, new Set(listed), {
          mcpExposure: true,
        }),
      );
      return tools.map((tool) => tool.name).filter((name) => name.startsWith("mail."));
    }

    it("offers the mail tools of the capabilities the credential lists and its project holds, and none for a list of core ids only", async () => {
      const runId = await runOf(tenant, tenant.mailProjectId);
      const all = ["core.item.read", "mail.read", "mail.draft", "mail.send"];

      expect(await mailNames(tenant, runId, tenant.mailProjectId, all)).toEqual([
        "mail.thread.get",
        "mail.search",
        "mail.draft.create",
        "mail.draft.update",
        "mail.draft.send",
      ]);
      expect(await mailNames(tenant, runId, tenant.mailProjectId, ["core.item.read"])).toEqual([]);
      expect(await mailNames(tenant, runId, tenant.mailProjectId, ["mail.read"])).toEqual([
        "mail.thread.get",
        "mail.search",
      ]);
      expect(await mailNames(tenant, runId, tenant.mailProjectId, ["mail.send"])).toEqual(["mail.draft.send"]);
    });

    it("offers no mail tool to a project that does not own the mail databases", async () => {
      const inbox = await admin.query<{ owner_project_item_id: string }>(
        "SELECT owner_project_item_id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'inbox'",
        [tenant.tenantId],
      );
      const inboxProjectId = inbox.rows[0]?.owner_project_item_id;
      if (!inboxProjectId) throw new Error("Missing the Semprec project");
      const inboxRunId = await runOf(tenant, inboxProjectId);

      expect(await mailNames(tenant, inboxRunId, inboxProjectId, ["mail.read", "mail.draft", "mail.send"])).toEqual([]);
    });
  });

  describe("mail.thread.get as the user", () => {
    it("answers the thread of a received message", async () => {
      const { threadId } = await receive(tenant, "Offer");

      const answer = await call(tenant, createMailThreadGetUserTool(runtime), { threadId });

      expect(answer.error).toBe(false);
      const thread = threadSchema.parse(JSON.parse(answer.result));
      expect(thread).toMatchObject({ threadId, subject: "Offer" });
      expect(thread.messages).toHaveLength(1);
    });

    it("answers an unknown thread and another tenant's thread with the same 404, and a bad argument with a 400", async () => {
      const foreign = await receive(other, "Secret");

      const unknown = refusalOf(await call(tenant, createMailThreadGetUserTool(runtime), { threadId: randomUUID() }));
      const crossTenant = refusalOf(
        await call(tenant, createMailThreadGetUserTool(runtime), { threadId: foreign.threadId }),
      );
      const invalid = refusalOf(await call(tenant, createMailThreadGetUserTool(runtime), { threadId: "x" }));

      expect(unknown).toMatchObject({ status: 404 });
      expect({ ...crossTenant, message: "" }).toEqual({ ...unknown, message: "" });
      expect(crossTenant.message).toBe(unknown.message);
      expect(invalid.status).toBe(400);
    });
  });

  describe("mail.draft.create as the user", () => {
    it("writes a new draft as an agent for the user with no run and no Semp thread", async () => {
      const draft = draftOf(
        await call(tenant, createMailDraftCreateUserTool(runtime), {
          mode: "new",
          mailboxId: tenant.mailboxId,
          to: [PETR],
          subject: "Hello",
          body: "Text",
        }),
      );

      expect(draft).toMatchObject({ mode: "new", subject: "Hello", body: "Text", createdBy: "agent", threadId: null });
      expect(await traceOf(draft.id)).toMatchObject({
        created_by: "agent",
        last_edited_by: "agent",
        agent_run_id: null,
      });
      expect(await countOf("mail_drafts", tenant)).toBe(1);
    });

    it("prefills a reply from the source message and reads the locale of the session's user", async () => {
      const { emailId, threadId } = await receive(tenant, "Offer");

      const draft = draftOf(
        await call(tenant, createMailDraftCreateUserTool(runtime), { mode: "reply", threadId, body: "Thanks" }),
      );

      expect(draft).toMatchObject({ mode: "reply", sourceEmailId: emailId, subject: "Re: Offer", createdBy: "agent" });
      expect(draft.to.map((recipient) => recipient.address)).toEqual([PETR.address]);
      expect(await traceOf(draft.id)).toMatchObject({ created_by: "agent", agent_run_id: null });
    });

    it("refuses a new draft without a mailbox, and an unknown mailbox, and writes nothing", async () => {
      const missing = refusalOf(
        await call(tenant, createMailDraftCreateUserTool(runtime), { mode: "new", body: "Text" }),
      );
      const unknown = refusalOf(
        await call(tenant, createMailDraftCreateUserTool(runtime), {
          mode: "new",
          mailboxId: other.mailboxId,
          body: "Text",
        }),
      );

      expect(missing).toMatchObject({ status: 400 });
      expect(unknown).toMatchObject({ status: 404 });
      expect(await countOf("mail_drafts", tenant)).toBe(0);
      expect(await countOf("mail_drafts", other)).toBe(0);
    });
  });

  describe("mail.draft.update as the user", () => {
    it("rewrites a draft the user last edited, which a run nobody asked for may not, and publishes no run delta", async () => {
      const draft = await userDraft(tenant);
      expect(await traceOf(draft.id)).toMatchObject({ last_edited_by: "user" });

      const updated = draftOf(
        await call(tenant, createMailDraftUpdateUserTool(runtime), { draftId: draft.id, body: "New text" }),
      );

      expect(updated).toMatchObject({ id: draft.id, body: "New text", lastEditedBy: "agent", subject: "My subject" });
      expect(await traceOf(draft.id)).toMatchObject({ last_edited_by: "agent", agent_run_id: null });
      expect(deltas).toEqual([]);
    });

    it("replaces the subject too when it is given", async () => {
      const draft = await userDraft(tenant);

      const updated = draftOf(
        await call(tenant, createMailDraftUpdateUserTool(runtime), {
          draftId: draft.id,
          body: "New text",
          subject: "New subject",
        }),
      );

      expect(updated).toMatchObject({ subject: "New subject" });
    });

    it("answers an unknown draft and another tenant's draft with the same 404 and leaves the other tenant's draft as it was", async () => {
      const foreign = await userDraft(other);

      const unknown = refusalOf(
        await call(tenant, createMailDraftUpdateUserTool(runtime), { draftId: randomUUID(), body: "x" }),
      );
      const crossTenant = refusalOf(
        await call(tenant, createMailDraftUpdateUserTool(runtime), { draftId: foreign.id, body: "Hacked" }),
      );

      expect(unknown).toMatchObject({ status: 404 });
      expect(crossTenant).toMatchObject({ status: 404, message: unknown.message });
      expect(await traceOf(foreign.id)).toMatchObject({ created_by: "user", last_edited_by: "user" });
    });

    it("refuses a sent draft with a 409 and a bad argument with a 400", async () => {
      const draft = await userDraft(tenant);
      const send = createMailDraftSendUserTool(runtime, {
        mailServerClients: { send: sendAdapters(transportFor(transport)) },
      });
      expect((await call(tenant, send, { draftId: draft.id })).error).toBe(false);

      const sent = refusalOf(
        await call(tenant, createMailDraftUpdateUserTool(runtime), { draftId: draft.id, body: "late" }),
      );
      const invalid = refusalOf(await call(tenant, createMailDraftUpdateUserTool(runtime), { draftId: draft.id }));

      expect(sent).toMatchObject({ status: 409, error: "mail_draft_already_sent" });
      expect(invalid.status).toBe(400);
    });
  });

  describe("mail.draft.send as the user", () => {
    const dependencies = () => ({ mailServerClients: { send: sendAdapters(transportFor(transport)) } });

    it("sends the draft as the user and creates no approval request", async () => {
      const draft = await userDraft(tenant);

      const answer = await call(tenant, createMailDraftSendUserTool(runtime, dependencies()), { draftId: draft.id });

      expect(answer.error, answer.result).toBe(false);
      const sent = sentSchema.parse(JSON.parse(answer.result));
      expect(sent).toMatchObject({ emailId: draft.id, mailbox: { id: tenant.mailboxId, name: "Personal" } });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.envelope).toEqual({ from: OWN_ADDRESS, recipients: [PETR.address] });
      expect((await traceOf(draft.id)).sent_at).not.toBeNull();
      expect(await countOf("approval_requests", tenant)).toBe(0);
    });

    it("sends a draft the session's user made through mail.draft.create, as the user", async () => {
      const draft = draftOf(
        await call(tenant, createMailDraftCreateUserTool(runtime), {
          mode: "new",
          mailboxId: tenant.mailboxId,
          to: [PETR],
          subject: "Via MCP",
          body: "Text",
        }),
      );

      const answer = await call(tenant, createMailDraftSendUserTool(runtime, dependencies()), { draftId: draft.id });

      expect(answer.error, answer.result).toBe(false);
      expect(transport.sent).toHaveLength(1);
      expect(await countOf("approval_requests", tenant)).toBe(0);
    });

    it("refuses a second send of the same draft with a 409 and sends once", async () => {
      const draft = await userDraft(tenant);
      const send = createMailDraftSendUserTool(runtime, dependencies());
      expect((await call(tenant, send, { draftId: draft.id })).error).toBe(false);

      const again = refusalOf(await call(tenant, send, { draftId: draft.id }));

      expect(again).toMatchObject({ status: 409, error: "mail_draft_already_sent" });
      expect(transport.sent).toHaveLength(1);
    });

    it("refuses a draft without a recipient with a 400 and sends nothing", async () => {
      const draft = await userDraft(tenant, { to: [] });

      const refusal = refusalOf(
        await call(tenant, createMailDraftSendUserTool(runtime, dependencies()), { draftId: draft.id }),
      );

      expect(refusal.status).toBe(400);
      expect(transport.sent).toEqual([]);
      expect((await traceOf(draft.id)).sent_at).toBeNull();
    });

    it("answers an unknown draft and another tenant's draft with the same 404 and sends nothing", async () => {
      const foreign = await userDraft(other);
      const send = createMailDraftSendUserTool(runtime, dependencies());

      const unknown = refusalOf(await call(tenant, send, { draftId: randomUUID() }));
      const crossTenant = refusalOf(await call(tenant, send, { draftId: foreign.id }));

      expect(unknown.status).toBe(404);
      expect(crossTenant).toMatchObject({ status: 404, message: unknown.message });
      expect(transport.sent).toEqual([]);
      expect(await traceOf(foreign.id)).toMatchObject({ sent_at: null, claims: 0 });
    });

    it("refuses an argument that is no draft id with a 400", async () => {
      const refusal = refusalOf(
        await call(tenant, createMailDraftSendUserTool(runtime, dependencies()), { draftId: "x" }),
      );

      expect(refusal.status).toBe(400);
    });

    it("fails the call with a plain error when the composition root configured no send adapters, and leaves the draft unsent", async () => {
      const draft = await userDraft(tenant);

      await expect(call(tenant, createMailDraftSendUserTool(runtime, {}), { draftId: draft.id })).rejects.toThrow(
        'custom route dependency "mailServerClients.send" is not configured by the composition root',
      );

      expect(await traceOf(draft.id)).toMatchObject({ sent_at: null, claims: 0 });
    });
  });
});
