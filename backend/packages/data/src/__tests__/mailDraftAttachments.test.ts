import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateBlob } from "../blobs/blobsStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import {
  createEmailDraft,
  updateEmailDraft,
  MailAttachmentTooLargeError,
  MailDraftAlreadySentError,
  MailDraftNotEditableError,
} from "../mail/draft.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import {
  createMailDraftAttachmentAddRouteHandler,
  createMailDraftAttachmentRemoveRouteHandler,
  createMailDraftCreateRouteHandler,
  createMailDraftDiscardRouteHandler,
  createMailDraftReadRouteHandler,
  createMailDraftUpdateRouteHandler,
} from "../mail/mailDraftRouteHandlers.js";
import { markMailDraftSent } from "../mail/mailDraftsStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const MEBIBYTE = 1024 * 1024;
const UPLOAD_LIMIT_BYTES = 10 * MEBIBYTE;

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

const USER_ID = randomUUID();
const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };

interface Fixture {
  mailboxId: string;
  draftsFolderId: string;
  threadId: string;
  /** Creates a Files item over a new blob of `byteSize` bytes, as an upload does. */
  upload: (name: string, byteSize: number) => Promise<string>;
  /** Creates a mailbox of `provider` with an address and a Drafts folder; no provider is a mailbox without the property. */
  mailbox: (provider: string | null) => Promise<string>;
}

