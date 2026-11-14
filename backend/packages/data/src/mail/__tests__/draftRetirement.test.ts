import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { getItemById, lockItemById } from "../../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { recordingTransport, transportFor } from "../../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";
import { createEmailDraft, updateEmailDraft } from "../draft.js";
import { retireSupersededSempDrafts } from "../draftRetirement.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import { createMailDraftCreateRouteHandler, createMailDraftSendRouteHandler } from "../mailDraftRouteHandlers.js";
import { markMailDraftSent, type MailDraftActor } from "../mailDraftsStore.js";
import { upsertMailMessageMeta } from "../mailMessageMetaStore.js";
import { createMailThreadListRouteHandler } from "../mailThreadRoutes.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";
import { resolveMailModuleIds, type MailModuleIds } from "../mailModuleIds.js";

const OWN_ADDRESS = "me@example.test";
const OTHER_ADDRESS = "sender@example.test";
const FIRST = new Date("2026-10-01T09:00:00Z");
const LATER = new Date("2026-10-02T09:00:00Z");
const ID = (name: string): string => `<${name}@example.test>`;

let admin: Pool;
let runtime: Pool;
let storageRoot: string;
let storage: LocalFsBlobStorageWriter;
let tenant: string;
let foreign: string;
let events: InvalidationEvent[];

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

interface SeededIds extends MailModuleIds {
  emailFolderProperty: string;
  emailAttachmentsProperty: string;
  folderMailboxProperty: string;
}

async function seededIds(tenantId: string): Promise<SeededIds> {
  return inTenant(tenantId, async (client) => {
    const mail = await resolveMailModuleIds(client);
    const propertyId = async (databaseId: string, key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [databaseId, key],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`property '${key}' is not seeded`);
      return id;
    };
    return {
      ...mail,
      emailFolderProperty: await propertyId(mail.emailsDatabaseId, "folder"),
      emailAttachmentsProperty: await propertyId(mail.emailsDatabaseId, "attachments"),
      folderMailboxProperty: await propertyId(mail.foldersDatabaseId, "mailbox"),
    };
  });
}

/** One tenant's mailbox with its folders, and the writers that fill a thread, every row written the way production writes it. */
async function mailFixture(tenantId: string) {
  const ids = await seededIds(tenantId);
  const mailboxId = await inTenant(tenantId, async (client) => {
    const item = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Personal", provider: "generic" },
    });
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId: ids.mailboxesDatabaseId,
      mailboxItemId: item.id,
      address: OWN_ADDRESS,
    });
    return item.id;
  });
  const folder = (specialPurpose: string): Promise<string> =>
    inTenant(tenantId, (client) =>
      ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailboxId,
        mailboxRelationPropertyId: ids.folderMailboxProperty,
        providerId: specialPurpose,
        name: specialPurpose,
        behavior: "folder",
        specialPurpose,
      }),
    );
  const inbox = await folder("inbox");
  const drafts = await folder("drafts");
  const sent = await folder("sent");

  /** One message through the ingest writer, as the sync adapters call it (they pass the mailbox's addresses). */
  const message = (input: {
    folderId: string;
    messageId: string;
    from?: string;
    date?: Date | null;
    references?: string[];
  }): Promise<{ itemId: string; threadId: string; created: boolean }> =>
    inTenant(tenantId, async (client) => {
      const references = input.references ?? [];
      const { itemId, created } = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: ids.emailFolderProperty,
        attachmentsRelationPropertyId: ids.emailAttachmentsProperty,
        folderItemId: input.folderId,
        mailboxItemId: mailboxId,
        mailboxAliases: [OWN_ADDRESS],
        messageId: input.messageId,
        inReplyTo: references.at(-1) ?? null,
        references,
        subject: input.messageId,
        ...(input.date === null ? {} : { date: input.date ?? FIRST }),
        envelope: {
          from: { name: "Sender", address: input.from ?? OTHER_ADDRESS },
          to: [{ name: "Me", address: OWN_ADDRESS }],
        },
        bodyText: "body",
        attachments: [],
        storage,
        storageKeyPrefix: "draft-retirement",
      });
      const { rows } = await client.query<{ thread_id: string | null }>(
        "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
        [itemId],
      );
      const threadId = rows[0]?.thread_id;
      if (!threadId) throw new Error(`message ${input.messageId} has no thread`);
      return { itemId, threadId, created };
    });

  /** A Semprec draft with its `mail_drafts` row; `source` is the message it answers. Answers the draft's Emails item id. */
  const draft = (input: {
    threadId: string | null;
    createdBy: MailDraftActor;
    source: string | null;
  }): Promise<string> =>
    inTenant(tenantId, async (client) => {
      const item = await createEmailDraft(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        folderRelationPropertyId: ids.emailFolderProperty,
        draftsFolderItemId: drafts,
        subject: "Draft",
        from: { address: OWN_ADDRESS },
        to: [{ name: "Sender", address: OTHER_ADDRESS }],
        bodyText: "Draft body",
        metadata: {
          mailboxItemId: mailboxId,
          threadId: input.threadId,
          mode: "reply",
          sourceEmailItemId: input.source,
          fromAddress: OWN_ADDRESS,
          to: [{ name: "Sender", address: OTHER_ADDRESS }],
          createdBy: input.createdBy,
        },
      });
      return item.id;
    });

  return { ids, mailboxId, inbox, drafts, sent, message, draft };
}
type MailFixture = Awaited<ReturnType<typeof mailFixture>>;

