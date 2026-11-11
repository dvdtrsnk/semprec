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
  it("filters inbox, flagged, folders, unread and mailbox in combination", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const inbox = await f.ingest({ id: "<inbox@example.test>", flags: ["\\Flagged"] });
      const spam = await f.ingest({ id: "<spam@example.test>", folder: f.folders.spam.id, flags: ["\\Flagged"] });
      const trash = await f.ingest({ id: "<trash@example.test>", folder: f.folders.trash.id, flags: ["\\Flagged"] });
      const read = await f.ingest({ id: "<read@example.test>", mailbox: f.boxB.id, flags: ["\\Seen"] });
      const threadId = async (itemId: string) => {
        const result = await withTransaction(runtime, (client) =>
          client.query<{ thread_id: string }>(
            "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
            [itemId],
          ),
        );
        expect(result.rows).toHaveLength(1);
        return result.rows[0]!.thread_id;
      };
      const [inboxId, spamId, trashId, readId] = await Promise.all(
        [inbox, spam, trash, read].map(({ itemId }) => threadId(itemId)),
      );
      const defaultRows = (await list()).body.threads;
      expect(new Set(defaultRows.map((row) => row.threadId))).toEqual(new Set([inboxId, readId]));
      expect((await list("/api/mail/threads?box=flagged")).body.threads.map((row) => row.threadId)).toEqual([inboxId]);
      expect(
        (await list(`/api/mail/threads?folderId=${f.folders.spam.id}`)).body.threads.map((row) => row.threadId),
      ).toEqual([spamId]);
      expect(
        (await list(`/api/mail/threads?folderId=${f.folders.trash.id}`)).body.threads.map((row) => row.threadId),
      ).toEqual([trashId]);
      expect((await list(`/api/mail/threads?unread=true&mailboxId=${f.boxB.id}`)).body.threads).toHaveLength(0);
      expect((await list(`/api/mail/threads?unread=true&mailboxId=${f.boxA.id}`)).body.threads).toHaveLength(1);
      await expect(list("/api/mail/threads?box=unknown")).rejects.toMatchObject({
        status: 400,
        details: { field: "box" },
      });
      await expect(list("/api/mail/threads?folderId=00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
        status: 404,
      });
    });
  });
  it("treats foreign and unknown folders identically", async () => {
    const foreignFolder = await runInTenant(foreign, async () => (await setup()).folders.inbox.id);
    await runInTenant(tenant, async () => {
      const handler = createMailThreadListRouteHandler(runtime);
      const error = async (id: string) =>
        handler({ req: { url: `/api/mail/threads?folderId=${id}` } }).then(
          () => {
            throw new Error("Expected missing folder");
          },
          (reason: unknown) => reason,
        );
      expect(await error(foreignFolder)).toEqual(await error("00000000-0000-4000-8000-000000000000"));
    });
  });
});
