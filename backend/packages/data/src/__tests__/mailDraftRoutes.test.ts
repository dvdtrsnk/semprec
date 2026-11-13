import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import {
  createEmailDraft,
  createEmailDraftInMailbox,
  discardEmailDraft,
  MailDraftAlreadySentError,
  MailDraftNotEditableError,
  updateEmailDraft,
} from "../mail/draft.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS } from "../mail/ingest.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import {
  createMailDraftCreateRouteHandler,
  createMailDraftDiscardRouteHandler,
  createMailDraftReadRouteHandler,
  createMailDraftUpdateRouteHandler,
} from "../mail/mailDraftRouteHandlers.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { markMailDraftSent, MailDraftThreadConflictError } from "../mail/mailDraftsStore.js";
import { createMailThread, reassignThread } from "../mail/mailMessageMetaStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

const USER_ID = randomUUID();
const OWN_ADDRESS = "me@example.test";
const ALIAS_ADDRESS = "Alias@Example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const JANA = { name: "", address: "jana@example.test" };

interface Fixture {
  mailboxId: string;
  /** A mailbox with the same address list and no Drafts folder: no sync pass has discovered one yet. */
  mailboxWithoutDraftsId: string;
  draftsFolderId: string;
  /** The thread of one received message, and the received message itself. */
  threadId: string;
  receivedId: string;
}

