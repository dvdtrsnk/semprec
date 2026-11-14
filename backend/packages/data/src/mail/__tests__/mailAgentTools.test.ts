import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../../agentTools/moduleAgentTools.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { ValidationError } from "../../errors.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import {
  setAgentRunDeltaHook,
  setInvalidationHook,
  type AgentRunDeltaEvent,
  type InvalidationEvent,
} from "../../realtimeHook.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createSempChatThread } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { createEmailDraftInMailbox, discardEmailDraft, updateEmailDraft, type EmailDraftView } from "../draft.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage, type IngestEmailMessageInput } from "../ingest.js";
import { createMailThreadGetTool, createMailDraftCreateTool, createMailDraftUpdateTool } from "../mailAgentTools.js";
import { getMailDraft, markMailDraftSent } from "../mailDraftsStore.js";
import type { MailEnvelope } from "../mailMessageMetaStore.js";
import { createMailThread, reassignThread } from "../mailMessageMetaStore.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";

const OWN_ADDRESS = "me@example.test";
const ALIAS_ADDRESS = "alias@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const JANA = { name: "", address: "jana@example.test" };

const draftSchema = z.looseObject({
  id: z.uuid(),
  mailboxId: z.uuid(),
  from: z.string(),
  to: z.array(z.looseObject({ name: z.string(), address: z.string() })),
  cc: z.array(z.unknown()),
  bcc: z.array(z.unknown()),
  subject: z.string(),
  body: z.string(),
  threadId: z.uuid().nullable(),
  mode: z.string(),
  sourceEmailId: z.uuid().nullable(),
  attachments: z.array(z.looseObject({ filename: z.string(), fileItemId: z.uuid() })),
  createdBy: z.string(),
  lastEditedBy: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().nullable(),
});
const refusalSchema = z.looseObject({
  status: z.number(),
  error: z.string(),
  message: z.string(),
  field: z.string().optional(),
});
const messageSchema = z.looseObject({
  emailId: z.uuid(),
  mailboxId: z.uuid().nullable(),
  folderPurpose: z.string().nullable(),
  isOwn: z.boolean(),
  from: z.looseObject({ name: z.string(), address: z.string() }).nullable(),
  to: z.array(z.looseObject({ address: z.string() })),
  cc: z.array(z.looseObject({ address: z.string() })),
  date: z.string().nullable(),
  bodyText: z.string(),
  bodyTruncated: z.boolean(),
  attachments: z.array(z.string()),
});
const threadSchema = z.looseObject({
  threadId: z.uuid(),
  subject: z.string(),
  messageCount: z.number(),
  participants: z.array(z.looseObject({ address: z.string() })),
  senderPerson: z.looseObject({ id: z.uuid(), name: z.string() }).nullable(),
  company: z.looseObject({ id: z.uuid(), name: z.string() }).nullable(),
  project: z.looseObject({ id: z.uuid(), name: z.string() }).nullable(),
  messages: z.array(messageSchema),
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
  draftsFolderId: string;
  inboxId: string;
}

interface ReceiveOptions {
  messageId?: string;
  subject?: string;
  envelope?: MailEnvelope;
  bodyText?: string;
  date?: Date;
  references?: string[];
  deliveredToHeaders?: string[];
  attachmentNames?: string[];
  /** Which folder of the mailbox the message is ingested into. */
  folder?: "inbox" | "drafts";
}

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let tenant: MailTenant;
let other: MailTenant;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let events: InvalidationEvent[];
let deltas: AgentRunDeltaEvent[];
/** What the draft's body was in the database each time a delta was published, read on another connection. */
let storedBodiesAtPublish: (string | undefined)[];

function inTenant<T>(t: MailTenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, fn);
}

async function seededTenant(locale = "en"): Promise<MailTenant> {
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
        properties: { name: "Personal", provider: "gmail" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes").id,
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
        aliases: [ALIAS_ADDRESS],
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
      };
    });
  });
}

/** Ingests a message into the Inbox (or the Drafts folder) of the tenant's mailbox as the sync worker does. */
async function receive(t: MailTenant, options: ReceiveOptions = {}): Promise<string> {
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
    const input: IngestEmailMessageInput = {
      emailsDatabaseId: db("emails"),
      filesDatabaseId: db("files"),
      folderRelationPropertyId: property("folder"),
      attachmentsRelationPropertyId: property("attachments"),
      mailboxItemId: t.mailboxId,
      folderItemId: options.folder === "drafts" ? t.draftsFolderId : t.inboxId,
      messageId: options.messageId ?? `<${randomUUID()}@example.test>`,
      subject: options.subject ?? "Offer",
      date: options.date ?? new Date("2026-10-01T09:00:00Z"),
      envelope: options.envelope ?? { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
      bodyText: options.bodyText ?? "Hello",
      references: options.references,
      deliveredToHeaders: options.deliveredToHeaders,
      attachments: (options.attachmentNames ?? []).map((filename) => ({
        filename,
        contentType: "application/pdf",
        contentId: null,
        disposition: "attachment" as const,
        openStream: () => Readable.from([Buffer.from(`bytes of ${filename} ${randomUUID()}`)]),
      })),
      storage: new LocalFsBlobStorageWriter(storageRoot),
      storageKeyPrefix: "mail-agent-tool-fixtures",
    };
    const { itemId } = await withTransaction(runtime, (client) => ingestEmailMessage(client, input));
    return itemId;
  });
}

async function threadOf(t: MailTenant, emailItemId: string): Promise<string> {
  const { rows } = await inTenant(t, () =>
    runtime.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
      [emailItemId],
    ),
  );
  const threadId = rows[0]?.thread_id;
  if (!threadId) throw new Error("Missing thread");
  return threadId;
}

/** A run of the project, with the Semp thread it belongs to when `withThread` is set. */
async function runOf(
  t: MailTenant,
  options: {
    projectItemId?: string | null;
    withThread?: boolean;
    triggeredBy?: "user" | "heartbeat" | "supervisor";
    parentRunId?: string;
  } = {},
): Promise<{ runId: string; conversationId: string | null }> {
  return inTenant(t, async () => {
    const conversationId = options.withThread ? await withTransaction(runtime, createSempChatThread) : null;
    const run = await createAgentRun(runtime, {
      projectItemId: options.projectItemId === undefined ? t.mailProjectId : options.projectItemId,
      userId: t.userId,
      triggeredBy: options.triggeredBy ?? "user",
      task: "mail",
      threadId: conversationId,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    });
    return { runId: run.id, conversationId };
  });
}

function toolsFor(
  t: MailTenant,
  runId: string,
  projectItemId: string = t.mailProjectId,
  effectiveCapabilities?: ReadonlySet<string>,
): Promise<ResolvedModuleAgentTool[]> {
  return inTenant(t, () =>
    resolveModuleAgentToolsForRun(runtime, registry, runId, projectItemId, effectiveCapabilities),
  );
}