describe("the attachments of a mail draft (issue gh-1895)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-draft-attachments-"));
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

  /** A Gmail mailbox with a Drafts folder, a received message with its thread, and the upload and mailbox helpers. */
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
    const createMailbox = async (client: PoolClient, provider: string | null) => {
      const created = await createItemWithClient(client, {
        databaseId: db("mailboxes"),
        properties: { name: `Mailbox ${randomUUID()}`, ...(provider === null ? {} : { provider }) },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes"),
        mailboxItemId: created.id,
        address: OWN_ADDRESS,
      });
      const draftsFolderId = await ensureFolderItem(client, {
        foldersDatabaseId: db("folders"),
        mailboxItemId: created.id,
        mailboxRelationPropertyId: property(folderProperties, "mailbox"),
        providerId: `DRAFTS-${created.id}`,
        name: "Drafts",
        behavior: "folder",
        specialPurpose: "drafts",
      });
      return { id: created.id, draftsFolderId };
    };
    return withTransaction(runtime, async (client) => {
      const { id: mailboxId, draftsFolderId } = await createMailbox(client, "gmail");
      const inboxId = await ensureFolderItem(client, {
        foldersDatabaseId: db("folders"),
        mailboxItemId: mailboxId,
        mailboxRelationPropertyId: property(folderProperties, "mailbox"),
        providerId: "INBOX",
        name: "Inbox",
        behavior: "folder",
        specialPurpose: "inbox",
      });
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
        storageKeyPrefix: "draft-attachment-fixtures",
      });
      const thread = await client.query<{ thread_id: string }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [received.itemId],
      );
      const threadId = thread.rows[0]?.thread_id;
      if (!threadId) throw new Error("Missing thread");
      return {
        mailboxId,
        draftsFolderId,
        threadId,
        // A mailbox of its own in a transaction of its own, as the setup's transaction is over when the test calls it.
        mailbox: (provider) =>
          withTransaction(runtime, async (mailboxClient) => (await createMailbox(mailboxClient, provider)).id),
        // The blob row states the size and no bytes are stored: the limits are decided on the recorded size.
        upload: (name, byteSize) =>
          withTransaction(runtime, async (uploadClient) => {
            const blob = await findOrCreateBlob(uploadClient, {
              mimeType: "application/pdf",
              byteSize,
              storageKey: `${randomUUID()}/${name}`,
              contentHash: randomUUID(),
            });
            const file = await createItemWithClient(uploadClient, {
              databaseId: db("files"),
              properties: { name, file: { blobId: blob.id } },
            });
            return file.id;
          }),
      };
    });
  }

  const ctx = (params: Record<string, string>, body: unknown) => ({
    params,
    body,
    identity: { user: { id: USER_ID, locale: "en" } },
  });
  const dependencies = { maxFileSizeBytes: UPLOAD_LIMIT_BYTES };

  function createDraft(f: Fixture, overrides: Record<string, unknown> = {}, inTenant = tenant) {
    return runInTenant(inTenant, () =>
      createMailDraftCreateRouteHandler(runtime)(
        ctx(
          {},
          {
            mailboxId: f.mailboxId,
            from: OWN_ADDRESS,
            to: [PETR],
            cc: [],
            bcc: [],
            subject: "Re: Nabídka na web",
            body: "Dobrý den",
            ...overrides,
          },
        ),
      ),
    ).then((answer) => answer.body);
  }
  function attach(
    draftId: string,
    fileItemId: string,
    inTenant = tenant,
    limits: { maxFileSizeBytes?: number } = dependencies,
  ) {
    return runInTenant(inTenant, () =>
      createMailDraftAttachmentAddRouteHandler(runtime, limits)(ctx({ id: draftId }, { fileItemId })),
    );
  }
  function detach(draftId: string, fileItemId: string, inTenant = tenant) {
    return runInTenant(inTenant, () =>
      createMailDraftAttachmentRemoveRouteHandler(runtime)(ctx({ id: draftId, fileItemId }, undefined)),
    );
  }
  function readDraft(id: string) {
    return runInTenant(tenant, () => createMailDraftReadRouteHandler(runtime)(ctx({ id }, undefined)));
  }
  function discard(id: string) {
    return runInTenant(tenant, () => createMailDraftDiscardRouteHandler(runtime)(ctx({ id }, undefined)));
  }

  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  /** The Files items an email holds through `Emails.attachments`, as the relation stores them, trashed ones included. */
  async function attachmentEdgesOf(emailItemId: string): Promise<string[]> {
    const { rows } = await runtime.query<{ file_item_id: string }>(
      `SELECT r.item_b::text AS file_item_id
       FROM item_relations r
       JOIN relation_definitions rd ON rd.id = r.relation_definition_id AND rd.tenant_id = r.tenant_id
       JOIN properties p ON p.id = rd.property_id_a AND p.tenant_id = rd.tenant_id AND p.key = 'attachments'
       WHERE r.tenant_id = app_tenant_default() AND r.item_a = $1
       ORDER BY r.item_b`,
      [emailItemId],
    );
    return rows.map((row) => row.file_item_id);
  }

  /** Every Files item of the tenant in scope: its id, whether it is in the Trash, and the blob it holds. */
  async function filesOfTenant(): Promise<{ id: string; trashed: boolean; blobId: string | null }[]> {
    const { rows } = await runtime.query<{ id: string; trashed: boolean; blob_id: string | null }>(
      `SELECT i.id::text, i.deleted_at IS NOT NULL AS trashed, i.properties->'file'->>'blobId' AS blob_id
       FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       WHERE i.tenant_id = app_tenant_default() AND d.owner_module_id = 'files' ORDER BY i.id`,
    );
    return rows.map((row) => ({ id: row.id, trashed: row.trashed, blobId: row.blob_id }));
  }

  async function trashedOf(fileIds: string[]): Promise<boolean[]> {
    const files = new Map((await filesOfTenant()).map((file) => [file.id, file.trashed]));
    return fileIds.map((id) => files.get(id) ?? false);
  }

  /** A received message with an attachment, ingested the way sync does: its own Files item over a stored blob. */
  async function messageWithAttachment(f: Fixture, name: string): Promise<{ emailId: string; fileId: string }> {
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
    const { itemId } = await withTransaction(runtime, async (client) => {
      const folders = await client.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
         WHERE i.tenant_id = app_tenant_default() AND d.owner_module_id = 'folders'
           AND i.properties->>'specialPurpose' = 'inbox'`,
      );
      const inbox = folders.rows[0];
      if (!inbox) throw new Error("Missing Inbox");
      return ingestEmailMessage(client, {
        emailsDatabaseId: db("emails"),
        filesDatabaseId: db("files"),
        folderRelationPropertyId: property("folder"),
        attachmentsRelationPropertyId: property("attachments"),
        mailboxItemId: f.mailboxId,
        folderItemId: inbox.id,
        messageId: `<${randomUUID()}@example.test>`,
        subject: "With a file",
        envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
        bodyText: "See the attachment",
        attachments: [
          {
            filename: name,
            contentType: "application/pdf",
            contentId: null,
            disposition: "attachment",
            openStream: () => Readable.from([Buffer.from(`bytes of ${name} ${randomUUID()}`)]),
          },
        ],
        storage: new LocalFsBlobStorageWriter(storageRoot),
        storageKeyPrefix: "draft-attachment-fixtures",
      });
    });
    const [fileId] = await attachmentEdgesOf(itemId);
    if (fileId === undefined) throw new Error("The message has no attachment");
    return { emailId: itemId, fileId };
  }

  it("attaches the file to the draft, lists it in the draft's view and attaches it to that draft only", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f, { threadId: f.threadId });
      const file = await f.upload("offer.pdf", 2048);
      const other = await createDraft(f);
      recordThreadAnnouncements();

      const answer = await attach(draft.id, file);

      expect(answer.status).toBe(200);
      const listed = { fileItemId: file, blobId: expect.any(String), filename: "offer.pdf", byteSize: 2048 };
      expect(answer.body.attachments).toEqual([listed]);
      expect(answer.body).toEqual((await readDraft(draft.id)).body);
      expect(await attachmentEdgesOf(draft.id)).toEqual([file]);
      expect(await attachmentEdgesOf(other.id)).toEqual([]);
      expect((await readDraft(other.id)).body.attachments).toEqual([]);
      expect(events).toEqual([{ scope: "mailThread", threadId: f.threadId }]);
    });
  });

  it("lists several attachments, oldest first, in the answer of a later update", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const first = await f.upload("a.pdf", 10);
      const second = await f.upload("b.pdf", 20);
      await attach(draft.id, first);
      const answer = await attach(draft.id, second);

      expect(answer.body.attachments.map((attachment) => attachment.fileItemId)).toEqual([first, second]);
      const updated = await runInTenant(tenant, () =>
        createMailDraftUpdateRouteHandler(runtime)(
          ctx({ id: draft.id }, { ifVersion: answer.body.updatedAt, subject: "Changed" }),
        ),
      );
      expect(updated.body.attachments.map((attachment) => attachment.fileItemId)).toEqual([first, second]);
    });
  });

  it("changes nothing and announces nothing when the file is attached to the draft already", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f, { threadId: f.threadId });
      const file = await f.upload("offer.pdf", 2048);
      const first = await attach(draft.id, file);
      recordThreadAnnouncements();

      const again = await attach(draft.id, file);

      expect(again.body).toEqual(first.body);
      expect(await attachmentEdgesOf(draft.id)).toEqual([file]);
      expect(await filesOfTenant()).toHaveLength(1);
      expect(events).toEqual([]);
    });
  });

  it("leaves a file that another email holds with that email and attaches a new Files item over the same blob", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { emailId, fileId } = await messageWithAttachment(f, "contract.pdf");
      const draft = await createDraft(f, { threadId: f.threadId });
      const filesBefore = await filesOfTenant();
      recordThreadAnnouncements();

      const answer = await attach(draft.id, fileId);

      const [attachment] = answer.body.attachments;
      expect(answer.body.attachments).toHaveLength(1);
      expect(attachment?.fileItemId).not.toBe(fileId);
      expect(attachment).toMatchObject({ filename: "contract.pdf" });
      // The copy holds the blob of the original, and the other email keeps its own Files item.
      const original = filesBefore.find((file) => file.id === fileId);
      expect(attachment?.blobId).toBe(original?.blobId);
      expect(await attachmentEdgesOf(emailId)).toEqual([fileId]);
      expect(await attachmentEdgesOf(draft.id)).toEqual([attachment?.fileItemId]);
      expect((await filesOfTenant()).filter((file) => !filesBefore.some((before) => before.id === file.id))).toEqual([
        { id: attachment?.fileItemId, trashed: false, blobId: original?.blobId },
      ]);
      expect(events).toEqual([{ scope: "mailThread", threadId: f.threadId }]);
    });
  });

  it("attaches a file that another email holds once when the post is repeated, and announces only the first", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { emailId, fileId } = await messageWithAttachment(f, "contract.pdf");
      const draft = await createDraft(f, { threadId: f.threadId });
      const first = await attach(draft.id, fileId);
      const filesAfterFirst = await filesOfTenant();
      recordThreadAnnouncements();

      const again = await attach(draft.id, fileId);

      expect(again.body).toEqual(first.body);
      expect(again.body.attachments).toHaveLength(1);
      expect(await filesOfTenant()).toEqual(filesAfterFirst);
      expect(await attachmentEdgesOf(draft.id)).toEqual([first.body.attachments[0]?.fileItemId]);
      expect(await attachmentEdgesOf(emailId)).toEqual([fileId]);
      expect(events).toEqual([]);
    });
  });

  it("does not count the repeated post of a held file against the limit a second time", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { fileId } = await messageWithAttachment(f, "contract.pdf");
      const draft = await createDraft(f, { mailboxId: await f.mailbox("generic") });
      const size = (await attach(draft.id, fileId, tenant, { maxFileSizeBytes: 1024 })).body.attachments[0]?.byteSize;
      if (size === undefined) throw new Error("Expected the copy");

      // The limit is exactly the size of one copy: a second copy would be refused, a retry is not.
      const again = await attach(draft.id, fileId, tenant, { maxFileSizeBytes: size });

      expect(again.status).toBe(200);
      expect(again.body.attachments).toHaveLength(1);
    });
  });

  it("copies a file that another draft holds, so that both drafts list an attachment of their own", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const first = await createDraft(f);
      const second = await createDraft(f);
      const file = await f.upload("shared.pdf", 4096);
      await attach(first.id, file);

      const answer = await attach(second.id, file);

      expect(answer.body.attachments).toHaveLength(1);
      expect(answer.body.attachments[0]?.fileItemId).not.toBe(file);
      expect((await readDraft(first.id)).body.attachments.map((attachment) => attachment.fileItemId)).toEqual([file]);
    });
  });

  it("gives two concurrent attaches of one file to two drafts the file once and a copy once, without a cardinality error", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const first = await createDraft(f);
      const second = await createDraft(f);
      const file = await f.upload("contended.pdf", 4096);

      const [one, two] = await Promise.all([attach(first.id, file), attach(second.id, file)]);

      const attached = [...one.body.attachments, ...two.body.attachments].map((attachment) => attachment.fileItemId);
      expect(attached).toHaveLength(2);
      expect(attached.filter((id) => id === file)).toHaveLength(1);
      expect(new Set(attached).size).toBe(2);
    });
  });

  it.each([
    ["gmail", 25],
    ["outlook", 20],
    ["icloud", 20],
  ])(
    "allows a %s draft up to %i MB of attachments and refuses a file over it with 413",
    async (provider, megabytes) => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const draft = await createDraft(f, { mailboxId: await f.mailbox(provider) });
        const limit = megabytes * MEBIBYTE;
        const first = await f.upload("first.pdf", limit - 10);
        const exact = await f.upload("exact.pdf", 10);
        const over = await f.upload("over.pdf", 1);
        await attach(draft.id, first);
        const filesBefore = await filesOfTenant();
        recordThreadAnnouncements();

        // The total reaches the limit exactly, which is allowed.
        expect((await attach(draft.id, exact)).body.attachments).toHaveLength(2);
        const refusal = await attach(draft.id, over).catch((error: unknown) => error);

        if (!(refusal instanceof MailAttachmentTooLargeError))
          throw new Error("Expected a MailAttachmentTooLargeError");
        expect({ status: refusal.status, code: refusal.code, details: refusal.details }).toEqual({
          status: 413,
          code: "mail_attachment_too_large",
          details: { limitBytes: limit, totalBytes: limit + 1 },
        });
        expect(await attachmentEdgesOf(draft.id)).toEqual([first, exact].sort());
        expect(await filesOfTenant()).toEqual(filesBefore);
      });
    },
  );

  it.each([
    ["generic", "generic"],
    ["no provider", null],
  ])("applies the upload limit to a mailbox of %s", async (_name, provider) => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f, { mailboxId: await f.mailbox(provider) });
      const fits = await f.upload("fits.pdf", UPLOAD_LIMIT_BYTES);
      const over = await f.upload("over.pdf", 1);

      expect((await attach(draft.id, fits)).body.attachments).toHaveLength(1);
      await expect(attach(draft.id, over)).rejects.toBeInstanceOf(MailAttachmentTooLargeError);

      expect(await attachmentEdgesOf(draft.id)).toEqual([fits]);
    });
  });

  it("counts the size of a file that is copied against the limit and creates no copy when it is too large", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { emailId, fileId } = await messageWithAttachment(f, "contract.pdf");
      const draft = await createDraft(f, { mailboxId: await f.mailbox("generic") });
      const filesBefore = await filesOfTenant();

      await expect(attach(draft.id, fileId, tenant, { maxFileSizeBytes: 1 })).rejects.toBeInstanceOf(
        MailAttachmentTooLargeError,
      );

      expect(await filesOfTenant()).toEqual(filesBefore);
      expect(await attachmentEdgesOf(emailId)).toEqual([fileId]);
      expect(await attachmentEdgesOf(draft.id)).toEqual([]);
    });
  });

  it("detaches a file, keeps its Files item and announces the change", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f, { threadId: f.threadId });
      const kept = await f.upload("kept.pdf", 10);
      const removed = await f.upload("removed.pdf", 10);
      await attach(draft.id, kept);
      await attach(draft.id, removed);
      recordThreadAnnouncements();

      const answer = await detach(draft.id, removed);

      expect(answer.status).toBe(200);
      expect(answer.body.attachments.map((attachment) => attachment.fileItemId)).toEqual([kept]);
      expect(answer.body).toEqual((await readDraft(draft.id)).body);
      expect(await attachmentEdgesOf(draft.id)).toEqual([kept]);
      expect(await trashedOf([kept, removed])).toEqual([false, false]);
      expect(events).toEqual([{ scope: "mailThread", threadId: f.threadId }]);
    });
  });

  it("records the user as the last editor of a draft whose attachment the user added or removed", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const lastEditedBy = async (draftId: string): Promise<string | undefined> => {
        const { rows } = await runtime.query<{ last_edited_by: string }>(
          "SELECT last_edited_by FROM mail_drafts WHERE tenant_id = app_tenant_default() AND email_item_id = $1",
          [draftId],
        );
        return rows[0]?.last_edited_by;
      };
      const editAsAgent = async (draftId: string) => {
        const version = (await readDraft(draftId)).body.updatedAt;
        await withTransaction(runtime, (client) =>
          updateEmailDraft(
            client,
            { draftItemId: draftId, ifVersion: version, body: "Text od agenta" },
            { writer: { writerKind: "agent" } },
          ),
        );
      };
      const draft = await createDraft(f);
      const file = await f.upload("offer.pdf", 10);
      await editAsAgent(draft.id);
      expect(await lastEditedBy(draft.id)).toBe("agent");

      await attach(draft.id, file);
      expect(await lastEditedBy(draft.id)).toBe("user");

      await editAsAgent(draft.id);
      expect(await lastEditedBy(draft.id)).toBe("agent");
      await detach(draft.id, file);
      expect(await lastEditedBy(draft.id)).toBe("user");
    });
  });

  it("answers 404 for a file that is not attached to the draft, one that another email holds and an unknown id", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f, { threadId: f.threadId });
      const other = await createDraft(f);
      const unattached = await f.upload("loose.pdf", 10);
      const heldElsewhere = await f.upload("elsewhere.pdf", 10);
      await attach(other.id, heldElsewhere);
      recordThreadAnnouncements();

      for (const fileId of [unattached, heldElsewhere, randomUUID()]) {
        await expect(detach(draft.id, fileId)).rejects.toBeInstanceOf(NotFoundError);
      }

      expect(await attachmentEdgesOf(other.id)).toEqual([heldElsewhere]);
      expect(events).toEqual([]);
    });
  });

  it("refuses to attach to or detach from a sent draft, and changes nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f, { threadId: f.threadId });
      const attached = await f.upload("attached.pdf", 10);
      const loose = await f.upload("loose.pdf", 10);
      await attach(draft.id, attached);
      await withTransaction(runtime, (client) => markMailDraftSent(client, draft.id));
      recordThreadAnnouncements();

      await expect(attach(draft.id, loose)).rejects.toBeInstanceOf(MailDraftAlreadySentError);
      await expect(detach(draft.id, attached)).rejects.toBeInstanceOf(MailDraftAlreadySentError);

      expect(await attachmentEdgesOf(draft.id)).toEqual([attached]);
      expect(events).toEqual([]);
    });
  });

  it("refuses to attach to or detach from an Emails item that has no draft row, and changes nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const file = await f.upload("loose.pdf", 10);
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

      await expect(attach(providerDraft.id, file)).rejects.toBeInstanceOf(MailDraftNotEditableError);
      await expect(detach(providerDraft.id, file)).rejects.toBeInstanceOf(MailDraftNotEditableError);

      expect(await attachmentEdgesOf(providerDraft.id)).toEqual([]);
    });
  });

  it("answers 404 for an unknown draft and refuses the Emails item of a received message as not editable", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const file = await f.upload("loose.pdf", 10);
      const { emailId } = await messageWithAttachment(f, "contract.pdf");

      await expect(attach(randomUUID(), file)).rejects.toBeInstanceOf(NotFoundError);
      await expect(detach(randomUUID(), file)).rejects.toBeInstanceOf(NotFoundError);
      // A received message has no draft row, so it is not editable; an id that names no Emails item is a 404.
      await expect(attach(emailId, file)).rejects.toBeInstanceOf(MailDraftNotEditableError);
      expect(await attachmentEdgesOf(emailId)).toHaveLength(1);
    });
  });

  it("answers 404 for a file that is unknown, trashed or an item of another database, and attaches nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const trashed = await f.upload("trashed.pdf", 10);
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const files = databases.find((row) => row.ownerModuleId === "files");
      if (!files) throw new Error("Missing files");
      expect(await cp.softDeleteItem(files.id, trashed)).not.toBeNull();

      for (const fileItemId of [randomUUID(), trashed, f.mailboxId, draft.id]) {
        await expect(attach(draft.id, fileItemId)).rejects.toBeInstanceOf(NotFoundError);
      }

      expect(await attachmentEdgesOf(draft.id)).toEqual([]);
    });
  });

  it("answers 404 for a file of another tenant, and for a draft of another tenant, and leaves both as they were", async () => {
    const theirs = await runInTenant(foreign, async () => {
      const f = await setup();
      return { draft: await createDraft(f, {}, foreign), file: await f.upload("theirs.pdf", 10) };
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const mine = await f.upload("mine.pdf", 10);
      await attach(draft.id, mine);

      await expect(attach(draft.id, theirs.file)).rejects.toBeInstanceOf(NotFoundError);
      await expect(attach(theirs.draft.id, mine)).rejects.toBeInstanceOf(NotFoundError);
      await expect(detach(theirs.draft.id, mine)).rejects.toBeInstanceOf(NotFoundError);

      expect(await attachmentEdgesOf(draft.id)).toEqual([mine]);
    });
    await runInTenant(foreign, async () => {
      expect(await attachmentEdgesOf(theirs.draft.id)).toEqual([]);
      expect((await filesOfTenant()).map((file) => ({ id: file.id, trashed: file.trashed }))).toEqual([
        { id: theirs.file, trashed: false },
      ]);
    });
  });

  it("answers 400 for a file without stored content and attaches nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const cp = createChokePoint(runtime);
      const files = (await cp.listDatabases()).find((row) => row.ownerModuleId === "files");
      if (!files) throw new Error("Missing files");
      const empty = await cp.createItem({ databaseId: files.id, properties: { name: "empty" } });

      await expect(attach(draft.id, empty.id)).rejects.toBeInstanceOf(ValidationError);

      expect(await attachmentEdgesOf(draft.id)).toEqual([]);
    });
  });

  it("answers 404 when the mailbox of the draft is in the Trash, and attaches nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const mailboxId = await f.mailbox("gmail");
      const draft = await createDraft(f, { mailboxId });
      const file = await f.upload("loose.pdf", 10);
      // Trashing the mailbox through the choke point leaves its drafts, as no hook of the mailbox deletes them.
      const cp = createChokePoint(runtime);
      const mailboxes = (await cp.listDatabases()).find((row) => row.ownerModuleId === "mailboxes");
      if (!mailboxes) throw new Error("Missing mailboxes");
      expect(await cp.softDeleteItem(mailboxes.id, mailboxId)).not.toBeNull();

      await expect(attach(draft.id, file)).rejects.toBeInstanceOf(NotFoundError);

      expect(await attachmentEdgesOf(draft.id)).toEqual([]);
    });
  });

  it("trashes the files uploaded for a discarded draft and the copies made for it, and no file of another email", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { emailId, fileId: foreignAttachment } = await messageWithAttachment(f, "contract.pdf");
      const draft = await createDraft(f, { threadId: f.threadId });
      const uploaded = await f.upload("uploaded.pdf", 10);
      const detached = await f.upload("detached.pdf", 10);
      const untouched = await f.upload("untouched.pdf", 10);
      await attach(draft.id, uploaded);
      await attach(draft.id, detached);
      await detach(draft.id, detached);
      const copied = (await attach(draft.id, foreignAttachment)).body.attachments.map((a) => a.fileItemId);
      const copy = copied.find((id) => id !== uploaded);
      if (copy === undefined || copied.length !== 2) throw new Error("Expected the upload and a copy");
      recordThreadAnnouncements();

      const answer = await discard(draft.id);

      expect(answer).toEqual({ status: 200, body: { id: draft.id } });
      expect(await trashedOf([uploaded, copy])).toEqual([true, true]);
      expect(await trashedOf([foreignAttachment, detached, untouched])).toEqual([false, false, false]);
      expect(await attachmentEdgesOf(emailId)).toEqual([foreignAttachment]);
      expect(events).toEqual([{ scope: "mailThread", threadId: f.threadId }]);
    });
  });

  it("keeps a file of a discarded draft that is related to anything else, such as a project", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const db = (key: string) => {
        const found = databases.find((row) => row.ownerModuleId === key);
        if (!found) throw new Error(`Missing ${key}`);
        return found.id;
      };
      const draft = await createDraft(f);
      const inProject = await f.upload("in-project.pdf", 10);
      const alone = await f.upload("alone.pdf", 10);
      const project = await cp.createItem({ databaseId: db("projects"), properties: { name: "Project" } });
      const projectsProperty = (await cp.listProperties(db("files"))).find((row) => row.key === "projects");
      if (!projectsProperty) throw new Error("Missing Files.projects");
      await cp.createRelation({
        relationPropertyId: projectsProperty.id,
        callerItemId: inProject,
        targetItemId: project.id,
      });
      await attach(draft.id, inProject);
      await attach(draft.id, alone);

      await discard(draft.id);

      expect(await trashedOf([inProject, alone])).toEqual([false, true]);
    });
  });

  it("keeps a file that existed before the draft when the draft is discarded, and trashes one uploaded after it", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const older = await f.upload("older.pdf", 10);
      const draft = await createDraft(f, { threadId: f.threadId });
      const uploaded = await f.upload("uploaded.pdf", 10);
      await attach(draft.id, older);
      await attach(draft.id, uploaded);

      await discard(draft.id);

      expect(await trashedOf([older, uploaded])).toEqual([false, true]);
      expect(await attachmentEdgesOf(draft.id)).toEqual([older, uploaded].sort());
    });
  });

  it("trashes the copy of a file that existed before the draft, as the copy was made for the draft", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const { fileId } = await messageWithAttachment(f, "contract.pdf");
      const draft = await createDraft(f);
      const copy = (await attach(draft.id, fileId)).body.attachments[0]?.fileItemId;
      if (copy === undefined) throw new Error("Expected the copy");

      await discard(draft.id);

      expect(await trashedOf([fileId, copy])).toEqual([false, true]);
    });
  });

  it("trashes no file when the draft was sent, and keeps its attachments", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const file = await f.upload("attached.pdf", 10);
      await attach(draft.id, file);
      await withTransaction(runtime, (client) => markMailDraftSent(client, draft.id));

      await expect(discard(draft.id)).rejects.toBeInstanceOf(MailDraftAlreadySentError);

      expect(await trashedOf([file])).toEqual([false]);
      expect(await attachmentEdgesOf(draft.id)).toEqual([file]);
    });
  });

  it("discards a draft that has no attachments and trashes no file that is not attached to it", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const loose = await f.upload("loose.pdf", 10);

      await discard(draft.id);

      expect(await trashedOf([loose])).toEqual([false]);
      await expect(readDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it.each([
    ["a file item id that is no UUID", { id: "draft", fileItemId: "not-a-uuid" }],
    ["a draft id that is no UUID", { id: "not-a-uuid", fileItemId: randomUUID() }],
  ])("answers 404 for %s when detaching", async (_name, params) => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const route = createMailDraftAttachmentRemoveRouteHandler(runtime);

      await expect(
        route(ctx({ ...params, id: params.id === "draft" ? draft.id : params.id }, undefined)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it.each([
    ["a body without fileItemId", {}],
    ["a fileItemId that is no UUID", { fileItemId: "not-a-uuid" }],
    ["a body with another key", { fileItemId: randomUUID(), extra: true }],
    ["a body that is null", null],
    ["a body that is an array", [randomUUID()]],
  ])("answers 400 for %s when attaching and attaches nothing", async (_name, body) => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);

      await expect(
        runInTenant(tenant, () =>
          createMailDraftAttachmentAddRouteHandler(runtime, dependencies)(ctx({ id: draft.id }, body)),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await attachmentEdgesOf(draft.id)).toEqual([]);
    });
  });

  it("answers 404 for a draft id that is no UUID when attaching", async () => {
    await expect(
      runInTenant(tenant, () =>
        createMailDraftAttachmentAddRouteHandler(
          runtime,
          dependencies,
        )(ctx({ id: "not-a-uuid" }, { fileItemId: randomUUID() })),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fails the attach request with a configuration error when the composition root set no upload limit", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const draft = await createDraft(f);
      const file = await f.upload("loose.pdf", 10);

      const failure = await attach(draft.id, file, tenant, {}).catch((error: unknown) => error);

      if (!(failure instanceof Error)) throw new Error("Expected an error");
      expect(failure.message).toBe(
        'custom route dependency "maxFileSizeBytes" is not configured by the composition root',
      );
      expect(failure).not.toBeInstanceOf(NotFoundError);
      expect(await attachmentEdgesOf(draft.id)).toEqual([]);
    });
  });
});