/** A thread with one received message at `FIRST`, and an agent draft that answers it. */
async function threadWithSempDraft(f: MailFixture, name: string) {
  const received = await f.message({ folderId: f.inbox, messageId: ID(name), date: FIRST });
  const draftId = await f.draft({ threadId: received.threadId, createdBy: "agent", source: received.itemId });
  return { received, draftId, threadId: received.threadId };
}

const listPage = z.object({
  threads: z.array(z.object({ threadId: z.string(), hasSempDraft: z.boolean() })),
  nextCursor: z.string().nullable(),
});

/** `hasSempDraft` of the listed thread `threadId` of `tenantId`, through the route the mailbox list calls. */
async function hasSempDraft(tenantId: string, threadId: string): Promise<boolean> {
  const answer = await runInTenant(tenantId, () =>
    createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads?limit=100" } }),
  );
  expect(answer.status).toBe(200);
  const row = listPage.parse(answer.body).threads.find((thread) => thread.threadId === threadId);
  if (!row) throw new Error(`thread ${threadId} is not listed`);
  return row.hasSempDraft;
}

interface DraftState {
  /** The Emails item is in the trash. */
  trashed: boolean;
  /** The `mail_drafts` row exists. */
  hasRow: boolean;
  /** The row's `sent_at`, when it has a row. */
  sentAt: Date | null | undefined;
}

async function stateOf(tenantId: string, draftId: string): Promise<DraftState> {
  return inTenant(tenantId, async (client) => {
    const item = await client.query<{ trashed: boolean }>(
      "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE tenant_id = app_tenant_default() AND id = $1",
      [draftId],
    );
    const row = await client.query<{ sent_at: Date | null }>(
      "SELECT sent_at FROM mail_drafts WHERE tenant_id = app_tenant_default() AND email_item_id = $1",
      [draftId],
    );
    return { trashed: item.rows[0]?.trashed ?? false, hasRow: row.rows.length > 0, sentAt: row.rows[0]?.sent_at };
  });
}

const RETIRED: DraftState = { trashed: true, hasRow: false, sentAt: undefined };
const UNTOUCHED: DraftState = { trashed: false, hasRow: true, sentAt: null };

function retire(
  tenantId: string,
  input: { threadId: string; ownMessageDate: Date; excludeDraftItemId?: string },
): Promise<string[]> {
  return inTenant(tenantId, (client) => retireSupersededSempDrafts(client, input));
}

/** The user edits the draft's body through the draft write operation, as the update route does. */
function editAsUser(draftId: string, body = "The user's own words"): Promise<unknown> {
  return inTenant(tenant, async (client) => {
    const { emailsDatabaseId } = await resolveMailModuleIds(client);
    const item = await getItemById(client, emailsDatabaseId, draftId);
    if (!item) throw new Error(`draft ${draftId} is missing`);
    return updateEmailDraft(
      client,
      { draftItemId: draftId, ifVersion: item.updatedAt, body },
      { writer: { writerKind: "user" }, actingUserId: randomUUID() },
    );
  });
}

