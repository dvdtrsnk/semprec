import "../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { htmlToPlainText } from "../mail/mailPlainText.js";
import { createMailThreadDetailRouteHandler, createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;

const HOSTILE_BODY =
  '<p onclick="steal()">Dobrý den</p><script>alert(1)</script>' +
  '<img src="https://tracker.example/pixel.gif" onerror="track()" alt="logo"><a href="https://example.test/offer">Nabídka</a>';

interface AttachmentInput {
  filename: string;
  content: string;
}

describe("GET /api/mail/threads/:threadId (issue #1632)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-detail-"));
    const role = await runAsSystem("verify mail detail test role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  /** Two mailboxes and their folders, and an ingest through the sync writer (`ingestEmailMessage`). */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const d = databases.find((row) => row.ownerModuleId === key);
      if (!d) throw new Error(`Missing ${key}`);
      return d.id;
    };
    const properties = await cp.listProperties(db("emails"));
    const property = (key: string) => {
      const p = properties.find((row) => row.key === key);
      if (!p) throw new Error(`Missing ${key}`);
      return p.id;
    };
    const boxA = await cp.createItem({
      databaseId: db("mailboxes"),
      properties: { name: "Personal", provider: "gmail" },
    });
    const boxB = await cp.createItem({
      databaseId: db("mailboxes"),
      properties: { name: "Work", provider: "outlook" },
    });
    const folders = await withTransaction(runtime, async (client) => {
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes"),
        mailboxItemId: boxA.id,
        address: "me@example.test",
      });
      const create = async (name: string, specialPurpose: string) =>
        createItemWithClient(
          client,
          { databaseId: db("folders"), properties: { name, behavior: "folder", specialPurpose } },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        );
      return {
        inbox: await create("Inbox", "inbox"),
        sent: await create("Sent", "sent"),
        drafts: await create("Drafts", "drafts"),
      };
    });
    const storage = new LocalFsBlobStorageWriter(storageRoot);
    const ingest = (input: {
      id: string;
      mailbox?: string;
      folder?: string;
      refs?: string[];
      from?: string;
      date?: Date;
      bodyHtml?: string;
      attachments?: AttachmentInput[];
      subject?: string;
    }) =>
      withTransaction(runtime, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: db("emails"),
          filesDatabaseId: db("files"),
          folderRelationPropertyId: property("folder"),
          attachmentsRelationPropertyId: property("attachments"),
          mailboxItemId: input.mailbox ?? boxA.id,
          folderItemId: input.folder ?? folders.inbox.id,
          messageId: input.id,
          references: input.refs ?? [],
          subject: input.subject ?? "Re: Nabídka na web",
          date: input.date,
          envelope: {
            from: {
              name: input.from === "me@example.test" ? "Me" : "Klient",
              address: input.from ?? "klient@example.test",
            },
            to: [{ name: "Me", address: "me@example.test" }],
            cc: [{ address: "kolega@example.test" }],
            replyTo: [{ name: "Klient", address: "reply@example.test" }],
          },
          bodyHtml: input.bodyHtml ?? `<p>${input.id}</p>`,
          attachments: (input.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            contentType: "text/plain",
            contentId: null,
            disposition: "attachment" as const,
            openStream: () => Readable.from([attachment.content]),
          })),
          storage,
          storageKeyPrefix: "detail-fixtures",
        }),
      );
    return { db, boxA, boxB, folders, ingest };
  }

  /** The conversation "Re: Nabídka na web": the user's sent offer with one attachment, then three replies. */
  async function offerThread() {
    const f = await setup();
    const day = (n: number) => new Date(`2026-10-0${n}T09:00:00Z`);
    const first = await f.ingest({
      id: "<offer@example.test>",
      from: "me@example.test",
      folder: f.folders.sent.id,
      date: day(1),
      subject: "Nabídka na web",
      attachments: [{ filename: "nabidka.txt", content: "offer" }],
    });
    const second = await f.ingest({ id: "<reply-1@example.test>", refs: ["<offer@example.test>"], date: day(2) });
    // The same message delivered to a second mailbox: a second Emails item with the same Message-ID.
    const copy = await f.ingest({
      id: "<reply-1@example.test>",
      mailbox: f.boxB.id,
      refs: ["<offer@example.test>"],
      date: day(2),
    });
    const third = await f.ingest({
      id: "<reply-2@example.test>",
      refs: ["<offer@example.test>", "<reply-1@example.test>"],
      from: "me@example.test",
      folder: f.folders.sent.id,
      date: day(3),
    });
    const last = await f.ingest({
      id: "<reply-3@example.test>",
      refs: ["<offer@example.test>", "<reply-2@example.test>"],
      date: day(4),
      bodyHtml: HOSTILE_BODY,
      attachments: [
        { filename: "smlouva.txt", content: "contract" },
        { filename: "cenik.txt", content: "prices" },
      ],
    });
    const thread = await runtime.query<{ thread_id: string }>(
      "SELECT DISTINCT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND thread_id IS NOT NULL",
    );
    expect(thread.rows).toHaveLength(1);
    const threadId = thread.rows[0]?.thread_id;
    if (!threadId) throw new Error("Missing thread");
    return { f, threadId, first, second, copy, third, last };
  }

  async function threadOf(emailItemId: string): Promise<string> {
    const thread = await runtime.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
      [emailItemId],
    );
    const threadId = thread.rows[0]?.thread_id;
    if (!threadId) throw new Error("Message has no thread");
    return threadId;
  }

  const detail = (threadId: string, query = "") =>
    createMailThreadDetailRouteHandler(runtime)({
      req: { url: `/api/mail/threads/${threadId}${query}` },
      params: { threadId },
    });

  /** The real `mail_attachments` rows and the Files items linked through the Emails `attachments` edge. */
  async function storedAttachments(emailItemId: string) {
    const rows = await runtime.query<{ blob_id: string; filename: string; byte_size: number }>(
      "SELECT blob_id, filename, byte_size::int AS byte_size FROM mail_attachments WHERE tenant_id = app_tenant_default() AND message_item_id = $1 ORDER BY filename",
      [emailItemId],
    );
    const files = await runtime.query<{ id: string; blob_id: string; name: string }>(
      `SELECT f.id, f.properties->'file'->>'blobId' AS blob_id, f.properties->>'name' AS name
       FROM item_relations r JOIN items f ON f.tenant_id = r.tenant_id AND f.id = r.item_b
       JOIN relation_definitions rd ON rd.tenant_id = r.tenant_id AND rd.id = r.relation_definition_id
       JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id = rd.property_id_a AND p.key = 'attachments'
       WHERE r.tenant_id = app_tenant_default() AND r.item_a = $1`,
      [emailItemId],
    );
    return rows.rows.map((row) => {
      const file = files.rows.find((candidate) => candidate.blob_id === row.blob_id && candidate.name === row.filename);
      if (!file) throw new Error(`No Files item for ${row.filename}`);
      return {
        fileItemId: file.id,
        blobId: row.blob_id,
        filename: row.filename,
        contentType: "text/plain",
        byteSize: row.byte_size,
      };
    });
  }

  it("returns the four messages of 'Re: Nabídka na web' in date order with the sent and the last attachments", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, first, second, copy, third, last } = await offerThread();
      const result = await detail(threadId);
      expect(result.status).toBe(200);
      const body = result.body;
      expect(body.threadId).toBe(threadId);
      expect(body.messages.map((message) => message.messageId)).toEqual([
        "<offer@example.test>",
        "<reply-1@example.test>",
        "<reply-2@example.test>",
        "<reply-3@example.test>",
      ]);
      expect(body.messages.map((message) => message.date)).toEqual([
        "2026-10-01T09:00:00.000000Z",
        "2026-10-02T09:00:00.000000Z",
        "2026-10-03T09:00:00.000000Z",
        "2026-10-04T09:00:00.000000Z",
      ]);
      const [sent, reply, ownReply, latest] = body.messages;
      expect(sent).toMatchObject({ emailId: first.itemId, isOwn: true, folderPurpose: "sent" });
      expect(reply?.isOwn).toBe(false);
      // One of the two mailbox copies of the reply, whichever the list's copy rule keeps.
      expect([second.itemId, copy.itemId]).toContain(reply?.emailId);
      expect(ownReply).toMatchObject({ emailId: third.itemId, isOwn: true, folderPurpose: "sent", attachments: [] });
      expect(latest).toMatchObject({ emailId: last.itemId, isOwn: false, folderPurpose: "inbox" });
      expect(sent?.attachments).toEqual(await storedAttachments(first.itemId));
      expect(sent?.attachments).toHaveLength(1);
      expect(latest?.attachments).toEqual(await storedAttachments(last.itemId));
      expect(latest?.attachments.map((attachment) => attachment.filename)).toEqual(["cenik.txt", "smlouva.txt"]);
      for (const attachment of [...(sent?.attachments ?? []), ...(latest?.attachments ?? [])]) {
        expect(attachment.blobId).toMatch(/^[0-9a-f-]{36}$/);
        expect(attachment.fileItemId).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(latest).toMatchObject({
        from: { name: "Klient", address: "klient@example.test" },
        to: [{ name: "Me", address: "me@example.test" }],
        cc: [{ name: "", address: "kolega@example.test" }],
        replyTo: [{ name: "Klient", address: "reply@example.test" }],
        read: false,
        flagged: false,
      });
    });
  });

  it("answers the header with exactly the fields and values of the thread's list row", async () => {
    await runInTenant(tenant, async () => {
      const { threadId } = await offerThread();
      const list = await createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads" } });
      const row = list.body.threads.find((candidate) => candidate.threadId === threadId);
      if (!row) throw new Error("Thread missing from the list");
      const { messages, ...header } = (await detail(threadId)).body;
      expect(messages).toHaveLength(4);
      expect(header).toEqual({
        threadId: row.threadId,
        subject: row.subject,
        lastMessageAt: row.lastMessageAt,
        lastSender: row.lastSender,
        participants: row.participants,
        messageCount: row.messageCount,
        unread: row.unread,
        flagged: row.flagged,
        mailboxes: row.mailboxes,
        senderPerson: row.senderPerson,
      });
      expect(header.messageCount).toBe(4);
    });
  });

  it("sanitizes scripts, on* attributes and remote images, and shows remote images only on request", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, last } = await offerThread();
      const stripped = (await detail(threadId)).body.messages.at(-1);
      const allowed = (await detail(threadId, "?allowRemoteImages=true")).body.messages.at(-1);
      const explicitFalse = (await detail(threadId, "?allowRemoteImages=false")).body.messages.at(-1);
      for (const html of [stripped?.bodyHtml, allowed?.bodyHtml, explicitFalse?.bodyHtml]) {
        expect(html).toContain("Dobrý den");
        expect(html).not.toContain("<script");
        expect(html).not.toContain("alert(1)");
        expect(html).not.toMatch(/\son\w+=/i);
      }
      expect(stripped?.bodyHtml).not.toContain("tracker.example");
      expect(explicitFalse?.bodyHtml).toBe(stripped?.bodyHtml);
      expect(allowed?.bodyHtml).toContain('src="https://tracker.example/pixel.gif"');
      expect(stripped?.bodyText).toBe(htmlToPlainText(HOSTILE_BODY));
      // Sanitizing is a read-time projection: the stored body keeps the raw HTML.
      const stored = await runtime.query<{ body: string }>(
        "SELECT properties->>'body' AS body FROM items WHERE tenant_id = app_tenant_default() AND id = $1",
        [last.itemId],
      );
      expect(stored.rows[0]?.body).toBe(HOSTILE_BODY);
    });
  });

  it("lists a message present in two mailboxes once", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, f } = await offerThread();
      const body = (await detail(threadId)).body;
      expect(body.messages.filter((message) => message.messageId === "<reply-1@example.test>")).toHaveLength(1);
      expect(body.mailboxes.map((mailbox) => mailbox.id).sort()).toEqual([f.boxA.id, f.boxB.id].sort());
      const copies = await runtime.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND message_id = '<reply-1@example.test>'",
      );
      expect(copies.rows).toEqual([{ n: 2 }]);
    });
  });

  it("answers a merged-away thread id with the target thread", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<left@example.test>", subject: "Left", date: new Date("2026-10-01T08:00:00Z") });
      await f.ingest({ id: "<right@example.test>", subject: "Right", date: new Date("2026-10-02T08:00:00Z") });
      const before = await runtime.query<{ thread_id: string }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() ORDER BY message_id",
      );
      expect(new Set(before.rows.map((row) => row.thread_id)).size).toBe(2);
      // A reply naming both messages joins their threads through the sync writer's threading.
      await f.ingest({
        id: "<join@example.test>",
        refs: ["<left@example.test>", "<right@example.test>"],
        date: new Date("2026-10-03T08:00:00Z"),
      });
      const alias = await runtime.query<{ from_thread_id: string; to_thread_id: string }>(
        "SELECT from_thread_id, to_thread_id FROM mail_thread_aliases WHERE tenant_id = app_tenant_default()",
      );
      expect(alias.rows).toHaveLength(1);
      const { from_thread_id: merged, to_thread_id: target } = alias.rows[0]!;
      const body = (await detail(merged)).body;
      expect(body.threadId).toBe(target);
      expect(body.messages.map((message) => message.messageId)).toEqual([
        "<left@example.test>",
        "<right@example.test>",
        "<join@example.test>",
      ]);
      expect(await detail(target)).toEqual(await detail(merged));
    });
  });

  it("aggregates a reply draft with the thread's messages while the list keeps leaving it out", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<question@example.test>", date: new Date("2026-10-01T08:00:00Z") });
      await f.ingest({
        id: "<answer@example.test>",
        refs: ["<question@example.test>"],
        from: "me@example.test",
        folder: f.folders.sent.id,
        date: new Date("2026-10-02T08:00:00Z"),
      });
      const draft = await f.ingest({
        id: "<draft@example.test>",
        refs: ["<question@example.test>", "<answer@example.test>"],
        from: "me@example.test",
        folder: f.folders.drafts.id,
        date: new Date("2026-10-03T08:00:00Z"),
        attachments: [{ filename: "koncept.txt", content: "draft attachment" }],
      });
      const threadId = await threadOf(draft.itemId);
      const body = (await detail(threadId)).body;
      expect(body.messages.map((message) => [message.messageId, message.folderPurpose, message.isOwn])).toEqual([
        ["<question@example.test>", "inbox", false],
        ["<answer@example.test>", "sent", true],
        ["<draft@example.test>", "drafts", true],
      ]);
      expect(body.messages.at(-1)?.attachments).toEqual(await storedAttachments(draft.itemId));
      // The detail header aggregates every live copy, the draft included.
      expect(body).toMatchObject({
        messageCount: 3,
        lastMessageAt: "2026-10-03T08:00:00.000000Z",
        lastSender: { name: "Me", address: "me@example.test" },
      });
      // The list keeps its draft exclusion: same thread, the draft not counted.
      const list = await createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads" } });
      expect(list.body.threads.find((row) => row.threadId === threadId)).toMatchObject({
        messageCount: 2,
        lastMessageAt: "2026-10-02T08:00:00.000000Z",
      });
    });
  });

  it("answers a draft-only thread with 200, its draft and a header over it, which the list does not show", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await f.ingest({
        id: "<new-draft@example.test>",
        from: "me@example.test",
        folder: f.folders.drafts.id,
        date: new Date("2026-10-05T08:00:00Z"),
        subject: "Nový koncept",
      });
      const threadId = await threadOf(draft.itemId);
      const result = await detail(threadId);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        threadId,
        subject: "Nový koncept",
        messageCount: 1,
        unread: false,
        lastMessageAt: "2026-10-05T08:00:00.000000Z",
        mailboxes: [{ id: f.boxA.id, name: "Personal", provider: "gmail" }],
      });
      expect(result.body.messages.map((message) => [message.emailId, message.folderPurpose])).toEqual([
        [draft.itemId, "drafts"],
      ]);
      const list = await createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads" } });
      expect(list.body.threads.map((row) => row.threadId)).not.toContain(threadId);
    });
  });

  it("answers 404 for a thread whose only message is in the item trash", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const message = await f.ingest({ id: "<gone@example.test>", date: new Date("2026-10-06T08:00:00Z") });
      const threadId = await threadOf(message.itemId);
      expect((await detail(threadId)).status).toBe(200);
      await createChokePoint(runtime).softDeleteItem(f.db("emails"), message.itemId);
      await expect(detail(threadId)).rejects.toMatchObject({ code: "not_found", message: "Thread not found" });
    });
  });

  it("answers an unknown id and another tenant's id with the same 404", async () => {
    const foreignThread = await runInTenant(foreign, async () => (await offerThread()).threadId);
    const outcome = async (id: string) => {
      try {
        await runInTenant(tenant, () => detail(id));
        return { ok: true };
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        return { name: error.name, code: error.code, message: error.message, details: error.details ?? null };
      }
    };
    const foreignOutcome = await outcome(foreignThread);
    expect(foreignOutcome).toEqual(await outcome("6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b"));
    expect(foreignOutcome).toMatchObject({ code: "not_found" });
  });

  it("refuses a non-UUID thread id and an allowRemoteImages value other than true or false", async () => {
    await runInTenant(tenant, async () => {
      await expect(detail("not-a-uuid")).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "threadId" },
      });
      const { threadId } = await offerThread();
      const refused = detail(threadId, "?allowRemoteImages=yes");
      await expect(refused).rejects.toBeInstanceOf(ValidationError);
      await expect(refused).rejects.toMatchObject({ details: { field: "allowRemoteImages" } });
    });
  });
});