async function toolNamed(t: MailTenant, runId: string, name: string): Promise<ResolvedModuleAgentTool> {
  const tool = (await toolsFor(t, runId)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The run has no tool ${name}`);
  return tool;
}

/** Calls the tool as a session does and parses the answer: `error` and the JSON text it holds. */
async function call(t: MailTenant, runId: string, name: string, args: unknown): Promise<ToolResult> {
  const tool = await toolNamed(t, runId, name);
  const { result, error } = await inTenant(t, () => tool.invoke(args));
  return { error, result };
}

function draftOf(result: ToolResult) {
  expect(result.error, result.result).toBe(false);
  return draftSchema.parse(JSON.parse(result.result));
}

function refusalOf(result: ToolResult) {
  expect(result.error).toBe(true);
  return refusalSchema.parse(JSON.parse(result.result));
}

async function draftRow(t: MailTenant, draftId: string) {
  const row = await inTenant(t, () => getMailDraft(runtime, draftId));
  if (!row) throw new Error("Missing draft row");
  return row;
}

/** What the tenant holds that a draft write adds to: Emails items, `mail_drafts` rows and relation edges. */
async function writtenState(t: MailTenant) {
  return inTenant(t, async () => {
    const emails = await runtime.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       WHERE i.tenant_id = app_tenant_default() AND d.owner_module_id = 'emails'`,
    );
    const drafts = await runtime.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM mail_drafts WHERE tenant_id = app_tenant_default()",
    );
    const edges = await runtime.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM item_relations WHERE tenant_id = app_tenant_default()",
    );
    return { emails: emails.rows[0]?.n, drafts: drafts.rows[0]?.n, edges: edges.rows[0]?.n };
  });
}

/** The Files items an email holds through `Emails.attachments`, trashed ones included. */
async function attachmentsOf(t: MailTenant, emailItemId: string): Promise<{ fileId: string; name: string }[]> {
  const { rows } = await inTenant(t, () =>
    runtime.query<{ file_id: string; name: string }>(
      `SELECT f.id::text AS file_id, f.properties->>'name' AS name
       FROM item_relations r
       JOIN relation_definitions rd ON rd.id = r.relation_definition_id AND rd.tenant_id = r.tenant_id
       JOIN properties p ON p.id = rd.property_id_a AND p.tenant_id = rd.tenant_id AND p.key = 'attachments'
       JOIN items f ON f.id = r.item_b AND f.tenant_id = r.tenant_id
       WHERE r.tenant_id = app_tenant_default() AND r.item_a = $1
       ORDER BY f.properties->>'name'`,
      [emailItemId],
    ),
  );
  return rows.map((row) => ({ fileId: row.file_id, name: row.name }));
}

/** A draft created by a person through the draft operation, as the compose window would. */
async function userDraft(t: MailTenant, overrides: { threadId?: string | null } = {}): Promise<EmailDraftView> {
  return inTenant(t, () =>
    withTransaction(runtime, (client) =>
      createEmailDraftInMailbox(
        client,
        {
          mailboxItemId: t.mailboxId,
          from: OWN_ADDRESS,
          to: [PETR],
          cc: [],
          bcc: [],
          subject: "My subject",
          body: "My text",
          threadId: overrides.threadId ?? null,
          mode: "new",
          sourceEmailItemId: null,
        },
        { writer: { writerKind: "user" }, actingUserId: t.userId },
      ),
    ),
  );
}