describe("the mail draft routes (issue gh-1867)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-draft-routes-"));
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
    events = [];
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  /** Two mailboxes of the tenant in scope (the first with a Drafts folder) and a received message with its thread. */
  async function setup(): Promise<Fixture> {
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
      const mailbox = async (name: string) => {
        const created = await createItemWithClient(client, {
          databaseId: db("mailboxes"),
          properties: { name, provider: "gmail" },
        });
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId: db("mailboxes"),
          mailboxItemId: created.id,
          address: OWN_ADDRESS,
          aliases: [ALIAS_ADDRESS],
        });
        return created.id;
      };
      const folder = (mailboxItemId: string, specialPurpose: string) =>
        ensureFolderItem(client, {
          foldersDatabaseId: db("folders"),
          mailboxItemId,
          mailboxRelationPropertyId: property(folderProperties, "mailbox"),
          providerId: specialPurpose.toUpperCase(),
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      const mailboxId = await mailbox("Personal");
      const mailboxWithoutDraftsId = await mailbox("Fresh");
      const draftsFolderId = await folder(mailboxId, "drafts");
      const inboxId = await folder(mailboxId, "inbox");
      const received = await ingestEmailMessage(client, {
        emailsDatabaseId: db("emails"),
        filesDatabaseId: db("files"),
        folderRelationPropertyId: property(emailProperties, "folder"),
        attachmentsRelationPropertyId: property(emailProperties, "attachments"),
        mailboxItemId: mailboxId,
        folderItemId: inboxId,
        messageId: "<received@example.test>",
        subject: "Nabídka na web",
        date: new Date("2026-10-01T09:00:00Z"),
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
        bodyHtml: "<p>Dobrý den</p>",
        attachments: [],
        storage: new LocalFsBlobStorageWriter(storageRoot),
        storageKeyPrefix: "draft-route-fixtures",
      });
      const thread = await client.query<{ thread_id: string }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [received.itemId],
      );
      const threadId = thread.rows[0]?.thread_id;
      if (!threadId) throw new Error("Missing thread");
      return { mailboxId, mailboxWithoutDraftsId, draftsFolderId, threadId, receivedId: received.itemId };
    });
  }

  const ctx = (params: Record<string, string>, body: unknown) => ({
    params,
    body,
    identity: { user: { id: USER_ID } },
  });

  function createDraft(body: unknown, inTenant = tenant) {
    return runInTenant(inTenant, () => createMailDraftCreateRouteHandler(runtime)(ctx({}, body)));
  }
  function readDraft(id: string, inTenant = tenant) {
    return runInTenant(inTenant, () => createMailDraftReadRouteHandler(runtime)(ctx({ id }, undefined)));
  }
  function updateDraft(id: string, body: unknown, inTenant = tenant) {
    return runInTenant(inTenant, () => createMailDraftUpdateRouteHandler(runtime)(ctx({ id }, body)));
  }
  function discardDraft(id: string, inTenant = tenant) {
    return runInTenant(inTenant, () => createMailDraftDiscardRouteHandler(runtime)(ctx({ id }, undefined)));
  }

  /** A complete create body: the draft the compose window autosaves once the user has typed a recipient and a subject. */
  const newDraft = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
    mailboxId: f.mailboxId,
    from: OWN_ADDRESS,
    to: [PETR],
    cc: [JANA],
    bcc: [],
    subject: "Re: Nabídka na web",
    body: "Dobrý den,\nděkuji za nabídku.",
    ...overrides,
  });

  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  async function count(table: "mail_drafts" | "emails"): Promise<number> {
    const sql =
      table === "mail_drafts"
        ? "SELECT count(*)::int AS n FROM mail_drafts WHERE tenant_id = app_tenant_default()"
        : `SELECT count(*)::int AS n FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
           WHERE i.tenant_id = app_tenant_default() AND d.owner_module_id = 'emails'`;
    const { rows } = await runtime.query<{ n: number }>(sql);
    return rows[0]?.n ?? -1;
  }

  /** The folders an Emails item is linked to, by special purpose. */
  async function folderPurposesOf(itemId: string): Promise<(string | null)[]> {
    const { rows } = await runtime.query<{ purpose: string | null }>(
      `SELECT folder.properties->>'specialPurpose' AS purpose
       FROM item_relations r
       JOIN items folder ON folder.tenant_id = r.tenant_id AND folder.id IN (r.item_a, r.item_b) AND folder.id <> $1
       WHERE r.tenant_id = app_tenant_default() AND $1 IN (r.item_a, r.item_b) AND folder.deleted_at IS NULL
         AND folder.properties ? 'specialPurpose'`,
      [itemId],
    );
    return rows.map((row) => row.purpose);
  }

  async function itemRow(itemId: string) {
    const { rows } = await runtime.query<{
      name: string;
      sender: string;
      recipients: string;
      body: string;
      deleted: boolean;
    }>(
      `SELECT properties->>'name' AS name, properties->>'sender' AS sender, properties->>'recipients' AS recipients,
              properties->>'body' AS body, deleted_at IS NOT NULL AS deleted
       FROM items WHERE tenant_id = app_tenant_default() AND id = $1`,
      [itemId],
    );
    return rows[0];
  }

  it("creates the draft with its row and its edge to the Drafts folder, and reopens it with the same recipients and mailbox", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();

      const created = await createDraft(newDraft(f));

      expect(created.status).toBe(201);
      const draft = created.body;
      expect(Object.keys(draft).sort()).toEqual(
        [
          "id",
          "mailboxId",
          "from",
          "to",
          "cc",
          "bcc",
          "subject",
          "body",
          "threadId",
          "mode",
          "sourceEmailId",
          "attachments",
          "createdBy",
          "lastEditedBy",
          "updatedAt",
          "sentAt",
        ].sort(),
      );
      expect(draft).toMatchObject({
        mailboxId: f.mailboxId,
        from: OWN_ADDRESS,
        to: [PETR],
        cc: [JANA],
        bcc: [],
        subject: "Re: Nabídka na web",
        body: "Dobrý den,\nděkuji za nabídku.",
        threadId: null,
        mode: "new",
        sourceEmailId: null,
        attachments: [],
        createdBy: "user",
        lastEditedBy: "user",
        sentAt: null,
      });
      expect(await folderPurposesOf(draft.id)).toEqual(["drafts"]);
      expect(await count("mail_drafts")).toBe(1);

      const reopened = await readDraft(draft.id);
      expect(reopened).toEqual({ status: 200, body: draft });
    });
  });

  it("stores the thread, the mode and the source message of a reply and reads them back", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();

      const { body: draft } = await createDraft(
        newDraft(f, { threadId: f.threadId, mode: "reply", sourceEmailId: f.receivedId }),
      );

      expect(draft).toMatchObject({ threadId: f.threadId, mode: "reply", sourceEmailId: f.receivedId });
      expect((await readDraft(draft.id)).body).toEqual(draft);
    });
  });

  it("translates the id of a merged thread to the thread that absorbed it", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const mergedAway = await withTransaction(runtime, async (client) => {
        const thread = await createMailThread(client);
        await reassignThread(client, thread.id, f.threadId);
        return thread.id;
      });
      recordThreadAnnouncements();

      const { body: draft } = await createDraft(newDraft(f, { threadId: mergedAway }));

      expect(draft.threadId).toBe(f.threadId);
      expect(events).toEqual([{ scope: "mailThread", threadId: f.threadId }]);
    });
  });

  it("accepts a registered alias of the mailbox as the sender, in any letter case", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();

      const { body: draft } = await createDraft(newDraft(f, { from: ALIAS_ADDRESS.toUpperCase() }));

      expect(draft.from).toBe(ALIAS_ADDRESS.toUpperCase());
    });
  });

  it("answers 403 from_address_not_registered for a sender the mailbox does not have, and creates nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const emailsBefore = await count("emails");
      recordThreadAnnouncements();

      const refusal = await createDraft(newDraft(f, { from: "stranger@example.test", threadId: f.threadId })).catch(
        (error: unknown) => error,
      );

      if (!(refusal instanceof ForbiddenError)) throw new Error("Expected a ForbiddenError");
      expect({ status: refusal.status, code: refusal.code }).toEqual({
        status: 403,
        code: "from_address_not_registered",
      });
      expect(await count("emails")).toBe(emailsBefore);
      expect(await count("mail_drafts")).toBe(0);
      expect(events).toEqual([]);
    });
  });

  it("answers 404 for an unknown mailbox, thread or source message, and creates nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const emailsBefore = await count("emails");

      for (const overrides of [
        { mailboxId: randomUUID() },
        { threadId: randomUUID() },
        { sourceEmailId: randomUUID() },
      ]) {
        await expect(createDraft(newDraft(f, overrides))).rejects.toBeInstanceOf(NotFoundError);
      }

      expect(await count("emails")).toBe(emailsBefore);
      expect(await count("mail_drafts")).toBe(0);
    });
  });

  it("answers 400 for a mailbox that has no Drafts folder yet, and creates nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const emailsBefore = await count("emails");

      await expect(createDraft(newDraft(f, { mailboxId: f.mailboxWithoutDraftsId }))).rejects.toBeInstanceOf(
        ValidationError,
      );

      expect(await count("emails")).toBe(emailsBefore);
    });
  });

  it("updates the fields it is given, keeps the others, records the editor and moves updatedAt", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      const updated = await updateDraft(created.id, {
        ifVersion: created.updatedAt,
        to: [PETR, JANA],
        subject: "Nabídka - odpověď",
      });

      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        id: created.id,
        mailboxId: f.mailboxId,
        from: OWN_ADDRESS,
        to: [PETR, JANA],
        cc: [JANA],
        subject: "Nabídka - odpověď",
        body: created.body,
        createdBy: "user",
        lastEditedBy: "user",
      });
      expect(updated.body.updatedAt).not.toBe(created.updatedAt);
      expect((await readDraft(created.id)).body).toEqual(updated.body);
      expect(await itemRow(created.id)).toEqual({
        name: "Nabídka - odpověď",
        sender: OWN_ADDRESS,
        recipients: "Petr Novák <petr@example.test>, jana@example.test",
        body: created.body,
        deleted: false,
      });
    });
  });

  it("records an agent as the editor of its own edit and keeps the creator", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      const edited = await withTransaction(runtime, (client) =>
        updateEmailDraft(
          client,
          { draftItemId: created.id, ifVersion: created.updatedAt, body: "Text od agenta" },
          { writer: { writerKind: "agent" }, actingUserId: USER_ID },
        ),
      );

      expect(edited).toMatchObject({ createdBy: "user", lastEditedBy: "agent", body: "Text od agenta" });
    });
  });

  it("answers 409 version_conflict for a stale ifVersion, writes nothing and announces nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f, { threadId: f.threadId }));
      const { body: second } = await updateDraft(created.id, { ifVersion: created.updatedAt, subject: "Druhá verze" });
      recordThreadAnnouncements();

      const refusal = await updateDraft(created.id, { ifVersion: created.updatedAt, subject: "Z dávné verze" }).catch(
        (error: unknown) => error,
      );

      if (!(refusal instanceof ConflictError)) throw new Error("Expected a ConflictError");
      expect({ status: refusal.status, code: refusal.code }).toEqual({ status: 409, code: "version_conflict" });
      expect((await readDraft(created.id)).body).toEqual(second);
      expect(events).toEqual([]);
      // The current version is accepted, so the refusal above was about the version.
      const accepted = await updateDraft(created.id, { ifVersion: second.updatedAt, subject: "Třetí verze" });
      expect(accepted.body.subject).toBe("Třetí verze");
    });
  });

  it("answers 409 mail_draft_already_sent for editing or discarding a sent draft, also with a stale version", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));
      await withTransaction(runtime, (client) => markMailDraftSent(client, created.id));
      const sent = (await readDraft(created.id)).body;
      expect(sent.sentAt).not.toBeNull();
      recordThreadAnnouncements();

      for (const attempt of [
        updateDraft(created.id, { ifVersion: sent.updatedAt, subject: "Po odeslání" }),
        updateDraft(created.id, { ifVersion: "2020-01-01T00:00:00.000Z", subject: "Po odeslání" }),
        discardDraft(created.id),
      ]) {
        const refusal = await attempt.catch((error: unknown) => error);
        if (!(refusal instanceof MailDraftAlreadySentError)) throw new Error("Expected a MailDraftAlreadySentError");
        expect({ status: refusal.status, code: refusal.code }).toEqual({
          status: 409,
          code: "mail_draft_already_sent",
        });
      }

      expect((await readDraft(created.id)).body).toEqual(sent);
      expect((await itemRow(created.id))?.deleted).toBe(false);
      expect(events).toEqual([]);
    });
  });

  it("answers 409 mail_draft_not_editable for a draft without a row, and does not read it as a draft", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      // A draft a provider holds: the Emails item and its Drafts edge, written the way a sync pass writes them.
      const providerDraft = await withTransaction(runtime, async (client) => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const emails = databases.find((row) => row.ownerModuleId === "emails");
        if (!emails) throw new Error("Missing emails");
        const folder = (await cp.listProperties(emails.id)).find((row) => row.key === "folder");
        if (!folder) throw new Error("Missing folder");
        return createEmailDraft(client, {
          emailsDatabaseId: emails.id,
          folderRelationPropertyId: folder.id,
          draftsFolderItemId: f.draftsFolderId,
          subject: "Provider draft",
        });
      });
      const before = await itemRow(providerDraft.id);

      const attempts = [
        updateDraft(providerDraft.id, { ifVersion: providerDraft.updatedAt, subject: "Změna" }),
        discardDraft(providerDraft.id),
      ];
      for (const attempt of attempts) {
        const refusal = await attempt.catch((error: unknown) => error);
        if (!(refusal instanceof MailDraftNotEditableError)) throw new Error("Expected a MailDraftNotEditableError");
        expect({ status: refusal.status, code: refusal.code }).toEqual({
          status: 409,
          code: "mail_draft_not_editable",
        });
      }

      expect(await itemRow(providerDraft.id)).toEqual(before);
      await expect(readDraft(providerDraft.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await count("mail_drafts")).toBe(0);
    });
  });

  it("answers 403 from_address_not_registered when an update names a sender the mailbox does not have", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      const refusal = await updateDraft(created.id, {
        ifVersion: created.updatedAt,
        from: "stranger@example.test",
      }).catch((error: unknown) => error);

      if (!(refusal instanceof ForbiddenError)) throw new Error("Expected a ForbiddenError");
      expect(refusal.code).toBe("from_address_not_registered");
      expect((await readDraft(created.id)).body).toEqual(created);
      const accepted = await updateDraft(created.id, { ifVersion: created.updatedAt, from: ALIAS_ADDRESS });
      expect(accepted.body.from).toBe(ALIAS_ADDRESS);
    });
  });

  it("answers 404 for a mailbox in the trash when a create or an update has to check its addresses", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));
      const { mailboxesDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      await withTransaction(runtime, (client) =>
        itemDeleteWithClient(client, mailboxesDatabaseId, f.mailboxId, {
          queueAffinity: createActionQueueAffinity(),
          writer: SYSTEM_WRITER,
        }),
      );

      await expect(createDraft(newDraft(f))).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateDraft(created.id, { ifVersion: created.updatedAt, from: OWN_ADDRESS })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // An update that names no sender checks no address, so the mailbox is not read.
      const kept = await updateDraft(created.id, { ifVersion: created.updatedAt, subject: "Still editable" });
      expect(kept.body.subject).toBe("Still editable");
    });
  });

  it("refuses an update that moves the draft to another mailbox or thread, and accepts the draft's own values", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f, { threadId: f.threadId }));

      for (const moved of [{ mailboxId: f.mailboxWithoutDraftsId }, { threadId: null }, { threadId: randomUUID() }]) {
        await expect(updateDraft(created.id, { ifVersion: created.updatedAt, ...moved })).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      expect((await readDraft(created.id)).body).toEqual(created);

      const same = await updateDraft(created.id, {
        ifVersion: created.updatedAt,
        mailboxId: f.mailboxId,
        threadId: f.threadId,
      });
      expect(same.status).toBe(200);
    });
  });

  it("answers 404 for an update that names a source message that does not exist", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      await expect(
        updateDraft(created.id, { ifVersion: created.updatedAt, sourceEmailId: randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const accepted = await updateDraft(created.id, {
        ifVersion: created.updatedAt,
        mode: "forward",
        sourceEmailId: f.receivedId,
      });
      expect(accepted.body).toMatchObject({ mode: "forward", sourceEmailId: f.receivedId });
    });
  });

  /**
   * Runs `edit` in a transaction that stays open until the returned `commit` runs, starts `request` while it is
   * open, and checks that `request` waits for it. Returns what `request` settled with, after the commit.
   */
  async function requestWaitingForOpenTransaction<T>(
    edit: (client: PoolClient) => Promise<void>,
    request: () => Promise<T>,
  ): Promise<PromiseSettledResult<T>> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEdited!: () => void;
    const edited = new Promise<void>((resolve) => {
      signalEdited = resolve;
    });
    const holder = withTransaction(runtime, async (client) => {
      await edit(client);
      signalEdited();
      await gate;
    });
    await edited;
    let settled = false;
    const pending = request().finally(() => {
      settled = true;
    });
    const outcome = Promise.allSettled([pending]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled, "the request must wait for the open transaction").toBe(false);
    release();
    await holder;
    return (await outcome)[0];
  }

  it("waits for a concurrent edit of the draft's item and then refuses its stale ifVersion", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));
      const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));

      const outcome = await requestWaitingForOpenTransaction(
        async (client) => {
          await lockItemById(client, emailsDatabaseId, created.id);
          await updateItemWithClient(
            client,
            { databaseId: emailsDatabaseId, itemId: created.id, propertiesPatch: { name: "Concurrent edit" } },
            { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
          );
        },
        () => updateDraft(created.id, { ifVersion: created.updatedAt, subject: "Late edit" }),
      );

      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ConflictError);
      expect((await itemRow(created.id))?.name).toBe("Concurrent edit");
    });
  });

  it("waits for a concurrent send of the draft and then refuses the edit as sent", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      const outcome = await requestWaitingForOpenTransaction(
        async (client) => {
          await markMailDraftSent(client, created.id);
        },
        () => updateDraft(created.id, { ifVersion: created.updatedAt, subject: "Late edit" }),
      );

      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(MailDraftAlreadySentError);
      expect((await itemRow(created.id))?.name).toBe(created.subject);
    });
  });

  it("discards a draft: the item goes to the trash, the row is gone and the draft can no longer be read or changed", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      const result = await discardDraft(created.id);

      expect(result).toEqual({ status: 200, body: { id: created.id } });
      expect((await itemRow(created.id))?.deleted).toBe(true);
      expect(await count("mail_drafts")).toBe(0);
      await expect(readDraft(created.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateDraft(created.id, { ifVersion: created.updatedAt })).rejects.toBeInstanceOf(NotFoundError);
      await expect(discardDraft(created.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("rejects a second unsent agent draft for a thread with the database, rolls the whole create back, and allows one after a discard", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const agent = { writer: { writerKind: "agent" } as const, actingUserId: USER_ID };
      const input = {
        mailboxItemId: f.mailboxId,
        from: OWN_ADDRESS,
        to: [PETR],
        cc: [],
        bcc: [],
        subject: "Návrh od agenta",
        body: "Text",
        threadId: f.threadId,
        mode: "reply" as const,
        sourceEmailItemId: null,
      };
      const first = await withTransaction(runtime, (client) => createEmailDraftInMailbox(client, input, agent));
      expect(first.createdBy).toBe("agent");
      const emailsBefore = await count("emails");

      const refusal = await withTransaction(runtime, (client) => createEmailDraftInMailbox(client, input, agent)).catch(
        (error: unknown) => error,
      );

      if (!(refusal instanceof MailDraftThreadConflictError))
        throw new Error("Expected a MailDraftThreadConflictError");
      expect(refusal.status).toBe(409);
      expect(await count("emails")).toBe(emailsBefore);
      expect(await count("mail_drafts")).toBe(1);

      // The person's drafts for the thread are not limited, and discarding the agent's draft frees the thread.
      await createDraft(newDraft(f, { threadId: f.threadId }));
      await createDraft(newDraft(f, { threadId: f.threadId }));
      await discardDraft(first.id);
      const next = await withTransaction(runtime, (client) => createEmailDraftInMailbox(client, input, agent));
      expect(next.createdBy).toBe("agent");
    });
  });

  it("announces the draft's thread once after each successful change, and nothing for a draft without a thread", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      recordThreadAnnouncements();
      const announced = { scope: "mailThread", threadId: f.threadId };

      const { body: created } = await createDraft(newDraft(f, { threadId: f.threadId }));
      expect(events).toEqual([announced]);

      const { body: updated } = await updateDraft(created.id, { ifVersion: created.updatedAt, body: "Nový text" });
      expect(events).toEqual([announced, announced]);

      await discardDraft(updated.id);
      expect(events).toEqual([announced, announced, announced]);
      expect(events[0]).not.toHaveProperty("userId");

      events = [];
      const { body: loose } = await createDraft(newDraft(f));
      const { body: looseUpdated } = await updateDraft(loose.id, { ifVersion: loose.updatedAt, body: "Text" });
      await discardDraft(looseUpdated.id);
      expect(events).toEqual([]);
    });
  });

  it("creates the Emails item as the writer of the call, so its invalidation is addressed to the acting user", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      const itemCreates: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        if (event.scope === "item" && event.op === "create") itemCreates.push(event);
      });
      const agentUser = randomUUID();

      const { body: byUser } = await createDraft(newDraft(f));
      const byAgent = await withTransaction(runtime, (client) =>
        createEmailDraftInMailbox(
          client,
          {
            mailboxItemId: f.mailboxId,
            from: OWN_ADDRESS,
            to: [],
            cc: [],
            bcc: [],
            subject: "Návrh od agenta",
            body: "",
            threadId: null,
            mode: "new",
            sourceEmailItemId: null,
          },
          { writer: { writerKind: "agent" }, actingUserId: agentUser },
        ),
      );

      const created = (itemId: string, userId: string) => ({
        scope: "item",
        databaseId: emailsDatabaseId,
        itemId,
        op: "create",
        updatedAt: expect.any(String),
        userId,
      });
      expect(itemCreates).toEqual([created(byUser.id, USER_ID), created(byAgent.id, agentUser)]);
    });
  });

  it("announces a change only after the commit of its transaction, and not when that transaction rolls back", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f, { threadId: f.threadId }));
      const context = { writer: { writerKind: "user" } as const, actingUserId: USER_ID };
      const operations: [string, (client: PoolClient) => Promise<unknown>][] = [
        [
          "create",
          (client) =>
            createEmailDraftInMailbox(
              client,
              {
                mailboxItemId: f.mailboxId,
                from: OWN_ADDRESS,
                to: [],
                cc: [],
                bcc: [],
                subject: "",
                body: "",
                threadId: f.threadId,
                mode: "new",
                sourceEmailItemId: null,
              },
              context,
            ),
        ],
        [
          "update",
          (client) =>
            updateEmailDraft(
              client,
              { draftItemId: created.id, ifVersion: created.updatedAt, body: "Nový text" },
              context,
            ),
        ],
        ["discard", (client) => discardEmailDraft(client, created.id, context)],
      ];
      const rollback = new Error("roll the transaction back");
      recordThreadAnnouncements();

      for (const [name, operation] of operations) {
        await expect(
          withTransaction(runtime, async (client) => {
            await operation(client);
            throw rollback;
          }),
          name,
        ).rejects.toBe(rollback);
        expect(events, `${name} must announce nothing for a rolled-back transaction`).toEqual([]);
      }
      // The draft is as it was created, so the same operations succeed now; each one announces after its commit.
      expect(await count("mail_drafts")).toBe(1);
      for (const [name, operation] of operations) {
        events = [];
        await withTransaction(runtime, async (client) => {
          await operation(client);
          expect(events, `${name} must hold its announcement back until the commit`).toEqual([]);
        });
        expect(events, name).toEqual([{ scope: "mailThread", threadId: f.threadId }]);
      }
    });
  });

  it("announces nothing when the one-per-thread rule rejects the create after its rows were written", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const agent = { writer: { writerKind: "agent" } as const, actingUserId: USER_ID };
      const input = {
        mailboxItemId: f.mailboxId,
        from: OWN_ADDRESS,
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        body: "",
        threadId: f.threadId,
        mode: "new" as const,
        sourceEmailItemId: null,
      };
      await withTransaction(runtime, (client) => createEmailDraftInMailbox(client, input, agent));
      recordThreadAnnouncements();

      await expect(
        withTransaction(runtime, (client) => createEmailDraftInMailbox(client, input, agent)),
      ).rejects.toThrow();

      expect(events).toEqual([]);
    });
  });

  it("keeps a draft of another tenant unreadable and unwritable, and answers like an unknown draft", async () => {
    const { ownerFixture, draft } = await runInTenant(tenant, async () => {
      const f = await setup();
      return { ownerFixture: f, draft: (await createDraft(newDraft(f, { threadId: f.threadId }))).body };
    });
    const foreignFixture = await runInTenant(foreign, () => setup());
    recordThreadAnnouncements();

    const attempts: [string, (id: string) => Promise<unknown>][] = [
      ["read", (id) => readDraft(id, foreign)],
      ["update", (id) => updateDraft(id, { ifVersion: draft.updatedAt, subject: "Cizí" }, foreign)],
      ["discard", (id) => discardDraft(id, foreign)],
    ];
    for (const [name, attempt] of attempts) {
      const refused = await attempt(draft.id).catch((error: unknown) => error);
      const unknown = await attempt(randomUUID()).catch((error: unknown) => error);
      if (!(refused instanceof NotFoundError) || !(unknown instanceof NotFoundError)) {
        throw new Error(`Both ${name} calls must be refused with a NotFoundError`);
      }
      expect(refused.message).toBe(unknown.message);
    }
    // Another tenant's mailbox, thread and source message are unknown ids to a create as well.
    for (const overrides of [
      { mailboxId: ownerFixture.mailboxId },
      { threadId: ownerFixture.threadId },
      { sourceEmailId: ownerFixture.receivedId },
    ]) {
      const refused = await createDraft(newDraft(foreignFixture, overrides), foreign).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(NotFoundError);
    }

    expect(events).toEqual([]);
    await runInTenant(tenant, async () => {
      expect((await readDraft(draft.id)).body).toEqual(draft);
      expect(await count("mail_drafts")).toBe(1);
    });
    await runInTenant(foreign, async () => {
      expect(await count("mail_drafts")).toBe(0);
    });
  });

  it.each([
    ["an address that is no address", { to: [{ address: "not-an-address" }] }],
    ["an address with a comma", { to: [{ address: "a@x.test,b@x.test" }] }],
    ["a recipient name with a line break", { to: [{ address: "a@x.test", name: "A\r\nBcc: x@x.test" }] }],
    ["a recipient with another key", { to: [{ address: "a@x.test", note: "x" }] }],
    ["a subject with a line break", { subject: "Hello\r\nBcc: x@x.test" }],
    ["a body with a NUL character", { body: "a\u0000b" }],
    ["more than 100 recipients", { to: Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@x.test` })) }],
    ["a recipient list that is no list", { cc: "a@x.test" }],
    ["a mode that does not exist", { mode: "redirect" }],
    ["a mailbox id that is no UUID", { mailboxId: "not-a-uuid" }],
    ["a thread id that is no UUID", { threadId: "not-a-uuid" }],
    ["a key the route does not know", { createdBy: "agent" }],
    ["a missing subject", { subject: undefined }],
    ["a body that is no string", { body: 7 }],
  ])("answers 400 for %s on create and creates nothing", async (_name, overrides) => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const emailsBefore = await count("emails");

      await expect(createDraft(newDraft(f, overrides))).rejects.toBeInstanceOf(ValidationError);

      expect(await count("emails")).toBe(emailsBefore);
      expect(await count("mail_drafts")).toBe(0);
    });
  });

  it.each([
    ["a body that is null", null],
    ["a body that is an array", []],
    ["a body that is a string", "ifVersion"],
  ])("answers 400 for %s on create", async (_name, raw) => {
    await expect(runInTenant(tenant, () => createDraft(raw))).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ["no ifVersion", () => ({ subject: "x" })],
    ["an ifVersion that is no string", () => ({ ifVersion: 7 })],
    ["an unknown key", (version: string) => ({ ifVersion: version, createdBy: "agent" })],
    ["a subject with a line break", (version: string) => ({ ifVersion: version, subject: "a\r\nBcc: x@x.test" })],
    ["a body that is null", () => null],
  ])("answers 400 for %s on update and changes nothing", async (_name, bodyOf) => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { body: created } = await createDraft(newDraft(f));

      await expect(updateDraft(created.id, bodyOf(created.updatedAt))).rejects.toBeInstanceOf(ValidationError);

      expect((await readDraft(created.id)).body).toEqual(created);
    });
  });

  it.each(["not-a-uuid", randomUUID()])("answers 404 for the draft id %s on every verb that names one", async (id) => {
    await runInTenant(tenant, async () => {
      await setup();
      await expect(readDraft(id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateDraft(id, { ifVersion: "x" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(discardDraft(id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
