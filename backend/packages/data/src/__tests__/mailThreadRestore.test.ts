import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createMailThread, reassignThread } from "../mail/mailMessageMetaStore.js";
import {
  createMailThreadArchiveRouteHandler,
  createMailThreadListRouteHandler,
  createMailThreadRestoreRouteHandler,
} from "../mail/mailThreadRoutes.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  MOVE_FIXTURE_OWN_ADDRESS,
  MOVE_FIXTURE_UID_VALIDITY,
  createMoveFixtureIngest,
  createMoveFixtureMailbox,
  moveFixtureAccountSyncJobs,
  moveFixtureEdgesOf,
  moveFixtureJobKeys,
  moveFixtureMoveRows,
  moveFixtureThreadOf,
  type MoveFolderKey,
} from "../testSupport/mailThreadMoveFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

const FIRST = "<first@example.test>";

describe("POST /api/mail/threads/:threadId/restore (issue gh-2033)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-restore-"));
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

  const threadOf = (emailItemId: string) => moveFixtureThreadOf(runtime, emailItemId);
  const edgesOf = (itemId: string) => moveFixtureEdgesOf(runtime, itemId);
  const moveRows = () => moveFixtureMoveRows(runtime);
  const accountSyncJobs = () => moveFixtureAccountSyncJobs(admin);

  /** A Gmail API mailbox of the user and an IMAP mailbox, each without the folders named in its `omit`. */
  async function mailboxes(omit: { gmail?: readonly MoveFolderKey[]; imap?: readonly MoveFolderKey[] } = {}) {
    const gmail = await createMoveFixtureMailbox(runtime, {
      name: "Personal",
      kind: "gmail",
      ownAddress: MOVE_FIXTURE_OWN_ADDRESS,
      omit: omit.gmail,
    });
    const imap = await createMoveFixtureMailbox(runtime, { name: "Work", kind: "imap", omit: omit.imap });
    const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
    return { gmail, imap, ingest };
  }

  /** An incoming message in the Archive folder of both mailboxes, the IMAP copy with UID 21. */
  async function archivedThread(omit: Parameters<typeof mailboxes>[0] = {}) {
    const m = await mailboxes(omit);
    const gmailCopy = await m.ingest({ id: FIRST, day: 1, mailbox: m.gmail, folders: ["archive"] });
    const imapCopy = await m.ingest({ id: FIRST, day: 1, mailbox: m.imap, folders: ["archive"], uid: 21 });
    return { ...m, gmailCopy, imapCopy, threadId: await threadOf(gmailCopy) };
  }

  /**
   * A trashed conversation: an incoming message in the Trash of both mailboxes (the IMAP copy with UID 22) and the
   * user's own reply in the Trash of the Gmail mailbox.
   */
  async function trashedThread(omit: Parameters<typeof mailboxes>[0] = {}) {
    const m = await mailboxes(omit);
    const incomingGmail = await m.ingest({ id: FIRST, day: 1, mailbox: m.gmail, folders: ["trash"] });
    const incomingImap = await m.ingest({ id: FIRST, day: 1, mailbox: m.imap, folders: ["trash"], uid: 22 });
    const own = await m.ingest({
      id: "<own@example.test>",
      day: 2,
      refs: [FIRST],
      mailbox: m.gmail,
      folders: ["trash"],
      from: MOVE_FIXTURE_OWN_ADDRESS,
    });
    return { ...m, incomingGmail, incomingImap, own, threadId: await threadOf(incomingGmail) };
  }

  async function snapshotOf(itemIds: readonly string[]) {
    return Promise.all(itemIds.map((id) => edgesOf(id)));
  }

  async function purposesOf(itemId: string): Promise<string[]> {
    return (await edgesOf(itemId)).map((edge) => edge.purpose).sort();
  }

  /** The thread ids of `box=inbox`, as the thread list answers them. */
  async function inboxBox(): Promise<string[]> {
    const { body } = await runInTenant(tenant, () =>
      createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads?box=inbox" } }),
    );
    return body.threads.map((thread) => thread.threadId);
  }

  /** Calls the restore route handler in the tenant of the session. */
  function restore(threadId: string, inTenant = tenant) {
    return runInTenant(inTenant, () => createMailThreadRestoreRouteHandler(runtime)({ params: { threadId } }));
  }

  /** From here on the fixture is built, so only the announcements of the call under test are recorded. */
  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  /** Expects the call to be refused with a 409 of `code`, and every table the route writes to to be as it was. */
  async function expectRefusedUnchanged(threadId: string, code: string, itemIds: readonly string[]): Promise<void> {
    const edgesBefore = await snapshotOf(itemIds);
    const movesBefore = await moveRows();
    const jobsBefore = await accountSyncJobs();
    recordThreadAnnouncements();

    const refused = await restore(threadId).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({ status: 409, code });
    expect(await snapshotOf(itemIds)).toEqual(edgesBefore);
    expect(await moveRows()).toEqual(movesBefore);
    expect(await accountSyncJobs()).toEqual(jobsBefore);
    expect(events).toEqual([]);
  }

  it("puts an archived thread back into the Inbox folder of each of its mailboxes and back into box=inbox", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread();
      expect(await inboxBox()).toEqual([]);
      recordThreadAnnouncements();

      const result = await restore(t.threadId);

      expect(result).toEqual({ status: 200, body: { threadId: t.threadId, moved: 2 } });
      expect((await edgesOf(t.gmailCopy)).map((edge) => edge.folderId)).toEqual([t.gmail.folders.inbox]);
      expect((await edgesOf(t.imapCopy)).map((edge) => edge.folderId)).toEqual([t.imap.folders.inbox]);
      expect(await inboxBox()).toEqual([t.threadId]);
    });
  });

  it("puts the incoming messages of a trashed thread into the Inbox folder and the user's own message into Sent", async () => {
    await runInTenant(tenant, async () => {
      const t = await trashedThread();
      recordThreadAnnouncements();

      const result = await restore(t.threadId);

      expect(result).toEqual({ status: 200, body: { threadId: t.threadId, moved: 3 } });
      expect((await edgesOf(t.incomingGmail)).map((edge) => edge.folderId)).toEqual([t.gmail.folders.inbox]);
      expect((await edgesOf(t.incomingImap)).map((edge) => edge.folderId)).toEqual([t.imap.folders.inbox]);
      expect((await edgesOf(t.own)).map((edge) => edge.folderId)).toEqual([t.gmail.folders.sent]);
      expect(await inboxBox()).toEqual([t.threadId]);
    });
  });

  it("records a pending move per restored message with its purpose, a source of its own provider, and one account sync per mailbox", async () => {
    await runInTenant(tenant, async () => {
      const t = await trashedThread();
      expect(await moveRows()).toEqual([]);
      expect(await accountSyncJobs()).toEqual([]);

      await restore(t.threadId);

      const providerId = (messageId: string) => `gm-${messageId}-${t.gmail.id}`;
      const gmailRow = (messageItemId: string, messageId: string, desiredPurpose: string) => ({
        messageItemId,
        mailboxItemId: t.gmail.id,
        desiredPurpose,
        desiredRevision: "1",
        status: "pending",
        source: { provider: "gmail", providerMessageId: providerId(messageId) },
      });
      expect(await moveRows()).toEqual(
        [
          gmailRow(t.incomingGmail, FIRST, "inbox"),
          gmailRow(t.own, "<own@example.test>", "sent"),
          {
            messageItemId: t.incomingImap,
            mailboxItemId: t.imap.id,
            desiredPurpose: "inbox",
            desiredRevision: "1",
            status: "pending",
            source: {
              provider: "imap",
              folderItemId: t.imap.folders.trash,
              path: "Trash",
              uid: 22,
              uidValidity: MOVE_FIXTURE_UID_VALIDITY,
            },
          },
        ].sort((x, y) => (x.messageItemId < y.messageItemId ? -1 : 1)),
      );
      expect(await accountSyncJobs()).toEqual(moveFixtureJobKeys(t.gmail, t.imap));
    });
  });

  it("keeps no UID of the old edge on the restored edge of an IMAP message", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread();
      const [before] = await edgesOf(t.imapCopy);
      expect(before?.metadata).toEqual({ uid: 21 });

      await restore(t.threadId);

      const [after] = await edgesOf(t.imapCopy);
      expect(after?.metadata).toEqual({});
      expect(after?.edgeId).not.toBe(before?.edgeId);
    });
  });

  it("restores a Gmail API message from the synthetic Archive and another from Trash", async () => {
    await runInTenant(tenant, async () => {
      const { gmail, ingest } = await mailboxes();
      const fromArchive = await ingest({ id: FIRST, day: 1, mailbox: gmail, folders: ["archive"] });
      const fromTrash = await ingest({
        id: "<second@example.test>",
        day: 2,
        refs: [FIRST],
        mailbox: gmail,
        folders: ["trash"],
      });

      const result = await restore(await threadOf(fromArchive));

      expect(result.body.moved).toBe(2);
      expect(await purposesOf(fromArchive)).toEqual(["inbox"]);
      expect(await purposesOf(fromTrash)).toEqual(["inbox"]);
      expect((await moveRows()).map((row) => [row.desiredPurpose, row.status])).toEqual([
        ["inbox", "pending"],
        ["inbox", "pending"],
      ]);
    });
  });

  it("does not touch messages in Junk, in an Inbox or in Sent, and none of a draft", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread();
      const refs = [FIRST];
      const junk = await t.ingest({ id: "<junk@example.test>", day: 2, refs, mailbox: t.gmail, folders: ["junk"] });
      const inbox = await t.ingest({ id: "<inbox@example.test>", day: 3, refs, mailbox: t.gmail, folders: ["inbox"] });
      const sent = await t.ingest({
        id: "<sent@example.test>",
        day: 4,
        refs,
        mailbox: t.gmail,
        folders: ["sent"],
        from: MOVE_FIXTURE_OWN_ADDRESS,
      });
      const draft = await t.ingest({
        id: "<draft@example.test>",
        day: 5,
        refs,
        mailbox: t.gmail,
        folders: ["archive", "drafts"],
        from: MOVE_FIXTURE_OWN_ADDRESS,
      });
      const untouched = [junk, inbox, sent, draft];
      const before = await snapshotOf(untouched);

      const result = await restore(t.threadId);

      expect(result.body.moved).toBe(2);
      expect(await snapshotOf(untouched)).toEqual(before);
      expect((await moveRows()).map((row) => row.messageItemId)).toEqual([t.gmailCopy, t.imapCopy].sort());
    });
  });

  it("restores a thread that was archived through the archive route before the sync ran, from the source the archive recorded", async () => {
    await runInTenant(tenant, async () => {
      const m = await mailboxes();
      const gmailCopy = await m.ingest({ id: FIRST, day: 1, mailbox: m.gmail, folders: ["inbox"] });
      const imapCopy = await m.ingest({ id: FIRST, day: 1, mailbox: m.imap, folders: ["inbox"], uid: 11 });
      const threadId = await threadOf(gmailCopy);
      await createMailThreadArchiveRouteHandler(runtime)({ params: { threadId } });
      expect(await inboxBox()).toEqual([]);
      // The tentative Archive edge of the IMAP copy has no UID, so only the source of the archive can address it.
      expect((await edgesOf(imapCopy))[0]?.metadata).toEqual({});
      const [archivedRow] = (await moveRows()).filter((row) => row.messageItemId === imapCopy);

      const result = await restore(threadId);

      expect(result.body.moved).toBe(2);
      expect(await inboxBox()).toEqual([threadId]);
      expect(await purposesOf(imapCopy)).toEqual(["inbox"]);
      const [restoredRow] = (await moveRows()).filter((row) => row.messageItemId === imapCopy);
      expect(restoredRow).toEqual({ ...archivedRow, desiredPurpose: "inbox", desiredRevision: "2" });
    });
  });

  it("sends exactly one mailThread invalidation per call, after the commit", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread();
      recordThreadAnnouncements();

      await restore(t.threadId);

      expect(events).toEqual([{ scope: "mailThread", threadId: t.threadId }]);
      expect(events[0]).not.toHaveProperty("userId");
    });
  });

  it("fails with 409 mail_thread_not_archived_or_trashed when no message is in Archive or Trash, and changes nothing", async () => {
    await runInTenant(tenant, async () => {
      const m = await mailboxes();
      const inbox = await m.ingest({ id: FIRST, day: 1, mailbox: m.gmail, folders: ["inbox"] });
      const junk = await m.ingest({
        id: "<junk@example.test>",
        day: 2,
        refs: [FIRST],
        mailbox: m.gmail,
        folders: ["junk"],
      });
      const sent = await m.ingest({
        id: "<sent@example.test>",
        day: 3,
        refs: [FIRST],
        mailbox: m.gmail,
        folders: ["sent"],
        from: MOVE_FIXTURE_OWN_ADDRESS,
      });

      await expectRefusedUnchanged(await threadOf(inbox), "mail_thread_not_archived_or_trashed", [inbox, junk, sent]);
    });
  });

  it("fails with 409 mail_thread_not_archived_or_trashed for a thread whose only message in Archive is a draft", async () => {
    await runInTenant(tenant, async () => {
      const m = await mailboxes();
      const draft = await m.ingest({
        id: FIRST,
        day: 1,
        mailbox: m.gmail,
        folders: ["archive", "drafts"],
        from: MOVE_FIXTURE_OWN_ADDRESS,
      });

      await expectRefusedUnchanged(await threadOf(draft), "mail_thread_not_archived_or_trashed", [draft]);
    });
  });

  it("fails with 409 mail_inbox_folder_missing when a mailbox without an Inbox folder holds a message to restore, and changes nothing", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread({ imap: ["inbox"] });

      await expectRefusedUnchanged(t.threadId, "mail_inbox_folder_missing", [t.gmailCopy, t.imapCopy]);
      // The Gmail copy, whose mailbox has an Inbox folder, stayed in Archive.
      expect(await purposesOf(t.gmailCopy)).toEqual(["archive"]);
    });
  });

  it("fails with 409 mail_sent_folder_missing when a mailbox without a Sent folder holds an own message to restore, and changes nothing", async () => {
    await runInTenant(tenant, async () => {
      const t = await trashedThread({ gmail: ["sent"] });

      await expectRefusedUnchanged(t.threadId, "mail_sent_folder_missing", [t.incomingGmail, t.incomingImap, t.own]);
      expect(await purposesOf(t.incomingGmail)).toEqual(["trash"]);
    });
  });

  it("does not need an Inbox folder in a mailbox that holds only own messages to restore", async () => {
    await runInTenant(tenant, async () => {
      const m = await mailboxes({ gmail: ["inbox"] });
      const own = await m.ingest({
        id: FIRST,
        day: 1,
        mailbox: m.gmail,
        folders: ["trash"],
        from: MOVE_FIXTURE_OWN_ADDRESS,
      });

      const result = await restore(await threadOf(own));

      expect(result.body.moved).toBe(1);
      expect(await purposesOf(own)).toEqual(["sent"]);
    });
  });

  it("rejects an id that is no UUID with a ValidationError", async () => {
    await runInTenant(tenant, async () => {
      await expect(restore("not-a-uuid")).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("answers 404 for an unknown thread id and writes and announces nothing", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread();
      const before = await snapshotOf([t.gmailCopy, t.imapCopy]);
      recordThreadAnnouncements();

      await expect(restore(randomUUID())).rejects.toBeInstanceOf(NotFoundError);

      expect(await snapshotOf([t.gmailCopy, t.imapCopy])).toEqual(before);
      expect(await moveRows()).toEqual([]);
      expect(events).toEqual([]);
    });
  });

  it("answers 404 for a thread without a live message", async () => {
    await runInTenant(tenant, async () => {
      const empty = await withTransaction(runtime, async (client) => (await createMailThread(client)).id);
      recordThreadAnnouncements();

      await expect(restore(empty)).rejects.toBeInstanceOf(NotFoundError);

      expect(events).toEqual([]);
    });
  });

  it("translates the id of a merged thread, restores the thread that absorbed it and announces that one", async () => {
    await runInTenant(tenant, async () => {
      const t = await archivedThread();
      const mergedAway = await withTransaction(runtime, async (client) => {
        const thread = await createMailThread(client);
        await reassignThread(client, thread.id, t.threadId);
        return thread.id;
      });
      recordThreadAnnouncements();

      const result = await restore(mergedAway);

      expect(result).toEqual({ status: 200, body: { threadId: t.threadId, moved: 2 } });
      expect(await purposesOf(t.gmailCopy)).toEqual(["inbox"]);
      expect(events).toEqual([{ scope: "mailThread", threadId: t.threadId }]);
    });
  });

  it("answers another tenant's thread like an unknown one and leaves its messages as they were", async () => {
    const { t, before } = await runInTenant(tenant, async () => {
      const fixture = await archivedThread();
      return { t: fixture, before: await snapshotOf([fixture.gmailCopy, fixture.imapCopy]) };
    });
    recordThreadAnnouncements();

    const refused = await restore(t.threadId, foreign).catch((error: unknown) => error);
    const unknown = await restore(randomUUID(), foreign).catch((error: unknown) => error);

    if (!(refused instanceof NotFoundError) || !(unknown instanceof NotFoundError)) {
      throw new Error("Both calls must be refused with a NotFoundError");
    }
    expect(refused.message).toBe(unknown.message);
    expect(events).toEqual([]);
    await runInTenant(tenant, async () => {
      expect(await snapshotOf([t.gmailCopy, t.imapCopy])).toEqual(before);
      expect(await moveRows()).toEqual([]);
      // The owner's call reaches the same messages, so the refusal above was a real one.
      expect((await restore(t.threadId)).body.moved).toBe(2);
    });
  });
});
