import "../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft } from "../mail/draft.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
import { reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
describe("mail thread list", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-threads-"));
    const role = await runAsSystem("verify mail test role", () =>
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
      mailbox?: string;
      folder?: string;
      id: string;
      refs?: string[];
      from?: string;
      date?: Date;
      body?: string;
      attachment?: boolean;
      flags?: string[];
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
          subject: "Re: Website proposal",
          date: input.date,
          envelope: {
            from: {
              name: input.from === "me@example.test" ? "Me" : "Sender",
              address: input.from ?? "sender@example.test",
            },
            to: [{ name: "Me", address: "me@example.test" }],
          },
          bodyText: input.body ?? "preview",
          flags: input.flags,
          attachments: input.attachment
            ? [
                {
                  filename: "note.txt",
                  contentType: "text/plain",
                  contentId: null,
                  disposition: "attachment",
                  openStream: () => Readable.from(["attachment"]),
                },
              ]
            : [],
          storage,
          storageKeyPrefix: "fixtures",
        }),
      );
    return { cp, db, property, boxA, boxB, folders, ingest };
  }
  const list = (url = "/api/mail/threads") => createMailThreadListRouteHandler(runtime)({ req: { url } });
  it("keeps the tenant-thread index on migration replay with populated mail", async () => {
    const id = await runInTenant(tenant, async () => {
      const f = await setup();
      return (await f.ingest({ id: "<migration@example.test>" })).itemId;
    });
    const index = await admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'mail_message_meta_tenant_thread_idx'",
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain("(tenant_id, thread_id)");
    await runAsSystem("replay mail thread index migration", () => runMigrations(admin));
    const persisted = await runInTenant(tenant, () =>
      runtime.query<{ item_id: string }>(
        "SELECT item_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [id],
      ),
    );
    expect(persisted.rows).toEqual([{ item_id: id }]);
    const applied = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM schema_migrations WHERE id = '0135_mail_message_meta_tenant_thread_idx.sql'",
    );
    expect(applied.rows).toEqual([{ n: 1 }]);
  });
  it("aggregates a conversation, deduplicates mailbox copies and ignores provider and Semp drafts", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const person = await f.cp.createItem({
        databaseId: f.db("people"),
        properties: { name: "Sender", relationship: "colleague" },
      });
      await withTransaction(runtime, (client) => reindexPersonEmails(client, person.id, ["sender@example.test"]));
      const dates = [1, 2, 3, 4].map((day) => new Date(`2026-01-0${day}T10:00:00Z`));
      await f.ingest({ id: "<one@example.test>", date: dates[0] });
      await f.ingest({
        id: "<two@example.test>",
        refs: ["<one@example.test>"],
        from: "me@example.test",
        folder: f.folders.sent.id,
        date: dates[1],
        attachment: true,
        flags: ["\\Flagged"],
      });
      await f.ingest({
        id: "<three@example.test>",
        refs: ["<one@example.test>"],
        from: "me@example.test",
        folder: f.folders.sent.id,
        date: dates[2],
      });
      await f.ingest({
        id: "<four@example.test>",
        refs: ["<one@example.test>"],
        date: dates[3],
        body: "Latest preview",
      });
      await f.ingest({
        id: "<four@example.test>",
        mailbox: f.boxB.id,
        refs: ["<one@example.test>"],
        date: dates[3],
        body: "Latest preview",
      });
      const before = await list();
      expect(before.body.threads).toHaveLength(1);
      const row = before.body.threads[0]!;
      expect(row).toMatchObject({
        subject: "Re: Website proposal",
        messageCount: 4,
        preview: "Latest preview",
        hasAttachment: true,
        unread: true,
        flagged: true,
        lastSender: { address: "sender@example.test", personId: person.id },
        senderPerson: { id: person.id, name: "Sender", relationship: "colleague" },
        mailboxes: expect.arrayContaining([
          { id: f.boxA.id, name: "Personal", provider: "gmail" },
          { id: f.boxB.id, name: "Work", provider: "outlook" },
        ]),
        project: null,
        company: null,
        hasSempDraft: false,
      });
      expect(row.mailboxes).toHaveLength(2);
      expect(row.participants).toEqual([
        { name: "Sender", address: "sender@example.test" },
        { name: "Me", address: "me@example.test" },
      ]);
      await f.ingest({
        id: "<provider-draft@example.test>",
        refs: ["<one@example.test>"],
        folder: f.folders.drafts.id,
        date: new Date("2027-01-01T00:00:00Z"),
      });
      await withTransaction(runtime, (client) =>
        createEmailDraft(client, {
          emailsDatabaseId: f.db("emails"),
          folderRelationPropertyId: f.property("folder"),
          draftsFolderItemId: f.folders.drafts.id,
          subject: "Draft",
          date: new Date("2028-01-01T00:00:00Z"),
          metadata: {
            mailboxItemId: f.boxA.id,
            threadId: row.threadId,
            mode: "reply",
            fromAddress: "me@example.test",
            createdBy: "agent",
          },
        }),
      );
      expect((await list()).body.threads[0]).toEqual(row);
    });
  });
  it("does not count an own sent-only message as unread", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<sent@example.test>", from: "me@example.test", folder: f.folders.sent.id });
      expect((await list()).body.threads).toHaveLength(0);
      expect((await list(`/api/mail/threads?folderId=${f.folders.sent.id}`)).body.threads[0]).toMatchObject({
        messageCount: 1,
        unread: false,
      });
    });
  });
  it("distinguishes own, sent-folder, read and unread incoming messages", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const own = await f.ingest({ id: "<own-inbox@example.test>", from: "me@example.test" });
      const sentFolder = await f.ingest({ id: "<foreign-sent@example.test>", folder: f.folders.sent.id });
      const read = await f.ingest({ id: "<read@example.test>", flags: ["\\Seen"] });
      const unread = await f.ingest({ id: "<unread@example.test>" });
      const ids = [own.itemId, sentFolder.itemId, read.itemId, unread.itemId];
      const raw = await runtime.query<Record<string, unknown>>(
        "SELECT item_id, thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = ANY($1::uuid[])",
        [ids],
      );
      const threads = z.array(z.object({ item_id: z.uuid(), thread_id: z.uuid() })).parse(raw.rows);
      const rows = (await list()).body.threads;
      const sentRows = (await list(`/api/mail/threads?folderId=${f.folders.sent.id}`)).body.threads;
      expect(
        rows.find((row) => row.threadId === threads.find((entry) => entry.item_id === sentFolder.itemId)?.thread_id),
      ).toBeUndefined();
      for (const [itemId, expected] of [
        [own.itemId, false],
        [sentFolder.itemId, false],
        [read.itemId, false],
        [unread.itemId, true],
      ] as const) {
        const threadId = threads.find((row) => row.item_id === itemId)?.thread_id;
        expect(threadId).toBeDefined();
        expect((itemId === sentFolder.itemId ? sentRows : rows).find((row) => row.threadId === threadId)?.unread).toBe(
          expected,
        );
      }
    });
  });
  it("paginates equal timestamps and does not expose another tenant", async () => {
    let foreignThread = "";
    await runInTenant(foreign, async () => {
      const f = await setup();
      await f.ingest({ id: "<foreign@example.test>", date: new Date("2026-01-01T00:00:00Z") });
      foreignThread = (await list()).body.threads[0]!.threadId;
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      for (let i = 0; i < 50; i++)
        await f.ingest({ id: `<${i}@example.test>`, date: new Date("2026-01-01T00:00:00Z") });
      const count = async (limit: number) =>
        withTransaction(runtime, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const { listMailThreads } = await import("../mail/mailThreadListQuery.js");
            const rows = await listMailThreads(client, limit, null);
            expect(rows).toHaveLength(limit + 1);
            return spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }
        });
      expect(await count(1)).toBe(await count(49));
      const first = (await list("/api/mail/threads?limit=30")).body;
      expect(first.threads).toHaveLength(30);
      expect(first.nextCursor).not.toBeNull();
      const second = (await list(`/api/mail/threads?limit=30&cursor=${first.nextCursor}`)).body;
      const ids = [...first.threads, ...second.threads].map((row) => row.threadId);
      expect(ids).toHaveLength(50);
      expect(ids).toEqual([...ids].sort().reverse());
      expect(new Set(ids).size).toBe(50);
      expect(ids).not.toContain(foreignThread);
      expect(second.nextCursor).toBeNull();
      await expect(list("/api/mail/threads?limit=201")).rejects.toMatchObject({
        status: 400,
        details: { field: "limit" },
      });
      await expect(list("/api/mail/threads?cursor=broken")).rejects.toMatchObject({
        status: 400,
        details: { field: "cursor" },
      });
    });
  });
  it("uses date, then ingest time, then the legacy updated timestamp without losing cursor precision", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const dated = await f.ingest({ id: "<dated@example.test>", date: new Date("2024-01-01T00:00:00Z") });
      const ingested = await f.ingest({ id: "<ingested@example.test>" });
      const legacy = await f.ingest({ id: "<legacy@example.test>" });
      const expected = await withTransaction(runtime, async (client) => {
        // Synthetic compatibility fixture: a pre-backfill null cannot be created by current ingest.
        const cleared = await client.query<{ item_id: string }>(
          "UPDATE mail_message_meta SET ingested_at = NULL WHERE tenant_id = app_tenant_default() AND item_id = $1 RETURNING item_id",
          [legacy.itemId],
        );
        expect(cleared.rowCount).toBe(1);
        // Synthetic exact times make a one-microsecond cursor boundary deterministic.
        const fixedIngest = await client.query(
          "UPDATE mail_message_meta SET ingested_at = $2::timestamptz WHERE tenant_id = app_tenant_default() AND item_id = $1",
          [ingested.itemId, "2025-01-01T00:00:00.123455Z"],
        );
        expect(fixedIngest.rowCount).toBe(1);
        const fixedLegacy = await client.query(
          "UPDATE items SET updated_at = $2::timestamptz WHERE tenant_id = app_tenant_default() AND id = $1",
          [legacy.itemId, "2025-01-01T00:00:00.123456Z"],
        );
        expect(fixedLegacy.rowCount).toBe(1);
        const result = await client.query<{
          item_id: string;
          thread_id: string;
          ingested: string | null;
          updated: string;
        }>(
          `SELECT m.item_id, m.thread_id,
          to_char(m.ingested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ingested,
          to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated
          FROM mail_message_meta m JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
          WHERE m.tenant_id = app_tenant_default() AND m.item_id = ANY($1::uuid[])`,
          [[dated.itemId, ingested.itemId, legacy.itemId]],
        );
        expect(result.rows).toHaveLength(3);
        return result.rows;
      });
      const seen: Array<{ threadId: string; lastMessageAt: string }> = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const path: string = `/api/mail/threads?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
        const page: { threads: Array<{ threadId: string; lastMessageAt: string }>; nextCursor: string | null } = (
          await list(path)
        ).body;
        seen.push(...page.threads);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(3);
      const dateRow = expected.find((entry) => entry.item_id === dated.itemId);
      const ingestRow = expected.find((entry) => entry.item_id === ingested.itemId);
      const legacyRow = expected.find((entry) => entry.item_id === legacy.itemId);
      if (!dateRow || !ingestRow || !legacyRow || !ingestRow.ingested) throw new Error("Missing timestamp fixture");
      expect(legacyRow.ingested).toBeNull();
      expect(ingestRow.ingested).toBe("2025-01-01T00:00:00.123455Z");
      expect(legacyRow.updated).toBe("2025-01-01T00:00:00.123456Z");
      expect(seen.map((entry) => entry.threadId)).toEqual([
        legacyRow.thread_id,
        ingestRow.thread_id,
        dateRow.thread_id,
      ]);
      expect(seen).toContainEqual(
        expect.objectContaining({ threadId: dateRow.thread_id, lastMessageAt: "2024-01-01T00:00:00.000000Z" }),
      );
      expect(seen).toContainEqual(
        expect.objectContaining({ threadId: ingestRow.thread_id, lastMessageAt: ingestRow.ingested }),
      );
      expect(seen).toContainEqual(
        expect.objectContaining({ threadId: legacyRow.thread_id, lastMessageAt: legacyRow.updated }),
      );
    });
  });
});
