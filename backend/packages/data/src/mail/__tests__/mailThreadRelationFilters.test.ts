import "../../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";
import { createMailThreadListRouteHandler } from "../mailThreadRoutes.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

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
  it("intersects project, area, person and unread filters and validates ids", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const email = await f.ingest({ id: "<related@example.test>" });
      const reply = await f.ingest({ id: "<related-reply@example.test>", refs: ["<related@example.test>"] });
      const read = await f.ingest({ id: "<read-in-area@example.test>", flags: ["\\Seen"] });
      const recipientOnly = await f.ingest({ id: "<recipient-only@example.test>" });
      const recipientReply = await f.ingest({
        id: "<recipient-reply@example.test>",
        refs: ["<recipient-only@example.test>"],
      });
      const unrelated = await f.ingest({ id: "<unrelated@example.test>" });
      const area = await f.cp.createItem({ databaseId: f.db("areas"), properties: { name: "Area" } });
      const project = await f.cp.createItem({ databaseId: f.db("projects"), properties: { name: "Project" } });
      const person = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Person" } });
      const recipientPerson = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Recipient" } });
      const senderPerson = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Sender" } });
      const property = async (db: string, key: string) => {
        const value = (await f.cp.listProperties(f.db(db))).find((p) => p.key === key);
        if (!value) throw new Error(`Missing ${db}.${key}`);
        return value.id;
      };
      const projectArea = await property("projects", "area");
      const threadProject = await property("threads", "project");
      const sender = await property("emails", "senderPeople");
      const recipients = await property("emails", "recipientsPeople");
      const raw = await runtime.query<{ item_id: string; thread_id: string; email_id: string }>(
        `SELECT t.item_id, t.id AS thread_id, m.item_id AS email_id FROM mail_message_meta m JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE m.tenant_id = app_tenant_default() AND m.item_id = ANY($1::uuid[])`,
        [[email.itemId, read.itemId, recipientOnly.itemId, unrelated.itemId]],
      );
      const matching = raw.rows.find((row) => row.email_id === email.itemId);
      const readThread = raw.rows.find((row) => row.email_id === read.itemId);
      const recipientThread = raw.rows.find((row) => row.email_id === recipientOnly.itemId);
      const nonmatching = raw.rows.find((row) => row.email_id === unrelated.itemId);
      const threadItem = matching?.item_id;
      if (
        !threadItem ||
        !matching ||
        !readThread ||
        !recipientThread ||
        !nonmatching ||
        new Set(raw.rows.map((row) => row.thread_id)).size !== 4
      )
        throw new Error("Missing distinct Threads items");
      expect(new Set((await list()).body.threads.map((thread) => thread.threadId))).toEqual(
        new Set([matching.thread_id, readThread.thread_id, recipientThread.thread_id, nonmatching.thread_id]),
      );
      await withTransaction(runtime, async (client) => {
        await createRelationWithClient(client, {
          relationPropertyId: projectArea,
          callerItemId: project.id,
          targetItemId: area.id,
        });
        await createRelationWithClient(client, {
          relationPropertyId: threadProject,
          callerItemId: threadItem,
          targetItemId: project.id,
        });
        await createRelationWithClient(client, {
          relationPropertyId: threadProject,
          callerItemId: readThread.item_id,
          targetItemId: project.id,
        });
        await createRelationWithClient(
          client,
          { relationPropertyId: sender, callerItemId: email.itemId, targetItemId: person.id },
          { ownerProcess: "emails" },
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: recipients, callerItemId: reply.itemId, targetItemId: person.id },
          { ownerProcess: "emails" },
        );
        for (const itemId of [recipientOnly.itemId, recipientReply.itemId])
          await createRelationWithClient(
            client,
            { relationPropertyId: recipients, callerItemId: itemId, targetItemId: recipientPerson.id },
            { ownerProcess: "emails" },
          );
        await createRelationWithClient(
          client,
          { relationPropertyId: sender, callerItemId: unrelated.itemId, targetItemId: senderPerson.id },
          { ownerProcess: "emails" },
        );
      });
      const recipientEdges = await withTransaction(runtime, (client) =>
        client.query<{ property_id: string; count: number }>(
          `SELECT d.property_id_a AS property_id, count(*)::int AS count
           FROM relation_definitions d JOIN item_relations r ON r.relation_definition_id = d.id AND r.tenant_id = d.tenant_id
           WHERE d.tenant_id = app_tenant_default() AND d.property_id_a = ANY($1::uuid[])
             AND r.item_a = ANY($2::uuid[]) AND r.item_b = $3
           GROUP BY d.property_id_a`,
          [[sender, recipients], [recipientOnly.itemId, recipientReply.itemId], recipientPerson.id],
        ),
      );
      expect(recipientEdges.rows).toEqual([{ property_id: recipients, count: 2 }]);
      for (const query of [`projectId=${project.id}`, `areaId=${area.id}`])
        expect(
          new Set((await list(`/api/mail/threads?${query}`)).body.threads.map((thread) => thread.threadId)),
        ).toEqual(new Set([matching.thread_id, readThread.thread_id]));
      for (const query of [
        `personId=${person.id}`,
        `areaId=${area.id}&unread=true`,
        `areaId=${area.id}&personId=${person.id}`,
      ])
        expect((await list(`/api/mail/threads?${query}`)).body.threads.map((thread) => thread.threadId)).toEqual([
          matching.thread_id,
        ]);
      expect(
        (await list(`/api/mail/threads?personId=${recipientPerson.id}`)).body.threads.map((thread) => thread.threadId),
      ).toEqual([recipientThread.thread_id]);
      expect(
        (await list(`/api/mail/threads?personId=${senderPerson.id}`)).body.threads.map((thread) => thread.threadId),
      ).toEqual([nonmatching.thread_id]);
      await expect(list("/api/mail/threads?personId=bad")).rejects.toMatchObject({
        status: 400,
        details: { field: "personId" },
      });
    });
  });
});