function recordThreadAnnouncements(): void {
  events = [];
  setInvalidationHook((event) => {
    if (event.scope === "mailThread") events.push(event);
  });
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-draft-retirement-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
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

describe("retireSupersededSempDrafts (issue gh-1902)", () => {
  it("soft-deletes the agent draft whose source is older than the message, frees the thread and announces it once", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "answered");
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
    recordThreadAnnouncements();

    const retired = await retire(tenant, { threadId, ownMessageDate: LATER });

    expect(retired).toEqual([draftId]);
    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
    expect(await hasSempDraft(tenant, threadId)).toBe(false);
    expect(events).toEqual([{ scope: "mailThread", threadId }]);
    // The row went with the draft, so the thread takes a new agent draft: the one-per-thread index no longer holds it.
    const next = await f.draft({ threadId, createdBy: "agent", source: null });
    expect(await stateOf(tenant, next)).toEqual(UNTOUCHED);
  });

  it("keeps a draft of the user, the draft it was told to exclude and a draft already sent", async () => {
    const f = await mailFixture(tenant);
    const received = await f.message({ folderId: f.inbox, messageId: ID("kept"), date: FIRST });
    const { threadId } = received;
    // An earlier agent draft of the thread, sent, which freed the thread for the next one.
    const sent = await f.draft({ threadId, createdBy: "agent", source: received.itemId });
    await inTenant(tenant, (client) => markMailDraftSent(client, sent));
    const excluded = await f.draft({ threadId, createdBy: "agent", source: received.itemId });
    const user = await f.draft({ threadId, createdBy: "user", source: received.itemId });
    recordThreadAnnouncements();

    const retired = await retire(tenant, { threadId, ownMessageDate: LATER, excludeDraftItemId: excluded });

    expect(retired).toEqual([]);
    expect(await stateOf(tenant, excluded)).toEqual(UNTOUCHED);
    expect(await stateOf(tenant, user)).toEqual(UNTOUCHED);
    expect(await stateOf(tenant, sent)).toEqual({ trashed: false, hasRow: true, sentAt: expect.any(Date) });
    expect(events).toEqual([]);
    // Without the exclusion the same call retires the draft that was spared, so the exclusion is what kept it.
    expect(await retire(tenant, { threadId, ownMessageDate: LATER })).toEqual([excluded]);
  });

  it("keeps a Semp draft the user edited, and retires one that only the agent edited", async () => {
    const f = await mailFixture(tenant);
    const edited = await threadWithSempDraft(f, "user-edited");
    const untouched = await threadWithSempDraft(f, "agent-only");
    await editAsUser(edited.draftId);
    // An update by the agent keeps the draft the agent's.
    await inTenant(tenant, async (client) => {
      const item = await getItemById(client, f.ids.emailsDatabaseId, untouched.draftId);
      if (!item) throw new Error("draft is missing");
      await updateEmailDraft(
        client,
        { draftItemId: untouched.draftId, ifVersion: item.updatedAt, body: "A better agent text" },
        { writer: { writerKind: "agent" } },
      );
    });
    recordThreadAnnouncements();

    expect(await retire(tenant, { threadId: edited.threadId, ownMessageDate: LATER })).toEqual([]);
    expect(await retire(tenant, { threadId: untouched.threadId, ownMessageDate: LATER })).toEqual([untouched.draftId]);

    expect(await stateOf(tenant, edited.draftId)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, edited.threadId)).toBe(true);
    expect(await stateOf(tenant, untouched.draftId)).toEqual(RETIRED);
    expect(events).toEqual([{ scope: "mailThread", threadId: untouched.threadId }]);
  });

  it("keeps a draft that holds the claim of a send in progress", async () => {
    const f = await mailFixture(tenant);
    const { received, draftId, threadId } = await threadWithSempDraft(f, "being-sent");
    // What `sendDraftEmail` writes before it calls the provider.
    await inTenant(tenant, (client) =>
      upsertMailMessageMeta(client, {
        itemId: draftId,
        mailboxItemId: f.mailboxId,
        messageId: ID("claim-of-the-send"),
        threadId,
        envelope: { from: { name: "", address: OWN_ADDRESS }, to: [{ name: "", address: OTHER_ADDRESS }] },
        ingestedAt: new Date(),
      }),
    );

    expect(await retire(tenant, { threadId, ownMessageDate: LATER })).toEqual([]);

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
    expect(received.threadId).toBe(threadId);
  });

  it("keeps an agent draft whose source is as new as the message or newer", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "newer");

    expect(await retire(tenant, { threadId, ownMessageDate: FIRST })).toEqual([]);
    expect(await retire(tenant, { threadId, ownMessageDate: new Date(FIRST.getTime() - 1000) })).toEqual([]);

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
  });

  it("keeps an agent draft whose source date cannot be read", async () => {
    const f = await mailFixture(tenant);
    const received = await f.message({ folderId: f.inbox, messageId: ID("undated"), date: FIRST });
    const undated = await inTenant(tenant, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: f.ids.emailsDatabaseId,
          properties: { name: "Odd date", sender: OTHER_ADDRESS, body: "", date: "not a date" },
        },
        { allowedSystemKeys: ["name", "sender", "body", "date"] },
      ),
    );
    const draftId = await f.draft({ threadId: received.threadId, createdBy: "agent", source: undated.id });

    expect(await retire(tenant, { threadId: received.threadId, ownMessageDate: LATER })).toEqual([]);

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
  });

  it("keeps an agent draft that has no source message", async () => {
    const f = await mailFixture(tenant);
    const received = await f.message({ folderId: f.inbox, messageId: ID("sourceless"), date: FIRST });
    const draftId = await f.draft({ threadId: received.threadId, createdBy: "agent", source: null });

    expect(await retire(tenant, { threadId: received.threadId, ownMessageDate: LATER })).toEqual([]);

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
  });

  it("leaves the Semp draft of another thread alone", async () => {
    const f = await mailFixture(tenant);
    const answered = await threadWithSempDraft(f, "answered-thread");
    const other = await threadWithSempDraft(f, "other-thread");

    const retired = await retire(tenant, { threadId: answered.threadId, ownMessageDate: LATER });

    expect(retired).toEqual([answered.draftId]);
    expect(await stateOf(tenant, other.draftId)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, other.threadId)).toBe(true);
  });

  it("retires a draft whose thread was merged into the thread of the message", async () => {
    const f = await mailFixture(tenant);
    const survivor = (await f.message({ folderId: f.inbox, messageId: ID("merge-root"), date: FIRST })).threadId;
    const merged = await f.message({
      folderId: f.inbox,
      messageId: ID("merge-reply"),
      date: FIRST,
      references: [ID("merge-bridge")],
    });
    expect(merged.threadId).not.toBe(survivor);
    const draftId = await f.draft({ threadId: merged.threadId, createdBy: "agent", source: merged.itemId });
    // The bridge answers the root and is answered by the reply: the thread of the reply joins the root's thread.
    const bridge = await f.message({
      folderId: f.inbox,
      messageId: ID("merge-bridge"),
      date: FIRST,
      references: [ID("merge-root")],
    });
    expect(bridge.threadId).toBe(survivor);

    const retired = await retire(tenant, { threadId: survivor, ownMessageDate: LATER });

    expect(retired).toEqual([draftId]);
    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
  });

  it("does not reach the Semp draft of another tenant, not even for its thread id", async () => {
    const own = await mailFixture(tenant);
    const other = await mailFixture(foreign);
    const theirs = await threadWithSempDraft(other, "foreign-thread");
    const ours = await threadWithSempDraft(own, "own-thread");

    const retired = await retire(tenant, { threadId: theirs.threadId, ownMessageDate: LATER });

    expect(retired).toEqual([]);
    expect(await stateOf(foreign, theirs.draftId)).toEqual(UNTOUCHED);
    expect(await stateOf(tenant, ours.draftId)).toEqual(UNTOUCHED);
    expect(await retire(foreign, { threadId: theirs.threadId, ownMessageDate: LATER })).toEqual([theirs.draftId]);
  });

  it("ignores a draft that is in the trash already", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "trashed");
    await inTenant(tenant, async (client) => {
      await itemDeleteWithClient(client, f.ids.emailsDatabaseId, draftId, {
        queueAffinity: createActionQueueAffinity(),
        writer: SYSTEM_WRITER,
      });
    });

    expect(await retire(tenant, { threadId, ownMessageDate: LATER })).toEqual([]);
  });

  describe("a draft that changes between the listing and its lock", () => {
    /** Polls until a statement of the database waits for a lock, which is the retirement waiting for the held draft. */
    async function untilStatementWaits(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if ((rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("the retirement never waited for the draft's lock");
    }

    /**
     * Holds the draft's lock in one transaction, starts the retirement in another (which lists the draft and then waits for
     * the lock), changes the draft in the holder's transaction and commits it. Answers what the retirement retired.
     */
    async function retireWhileHeld(
      f: MailFixture,
      input: { draftId: string; threadId: string },
      change: (client: PoolClient) => Promise<void>,
    ): Promise<string[]> {
      let retiring: Promise<string[]> | undefined;
      await inTenant(tenant, async (holder) => {
        await lockItemById(holder, f.ids.emailsDatabaseId, input.draftId);
        retiring = retire(tenant, { threadId: input.threadId, ownMessageDate: LATER });
        // A rejection is awaited below; until then nothing may report it as unhandled.
        retiring.catch(() => undefined);
        await untilStatementWaits();
        await change(holder);
      });
      if (!retiring) throw new Error("the retirement was not started");
      return retiring;
    }

    it("keeps a draft the user sent meanwhile", async () => {
      const f = await mailFixture(tenant);
      const { draftId, threadId } = await threadWithSempDraft(f, "sent-meanwhile");

      const retired = await retireWhileHeld(f, { draftId, threadId }, async (client) => {
        await markMailDraftSent(client, draftId);
      });

      expect(retired).toEqual([]);
      expect(await stateOf(tenant, draftId)).toEqual({ trashed: false, hasRow: true, sentAt: expect.any(Date) });
    });

    it("keeps a draft that was discarded meanwhile as the discard left it", async () => {
      const f = await mailFixture(tenant);
      const { draftId, threadId } = await threadWithSempDraft(f, "discarded-meanwhile");

      const retired = await retireWhileHeld(f, { draftId, threadId }, async (client) => {
        await itemDeleteWithClient(client, f.ids.emailsDatabaseId, draftId, {
          queueAffinity: createActionQueueAffinity(),
          writer: SYSTEM_WRITER,
        });
      });

      expect(retired).toEqual([]);
      expect(await stateOf(tenant, draftId)).toEqual({ trashed: true, hasRow: true, sentAt: null });
    });

    it("keeps a draft whose row was deleted meanwhile", async () => {
      const f = await mailFixture(tenant);
      const { draftId, threadId } = await threadWithSempDraft(f, "row-gone-meanwhile");

      const retired = await retireWhileHeld(f, { draftId, threadId }, async (client) => {
        await client.query("DELETE FROM mail_drafts WHERE tenant_id = app_tenant_default() AND email_item_id = $1", [
          draftId,
        ]);
      });

      expect(retired).toEqual([]);
      expect(await stateOf(tenant, draftId)).toEqual({ trashed: false, hasRow: false, sentAt: undefined });
    });
  });
});