describe("the mail agent tools (issue gh-1927)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    registry = await loadFullModuleRegistry();
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-agent-tools-"));
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
    events = [];
    deltas = [];
    storedBodiesAtPublish = [];
  });

  afterEach(() => {
    setInvalidationHook(() => {});
    setAgentRunDeltaHook(async () => {});
    vi.unstubAllEnvs();
  });

  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  /** Records every ephemeral delta published, and the body the draft held in the database at that moment. */
  function recordDeltas(): void {
    deltas = [];
    storedBodiesAtPublish = [];
    setAgentRunDeltaHook(async (event) => {
      deltas.push(event);
      const delta: unknown = event.delta;
      const draftId = typeof delta === "object" && delta !== null && "draftId" in delta ? delta.draftId : undefined;
      const { rows } = await runtime.query<{ body: string }>(
        "SELECT properties->>'body' AS body FROM items WHERE id = $1",
        [draftId],
      );
      storedBodiesAtPublish.push(rows[0]?.body);
    });
  }

  describe("composition", () => {
    it("lists the four tools for a run of the project that owns the mail databases and classifies the three draft tools without approval", async () => {
      const { runId } = await runOf(tenant);

      const tools = (await toolsFor(tenant, runId)).filter((tool) => tool.name.startsWith("mail."));

      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "mail.draft.create",
        "mail.draft.send",
        "mail.draft.update",
        "mail.thread.get",
      ]);
      expect(Object.fromEntries(tools.map((tool) => [tool.name, [tool.requiresApproval, tool.riskClass]]))).toEqual({
        "mail.thread.get": [false, "read"],
        "mail.draft.create": [false, "write"],
        "mail.draft.update": [false, "write"],
        "mail.draft.send": [false, "unclassified"],
      });
    });

    it("leaves out the three tools for a run of a project that does not own the mail databases", async () => {
      const inbox = await inTenant(tenant, () =>
        withTransaction(runtime, (client) => databasesStore.getDatabaseByModuleId(client, "inbox")),
      );
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const { runId } = await runOf(tenant, { projectItemId: inbox.ownerProjectItemId });

      const names = (await toolsFor(tenant, runId, inbox.ownerProjectItemId)).map((tool) => tool.name);

      expect(names.filter((name) => name.startsWith("mail."))).toEqual([]);
    });

    it("offers the read tool only with mail.read and the two draft tools only with mail.draft", async () => {
      const { runId } = await runOf(tenant);
      const mailNames = async (granted: string[]) =>
        (await toolsFor(tenant, runId, tenant.mailProjectId, new Set(granted)))
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("mail."))
          .sort();

      expect(await mailNames(["mail.read"])).toEqual(["mail.thread.get"]);
      expect(await mailNames(["mail.draft"])).toEqual(["mail.draft.create", "mail.draft.update"]);
      expect(await mailNames([])).toEqual([]);
    });

    it("declares argument schemas that refuse an unknown key, a wrongly typed value and a missing required one", async () => {
      const { runId } = await runOf(tenant);
      const get = await toolNamed(tenant, runId, "mail.thread.get");
      const create = await toolNamed(tenant, runId, "mail.draft.create");
      const update = await toolNamed(tenant, runId, "mail.draft.update");

      expect(get.acceptsArguments({ threadId: randomUUID() })).toBe(true);
      expect(get.acceptsArguments({ threadId: "not-a-uuid" })).toBe(false);
      expect(get.acceptsArguments({ threadId: randomUUID(), extra: 1 })).toBe(false);
      expect(create.acceptsArguments({ mode: "new", mailboxId: randomUUID(), body: "x" })).toBe(true);
      expect(create.acceptsArguments({ mode: "reply", threadId: randomUUID(), body: "x" })).toBe(true);
      expect(create.acceptsArguments({ mode: "send", body: "x" })).toBe(false);
      expect(create.acceptsArguments({ mode: "new", mailboxId: randomUUID() })).toBe(false);
      expect(create.acceptsArguments({ mode: "new", mailboxId: randomUUID(), body: "x", from: OWN_ADDRESS })).toBe(
        false,
      );
      expect(
        create.acceptsArguments({ mode: "new", mailboxId: randomUUID(), body: "x", to: [{ address: "no" }] }),
      ).toBe(false);
      expect(update.acceptsArguments({ draftId: randomUUID(), body: "x" })).toBe(true);
      expect(update.acceptsArguments({ draftId: randomUUID(), body: "x", subject: "a\r\nb" })).toBe(false);
      expect(update.acceptsArguments({ draftId: randomUUID() })).toBe(false);
      await expect(inTenant(tenant, () => update.invoke({ draftId: randomUUID() }))).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("answers a bad argument object of a handler called directly with a 400 and writes nothing", async () => {
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      for (const [factory, args] of [
        [createMailThreadGetTool, { threadId: "x" }],
        [createMailDraftCreateTool, { mode: "new" }],
        [createMailDraftUpdateTool, { draftId: randomUUID() }],
      ] as const) {
        const answer = await inTenant(tenant, () => factory(runtime)(runId, args));
        expect(refusalOf(answer)).toMatchObject({ status: 400, message: "Invalid arguments" });
      }
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("refuses a run that does not exist with a 404 and a run without a project with a 403, for every tool", async () => {
      const noProject = await runOf(tenant, { projectItemId: null });
      const threadId = randomUUID();
      const before = await writtenState(tenant);

      for (const [factory, args] of [
        [createMailThreadGetTool, { threadId }],
        [createMailDraftCreateTool, { mode: "new", mailboxId: tenant.mailboxId, body: "x" }],
        [createMailDraftUpdateTool, { draftId: randomUUID(), body: "x" }],
      ] as const) {
        const unknown = await inTenant(tenant, () => factory(runtime)(randomUUID(), args));
        expect(refusalOf(unknown)).toMatchObject({ status: 404, message: "Run not found" });
        const withoutProject = await inTenant(tenant, () => factory(runtime)(noProject.runId, args));
        expect(refusalOf(withoutProject)).toMatchObject({ status: 403, error: "forbidden" });
      }
      expect(await writtenState(tenant)).toEqual(before);
    });
  });

  describe("mail.thread.get", () => {
    it("returns the thread as text with its messages, recipients, dates, attachment names, people, company and project", async () => {
      const first = await receive(tenant, {
        messageId: "<first@example.test>",
        subject: "Offer",
        bodyText: "Hello,\nthe offer is attached.",
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }], cc: [JANA] },
        attachmentNames: ["offer.pdf"],
        date: new Date("2026-10-01T09:00:00Z"),
      });
      const second = await receive(tenant, {
        messageId: "<second@example.test>",
        subject: "Re: Offer",
        bodyText: "Thanks, I will read it.",
        envelope: { from: { name: "Me", address: OWN_ADDRESS }, to: [PETR] },
        references: ["<first@example.test>"],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      const threadId = await threadOf(tenant, first);
      expect(await threadOf(tenant, second)).toBe(threadId);
      await inTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const db = (key: string) => databases.find((row) => row.ownerModuleId === key)?.id ?? "";
        const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Website" } });
        const threadItem = await runtime.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
          threadId,
        ]);
        const threadItemId = threadItem.rows[0]?.item_id;
        if (!threadItemId) throw new Error("The thread has no item");
        const projectProperty = (await cp.listProperties(db("threads"))).find((row) => row.key === "project");
        if (!projectProperty) throw new Error("Missing the Threads project property");
        await cp.createRelation(
          { relationPropertyId: projectProperty.id, callerItemId: threadItemId, targetItemId: project.id },
          { writerKind: "user" },
        );
      });
      const { runId } = await runOf(tenant);

      const answer = await call(tenant, runId, "mail.thread.get", { threadId });

      expect(answer.error).toBe(false);
      const thread = threadSchema.parse(JSON.parse(answer.result));
      expect(thread).toMatchObject({ threadId, subject: "Re: Offer", messageCount: 2, company: null });
      expect(thread.project).toMatchObject({ name: "Website" });
      expect(thread.participants.map((participant) => participant.address).sort()).toEqual(
        [PETR.address, OWN_ADDRESS, JANA.address].sort(),
      );
      expect(thread.messages.map((message) => message.emailId)).toEqual([first, second]);
      expect(thread.messages[0]).toMatchObject({
        mailboxId: tenant.mailboxId,
        folderPurpose: "inbox",
        isOwn: false,
        from: PETR,
        to: [{ address: OWN_ADDRESS }],
        cc: [{ address: JANA.address }],
        date: "2026-10-01T09:00:00.000000Z",
        bodyText: "Hello,\nthe offer is attached.",
        bodyTruncated: false,
        attachments: ["offer.pdf"],
      });
      expect(thread.messages[1]).toMatchObject({ isOwn: true, attachments: [], bodyText: "Thanks, I will read it." });
    });

    it("returns the company of the thread and the person who wrote its latest message, with their ids and names", async () => {
      const message = await receive(tenant, { subject: "Offer", envelope: { from: PETR, to: [JANA] } });
      const threadId = await threadOf(tenant, message);
      const { companyId, personId } = await inTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const db = (key: string) => databases.find((row) => row.ownerModuleId === key)?.id ?? "";
        const company = await cp.createItem({ databaseId: db("companies"), properties: { name: "Acme" } });
        const person = await cp.createItem({ databaseId: db("people"), properties: { name: "Petr Novák" } });
        await withTransaction(runtime, (client) => reindexPersonEmails(client, person.id, [PETR.address]));
        const threadItem = await runtime.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
          threadId,
        ]);
        const threadItemId = threadItem.rows[0]?.item_id;
        if (!threadItemId) throw new Error("The thread has no item");
        const companyProperty = (await cp.listProperties(db("threads"))).find((row) => row.key === "company");
        if (!companyProperty) throw new Error("Missing the Threads company property");
        await cp.createRelation(
          { relationPropertyId: companyProperty.id, callerItemId: threadItemId, targetItemId: company.id },
          { writerKind: "user" },
        );
        return { companyId: company.id, personId: person.id };
      });
      const { runId } = await runOf(tenant);

      const thread = threadSchema.parse(
        JSON.parse((await call(tenant, runId, "mail.thread.get", { threadId })).result),
      );

      expect(thread.company).toMatchObject({ id: companyId, name: "Acme" });
      expect(thread.senderPerson).toMatchObject({ id: personId, name: "Petr Novák" });
      expect(thread.project).toBeNull();
    });

    it("returns the current thread for the id of a thread that was merged into it", async () => {
      const message = await receive(tenant, { subject: "Merged" });
      const keptId = await threadOf(tenant, message);
      const goneId = await inTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const gone = await createMailThread(client, "Old");
          await reassignThread(client, gone.id, keptId);
          return gone.id;
        }),
      );
      const { runId } = await runOf(tenant);

      const answer = await call(tenant, runId, "mail.thread.get", { threadId: goneId });

      const thread = threadSchema.parse(JSON.parse(answer.result));
      expect(thread.threadId).toBe(keptId);
      expect(thread.messages.map((entry) => entry.emailId)).toEqual([message]);
    });

    it("answers an unknown thread and another tenant's thread with the same 404 and writes nothing", async () => {
      const foreign = await receive(other, { subject: "Foreign" });
      const foreignThread = await threadOf(other, foreign);
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      const unknown = await call(tenant, runId, "mail.thread.get", { threadId: randomUUID() });
      const crossTenant = await call(tenant, runId, "mail.thread.get", { threadId: foreignThread });

      expect(refusalOf(unknown)).toMatchObject({ status: 404, error: "not_found", message: "Thread not found" });
      expect(refusalOf(crossTenant)).toEqual(refusalOf(unknown));
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("cuts a long message and serves the newest messages first when the text of the thread is over its limit", async () => {
      const ids: string[] = [];
      let references: string[] = [];
      for (let index = 0; index < 13; index += 1) {
        const messageId = `<m${index}@example.test>`;
        ids.push(
          await receive(tenant, {
            messageId,
            bodyText: index === 12 ? "short and newest" : "x".repeat(25_000),
            references,
            date: new Date(Date.UTC(2026, 9, 1 + index, 9)),
          }),
        );
        references = [...references, messageId];
      }
      const threadId = await threadOf(tenant, ids[0] ?? "");
      const { runId } = await runOf(tenant);

      const thread = threadSchema.parse(
        JSON.parse((await call(tenant, runId, "mail.thread.get", { threadId })).result),
      );

      expect(thread.messages.map((message) => message.emailId)).toEqual(ids);
      // The newest message takes 16 characters and nine more take 20000 each, so the tenth takes the 19984 that are left
      // of 200000 and the two oldest take none.
      expect(thread.messages.map((message) => message.bodyText.length)).toEqual([
        0, 0, 19_984, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 16,
      ]);
      expect(thread.messages.map((message) => message.bodyTruncated)).toEqual([
        ...Array.from({ length: 12 }, () => true),
        false,
      ]);
    });
  });

  describe("mail.draft.create with mode new", () => {
    it("creates a draft without a thread from the primary address of the mailbox, as the agent of the run", async () => {
      const { runId, conversationId } = await runOf(tenant, { withThread: true });
      recordThreadAnnouncements();

      const answer = await call(tenant, runId, "mail.draft.create", {
        mode: "new",
        mailboxId: tenant.mailboxId,
        to: [PETR],
        cc: [JANA],
        subject: "Hello",
        body: "A new mail",
      });

      const draft = draftOf(answer);
      expect(draft).toMatchObject({
        mailboxId: tenant.mailboxId,
        from: OWN_ADDRESS,
        to: [PETR],
        cc: [JANA],
        bcc: [],
        subject: "Hello",
        body: "A new mail",
        threadId: null,
        mode: "new",
        sourceEmailId: null,
        attachments: [],
        createdBy: "agent",
        lastEditedBy: "agent",
        sentAt: null,
      });
      const row = await draftRow(tenant, draft.id);
      expect(row).toMatchObject({ agentRunId: runId, conversationId, inReplyTo: null, references: [] });
      expect(events).toEqual([]);
      expect(await writtenState(tenant)).toMatchObject({ drafts: 1 });
    });

    it("records no conversation for a run without a Semp thread, and defaults the recipients and the subject to none", async () => {
      const { runId } = await runOf(tenant);

      const draft = draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "new", mailboxId: tenant.mailboxId, body: "Only text" }),
      );

      expect(draft).toMatchObject({ to: [], cc: [], bcc: [], subject: "" });
      expect(await draftRow(tenant, draft.id)).toMatchObject({ agentRunId: runId, conversationId: null });
    });

    it("puts the draft in the thread it names, and answers 404 for a thread that does not exist", async () => {
      const message = await receive(tenant);
      const threadId = await threadOf(tenant, message);
      const { runId } = await runOf(tenant);

      const inThread = draftOf(
        await call(tenant, runId, "mail.draft.create", {
          mode: "new",
          mailboxId: tenant.mailboxId,
          threadId,
          body: "Into the thread",
        }),
      );
      const before = await writtenState(tenant);
      const unknown = await call(tenant, runId, "mail.draft.create", {
        mode: "new",
        mailboxId: tenant.mailboxId,
        threadId: randomUUID(),
        body: "Nowhere",
      });

      expect(inThread.threadId).toBe(threadId);
      expect(refusalOf(unknown)).toMatchObject({ status: 404, message: "Thread not found" });
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("refuses a new draft without a mailbox with a 400 and writes nothing", async () => {
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      const answer = await call(tenant, runId, "mail.draft.create", { mode: "new", body: "x" });

      expect(refusalOf(answer)).toMatchObject({ status: 400, field: "mailboxId" });
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("refuses a new draft that names a source message with a 400 and writes nothing", async () => {
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      const answer = await call(tenant, runId, "mail.draft.create", {
        mode: "new",
        mailboxId: tenant.mailboxId,
        sourceEmailId: randomUUID(),
        body: "x",
      });

      expect(refusalOf(answer)).toMatchObject({ status: 400, field: "sourceEmailId" });
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("answers 404 for an unknown mailbox, another tenant's mailbox and a mailbox in the Trash, and writes nothing", async () => {
      const { runId } = await runOf(tenant);
      const trashed = await inTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const mailboxes = databases.find((row) => row.ownerModuleId === "mailboxes");
        if (!mailboxes) throw new Error("Missing mailboxes");
        const created = await cp.createItem({
          databaseId: mailboxes.id,
          properties: { name: "Old", provider: "gmail" },
        });
        await withTransaction(runtime, (client) =>
          itemDeleteWithClient(client, mailboxes.id, created.id, { queueAffinity: createActionQueueAffinity() }),
        );
        return created.id;
      });
      const before = await writtenState(tenant);

      for (const mailboxId of [randomUUID(), other.mailboxId, trashed]) {
        const answer = await call(tenant, runId, "mail.draft.create", { mode: "new", mailboxId, body: "x" });
        expect(refusalOf(answer)).toMatchObject({ status: 404, message: "Mailbox not found" });
      }
      expect(await writtenState(tenant)).toEqual(before);
      expect(await writtenState(other)).toMatchObject({ drafts: 0 });
    });

    it("answers 400 for a mailbox that has no address to send from", async () => {
      const { runId } = await runOf(tenant);
      const addressless = await inTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const mailboxes = databases.find((row) => row.ownerModuleId === "mailboxes");
        if (!mailboxes) throw new Error("Missing mailboxes");
        return (await cp.createItem({ databaseId: mailboxes.id, properties: { name: "Empty", provider: "gmail" } })).id;
      });
      const before = await writtenState(tenant);

      const answer = await call(tenant, runId, "mail.draft.create", { mode: "new", mailboxId: addressless, body: "x" });

      expect(refusalOf(answer)).toMatchObject({ status: 400, field: "mailboxId" });
      expect(await writtenState(tenant)).toEqual(before);
    });
  });

  describe("mail.draft.create with a source message", () => {
    it("creates a reply draft for a thread with the In-Reply-To of its newest incoming message, from the address it was delivered to", async () => {
      await receive(tenant, { messageId: "<older@example.test>", date: new Date("2026-10-01T09:00:00Z") });
      const incoming = await receive(tenant, {
        messageId: "<incoming@example.test>",
        subject: "Offer",
        bodyText: "Please answer",
        references: ["<older@example.test>"],
        deliveredToHeaders: [ALIAS_ADDRESS],
        date: new Date("2026-10-02T09:00:00Z"),
      });
      await receive(tenant, {
        messageId: "<mine@example.test>",
        envelope: { from: { name: "Me", address: OWN_ADDRESS }, to: [PETR] },
        references: ["<older@example.test>", "<incoming@example.test>"],
        date: new Date("2026-10-03T09:00:00Z"),
      });
      const threadId = await threadOf(tenant, incoming);
      const { runId, conversationId } = await runOf(tenant, { withThread: true });
      recordThreadAnnouncements();

      const draft = draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "Here is my answer" }),
      );

      expect(draft).toMatchObject({
        mailboxId: tenant.mailboxId,
        from: ALIAS_ADDRESS,
        to: [PETR],
        subject: "Re: Offer",
        threadId,
        mode: "reply",
        sourceEmailId: incoming,
        createdBy: "agent",
      });
      expect(draft.body.startsWith("Here is my answer\n\nOn ")).toBe(true);
      expect(draft.body.endsWith("\n> Please answer")).toBe(true);
      const row = await draftRow(tenant, draft.id);
      expect(row.inReplyTo).toBe("<incoming@example.test>");
      expect(row.references.at(-1)).toBe("<incoming@example.test>");
      expect(row).toMatchObject({ agentRunId: runId, conversationId });
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });

    it("answers the newest message that is not a draft when the thread has none but its own, and skips a draft of the provider", async () => {
      const mine = await receive(tenant, {
        messageId: "<mine@example.test>",
        envelope: { from: { name: "Me", address: OWN_ADDRESS }, to: [PETR] },
        date: new Date("2026-10-01T09:00:00Z"),
      });
      await receive(tenant, {
        messageId: "<provider-draft@example.test>",
        envelope: { from: { name: "Me", address: OWN_ADDRESS }, to: [PETR] },
        references: ["<mine@example.test>"],
        folder: "drafts",
        date: new Date("2026-10-02T09:00:00Z"),
      });
      const threadId = await threadOf(tenant, mine);
      const { runId } = await runOf(tenant);

      const draft = draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "replyAll", threadId, body: "Again" }),
      );

      expect(draft).toMatchObject({ sourceEmailId: mine, mode: "replyAll", threadId });
    });

    it("answers 404 for a thread that holds nothing but drafts of the provider, and writes nothing", async () => {
      const onlyDraft = await receive(tenant, { folder: "drafts" });
      const threadId = await threadOf(tenant, onlyDraft);
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      const answer = await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "x" });

      expect(refusalOf(answer)).toMatchObject({ status: 404, message: "The thread has no message to answer" });
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("creates a reply whose mailbox comes from the source message, and ignores the mailbox the call gives", async () => {
      const source = await receive(tenant, { subject: "Offer", envelope: { from: PETR, to: [JANA], replyTo: [JANA] } });
      const { runId } = await runOf(tenant);

      const draft = draftOf(
        await call(tenant, runId, "mail.draft.create", {
          mode: "reply",
          sourceEmailId: source,
          mailboxId: other.mailboxId,
          body: "x",
        }),
      );

      expect(draft).toMatchObject({
        mailboxId: tenant.mailboxId,
        from: OWN_ADDRESS,
        to: [JANA],
        cc: [],
        subject: "Re: Offer",
        sourceEmailId: source,
      });
    });

    it("addresses a forward with the recipients and the subject the call gives, and keeps the rest of the prefill", async () => {
      const source = await receive(tenant, { subject: "Offer", bodyText: "The offer" });
      const { runId } = await runOf(tenant);

      const draft = draftOf(
        await call(tenant, runId, "mail.draft.create", {
          mode: "forward",
          sourceEmailId: source,
          to: [JANA],
          cc: [PETR],
          bcc: [{ name: "", address: "boss@example.test" }],
          subject: "For your information",
          body: "FYI",
        }),
      );

      expect(draft).toMatchObject({
        mailboxId: tenant.mailboxId,
        from: OWN_ADDRESS,
        to: [JANA],
        cc: [PETR],
        bcc: [{ name: "", address: "boss@example.test" }],
        subject: "For your information",
        mode: "forward",
        sourceEmailId: source,
        createdBy: "agent",
      });
      expect(draft.body).toContain("FYI\n\n---------- Forwarded message ----------");
      expect(draft.body).toContain("> The offer");
    });

    it("replaces the computed recipients and subject of a reply and a reply-all with those the call gives, field by field", async () => {
      const envelope = { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }, JANA] };
      // Two threads, as an agent has one unsent draft for each.
      const source = await receive(tenant, { subject: "Offer", envelope });
      const second = await receive(tenant, { subject: "Offer", envelope });
      const { runId } = await runOf(tenant);

      const reply = draftOf(
        await call(tenant, runId, "mail.draft.create", {
          mode: "reply",
          sourceEmailId: source,
          to: [JANA],
          body: "x",
        }),
      );
      const replyAll = draftOf(
        await call(tenant, runId, "mail.draft.create", {
          mode: "replyAll",
          sourceEmailId: second,
          subject: "Re: Offer, new terms",
          cc: [PETR],
          body: "y",
        }),
      );

      // The reply's recipients are the ones given and its subject stays computed.
      expect(reply).toMatchObject({ to: [JANA], subject: "Re: Offer" });
      // The reply-all keeps its computed recipients and takes the subject and the Cc the call gives.
      expect(replyAll).toMatchObject({ to: [PETR, JANA], cc: [PETR], subject: "Re: Offer, new terms" });
    });

    it("creates a reply-all draft in the language of the user, without the addresses of the mailbox", async () => {
      const czech = await seededTenant("cs");
      const source = await receive(czech, {
        subject: "Nabídka",
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }, JANA] },
        bodyText: "Dobrý den",
      });
      const { runId } = await runOf(czech);

      const replyAll = draftOf(
        await call(czech, runId, "mail.draft.create", { mode: "replyAll", sourceEmailId: source, body: "" }),
      );

      expect(replyAll).toMatchObject({ to: [PETR, JANA], mode: "replyAll", subject: "Re: Nabídka" });
      expect(replyAll.body).toMatch(/^\n\nDne .* napsal\(a\) Petr Novák:\n> Dobrý den$/u);
    });

    it("creates a forward draft in the language of the user and copies the attachments, which the original message keeps", async () => {
      const czech = await seededTenant("cs");
      const source = await receive(czech, {
        subject: "Nabídka",
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }, JANA] },
        bodyText: "Dobrý den",
        attachmentNames: ["nabidka.pdf"],
      });
      const { runId } = await runOf(czech);

      const forward = draftOf(
        await call(czech, runId, "mail.draft.create", { mode: "forward", sourceEmailId: source, body: "FYI" }),
      );

      expect(forward).toMatchObject({ to: [], subject: "Fwd: Nabídka", mode: "forward", createdBy: "agent" });
      expect(forward.body).toContain(
        "FYI\n\n---------- Přeposlaná zpráva ----------\nOd: Petr Novák <petr@example.test>",
      );
      expect(forward.attachments.map((file) => file.filename)).toEqual(["nabidka.pdf"]);
      const copies = await attachmentsOf(czech, forward.id);
      const originals = await attachmentsOf(czech, source);
      expect(originals).toHaveLength(1);
      expect(copies.map((file) => file.name)).toEqual(["nabidka.pdf"]);
      expect(copies.map((file) => file.fileId)).not.toEqual(originals.map((file) => file.fileId));
    });

    it("refuses a forward over MAX_FILE_SIZE_MB in a mailbox without a provider limit with a 413, as the HTTP forward does, and writes nothing", async () => {
      await admin.query(
        'UPDATE items SET properties = properties || \'{"provider": "generic"}\'::jsonb WHERE tenant_id = $1 AND id = $2',
        [tenant.tenantId, tenant.mailboxId],
      );
      const source = await receive(tenant, { subject: "Offer", attachmentNames: ["one.pdf", "two.pdf"] });
      const { runId } = await runOf(tenant);
      // About 105 bytes: one fixture attachment weighs about 54 bytes, the two together about 108.
      vi.stubEnv("MAX_FILE_SIZE_MB", "0.0001");
      const before = await writtenState(tenant);

      const answer = await call(tenant, runId, "mail.draft.create", {
        mode: "forward",
        sourceEmailId: source,
        body: "",
      });

      expect(refusalOf(answer)).toMatchObject({ status: 413, error: "mail_attachment_too_large" });
      expect(await writtenState(tenant)).toEqual(before);
      expect(await attachmentsOf(tenant, source)).toHaveLength(2);
    });

    it("forwards in a mailbox without a provider limit what fits MAX_FILE_SIZE_MB, and with its default of 100 MB when it is not set", async () => {
      await admin.query(
        'UPDATE items SET properties = properties || \'{"provider": "generic"}\'::jsonb WHERE tenant_id = $1 AND id = $2',
        [tenant.tenantId, tenant.mailboxId],
      );
      const single = await receive(tenant, { subject: "One", attachmentNames: ["one.pdf"] });
      const pair = await receive(tenant, { subject: "Two", attachmentNames: ["a.pdf", "b.pdf"] });
      const { runId } = await runOf(tenant);

      const unset = draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "forward", sourceEmailId: pair, body: "" }),
      );
      vi.stubEnv("MAX_FILE_SIZE_MB", "0.0001");
      const fits = draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "forward", sourceEmailId: single, body: "" }),
      );

      expect(fits.attachments.map((file) => file.filename)).toEqual(["one.pdf"]);
      expect(unset.attachments.map((file) => file.filename).sort()).toEqual(["a.pdf", "b.pdf"]);
    });

    it("refuses a source message that is not in the thread the call names with a 400, and accepts the id of a merged-away thread", async () => {
      const source = await receive(tenant, { subject: "Offer" });
      const sourceThread = await threadOf(tenant, source);
      const otherMessage = await receive(tenant, { subject: "Unrelated" });
      const otherThread = await threadOf(tenant, otherMessage);
      const mergedId = await inTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const gone = await createMailThread(client, "Old");
          await reassignThread(client, gone.id, sourceThread);
          return gone.id;
        }),
      );
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      const mismatch = await call(tenant, runId, "mail.draft.create", {
        mode: "reply",
        sourceEmailId: source,
        threadId: otherThread,
        body: "x",
      });
      const unknownThread = await call(tenant, runId, "mail.draft.create", {
        mode: "reply",
        sourceEmailId: source,
        threadId: randomUUID(),
        body: "x",
      });

      expect(refusalOf(mismatch)).toMatchObject({ status: 400, field: "sourceEmailId" });
      expect(refusalOf(unknownThread)).toMatchObject({ status: 404, message: "Thread not found" });
      expect(await writtenState(tenant)).toEqual(before);
      const merged = draftOf(
        await call(tenant, runId, "mail.draft.create", {
          mode: "reply",
          sourceEmailId: source,
          threadId: mergedId,
          body: "x",
        }),
      );
      expect(merged.threadId).toBe(sourceThread);
    });

    it("refuses a source message without a thread when the call names a thread, and a reply that names neither", async () => {
      const elsewhere = await receive(tenant, { subject: "Elsewhere" });
      const elsewhereThread = await threadOf(tenant, elsewhere);
      const source = await receive(tenant, { subject: "Detached" });
      // A message the threading pass has not reached yet; no write of the API leaves a message without a thread.
      await admin.query("UPDATE mail_message_meta SET thread_id = NULL WHERE item_id = $1", [source]);
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      const detached = await call(tenant, runId, "mail.draft.create", {
        mode: "reply",
        sourceEmailId: source,
        threadId: elsewhereThread,
        body: "x",
      });
      const neither = await call(tenant, runId, "mail.draft.create", { mode: "forward", body: "x" });

      expect(refusalOf(detached)).toMatchObject({ status: 400, field: "sourceEmailId" });
      expect(refusalOf(neither)).toMatchObject({ status: 400, field: "sourceEmailId" });
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("answers 404 for an unknown source message, an unknown thread, another tenant's message and a draft as source", async () => {
      const foreign = await receive(other);
      const foreignThread = await threadOf(other, foreign);
      const own = await userDraft(tenant);
      const { runId } = await runOf(tenant);
      const before = await writtenState(tenant);

      for (const args of [
        { sourceEmailId: randomUUID() },
        { sourceEmailId: foreign },
        { sourceEmailId: own.id },
        { threadId: randomUUID() },
        { threadId: foreignThread },
      ]) {
        const answer = await call(tenant, runId, "mail.draft.create", { mode: "reply", body: "x", ...args });
        expect(refusalOf(answer).status, JSON.stringify(args)).toBe(404);
      }
      expect(await writtenState(tenant)).toEqual(before);
      expect(await writtenState(other)).toMatchObject({ drafts: 0 });
    });

    it("refuses a source message that belongs to no mailbox with a 400", async () => {
      const source = await receive(tenant);
      // A message of the legacy migration has no mailbox; no write of the API produces one.
      await admin.query("UPDATE mail_message_meta SET mailbox_item_id = NULL WHERE item_id = $1", [source]);
      const threadId = await threadOf(tenant, source);
      const { runId } = await runOf(tenant);

      const bySource = await call(tenant, runId, "mail.draft.create", {
        mode: "reply",
        sourceEmailId: source,
        body: "x",
      });
      const byThread = await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "x" });

      expect(refusalOf(bySource)).toMatchObject({ status: 400, field: "sourceEmailId" });
      expect(refusalOf(byThread)).toMatchObject({ status: 400, field: "threadId" });
      expect((await writtenState(tenant)).drafts).toBe(0);
    });

    it("refuses a second unsent agent draft for a thread with a 409 and writes nothing, while a person's draft of the thread is no obstacle", async () => {
      const source = await receive(tenant);
      const threadId = await threadOf(tenant, source);
      await userDraft(tenant, { threadId });
      const { runId } = await runOf(tenant);
      const first = draftOf(await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "First" }));
      const before = await writtenState(tenant);

      const second = await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "Second" });

      expect(refusalOf(second)).toMatchObject({ status: 409 });
      expect(await writtenState(tenant)).toEqual(before);
      expect((await draftRow(tenant, first.id)).sentAt).toBeNull();
    });

    it("names the open agent draft of the thread in the conflict it answers to a reply or a reply-all, by thread or by source message (issue gh-1941)", async () => {
      const source = await receive(tenant);
      const threadId = await threadOf(tenant, source);
      const { runId } = await runOf(tenant);
      const first = draftOf(await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "First" }));
      const before = await writtenState(tenant);

      for (const args of [
        { mode: "reply", threadId, body: "Second" },
        { mode: "replyAll", threadId, body: "Second" },
        { mode: "reply", sourceEmailId: source, body: "Second" },
      ]) {
        const answer = refusalOf(await call(tenant, runId, "mail.draft.create", args));

        expect(answer).toMatchObject({ status: 409, error: "mail_agent_draft_exists", draftId: first.id });
        expect(answer.message).toContain(first.id);
      }
      expect(await writtenState(tenant)).toEqual(before);
    });

    it("leaves a forward of the thread to the 409 of the draft store, which names no draft", async () => {
      const source = await receive(tenant);
      const threadId = await threadOf(tenant, source);
      const { runId } = await runOf(tenant);
      draftOf(await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "First" }));

      const forward = await call(tenant, runId, "mail.draft.create", {
        mode: "forward",
        sourceEmailId: source,
        to: [JANA],
        body: "Second",
      });

      expect(refusalOf(forward)).toMatchObject({ status: 409 });
      expect(JSON.parse(forward.result)).not.toHaveProperty("draftId");
      expect(JSON.parse(forward.result)).not.toMatchObject({ error: "mail_agent_draft_exists" });
    });

    it("allows a reply once the open agent draft of the thread was sent or belongs to another thread", async () => {
      const source = await receive(tenant);
      const threadId = await threadOf(tenant, source);
      const otherSource = await receive(tenant, { subject: "Something else" });
      const otherThreadId = await threadOf(tenant, otherSource);
      expect(otherThreadId).not.toBe(threadId);
      const { runId } = await runOf(tenant);
      const first = draftOf(await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "First" }));

      draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId: otherThreadId, body: "Other" }),
      );
      await inTenant(tenant, () => withTransaction(runtime, (client) => markMailDraftSent(client, first.id)));
      const next = draftOf(await call(tenant, runId, "mail.draft.create", { mode: "reply", threadId, body: "Next" }));

      expect(next.id).not.toBe(first.id);
    });
  });

  describe("mail.draft.update", () => {
    it("replaces the body of a draft, keeps its subject and recipients and marks the agent as the last editor", async () => {
      const draft = await userDraft(tenant);
      const { runId } = await runOf(tenant);
      recordThreadAnnouncements();

      const answer = draftOf(await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Agent text" }));

      expect(answer).toMatchObject({
        id: draft.id,
        body: "Agent text",
        subject: "My subject",
        to: [PETR],
        from: OWN_ADDRESS,
        createdBy: "user",
        lastEditedBy: "agent",
      });
      expect(await draftRow(tenant, draft.id)).toMatchObject({ createdBy: "user", lastEditedBy: "agent" });
    });

    it("changes the subject too when the call gives one, and announces the change on the draft's thread once", async () => {
      const message = await receive(tenant);
      const threadId = await threadOf(tenant, message);
      const draft = await userDraft(tenant, { threadId });
      const { runId } = await runOf(tenant);
      recordThreadAnnouncements();

      const answer = draftOf(
        await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Text", subject: "New subject" }),
      );

      expect(answer).toMatchObject({ subject: "New subject", body: "Text" });
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });

    it("updates a draft an agent created, and a second update after the first sees its version", async () => {
      const { runId } = await runOf(tenant);
      const created = draftOf(
        await call(tenant, runId, "mail.draft.create", { mode: "new", mailboxId: tenant.mailboxId, body: "One" }),
      );

      const first = draftOf(await call(tenant, runId, "mail.draft.update", { draftId: created.id, body: "Two" }));
      const second = draftOf(await call(tenant, runId, "mail.draft.update", { draftId: created.id, body: "Three" }));

      expect([first.body, second.body]).toEqual(["Two", "Three"]);
      expect(await draftRow(tenant, created.id)).toMatchObject({ createdBy: "agent", lastEditedBy: "agent" });
    });

    describe("a draft the user edited and a run no person asked for (issue gh-1941)", () => {
      async function bodyOf(draftId: string): Promise<string | undefined> {
        const { rows } = await admin.query<{ body: string }>(
          "SELECT properties->>'body' AS body FROM items WHERE id = $1",
          [draftId],
        );
        return rows[0]?.body;
      }

      it("refuses a run started by a heartbeat a draft whose last editor is the user, with a 409 naming the draft, and writes nothing", async () => {
        const draft = await userDraft(tenant);
        const { runId } = await runOf(tenant, { triggeredBy: "heartbeat" });

        const answer = await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Overwritten" });

        expect(refusalOf(answer)).toMatchObject({ status: 409, error: "mail_draft_edited_by_user", draftId: draft.id });
        expect(await bodyOf(draft.id)).toBe("My text");
        expect(await draftRow(tenant, draft.id)).toMatchObject({ lastEditedBy: "user" });
      });

      it("refuses it when the user saves the edit after the run began and the draft was the agent's before", async () => {
        const { runId } = await runOf(tenant, { triggeredBy: "heartbeat" });
        const created = draftOf(
          await call(tenant, runId, "mail.draft.create", { mode: "new", mailboxId: tenant.mailboxId, body: "Mine" }),
        );
        await inTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            updateEmailDraft(
              client,
              { draftItemId: created.id, ifVersion: created.updatedAt, body: "Edited by the user" },
              { writer: { writerKind: "user" }, actingUserId: tenant.userId },
            ),
          ),
        );

        const answer = await call(tenant, runId, "mail.draft.update", { draftId: created.id, body: "Agent again" });

        expect(refusalOf(answer)).toMatchObject({ status: 409, error: "mail_draft_edited_by_user" });
        expect(await bodyOf(created.id)).toBe("Edited by the user");
        expect(await draftRow(tenant, created.id)).toMatchObject({ createdBy: "agent", lastEditedBy: "user" });
      });

      it("refuses a run that a heartbeat run delegated to", async () => {
        const draft = await userDraft(tenant);
        const parent = await runOf(tenant, { triggeredBy: "heartbeat" });
        const child = await runOf(tenant, { triggeredBy: "supervisor", parentRunId: parent.runId });

        const answer = await call(tenant, child.runId, "mail.draft.update", { draftId: draft.id, body: "Overwritten" });

        expect(refusalOf(answer)).toMatchObject({ status: 409, error: "mail_draft_edited_by_user" });
        expect(await bodyOf(draft.id)).toBe("My text");
      });

      it("still updates the draft the agent last edited, and a run a person asked for may rewrite the user's draft", async () => {
        const heartbeat = await runOf(tenant, { triggeredBy: "heartbeat" });
        const created = draftOf(
          await call(tenant, heartbeat.runId, "mail.draft.create", {
            mode: "new",
            mailboxId: tenant.mailboxId,
            body: "One",
          }),
        );
        const userAsked = await runOf(tenant);
        const userOwned = await userDraft(tenant);

        const revised = draftOf(
          await call(tenant, heartbeat.runId, "mail.draft.update", { draftId: created.id, body: "Two" }),
        );
        const rewritten = draftOf(
          await call(tenant, userAsked.runId, "mail.draft.update", { draftId: userOwned.id, body: "Asked for" }),
        );

        expect([revised.body, rewritten.body]).toEqual(["Two", "Asked for"]);
      });
    });

    it("refuses a sent draft with a 409 and changes nothing", async () => {
      const draft = await userDraft(tenant);
      await inTenant(tenant, () => withTransaction(runtime, (client) => markMailDraftSent(client, draft.id)));
      const { runId } = await runOf(tenant);

      const answer = await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Too late" });

      expect(refusalOf(answer)).toMatchObject({ status: 409, error: "mail_draft_already_sent" });
      const row = await draftRow(tenant, draft.id);
      expect(row.lastEditedBy).toBe("user");
      const reread = await inTenant(tenant, () =>
        runtime.query<{ body: string }>("SELECT properties->>'body' AS body FROM items WHERE id = $1", [draft.id]),
      );
      expect(reread.rows[0]?.body).toBe("My text");
    });

    it("refuses a discarded draft with a 404", async () => {
      const draft = await userDraft(tenant);
      await inTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          discardEmailDraft(client, draft.id, { writer: { writerKind: "user" }, actingUserId: tenant.userId }),
        ),
      );
      const { runId } = await runOf(tenant);

      const answer = await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Back" });

      expect(refusalOf(answer)).toMatchObject({ status: 404, message: "Draft not found" });
    });

    it("refuses a message that has no draft row with a 409, and an unknown or another tenant's draft with a 404", async () => {
      const received = await receive(tenant);
      const foreignDraft = await userDraft(other);
      const { runId } = await runOf(tenant);

      const notEditable = await call(tenant, runId, "mail.draft.update", { draftId: received, body: "x" });
      const unknown = await call(tenant, runId, "mail.draft.update", { draftId: randomUUID(), body: "x" });
      const crossTenant = await call(tenant, runId, "mail.draft.update", { draftId: foreignDraft.id, body: "x" });

      expect(refusalOf(notEditable)).toMatchObject({ status: 409, error: "mail_draft_not_editable" });
      expect(refusalOf(unknown)).toMatchObject({ status: 404, message: "Draft not found" });
      expect(refusalOf(crossTenant)).toEqual(refusalOf(unknown));
      expect(await draftRow(other, foreignDraft.id)).toMatchObject({ lastEditedBy: "user" });
    });
  });

  describe("mail.draft.update delta frames (issue gh-1948)", () => {
    it("publishes the new body of the draft to the run before the update is committed, and then writes it", async () => {
      const draft = await userDraft(tenant);
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      const answer = draftOf(await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Agent text" }));

      expect(deltas).toEqual([
        { agentRunId: runId, delta: { kind: "mailDraftBody", draftId: draft.id, body: "Agent text" } },
      ]);
      expect(storedBodiesAtPublish).toEqual(["My text"]);
      expect(answer).toMatchObject({ id: draft.id, body: "Agent text", lastEditedBy: "agent" });
    });

    it("publishes one frame per update, in the order of the updates, each with the draft id", async () => {
      const first = await userDraft(tenant);
      const second = await userDraft(tenant);
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      draftOf(await call(tenant, runId, "mail.draft.update", { draftId: first.id, body: "One" }));
      draftOf(await call(tenant, runId, "mail.draft.update", { draftId: second.id, body: "Two", subject: "Other" }));

      expect(deltas.map((event) => event.delta)).toEqual([
        { kind: "mailDraftBody", draftId: first.id, body: "One" },
        { kind: "mailDraftBody", draftId: second.id, body: "Two" },
      ]);
    });

    it("publishes nothing for a run without a Semp thread and still updates the draft", async () => {
      const draft = await userDraft(tenant);
      const { runId } = await runOf(tenant);
      recordDeltas();

      const answer = draftOf(await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Agent text" }));

      expect(deltas).toEqual([]);
      expect(answer).toMatchObject({ body: "Agent text", lastEditedBy: "agent" });
    });

    it("publishes nothing for a sent draft, which is refused with a 409 and left as it was", async () => {
      const draft = await userDraft(tenant);
      await inTenant(tenant, () => withTransaction(runtime, (client) => markMailDraftSent(client, draft.id)));
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      const answer = await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Too late" });

      expect(refusalOf(answer)).toMatchObject({ status: 409, error: "mail_draft_already_sent" });
      expect(deltas).toEqual([]);
      expect((await draftRow(tenant, draft.id)).lastEditedBy).toBe("user");
    });

    it("publishes nothing for a discarded draft, which is refused with a 404", async () => {
      const draft = await userDraft(tenant);
      await inTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          discardEmailDraft(client, draft.id, { writer: { writerKind: "user" }, actingUserId: tenant.userId }),
        ),
      );
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      const answer = await call(tenant, runId, "mail.draft.update", { draftId: draft.id, body: "Back" });

      expect(refusalOf(answer)).toMatchObject({ status: 404, message: "Draft not found" });
      expect(deltas).toEqual([]);
    });

    it("publishes nothing for a message that has no draft row, which is refused with a 409", async () => {
      const received = await receive(tenant);
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      const answer = await call(tenant, runId, "mail.draft.update", { draftId: received, body: "x" });

      expect(refusalOf(answer)).toMatchObject({ status: 409, error: "mail_draft_not_editable" });
      expect(deltas).toEqual([]);
    });

    it("publishes nothing for another tenant's draft, which is refused as an unknown id is", async () => {
      const foreignDraft = await userDraft(other);
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      const crossTenant = await call(tenant, runId, "mail.draft.update", { draftId: foreignDraft.id, body: "x" });
      const unknown = await call(tenant, runId, "mail.draft.update", { draftId: randomUUID(), body: "x" });

      expect(refusalOf(crossTenant)).toEqual(refusalOf(unknown));
      expect(deltas).toEqual([]);
      expect(await draftRow(other, foreignDraft.id)).toMatchObject({ lastEditedBy: "user" });
    });

    it("publishes nothing for a blank subject, which the write would refuse, and leaves the draft as it was", async () => {
      const draft = await userDraft(tenant);
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      for (const subject of ["", "   "]) {
        const answer = await inTenant(tenant, () =>
          createMailDraftUpdateTool(runtime)(runId, { draftId: draft.id, body: "New text", subject }),
        );
        expect(refusalOf(answer)).toMatchObject({ status: 400, message: "Invalid arguments" });
      }

      expect(deltas).toEqual([]);
      expect(await draftRow(tenant, draft.id)).toMatchObject({ lastEditedBy: "user" });
    });

    it("publishes nothing for arguments the schema refuses", async () => {
      const draft = await userDraft(tenant);
      const { runId } = await runOf(tenant, { withThread: true });
      recordDeltas();

      const answer = await inTenant(tenant, () => createMailDraftUpdateTool(runtime)(runId, { draftId: draft.id }));

      expect(refusalOf(answer)).toMatchObject({ status: 400, message: "Invalid arguments" });
      expect(deltas).toEqual([]);
    });
  });
});
