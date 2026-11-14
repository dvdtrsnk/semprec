import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findOrCreateBlob } from "../blobs/blobsStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft, createEmailDraftInMailbox } from "../mail/draft.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import {
  createMailDraftAttachmentAddRouteHandler,
  createMailDraftCreateRouteHandler,
  createMailDraftDiscardRouteHandler,
  createMailDraftReadRouteHandler,
  createMailDraftSendRouteHandler,
  createMailDraftUpdateRouteHandler,
} from "../mail/mailDraftRouteHandlers.js";
import { markMailDraftSent } from "../mail/mailDraftsStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { createMailTransportFactory, type MailTransport, type MailTransportMessage } from "../mail/mailTransport.js";
import {
  MailReauthorizationRequiredError,
  MailRecipientRejectedError,
  MailSendAuthFailedError,
  MailServerUnreachableError,
} from "../mail/providerTypes.js";
import { reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import type { MailSendAdapterFactory } from "../mail/send.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { recordingTransport, transportFor } from "../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

const USER_ID = randomUUID();
const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const JANA = { name: "", address: "jana@example.test" };
const SECRET = { name: "Skrytá", address: "hidden@example.test" };

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";
const REFRESH_TOKEN = "1//stored-refresh-token-for-the-send-route";
const OAUTH_CLIENT = { clientId: "send-route-client.example", clientSecret: "send-route-client-secret" };

interface Fixture {
  mailboxId: string;
  mailboxName: string;
  draftsFolderId: string;
  sentFolderId: string;
  /** The thread of one received message, the received message and its Message-ID. */
  threadId: string;
  receivedId: string;
  receivedMessageId: string;
  /** A message of a second mailbox of the tenant that has a `mail_message_meta` row and a provider thread id. */
  otherMailboxReceivedId: string;
  /** An Emails item with no `mail_message_meta` row: a message that was never ingested. */
  unsyncedSourceId: string;
  /** A mailbox with no Sent folder. */
  mailboxWithoutSentId: string;
}

describe("sending a mail draft over HTTP (issue gh-1896)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-draft-send-"));
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

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn));

  async function databaseIds() {
    const databases = await createChokePoint(runtime).listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    const cp = createChokePoint(runtime);
    const emailProperties = await cp.listProperties(db("emails"));
    const folderProperties = await cp.listProperties(db("folders"));
    const property = (properties: typeof emailProperties, key: string) => {
      const found = properties.find((row) => row.key === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    return { db, emailProperties, folderProperties, property };
  }

  /** A Gmail mailbox with Drafts, Sent and Inbox folders and a received message, a second mailbox and a mailbox without Sent. */
  async function setup(provider = "gmail"): Promise<Fixture> {
    const { db, emailProperties, folderProperties, property } = await databaseIds();
    return withTransaction(runtime, async (client) => {
      const mailbox = async (name: string, mailboxProvider: string) => {
        const created = await createItemWithClient(client, {
          databaseId: db("mailboxes"),
          properties: { name, provider: mailboxProvider },
        });
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId: db("mailboxes"),
          mailboxItemId: created.id,
          address: OWN_ADDRESS,
        });
        return created.id;
      };
      const folder = (mailboxItemId: string, specialPurpose: string) =>
        ensureFolderItem(client, {
          foldersDatabaseId: db("folders"),
          mailboxItemId,
          mailboxRelationPropertyId: property(folderProperties, "mailbox"),
          providerId: `${specialPurpose.toUpperCase()}-${mailboxItemId}`,
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      const receive = (mailboxItemId: string, folderItemId: string, messageId: string, providerThreadId: string) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: db("emails"),
          filesDatabaseId: db("files"),
          folderRelationPropertyId: property(emailProperties, "folder"),
          attachmentsRelationPropertyId: property(emailProperties, "attachments"),
          mailboxItemId,
          folderItemId,
          messageId,
          subject: "Nabídka na web",
          date: new Date("2026-10-01T09:00:00Z"),
          envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
          bodyHtml: "<p>Dobrý den</p>",
          attachments: [],
          providerThreadId,
          storage: new LocalFsBlobStorageWriter(storageRoot),
          storageKeyPrefix: "draft-send-fixtures",
        });

      const mailboxName = "Personal";
      const mailboxId = await mailbox(mailboxName, provider);
      const draftsFolderId = await folder(mailboxId, "drafts");
      const sentFolderId = await folder(mailboxId, "sent");
      const inboxId = await folder(mailboxId, "inbox");
      const received = await receive(mailboxId, inboxId, "<received@example.test>", "gmail-thread-1");
      const otherMailboxId = await mailbox("Other", "gmail");
      const otherInboxId = await folder(otherMailboxId, "inbox");
      const otherReceived = await receive(otherMailboxId, otherInboxId, "<other@example.test>", "gmail-thread-other");
      const mailboxWithoutSentId = await mailbox("No Sent", provider);
      await folder(mailboxWithoutSentId, "drafts");
      const unsynced = await createItemWithClient(
        client,
        { databaseId: db("emails"), properties: { name: "Never ingested", sender: "x@example.test", body: "" } },
        { allowedSystemKeys: ["name", "sender", "body"] },
      );
      const thread = await client.query<{ thread_id: string }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [received.itemId],
      );
      const threadId = thread.rows[0]?.thread_id;
      if (!threadId) throw new Error("Missing thread");
      return {
        mailboxId,
        mailboxName,
        draftsFolderId,
        sentFolderId,
        threadId,
        receivedId: received.itemId,
        receivedMessageId: "<received@example.test>",
        otherMailboxReceivedId: otherReceived.itemId,
        unsyncedSourceId: unsynced.id,
        mailboxWithoutSentId,
      };
    });
  }

  const ctx = (params: Record<string, string>, body: unknown) => ({
    params,
    body,
    identity: { user: { id: USER_ID, locale: "en" } },
  });

  function adaptersFor(transport: MailTransport): MailSendAdapterFactory {
    return { transports: transportFor(transport), attachmentStorage: attachmentStorage() };
  }

  function attachmentStorage() {
    const storage = new LocalFsBlobStorageWriter(storageRoot);
    return { files: storage, mailAttachments: storage };
  }

  function sendDraft(id: string, adapters: MailSendAdapterFactory, inTenant = tenant) {
    return runInTenant(inTenant, () =>
      createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adapters } })(ctx({ id }, undefined)),
    );
  }

  /** A draft of the fixture's mailbox made through the real create route; `overrides` replace the fields of the body. */
  async function newDraft(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 100 * 1024 * 1024 })(
      ctx(
        {},
        {
          mailboxId: f.mailboxId,
          from: OWN_ADDRESS,
          to: [PETR],
          cc: [JANA],
          bcc: [SECRET],
          subject: "Re: Nabídka na web",
          body: "Dobrý den,\nděkuji za nabídku.",
          ...overrides,
        },
      ),
    );
    expect(created.status).toBe(201);
    return created.body.id;
  }

  const replyTo = (f: Fixture) => ({ threadId: f.threadId, mode: "reply", sourceEmailId: f.receivedId });

  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  async function sentAtOf(draftId: string): Promise<Date | null | undefined> {
    const { rows } = await runtime.query<{ sent_at: Date | null }>(
      "SELECT sent_at FROM mail_drafts WHERE tenant_id = app_tenant_default() AND email_item_id = $1",
      [draftId],
    );
    return rows[0] ? rows[0].sent_at : undefined;
  }

  async function claimOf(draftId: string): Promise<{ thread_id: string; message_id: string } | undefined> {
    const { rows } = await runtime.query<{ thread_id: string; message_id: string }>(
      "SELECT thread_id, message_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
      [draftId],
    );
    return rows[0];
  }

  async function messagesInThread(threadId: string): Promise<number> {
    const { rows } = await runtime.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND thread_id = $1",
      [threadId],
    );
    return rows[0]?.n ?? -1;
  }

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

  async function dateOf(itemId: string): Promise<string | undefined> {
    const { rows } = await runtime.query<{ date: string | null }>(
      "SELECT properties->>'date' AS date FROM items WHERE tenant_id = app_tenant_default() AND id = $1",
      [itemId],
    );
    return rows[0]?.date ?? undefined;
  }

  async function setSyncStatus(mailboxId: string, syncStatus: string): Promise<void> {
    await withTransaction(runtime, async (client) => {
      const ids = await resolveMailModuleIds(client);
      await updateItemWithClient(
        client,
        { databaseId: ids.mailboxesDatabaseId, itemId: mailboxId, propertiesPatch: { syncStatus } },
        { allowedSystemKeys: ["syncStatus"] },
      );
    });
  }

  /** Moves an item to the trash through the choke point, as a delete does; the system writer passes the mailbox hook. */
  async function trash(databaseKey: "emails" | "mailboxes", itemId: string): Promise<void> {
    const { db } = await databaseIds();
    await withTransaction(runtime, async (client) => {
      const trashed = await itemDeleteWithClient(client, db(databaseKey), itemId, {
        queueAffinity: createActionQueueAffinity(),
        writer: SYSTEM_WRITER,
      });
      expect(trashed).not.toBeNull();
    });
  }

  /** The draft is as it was before the call: no claim, no `sent_at`, still in Drafts, and nothing was announced. */
  async function expectDraftUntouched(draftId: string): Promise<void> {
    expect(await claimOf(draftId)).toBeUndefined();
    expect(await sentAtOf(draftId)).toBeNull();
    expect(await folderPurposesOf(draftId)).toEqual(["drafts"]);
    expect(events).toEqual([]);
  }

  tenantIt("sends the draft once and answers its item, thread, send time and mailbox", async () => {
    const f = await setup();
    const draftId = await newDraft(f);
    const transport = recordingTransport();
    recordThreadAnnouncements();

    const answer = await sendDraft(draftId, adaptersFor(transport));

    const claim = await claimOf(draftId);
    expect(claim).toBeDefined();
    expect(answer).toEqual({
      status: 200,
      body: {
        emailId: draftId,
        threadId: claim?.thread_id,
        sentAt: expect.any(String),
        mailbox: { id: f.mailboxId, name: f.mailboxName },
      },
    });
    expect(transport.sent).toHaveLength(1);
    const delivered = transport.sent[0];
    expect(delivered?.envelope).toEqual({
      from: OWN_ADDRESS,
      recipients: [PETR.address, JANA.address, SECRET.address],
    });
    const parsed = await simpleParser(delivered?.raw ?? Buffer.alloc(0));
    expect(parsed.messageId).toBe(claim?.message_id);
    expect(parsed.subject).toBe("Re: Nabídka na web");
    expect(parsed.text).toContain("děkuji za nabídku.");
    expect(parsed.inReplyTo).toBeUndefined();
    // A draft that replies to nothing starts its own thread, which holds this message alone.
    expect(await messagesInThread(claim?.thread_id ?? "")).toBe(1);
  });

  tenantIt(
    "sets the draft's sent_at to the time it answers, moves the item to Sent and announces its thread once",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f);
      recordThreadAnnouncements();

      const answer = await sendDraft(draftId, adaptersFor(recordingTransport()));

      const sentAt = await sentAtOf(draftId);
      expect(sentAt).toBeInstanceOf(Date);
      expect(answer.body.sentAt).toBe(sentAt?.toISOString());
      expect(await dateOf(draftId)).toBe(answer.body.sentAt);
      expect(await folderPurposesOf(draftId)).toEqual(["sent"]);
      expect(events).toEqual([{ scope: "mailThread", threadId: answer.body.threadId }]);
    },
  );

  tenantIt(
    "sends a reply with In-Reply-To and References, into the thread of its source message, adding one message",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f, replyTo(f));
      const transport = recordingTransport();
      expect(await messagesInThread(f.threadId)).toBe(1);

      const answer = await sendDraft(draftId, adaptersFor(transport));

      expect(answer.body.threadId).toBe(f.threadId);
      expect(await messagesInThread(f.threadId)).toBe(2);
      const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
      expect(parsed.inReplyTo).toBe(f.receivedMessageId);
      // mailparser gives one reference as a string and several as an array.
      expect([parsed.references ?? []].flat()).toEqual([f.receivedMessageId]);
      // The provider's conversation id of a source in the draft's own mailbox goes to the transport.
      expect(transport.sent[0]?.providerThreadId).toBe("gmail-thread-1");
    },
  );

  tenantIt("does not hand the transport the provider thread of a source message of another mailbox", async () => {
    const f = await setup();
    const draftId = await newDraft(f, {
      threadId: null,
      mode: "reply",
      sourceEmailId: f.otherMailboxReceivedId,
    });
    const transport = recordingTransport();

    await sendDraft(draftId, adaptersFor(transport));

    const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.inReplyTo).toBe("<other@example.test>");
    expect(transport.sent[0]).not.toHaveProperty("providerThreadId");
  });

  tenantIt("sends a reply-all with the reply headers too", async () => {
    const f = await setup();
    const draftId = await newDraft(f, { ...replyTo(f), mode: "replyAll" });
    const transport = recordingTransport();

    await sendDraft(draftId, adaptersFor(transport));

    const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.inReplyTo).toBe(f.receivedMessageId);
  });

  tenantIt("sends a forward without In-Reply-To, as a thread of its own", async () => {
    const f = await setup();
    const draftId = await newDraft(f, { ...replyTo(f), mode: "forward" });
    // A forward starts with no recipient (gh-1899); the person addresses it before sending.
    const read = await createMailDraftReadRouteHandler(runtime)(ctx({ id: draftId }, undefined));
    await createMailDraftUpdateRouteHandler(runtime)(
      ctx({ id: draftId }, { ifVersion: read.body.updatedAt, to: [PETR] }),
    );
    const transport = recordingTransport();

    const answer = await sendDraft(draftId, adaptersFor(transport));

    const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.inReplyTo).toBeUndefined();
    expect(answer.body.threadId).not.toBe(f.threadId);
    expect(transport.sent[0]).not.toHaveProperty("providerThreadId");
  });

  tenantIt("sends a reply whose source message was never ingested without reply headers", async () => {
    const f = await setup();
    // The create route (gh-1899) refuses a reply to a message with no ingested metadata, so the draft is written
    // through the operation underneath it, which only requires a live source item.
    const draft = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        createEmailDraftInMailbox(
          client,
          {
            mailboxItemId: f.mailboxId,
            threadId: null,
            mode: "reply",
            sourceEmailItemId: f.unsyncedSourceId,
            from: OWN_ADDRESS,
            to: [PETR],
            cc: [JANA],
            bcc: [SECRET],
            subject: "Re: Nabídka na web",
            body: "Dobrý den,\nděkuji za nabídku.",
          },
          { writer: { writerKind: "user" }, actingUserId: USER_ID },
        ),
      ),
    );
    const draftId = draft.id;
    const transport = recordingTransport();

    await sendDraft(draftId, adaptersFor(transport));

    const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.inReplyTo).toBeUndefined();
    expect(transport.sent).toHaveLength(1);
  });

  tenantIt("sends the draft's attachments with their names and types", async () => {
    const f = await setup();
    const { db } = await databaseIds();
    const bytes = Buffer.from("%PDF-1.4 the attached bytes");
    const fileId = await withTransaction(runtime, async (client) => {
      const storage = new LocalFsBlobStorageWriter(storageRoot);
      const storageKey = `${randomUUID()}/offer.pdf`;
      const written = await storage.writeStream(storageKey, Readable.from([bytes]));
      const blob = await findOrCreateBlob(client, {
        mimeType: "application/pdf",
        byteSize: written.byteSize,
        storageKey,
        contentHash: written.contentHash,
      });
      const file = await createItemWithClient(client, {
        databaseId: db("files"),
        properties: { name: "offer.pdf", file: { blobId: blob.id } },
      });
      return file.id;
    });
    const draftId = await newDraft(f);
    const attached = await createMailDraftAttachmentAddRouteHandler(runtime, { maxFileSizeBytes: 1_000_000 })(
      ctx({ id: draftId }, { fileItemId: fileId }),
    );
    expect(attached.status).toBe(200);
    const transport = recordingTransport();

    await sendDraft(draftId, adaptersFor(transport));

    const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: "offer.pdf", contentType: "application/pdf" });
    expect(parsed.attachments[0]?.content.equals(bytes)).toBe(true);
  });

  tenantIt(
    "answers a second call with 409 mail_draft_already_sent and where the message went, sending nothing again",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f, replyTo(f));
      const transport = recordingTransport();
      const first = await sendDraft(draftId, adaptersFor(transport));
      recordThreadAnnouncements();

      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
        status: 409,
        code: "mail_draft_already_sent",
        details: { emailId: draftId, threadId: first.body.threadId },
      });

      expect(transport.sent).toHaveLength(1);
      expect(await messagesInThread(f.threadId)).toBe(2);
      expect(events).toEqual([]);
    },
  );

  tenantIt(
    "answers a call that loses the claim to a send in progress with 409 mail_draft_already_sent, delivering once",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f);
      const sent: MailTransportMessage[] = [];
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedTransport = (): void => {};
      const inTransport = new Promise<void>((resolve) => {
        reachedTransport = resolve;
      });
      const blocking: MailTransport = {
        async send(message) {
          sent.push(message);
          reachedTransport();
          await gate;
          return {};
        },
      };
      const winner = sendDraft(draftId, adaptersFor(blocking));
      // The winner's claim is committed before its transport is called.
      await inTransport;

      let loser: unknown;
      try {
        await sendDraft(draftId, adaptersFor(blocking));
      } catch (error) {
        loser = error;
      } finally {
        release();
      }
      const won = await winner;

      expect(loser).toMatchObject({
        status: 409,
        code: "mail_draft_already_sent",
        details: { emailId: draftId, threadId: won.body.threadId },
      });
      expect(sent).toHaveLength(1);
      expect(await sentAtOf(draftId)).toBeInstanceOf(Date);
    },
  );

  describe("a draft that is written while it is being sent", () => {
    /** The version the update route wants from a client: what the read route answers. */
    async function versionOf(draftId: string): Promise<string> {
      const read = await createMailDraftReadRouteHandler(runtime)(ctx({ id: draftId }, undefined));
      return read.body.updatedAt;
    }

    const updateAs = async (draftId: string, fields: Record<string, unknown>) =>
      createMailDraftUpdateRouteHandler(runtime)(
        ctx({ id: draftId }, { ifVersion: await versionOf(draftId), ...fields }),
      );

    const discard = (draftId: string) => createMailDraftDiscardRouteHandler(runtime)(ctx({ id: draftId }, undefined));

    /**
     * Runs `action` once, after the send route has read the draft and committed, and before it claims the draft: the
     * route reads the mailbox's sync state between the two, through `pool.query`.
     */
    function betweenReadAndClaim(action: () => Promise<unknown>): void {
      // `pg`'s overloads of `query` do not fit a spy; the route calls it with a text and values only.
      const pool = runtime as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      const original = pool.query.bind(pool);
      let fired = false;
      vi.spyOn(pool, "query").mockImplementation((...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
        if (!fired && text?.includes("mail_account_sync_state")) {
          fired = true;
          return action().then(() => original(...args));
        }
        return original(...args);
      });
    }

    /** A transport that reports it was called and then waits to be released; `inTransport` resolves at the call. */
    function holdingTransport() {
      let release = (): void => {};
      let reached = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inTransport = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const transport = recordingTransport({
        async send(message) {
          transport.sent.push(message);
          reached();
          await gate;
          return {};
        },
      });
      return { transport, inTransport, release };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    tenantIt("sends nothing for a draft that was discarded after the route read it, and answers 404", async () => {
      const f = await setup();
      const draftId = await newDraft(f, replyTo(f));
      const transport = recordingTransport();
      betweenReadAndClaim(() => discard(draftId));

      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({ status: 404 });

      expect(transport.sent).toEqual([]);
      expect(await claimOf(draftId)).toBeUndefined();
      expect(await sentAtOf(draftId)).toBeUndefined();
      expect(await messagesInThread(f.threadId)).toBe(1);
    });

    tenantIt(
      "sends nothing for a draft that was edited after the route read it, answers 409 version_conflict, and sends the edit on a retry",
      async () => {
        const f = await setup();
        const draftId = await newDraft(f, replyTo(f));
        const transport = recordingTransport();
        betweenReadAndClaim(() => updateAs(draftId, { to: [JANA], cc: [], bcc: [], body: "Zcela nový text" }));

        await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
          status: 409,
          code: "version_conflict",
        });

        expect(transport.sent).toEqual([]);
        expect(await claimOf(draftId)).toBeUndefined();
        expect(await sentAtOf(draftId)).toBeNull();
        vi.restoreAllMocks();
        const retry = await sendDraft(draftId, adaptersFor(transport));
        expect(retry.status).toBe(200);
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]?.envelope.recipients).toEqual([JANA.address]);
        const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
        expect(parsed.text).toContain("Zcela nový text");
      },
    );

    tenantIt(
      "refuses an edit and a discard during the provider call with 409 mail_draft_already_sent, delivering the draft as it was claimed",
      async () => {
        const f = await setup();
        const draftId = await newDraft(f, replyTo(f));
        const { transport, inTransport, release } = holdingTransport();
        const winner = sendDraft(draftId, adaptersFor(transport));
        await inTransport;
        const claim = await claimOf(draftId);
        const alreadySent = {
          status: 409,
          code: "mail_draft_already_sent",
          details: { emailId: draftId, threadId: claim?.thread_id },
        };

        let edit: unknown;
        let discarded: unknown;
        try {
          edit = await updateAs(draftId, { to: [JANA], body: "Pozdní úprava" }).catch((error: unknown) => error);
          discarded = await discard(draftId).catch((error: unknown) => error);
        } finally {
          release();
        }
        const won = await winner;

        expect(edit).toMatchObject(alreadySent);
        expect(discarded).toMatchObject(alreadySent);
        expect(won.status).toBe(200);
        expect(transport.sent).toHaveLength(1);
        const parsed = await simpleParser(transport.sent[0]?.raw ?? Buffer.alloc(0));
        expect(parsed.text).toContain("děkuji za nabídku.");
        expect(parsed.text).not.toContain("Pozdní úprava");
        // The draft is the message that went: sent, in Sent, with the recipients the message had.
        expect(await sentAtOf(draftId)).toBeInstanceOf(Date);
        expect(await folderPurposesOf(draftId)).toEqual(["sent"]);
        const { rows } = await runtime.query<{ to_recipients: { address: string }[] }>(
          "SELECT to_recipients FROM mail_drafts WHERE tenant_id = app_tenant_default() AND email_item_id = $1",
          [draftId],
        );
        expect(rows[0]?.to_recipients.map((to) => to.address)).toEqual([PETR.address]);
      },
    );

    tenantIt("makes the draft writable again when the send fails, which undoes the claim", async () => {
      const f = await setup();
      const draftId = await newDraft(f, replyTo(f));
      const failing = recordingTransport({
        async send() {
          throw new MailServerUnreachableError();
        },
      });

      await expect(sendDraft(draftId, adaptersFor(failing))).rejects.toMatchObject({ code: "mail_server_unreachable" });

      expect((await updateAs(draftId, { body: "Nová verze po neúspěchu" })).status).toBe(200);
      expect((await discard(draftId)).status).toBe(200);
    });
  });

  tenantIt(
    "answers 409 mail_draft_already_sent for a draft whose row says it was sent, with the draft's own thread",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f, replyTo(f));
      await withTransaction(runtime, (client) => markMailDraftSent(client, draftId));
      const transport = recordingTransport();

      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
        status: 409,
        code: "mail_draft_already_sent",
        details: { emailId: draftId, threadId: f.threadId },
      });

      expect(transport.sent).toEqual([]);
      expect(await claimOf(draftId)).toBeUndefined();
    },
  );

  tenantIt("answers a sent draft that has no thread with a null threadId", async () => {
    const f = await setup();
    const draftId = await newDraft(f);
    await withTransaction(runtime, (client) => markMailDraftSent(client, draftId));

    await expect(sendDraft(draftId, adaptersFor(recordingTransport()))).rejects.toMatchObject({
      code: "mail_draft_already_sent",
      details: { emailId: draftId, threadId: null },
    });
  });

  tenantIt("answers 400 for a draft without a recipient and sends nothing", async () => {
    const f = await setup();
    const draftId = await newDraft(f, { to: [], cc: [], bcc: [] });
    const transport = recordingTransport();
    recordThreadAnnouncements();

    await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
      status: 400,
      details: { field: "to" },
    });

    expect(transport.sent).toEqual([]);
    await expectDraftUntouched(draftId);
  });

  tenantIt("sends a draft whose only recipient is in Bcc, and one whose only recipient is in Cc", async () => {
    const f = await setup();
    const onlyBcc = await newDraft(f, { to: [], cc: [], bcc: [SECRET] });
    const onlyCc = await newDraft(f, { to: [], cc: [JANA], bcc: [] });
    const transport = recordingTransport();

    await sendDraft(onlyBcc, adaptersFor(transport));
    await sendDraft(onlyCc, adaptersFor(transport));

    expect(transport.sent.map((message) => message.envelope.recipients)).toEqual([[SECRET.address], [JANA.address]]);
  });

  tenantIt(
    "answers 409 mail_draft_not_editable for a provider draft with no mail_drafts row, and sends nothing",
    async () => {
      const f = await setup();
      const { db, emailProperties, property } = await databaseIds();
      const providerDraft = await withTransaction(runtime, (client) =>
        createEmailDraft(client, {
          emailsDatabaseId: db("emails"),
          folderRelationPropertyId: property(emailProperties, "folder"),
          draftsFolderItemId: f.draftsFolderId,
          subject: "Held by the provider",
          from: { address: OWN_ADDRESS },
          to: [PETR],
          bodyText: "text",
        }),
      );
      const transport = recordingTransport();

      await expect(sendDraft(providerDraft.id, adaptersFor(transport))).rejects.toMatchObject({
        status: 409,
        code: "mail_draft_not_editable",
      });

      expect(transport.sent).toEqual([]);
      expect(await claimOf(providerDraft.id)).toBeUndefined();
    },
  );

  tenantIt("answers 404 for an unknown id, a malformed id and a draft in the trash", async () => {
    const f = await setup();
    const draftId = await newDraft(f);
    const transport = recordingTransport();
    await trash("emails", draftId);

    await expect(sendDraft(randomUUID(), adaptersFor(transport))).rejects.toMatchObject({ status: 404 });
    await expect(sendDraft("not-a-uuid", adaptersFor(transport))).rejects.toMatchObject({ status: 404 });
    await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({ status: 404 });

    expect(transport.sent).toEqual([]);
  });

  it("cannot send a draft of another tenant: it answers 404 and the draft stays unsent", async () => {
    const draftId = await runInTenant(tenant, async () => newDraft(await setup()));
    const transport = recordingTransport();

    await expect(sendDraft(draftId, adaptersFor(transport), foreign)).rejects.toMatchObject({ status: 404 });

    await runInTenant(tenant, async () => {
      expect(transport.sent).toEqual([]);
      expect(await sentAtOf(draftId)).toBeNull();
      expect(await claimOf(draftId)).toBeUndefined();
      // The owner sends it, so the refusal above was the tenant boundary and not a broken draft.
      expect((await sendDraft(draftId, adaptersFor(transport))).status).toBe(200);
    });
  });

  tenantIt("answers 404 for a draft whose mailbox is gone", async () => {
    const f = await setup();
    const draftId = await newDraft(f);
    await trash("mailboxes", f.mailboxId);
    const transport = recordingTransport();

    await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({ status: 404 });

    expect(transport.sent).toEqual([]);
    await expectDraftUntouched(draftId);
  });

  tenantIt(
    "answers 403 from_address_not_registered for a sender the mailbox no longer has, and sends nothing",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f);
      const { db } = await databaseIds();
      await withTransaction(runtime, (client) =>
        writeMailboxAddresses(client, {
          mailboxesDatabaseId: db("mailboxes"),
          mailboxItemId: f.mailboxId,
          address: "changed@example.test",
        }),
      );
      const transport = recordingTransport();

      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
        status: 403,
        code: "from_address_not_registered",
      });

      expect(transport.sent).toEqual([]);
      await expectDraftUntouched(draftId);
    },
  );

  tenantIt(
    "answers 409 mail_reauthorization_required for a mailbox that needs reauthorization, keeping the draft",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f);
      await setSyncStatus(f.mailboxId, "needsReauthorization");
      const transport = recordingTransport();

      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
        status: 409,
        code: "mail_reauthorization_required",
      });

      expect(transport.sent).toEqual([]);
      await expectDraftUntouched(draftId);
      // Nothing was queued for later: once the mailbox is healthy again the same draft sends.
      await setSyncStatus(f.mailboxId, "ok");
      expect((await sendDraft(draftId, adaptersFor(transport))).status).toBe(200);
      expect(transport.sent).toHaveLength(1);
    },
  );

  tenantIt("answers 409 mail_sent_folder_missing for a mailbox with no Sent folder, keeping the draft", async () => {
    const f = await setup();
    const draftId = await newDraft(f, { mailboxId: f.mailboxWithoutSentId });
    const transport = recordingTransport();

    await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
      status: 409,
      code: "mail_sent_folder_missing",
    });

    expect(transport.sent).toEqual([]);
    await expectDraftUntouched(draftId);
  });

  describe("a failure of the transport", () => {
    const failures = [
      {
        name: "a revoked credential",
        error: new MailReauthorizationRequiredError("revoked"),
        status: 409,
        code: "mail_reauthorization_required",
      },
      {
        name: "a refused recipient",
        error: new MailRecipientRejectedError(),
        status: 422,
        code: "mail_recipient_rejected",
      },
      { name: "a rejected login", error: new MailSendAuthFailedError(), status: 400, code: "mail_auth_failed" },
      {
        name: "an unreachable server",
        error: new MailServerUnreachableError(),
        status: 400,
        code: "mail_server_unreachable",
      },
    ];

    for (const failure of failures) {
      tenantIt(
        `answers ${failure.status} ${failure.code} for ${failure.name} and leaves the draft sendable again`,
        async () => {
          const f = await setup();
          const draftId = await newDraft(f, replyTo(f));
          const failing = recordingTransport({
            async send() {
              throw failure.error;
            },
          });
          recordThreadAnnouncements();

          await expect(sendDraft(draftId, adaptersFor(failing))).rejects.toMatchObject({
            status: failure.status,
            code: failure.code,
          });

          // The claim is undone, the draft is unsent in Drafts, the reply's thread has no new message, and nothing was announced.
          await expectDraftUntouched(draftId);
          expect(await messagesInThread(f.threadId)).toBe(1);
          const working = recordingTransport();
          expect((await sendDraft(draftId, adaptersFor(working))).status).toBe(200);
          expect(working.sent).toHaveLength(1);
        },
      );
    }

    tenantIt("does not map an unknown failure: it propagates and the draft stays sendable", async () => {
      const f = await setup();
      const draftId = await newDraft(f);
      const broken = new Error("the SMTP library broke");
      const failing = recordingTransport({
        async send() {
          throw broken;
        },
      });

      await expect(sendDraft(draftId, adaptersFor(failing))).rejects.toBe(broken);

      await expectDraftUntouched(draftId);
      expect((await sendDraft(draftId, adaptersFor(recordingTransport()))).status).toBe(200);
    });
  });

  tenantIt(
    "keeps the claim when the finalization fails after delivery, so a retry delivers nothing twice",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f);
      const cp = createChokePoint(runtime);
      const { db } = await databaseIds();
      const person = await cp.createItem({
        databaseId: db("people"),
        properties: { name: "Petr", emails: PETR.address },
      });
      await withTransaction(runtime, (client) => reindexPersonEmails(client, person.id, [PETR.address]));
      // The address index still maps the recipient to the person after the soft delete, so the finalization's people
      // link is refused by the choke point and the transaction rolls back after the message was delivered.
      await cp.softDeleteItem(db("people"), person.id);
      const transport = recordingTransport();

      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({ name: "ValidationError" });

      expect(transport.sent).toHaveLength(1);
      expect(await sentAtOf(draftId)).toBeNull();
      const claim = await claimOf(draftId);
      expect(claim).toBeDefined();
      await expect(sendDraft(draftId, adaptersFor(transport))).rejects.toMatchObject({
        status: 409,
        code: "mail_draft_already_sent",
        details: { emailId: draftId, threadId: claim?.thread_id },
      });
      expect(transport.sent).toHaveLength(1);
    },
  );

  tenantIt(
    "fails with a plain configuration error, touching nothing, when the root configured no send adapters",
    async () => {
      const f = await setup();
      const draftId = await newDraft(f);

      for (const dependencies of [{}, { mailServerClients: {} }]) {
        const failure = await runInTenant(tenant, () =>
          createMailDraftSendRouteHandler(runtime, dependencies)(ctx({ id: draftId }, undefined)),
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toHaveProperty("status");
        expect(String(failure)).toContain("mailServerClients.send");
      }
      await expectDraftUntouched(draftId);
    },
  );

  describe("through the transports of the mailbox's provider", () => {
    /** A fake Google: one stored refresh token, and every send is recorded with its thread id and raw message. */
    function fakeGoogle(options: { tokenRefused?: boolean } = {}) {
      const sends: { threadId: string | undefined; raw: Buffer }[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (target === GOOGLE_TOKEN_URL) {
          const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
          if (options.tokenRefused || form.get("refresh_token") !== REFRESH_TOKEN) {
            return new Response("invalid_grant", { status: 400 });
          }
          return Response.json({ access_token: "ya29.send-route", expires_in: 3600 });
        }
        if (target === GOOGLE_SEND_URL) {
          const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
          const body = typeof parsed === "object" && parsed !== null ? parsed : {};
          const raw = Reflect.get(body, "raw");
          const threadId = Reflect.get(body, "threadId");
          sends.push({
            threadId: typeof threadId === "string" ? threadId : undefined,
            raw: Buffer.from(typeof raw === "string" ? raw : "", "base64url"),
          });
          return Response.json({ id: "gmail-sent-1", threadId: "gmail-thread-1" });
        }
        throw new Error(`unexpected request to ${target}`);
      });
      return { sends, fetchImpl };
    }

    /** A fake Microsoft: a token endpoint that accepts the stored refresh token and a `sendMail` that records the MIME. */
    function fakeMicrosoft() {
      const sends: Buffer[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (target === MICROSOFT_TOKEN_URL) {
          const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
          if (form.get("refresh_token") !== REFRESH_TOKEN) return new Response("invalid_grant", { status: 400 });
          return Response.json({ access_token: "eyJ-send-route", expires_in: 3600, refresh_token: REFRESH_TOKEN });
        }
        if (target === GRAPH_SEND_URL) {
          sends.push(Buffer.from(typeof init?.body === "string" ? init.body : "", "base64"));
          return new Response(null, { status: 202 });
        }
        throw new Error(`unexpected request to ${target}`);
      });
      return { sends, fetchImpl };
    }

    function providerAdapters(fetchImpl: typeof fetch): MailSendAdapterFactory {
      return {
        transports: createMailTransportFactory(runtime, {
          gmailOAuthClient: OAUTH_CLIENT,
          graphOAuthClient: OAUTH_CLIENT,
          fetchImpl,
        }),
        attachmentStorage: attachmentStorage(),
      };
    }

    async function storeRefreshToken(mailboxId: string): Promise<void> {
      await storeCredential(runtime, {
        itemId: mailboxId,
        credentialType: "oauth2_refresh_token",
        plaintext: REFRESH_TOKEN,
      });
    }

    tenantIt(
      "sends a reply from a Gmail mailbox into the provider's conversation, once, with In-Reply-To",
      async () => {
        const f = await setup("gmail");
        await storeRefreshToken(f.mailboxId);
        const draftId = await newDraft(f, replyTo(f));
        const google = fakeGoogle();

        const answer = await sendDraft(draftId, providerAdapters(google.fetchImpl));

        expect(google.sends).toHaveLength(1);
        expect(google.sends[0]?.threadId).toBe("gmail-thread-1");
        const parsed = await simpleParser(google.sends[0]?.raw ?? Buffer.alloc(0));
        expect(parsed.inReplyTo).toBe(f.receivedMessageId);
        expect(answer.body.threadId).toBe(f.threadId);
        expect(await messagesInThread(f.threadId)).toBe(2);
      },
    );

    tenantIt("sends a reply from a Microsoft Graph mailbox once, with In-Reply-To", async () => {
      const f = await setup("outlook");
      await storeRefreshToken(f.mailboxId);
      const draftId = await newDraft(f, replyTo(f));
      const microsoft = fakeMicrosoft();

      const answer = await sendDraft(draftId, providerAdapters(microsoft.fetchImpl));

      expect(microsoft.sends).toHaveLength(1);
      const parsed = await simpleParser(microsoft.sends[0] ?? Buffer.alloc(0));
      expect(parsed.inReplyTo).toBe(f.receivedMessageId);
      expect(answer.body.threadId).toBe(f.threadId);
      expect(await messagesInThread(f.threadId)).toBe(2);
    });

    tenantIt(
      "answers 409 mail_reauthorization_required when Google revokes the refresh token, delivering nothing",
      async () => {
        const f = await setup("gmail");
        await storeRefreshToken(f.mailboxId);
        const draftId = await newDraft(f, replyTo(f));
        const google = fakeGoogle({ tokenRefused: true });
        recordThreadAnnouncements();

        await expect(sendDraft(draftId, providerAdapters(google.fetchImpl))).rejects.toMatchObject({
          status: 409,
          code: "mail_reauthorization_required",
        });

        expect(google.sends).toEqual([]);
        await expectDraftUntouched(draftId);
        expect(await messagesInThread(f.threadId)).toBe(1);
      },
    );
  });
});