describe("a send of the user's own (issue gh-1902)", () => {
  const sendAdapters = () => {
    const storageForSend = new LocalFsBlobStorageWriter(storageRoot);
    return {
      transports: transportFor(recordingTransport()),
      attachmentStorage: { files: storageForSend, mailAttachments: storageForSend },
    };
  };
  const ctx = (id: string) => ({ params: { id }, body: undefined, identity: { user: { id: randomUUID() } } });
  const send = (id: string) =>
    runInTenant(tenant, () =>
      createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: sendAdapters() } })(ctx(id)),
    );

  /** A draft of the user that answers `source` in `threadId`, through the real create route, and the Sent folder it moves to. */
  async function userReply(f: MailFixture, input: { threadId: string; source: string }): Promise<string> {
    const created = await runInTenant(tenant, () =>
      createMailDraftCreateRouteHandler(runtime)({
        params: {},
        identity: { user: { id: randomUUID(), locale: "en" } },
        body: {
          mailboxId: f.mailboxId,
          from: OWN_ADDRESS,
          to: [{ address: OTHER_ADDRESS }],
          cc: [],
          bcc: [],
          subject: "My answer",
          body: "My own reply",
          threadId: input.threadId,
          mode: "reply",
          sourceEmailId: input.source,
        },
      }),
    );
    return created.body.id;
  }

  it("retires the thread's agent draft when the user sends their own reply, and hasSempDraft becomes false", async () => {
    const f = await mailFixture(tenant);
    const { received, draftId: semp, threadId } = await threadWithSempDraft(f, "reply-sent");
    const mine = await userReply(f, { threadId, source: received.itemId });
    const otherUserDraft = await f.draft({ threadId, createdBy: "user", source: received.itemId });
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
    recordThreadAnnouncements();

    const answer = await send(mine);

    expect(answer.body.threadId).toBe(threadId);
    expect(await stateOf(tenant, semp)).toEqual(RETIRED);
    expect(await hasSempDraft(tenant, threadId)).toBe(false);
    // The user's own sent draft and their other draft are not Semp drafts: the first was sent, the second stays.
    expect((await stateOf(tenant, mine)).sentAt).toEqual(expect.any(Date));
    expect(await stateOf(tenant, otherUserDraft)).toEqual(UNTOUCHED);
    // The send announces the thread, and so does the retirement of a draft in it.
    expect(events).toEqual([
      { scope: "mailThread", threadId },
      { scope: "mailThread", threadId },
    ]);
  });

  it("changes nothing else when the user sends the Semp draft itself", async () => {
    const f = await mailFixture(tenant);
    const { received, draftId: semp, threadId } = await threadWithSempDraft(f, "semp-sent");
    const userDraft = await f.draft({ threadId, createdBy: "user", source: received.itemId });
    recordThreadAnnouncements();

    const answer = await send(semp);

    expect(answer.body.emailId).toBe(semp);
    expect(await stateOf(tenant, semp)).toEqual({ trashed: false, hasRow: true, sentAt: expect.any(Date) });
    expect(await stateOf(tenant, userDraft)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, threadId)).toBe(false);
    expect(events).toEqual([{ scope: "mailThread", threadId }]);
  });

  it("keeps a Semp draft the user edited when the user sends their own reply", async () => {
    const f = await mailFixture(tenant);
    const { received, draftId: semp, threadId } = await threadWithSempDraft(f, "edited-then-reply");
    await editAsUser(semp);
    const mine = await userReply(f, { threadId, source: received.itemId });

    await send(mine);

    expect(await stateOf(tenant, semp)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
  });

  it("keeps the agent draft of a newer message when the user answers an older one", async () => {
    const f = await mailFixture(tenant);
    const older = await f.message({
      folderId: f.inbox,
      messageId: ID("older"),
      date: new Date("2020-01-01T00:00:00Z"),
    });
    const newer = await f.message({
      folderId: f.inbox,
      messageId: ID("newer"),
      date: new Date("2999-01-01T00:00:00Z"),
      references: [ID("older")],
    });
    const semp = await f.draft({ threadId: newer.threadId, createdBy: "agent", source: newer.itemId });
    const mine = await userReply(f, { threadId: older.threadId, source: older.itemId });

    await send(mine);

    // The draft answers a message dated after the moment of the send, which the user's reply cannot have answered.
    expect(await stateOf(tenant, semp)).toEqual(UNTOUCHED);
  });
});

