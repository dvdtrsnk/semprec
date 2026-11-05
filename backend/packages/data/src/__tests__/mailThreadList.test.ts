import "../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
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
          subject: "Re: Nabídka na web",
          date: input.date,
          envelope: {
            from: {
              name: input.from === "me@example.test" ? "Me" : "Sender",
              address: input.from ?? "sender@example.test",
            },
            to: [{ name: "Me", address: "me@example.test" }],
          },
          bodyText: input.body ?? "preview",
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
        messageCount: 4,
        preview: "Latest preview",
        hasAttachment: true,
        unread: true,
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
        const result = await client.query<{ item_id: string; thread_id: string; expected: string }>(
          `SELECT m.item_id, m.thread_id,
          to_char(COALESCE(NULLIF(i.properties->>'date', '')::timestamptz, m.ingested_at, i.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expected
          FROM mail_message_meta m JOIN items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
          WHERE m.tenant_id = app_tenant_default() AND m.item_id = ANY($1::uuid[])`,
          [[dated.itemId, ingested.itemId, legacy.itemId]],
        );
        expect(result.rows).toHaveLength(3);
        return result.rows;
      });
      const seen: Array<{ threadId: string; lastMessageAt: string }> = [];
      let cursor: string | null = null;
      do {
        const path = `/api/mail/threads?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
        const page = (await list(path)).body;
        seen.push(...page.threads);
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(3);
      for (const row of expected)
        expect(seen).toContainEqual(expect.objectContaining({ threadId: row.thread_id, lastMessageAt: row.expected }));
      expect(
        seen.find((row) => row.threadId === expected.find((entry) => entry.item_id === dated.itemId)?.thread_id)
          ?.lastMessageAt,
      ).toBe("2024-01-01T00:00:00.000000Z");
    });
  });
});
