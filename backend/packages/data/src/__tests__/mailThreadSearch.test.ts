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
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
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
        spam: await create("Spam", "junk"),
        trash: await create("Trash", "trash"),
      };
    });
    const storage = new LocalFsBlobStorageWriter(storageRoot);
    const ingest = (input: {
      subject?: string;
      fromName?: string;
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
          subject: input.subject ?? "Re: Website proposal",
          date: input.date,
          envelope: {
            from: {
              name: input.fromName ?? (input.from === "me@example.test" ? "Me" : "Sender"),
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
  it("combines text, folded sender, operators and mailbox without narrowing the aggregate", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const first = await f.ingest({
        id: "<search-one@example.test>",
        subject: "Re: Nabídka na web",
        fromName: "Petr Novák",
        from: "petr@example.test",
      });
      await f.ingest({ id: "<search-two@example.test>", refs: ["<search-one@example.test>"], subject: "Later" });
      await f.ingest({
        id: "<draft-search@example.test>",
        refs: ["<search-one@example.test>"],
        folder: f.folders.drafts.id,
        body: "distinctiveneedle",
      });
      expect((await list("/api/mail/threads?q=distinctiveneedle")).body.threads[0]).toMatchObject({ messageCount: 2 });
      expect((await list("/api/mail/threads?q=from%3ANOVAK")).body.threads[0]).toMatchObject({ messageCount: 2 });
      expect((await list("/api/mail/threads?q=nab")).body.threads).toHaveLength(1);
      await f.ingest({ id: "<bath@example.test>", subject: "Siko Koupelny" });
      expect((await list("/api/mail/threads?q=koupelny")).body.threads).toHaveLength(1);
      const morphology = await runtime.query<{ matches: boolean }>(
        "SELECT to_tsvector('czech', 'Koupelny') @@ to_tsquery('czech', 'koupelna') AS matches",
      );
      expect(morphology.rows).toHaveLength(1);
      expect((await list("/api/mail/threads?q=koupelna")).body.threads).toHaveLength(
        morphology.rows[0]!.matches ? 1 : 0,
      );
      expect((await list(`/api/mail/threads?q=nab&box=inbox&mailboxId=${f.boxA.id}`)).body.threads).toHaveLength(1);
      expect((await list(`/api/mail/threads?q=nab&box=inbox&mailboxId=${f.boxB.id}`)).body.threads).toHaveLength(0);
      expect((await list("/api/mail/threads?q=is%3Aunread%20is%3Aread")).body.threads).toEqual([]);
      expect((await list("/api/mail/threads?q=%20%20")).body.threads).toHaveLength(2);
      await expect(list("/api/mail/threads?q=before%3Anot-a-date")).rejects.toMatchObject({
        status: 400,
        details: { field: "q" },
      });
      await f.cp.softDeleteItem(f.db("emails"), first.itemId);
      expect((await list("/api/mail/threads?q=nab")).body.threads).toEqual([]);
      expect((await list()).body.threads).toHaveLength(2);
    });
  });
  it("matches attachment, date and flag operators on the same message", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({
        id: "<operator@example.test>",
        date: new Date("2026-01-02T12:00:00Z"),
        flags: ["\\Seen", "\\Flagged"],
        attachment: true,
      });
      for (const q of [
        "has:attachment",
        "is:read",
        "is:flagged",
        "before:2026-01-03",
        "after:2026-01-01",
        "has:attachment is:read is:flagged",
      ]) {
        expect((await list(`/api/mail/threads?q=${encodeURIComponent(q)}`)).body.threads).toHaveLength(1);
      }
      expect(
        (await list(`/api/mail/threads?q=has%3Aattachment&box=flagged&mailboxId=${f.boxA.id}`)).body.threads,
      ).toHaveLength(1);
      await f.ingest({ id: "<sent-search@example.test>", folder: f.folders.sent.id });
      expect((await list(`/api/mail/threads?folderId=${f.folders.sent.id}`)).body.threads).toHaveLength(1);
      expect((await list(`/api/mail/threads?folderId=${f.folders.sent.id}&q=is%3Aunread`)).body.threads).toHaveLength(
        0,
      );
      for (const q of ["is:unread", "is:unflagged", "before:2026-01-01", "after:2026-01-03"]) {
        expect((await list(`/api/mail/threads?q=${encodeURIComponent(q)}`)).body.threads).toHaveLength(0);
      }
    });
  });
});