describe("an own message that is ingested (issue gh-1902)", () => {
  it("retires the agent draft when a reply the user sent from another client arrives in the Sent folder", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "other-client");
    recordThreadAnnouncements();

    const own = await f.message({
      folderId: f.sent,
      messageId: ID("my-reply"),
      from: OWN_ADDRESS,
      date: LATER,
      references: [ID("other-client")],
    });

    expect(own.threadId).toBe(threadId);
    expect(own.created).toBe(true);
    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
    expect(await hasSempDraft(tenant, threadId)).toBe(false);
    // The new message announces its thread, and so does the retirement of a draft in it.
    expect(events).toEqual([
      { scope: "mailThread", threadId },
      { scope: "mailThread", threadId },
    ]);
  });

  it("retires it for a message in the Sent folder whose sender is not a registered address", async () => {
    const f = await mailFixture(tenant);
    const { draftId } = await threadWithSempDraft(f, "sent-folder-only");

    await f.message({
      folderId: f.sent,
      messageId: ID("sent-reply"),
      from: "unregistered-alias@example.test",
      date: LATER,
      references: [ID("sent-folder-only")],
    });

    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
  });

  it("retires it for a message from a registered address that is not in the Sent folder", async () => {
    const f = await mailFixture(tenant);
    const { draftId } = await threadWithSempDraft(f, "alias-only");

    await f.message({
      folderId: f.inbox,
      messageId: ID("copy-to-self"),
      from: OWN_ADDRESS.toUpperCase(),
      date: LATER,
      references: [ID("alias-only")],
    });

    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
  });

  it("keeps a Semp draft the user edited when a reply the user sent from another client arrives", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "edited-other-client");
    await editAsUser(draftId);

    await f.message({
      folderId: f.sent,
      messageId: ID("edited-other-client-reply"),
      from: OWN_ADDRESS,
      date: LATER,
      references: [ID("edited-other-client")],
    });

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
  });

  it("keeps the agent draft when the user's unsent work arrives in the Drafts folder, whoever it is from", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "work-in-progress");
    recordThreadAnnouncements();

    const wip = await f.message({
      folderId: f.drafts,
      messageId: ID("autosaved-reply"),
      from: OWN_ADDRESS,
      date: LATER,
      references: [ID("work-in-progress")],
    });

    expect(wip.created).toBe(true);
    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
    // Only the new message announced its thread.
    expect(events).toEqual([{ scope: "mailThread", threadId }]);
    // The reply the user then sends, filed in the Sent folder of the mailbox, is their answer.
    await f.message({
      folderId: f.sent,
      messageId: ID("sent-reply-after-draft"),
      from: OWN_ADDRESS,
      date: LATER,
      references: [ID("work-in-progress")],
    });
    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
  });

  it("keeps the agent draft when the message that arrives is someone else's", async () => {
    const f = await mailFixture(tenant);
    const { draftId, threadId } = await threadWithSempDraft(f, "not-mine");
    recordThreadAnnouncements();

    await f.message({
      folderId: f.inbox,
      messageId: ID("their-reply"),
      from: OTHER_ADDRESS,
      date: LATER,
      references: [ID("not-mine")],
    });

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
    expect(await hasSempDraft(tenant, threadId)).toBe(true);
    expect(events).toEqual([{ scope: "mailThread", threadId }]);
  });

  it("keeps the agent draft when the own message is older than the message the draft answers", async () => {
    const f = await mailFixture(tenant);
    const { draftId } = await threadWithSempDraft(f, "own-is-older");

    await f.message({
      folderId: f.sent,
      messageId: ID("old-reply"),
      from: OWN_ADDRESS,
      date: new Date("2026-09-01T00:00:00Z"),
      references: [ID("own-is-older")],
    });

    expect(await stateOf(tenant, draftId)).toEqual(UNTOUCHED);
  });

  it("dates an own message without a date at the moment it is ingested", async () => {
    const f = await mailFixture(tenant);
    const { draftId } = await threadWithSempDraft(f, "undated-own");

    await f.message({
      folderId: f.sent,
      messageId: ID("undated-reply"),
      from: OWN_ADDRESS,
      date: null,
      references: [ID("undated-own")],
    });

    expect(await stateOf(tenant, draftId)).toEqual(RETIRED);
  });

  it("does not retire for an own message that was ingested already", async () => {
    const f = await mailFixture(tenant);
    const { threadId } = await threadWithSempDraft(f, "twice");
    const input = {
      folderId: f.sent,
      messageId: ID("twice-reply"),
      from: OWN_ADDRESS,
      date: LATER,
      references: [ID("twice")],
    };
    await f.message(input);
    // The thread gets a new Semp draft for a message that is older than the own one, and the same message is observed again.
    const received = await f.message({ folderId: f.inbox, messageId: ID("twice"), date: FIRST });
    const next = await f.draft({ threadId, createdBy: "agent", source: received.itemId });

    const again = await f.message(input);

    expect(again.created).toBe(false);
    expect(await stateOf(tenant, next)).toEqual(UNTOUCHED);
  });
});
