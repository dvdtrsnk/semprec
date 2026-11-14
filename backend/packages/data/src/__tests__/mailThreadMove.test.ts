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
import { lockMailThreadMutation } from "../mail/mailThreadMutationGuard.js";
import {
  createMailThreadArchiveRouteHandler,
  createMailThreadListRouteHandler,
  createMailThreadTrashRouteHandler,
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
} from "../testSupport/mailThreadMoveFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

type MoveKind = "archive" | "trash";

describe("POST /api/mail/threads/:threadId/archive and /trash (issue gh-1917)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-move-"));
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

  /**
   * The conversation "Re: Nabídka na web" in two accounts: a Gmail API mailbox `gmail` and an IMAP mailbox `imap`.
   * `inboxGmail` is an incoming message of the Gmail mailbox's Inbox, delivered to the IMAP mailbox as `inboxImap`
   * (UID 11); `archived` is incoming mail already in Archive, `sentOwn` the user's own mail in Sent and `junk` incoming
   * mail in Junk.
   */
  async function offerThread(options: { omitImap?: readonly ("archive" | "trash" | "inbox")[] } = {}) {
    const gmail = await createMoveFixtureMailbox(runtime, {
      name: "Personal",
      kind: "gmail",
      ownAddress: MOVE_FIXTURE_OWN_ADDRESS,
    });
    const imap = await createMoveFixtureMailbox(runtime, { name: "Work", kind: "imap", omit: options.omitImap });
    const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
    const first = "<first@example.test>";
    const refs = [first];
    const inboxGmail = await ingest({ id: first, day: 1, mailbox: gmail, folders: ["inbox"] });
    const inboxImap = await ingest({ id: first, day: 1, mailbox: imap, folders: ["inbox"], uid: 11 });
    const archived = await ingest({
      id: "<archived@example.test>",
      day: 2,
      refs,
      mailbox: gmail,
      folders: ["archive"],
    });
    const sentOwn = await ingest({
      id: "<sent@example.test>",
      day: 3,
      refs,
      mailbox: gmail,
      folders: ["sent"],
      from: MOVE_FIXTURE_OWN_ADDRESS,
    });
    const junk = await ingest({ id: "<junk@example.test>", day: 4, refs, mailbox: gmail, folders: ["junk"] });
    const threadId = await threadOf(inboxGmail);
    return { gmail, imap, ingest, refs, inboxGmail, inboxImap, archived, sentOwn, junk, threadId };
  }

  const threadOf = (emailItemId: string) => moveFixtureThreadOf(runtime, emailItemId);

  const edgesOf = (itemId: string) => moveFixtureEdgesOf(runtime, itemId);

  async function snapshotOf(itemIds: readonly string[]) {
    return Promise.all(itemIds.map((id) => edgesOf(id)));
  }

  async function purposesOf(itemId: string): Promise<string[]> {
    return (await edgesOf(itemId)).map((edge) => edge.purpose).sort();
  }

  const moveRows = () => moveFixtureMoveRows(runtime);

  const accountSyncJobs = () => moveFixtureAccountSyncJobs(admin);

  const jobKeys = moveFixtureJobKeys;

  /** The thread ids of `box=inbox`, as the thread list answers them. */
  async function inboxBox(): Promise<string[]> {
    const { body } = await runInTenant(tenant, () =>
      createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads?box=inbox" } }),
    );
    return body.threads.map((thread) => thread.threadId);
  }

  /** Calls the route handler in the tenant of the session. */
  function post(kind: MoveKind, threadId: string, inTenant = tenant) {
    const handler = kind === "archive" ? createMailThreadArchiveRouteHandler : createMailThreadTrashRouteHandler;
    return runInTenant(inTenant, () => handler(runtime)({ params: { threadId } }));
  }

  /** From here on the fixture is built, so only the announcements of the call under test are recorded. */
  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  /** Expects the call to be refused with a 409 of `code`, and every table the route writes to to be as it was. */
  async function expectRefusedUnchanged(
    kind: MoveKind,
    threadId: string,
    code: string,
    itemIds: readonly string[],
  ): Promise<void> {
    const edgesBefore = await snapshotOf(itemIds);
    const movesBefore = await moveRows();
    const jobsBefore = await accountSyncJobs();
    recordThreadAnnouncements();

    const refused = await post(kind, threadId).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({ status: 409, code });
    expect(await snapshotOf(itemIds)).toEqual(edgesBefore);
    expect(await moveRows()).toEqual(movesBefore);
    expect(await accountSyncJobs()).toEqual(jobsBefore);
    expect(events).toEqual([]);
  }

  describe("archive", () => {
    it("moves the Inbox messages of every account to the Archive folder of their own mailbox and takes the thread out of box=inbox", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        expect(await inboxBox()).toEqual([t.threadId]);
        const untouched = [t.archived, t.sentOwn, t.junk];
        const untouchedBefore = await snapshotOf(untouched);
        recordThreadAnnouncements();

        const result = await post("archive", t.threadId);

        expect(result).toEqual({ status: 200, body: { threadId: t.threadId, moved: 2 } });
        expect((await edgesOf(t.inboxGmail)).map((edge) => edge.folderId)).toEqual([t.gmail.folders.archive]);
        expect((await edgesOf(t.inboxImap)).map((edge) => edge.folderId)).toEqual([t.imap.folders.archive]);
        expect(await inboxBox()).toEqual([]);
        // Messages outside the inbox are not touched: the same edges, not re-created ones.
        expect(await snapshotOf(untouched)).toEqual(untouchedBefore);
      });
    });

    it("uses the synthetic Archive folder of a Gmail API mailbox", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();

        await post("archive", t.threadId);

        const [edge] = await edgesOf(t.inboxGmail);
        const { rows } = await runtime.query<{ provider_id: string; name: string }>(
          "SELECT properties->>'providerId' AS provider_id, properties->>'name' AS name FROM items WHERE tenant_id = app_tenant_default() AND id = $1",
          [edge?.folderId],
        );
        expect(rows[0]?.provider_id).toBe("semprec:archive");
      });
    });

    it("removes every folder edge of a moved message, not only the Inbox one, and keeps no UID of the old edge", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        // A Gmail message in Inbox and Sent (mail the user sent to themself) has two edges.
        const both = await t.ingest({
          id: "<self@example.test>",
          day: 5,
          refs: t.refs,
          mailbox: t.gmail,
          folders: ["inbox", "sent"],
        });
        expect(await purposesOf(both)).toEqual(["inbox", "sent"]);
        const imapBefore = await edgesOf(t.inboxImap);
        expect(imapBefore[0]?.metadata).toEqual({ uid: 11 });

        await post("archive", t.threadId);

        expect(await purposesOf(both)).toEqual(["archive"]);
        const [imapAfter] = await edgesOf(t.inboxImap);
        expect(imapAfter?.metadata).toEqual({});
        expect(imapAfter?.edgeId).not.toBe(imapBefore[0]?.edgeId);
      });
    });

    it("records a pending move per moved message, with the source its provider addresses it by, and enqueues one account sync per mailbox", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        expect(await moveRows()).toEqual([]);
        expect(await accountSyncJobs()).toEqual([]);

        await post("archive", t.threadId);

        const gmailProviderId = `gm-<first@example.test>-${t.gmail.id}`;
        expect(await moveRows()).toEqual(
          [
            {
              messageItemId: t.inboxGmail,
              mailboxItemId: t.gmail.id,
              desiredPurpose: "archive",
              desiredRevision: "1",
              status: "pending",
              source: { provider: "gmail", providerMessageId: gmailProviderId },
            },
            {
              messageItemId: t.inboxImap,
              mailboxItemId: t.imap.id,
              desiredPurpose: "archive",
              desiredRevision: "1",
              status: "pending",
              source: {
                provider: "imap",
                folderItemId: t.imap.folders.inbox,
                path: "INBOX",
                uid: 11,
                uidValidity: MOVE_FIXTURE_UID_VALIDITY,
              },
            },
          ].sort((x, y) => (x.messageItemId < y.messageItemId ? -1 : 1)),
        );
        expect(await accountSyncJobs()).toEqual(jobKeys(t.gmail, t.imap));
      });
    });

    it("sends exactly one mailThread invalidation per call, after the commit", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        recordThreadAnnouncements();

        await post("archive", t.threadId);

        expect(events).toEqual([{ scope: "mailThread", threadId: t.threadId }]);
        expect(events[0]).not.toHaveProperty("userId");
      });
    });

    it("answers moved 0, writes nothing and still announces the call when no message is in an Inbox", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        await post("archive", t.threadId);
        const all = [t.inboxGmail, t.inboxImap, t.archived, t.sentOwn, t.junk];
        const edgesBefore = await snapshotOf(all);
        const movesBefore = await moveRows();
        const jobsBefore = await accountSyncJobs();
        recordThreadAnnouncements();

        const again = await post("archive", t.threadId);

        expect(again).toEqual({ status: 200, body: { threadId: t.threadId, moved: 0 } });
        expect(await snapshotOf(all)).toEqual(edgesBefore);
        expect(await moveRows()).toEqual(movesBefore);
        expect(await accountSyncJobs()).toEqual(jobsBefore);
        expect(events).toEqual([{ scope: "mailThread", threadId: t.threadId }]);
      });
    });

    it("fails with 409 mail_archive_folder_missing when an IMAP mailbox with an Inbox message has no Archive folder, and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread({ omitImap: ["archive"] });

        await expectRefusedUnchanged("archive", t.threadId, "mail_archive_folder_missing", [
          t.inboxGmail,
          t.inboxImap,
          t.archived,
          t.sentOwn,
          t.junk,
        ]);
        // The Gmail copy, which has an Archive folder, stayed in its Inbox.
        expect(await purposesOf(t.inboxGmail)).toEqual(["inbox"]);
      });
    });

    it("does not need an Archive folder of a mailbox that holds no Inbox message of the thread", async () => {
      await runInTenant(tenant, async () => {
        const gmail = await createMoveFixtureMailbox(runtime, { name: "Personal", kind: "gmail" });
        const imap = await createMoveFixtureMailbox(runtime, { name: "Work", kind: "imap", omit: ["archive"] });
        const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
        const first = "<first@example.test>";
        const inboxGmail = await ingest({ id: first, day: 1, mailbox: gmail, folders: ["inbox"] });
        const junkImap = await ingest({ id: first, day: 1, mailbox: imap, folders: ["junk"] });

        const result = await post("archive", await threadOf(inboxGmail));

        expect(result.body.moved).toBe(1);
        expect(await purposesOf(inboxGmail)).toEqual(["archive"]);
        expect(await purposesOf(junkImap)).toEqual(["junk"]);
      });
    });

    // The thread list counts a copy in Inbox and Drafts (it leaves out only copies whose every folder is Drafts), but a
    // copy with a Drafts folder is a draft for the move routes (`MailThreadMoveCopy.draft`) and stays where it is.
    it("never moves a copy that has a Drafts folder edge, also one in an Inbox", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        const draft = await t.ingest({
          id: "<draft@example.test>",
          day: 7,
          refs: t.refs,
          mailbox: t.gmail,
          folders: ["inbox", "drafts"],
          from: MOVE_FIXTURE_OWN_ADDRESS,
        });
        const before = await edgesOf(draft);

        const result = await post("archive", t.threadId);

        expect(result.body.moved).toBe(2);
        expect(await edgesOf(draft)).toEqual(before);
      });
    });
  });

  describe("trash", () => {
    /** Adds incoming mail that is already in Trash and a draft, which trash must leave alone. */
    async function withTrashedAndDraft(t: Awaited<ReturnType<typeof offerThread>>) {
      const trashed = await t.ingest({
        id: "<trashed@example.test>",
        day: 5,
        refs: t.refs,
        mailbox: t.gmail,
        folders: ["trash"],
      });
      const draft = await t.ingest({
        id: "<draft@example.test>",
        day: 6,
        refs: t.refs,
        mailbox: t.gmail,
        folders: ["drafts"],
        from: MOVE_FIXTURE_OWN_ADDRESS,
      });
      return { trashed, draft };
    }

    it("moves every message to the Trash folder of its own mailbox, deleting nothing", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        const { trashed, draft } = await withTrashedAndDraft(t);
        const moving = [t.inboxGmail, t.inboxImap, t.archived, t.sentOwn, t.junk];
        const metaBefore = await runtime.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM mail_message_meta WHERE tenant_id = app_tenant_default()",
        );
        const untouched = [trashed, draft];
        const untouchedBefore = await snapshotOf(untouched);
        recordThreadAnnouncements();

        const result = await post("trash", t.threadId);

        expect(result).toEqual({ status: 200, body: { threadId: t.threadId, moved: 5 } });
        for (const itemId of moving) {
          const mailbox = itemId === t.inboxImap ? t.imap : t.gmail;
          expect((await edgesOf(itemId)).map((edge) => edge.folderId)).toEqual([mailbox.folders.trash]);
        }
        expect(await snapshotOf(untouched)).toEqual(untouchedBefore);
        // Nothing is deleted permanently: every item is live and keeps its mail row.
        const live = await runtime.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM items WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[]) AND deleted_at IS NULL",
          [[...moving, ...untouched]],
        );
        expect(live.rows[0]?.count).toBe("7");
        const metaAfter = await runtime.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM mail_message_meta WHERE tenant_id = app_tenant_default()",
        );
        expect(metaAfter.rows).toEqual(metaBefore.rows);
        expect(await inboxBox()).toEqual([]);
        expect(events).toEqual([{ scope: "mailThread", threadId: t.threadId }]);
      });
    });

    it("records a pending trash move per moved message and enqueues one account sync per mailbox", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        const { trashed, draft } = await withTrashedAndDraft(t);

        await post("trash", t.threadId);

        const rows = await moveRows();
        expect(rows.map((row) => row.messageItemId)).toEqual(
          [t.inboxGmail, t.inboxImap, t.archived, t.sentOwn, t.junk].sort(),
        );
        expect(rows.map((row) => [row.desiredPurpose, row.status])).toEqual(rows.map(() => ["trash", "pending"]));
        expect(rows.map((row) => row.messageItemId)).not.toContain(trashed);
        expect(rows.map((row) => row.messageItemId)).not.toContain(draft);
        expect(await accountSyncJobs()).toEqual(jobKeys(t.gmail, t.imap));
      });
    });

    it("fails with 409 mail_thread_already_trashed when every message is in Trash or Junk, and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const gmail = await createMoveFixtureMailbox(runtime, { name: "Personal", kind: "gmail" });
        const imap = await createMoveFixtureMailbox(runtime, { name: "Work", kind: "imap" });
        const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
        const first = "<first@example.test>";
        const inTrash = await ingest({ id: first, day: 1, mailbox: gmail, folders: ["trash"] });
        const inJunk = await ingest({ id: first, day: 1, mailbox: imap, folders: ["junk"] });
        const alsoJunk = await ingest({
          id: "<second@example.test>",
          day: 2,
          refs: [first],
          mailbox: gmail,
          folders: ["junk"],
        });

        await expectRefusedUnchanged("trash", await threadOf(inTrash), "mail_thread_already_trashed", [
          inTrash,
          inJunk,
          alsoJunk,
        ]);
      });
    });

    it("fails with 409 mail_trash_folder_missing when a mailbox with a message to move has no Trash folder, and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread({ omitImap: ["trash"] });

        await expectRefusedUnchanged("trash", t.threadId, "mail_trash_folder_missing", [
          t.inboxGmail,
          t.inboxImap,
          t.archived,
          t.sentOwn,
          t.junk,
        ]);
        expect(await purposesOf(t.inboxGmail)).toEqual(["inbox"]);
      });
    });

    it("answers moved 0 for a thread of drafts only instead of refusing it as trashed", async () => {
      await runInTenant(tenant, async () => {
        const gmail = await createMoveFixtureMailbox(runtime, {
          name: "Personal",
          kind: "gmail",
          ownAddress: MOVE_FIXTURE_OWN_ADDRESS,
        });
        const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
        const draft = await ingest({
          id: "<only-draft@example.test>",
          day: 1,
          mailbox: gmail,
          folders: ["drafts"],
          from: MOVE_FIXTURE_OWN_ADDRESS,
        });
        const before = await edgesOf(draft);

        const result = await post("trash", await threadOf(draft));

        expect(result.body.moved).toBe(0);
        expect(await edgesOf(draft)).toEqual(before);
        expect(await moveRows()).toEqual([]);
      });
    });

    it("moves a Junk message together with the rest when some message is not in Trash or Junk", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();

        await post("trash", t.threadId);

        expect(await purposesOf(t.junk)).toEqual(["trash"]);
      });
    });
  });

  describe("moves that cannot be addressed at the provider", () => {
    it("fails with 409 mail_move_source_unverified for an IMAP copy whose edge carries no UID, and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        // A state the routes cannot produce: an edge of a synced IMAP copy that lost its UID metadata.
        await admin.query(
          "UPDATE item_relations SET metadata = '{}'::jsonb WHERE tenant_id = $1 AND (item_a = $2 OR item_b = $2)",
          [tenant, t.inboxImap],
        );

        await expectRefusedUnchanged("archive", t.threadId, "mail_move_source_unverified", [t.inboxGmail, t.inboxImap]);
        expect(await purposesOf(t.inboxGmail)).toEqual(["inbox"]);
      });
    });

    it("fails with 409 mail_move_source_unverified for a mailbox without sync state, and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const gmail = await createMoveFixtureMailbox(runtime, {
          name: "Personal",
          kind: "gmail",
          withoutSyncState: true,
        });
        const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
        const message = await ingest({ id: "<first@example.test>", day: 1, mailbox: gmail, folders: ["inbox"] });

        await expectRefusedUnchanged("archive", await threadOf(message), "mail_move_source_unverified", [message]);
      });
    });

    it("keeps the source of a move that is still pending when the thread is moved again before the sync ran", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        await post("archive", t.threadId);
        const [imapRowBefore] = (await moveRows()).filter((row) => row.messageItemId === t.inboxImap);
        // The IMAP copy now has a tentative edge without a UID, so only the recorded source can address it.
        expect((await edgesOf(t.inboxImap))[0]?.metadata).toEqual({});

        const result = await post("trash", t.threadId);

        expect(result.body.moved).toBe(5);
        const [imapRowAfter] = (await moveRows()).filter((row) => row.messageItemId === t.inboxImap);
        expect(imapRowAfter).toEqual({ ...imapRowBefore, desiredPurpose: "trash", desiredRevision: "2" });
        expect(await purposesOf(t.inboxImap)).toEqual(["trash"]);
      });
    });
  });

  describe("failures and scoping", () => {
    it.each<MoveKind>(["archive", "trash"])(
      "%s: rejects an id that is no UUID with a ValidationError",
      async (kind) => {
        await runInTenant(tenant, async () => {
          await expect(post(kind, "not-a-uuid")).rejects.toBeInstanceOf(ValidationError);
        });
      },
    );

    it.each<MoveKind>(["archive", "trash"])(
      "%s: answers 404 for an unknown thread id and writes and announces nothing",
      async (kind) => {
        await runInTenant(tenant, async () => {
          const t = await offerThread();
          const before = await snapshotOf([t.inboxGmail, t.inboxImap]);
          recordThreadAnnouncements();

          await expect(post(kind, randomUUID())).rejects.toBeInstanceOf(NotFoundError);

          expect(await snapshotOf([t.inboxGmail, t.inboxImap])).toEqual(before);
          expect(await moveRows()).toEqual([]);
          expect(events).toEqual([]);
        });
      },
    );

    it.each<MoveKind>(["archive", "trash"])("%s: answers 404 for a thread without a live message", async (kind) => {
      await runInTenant(tenant, async () => {
        const empty = await withTransaction(runtime, async (client) => (await createMailThread(client)).id);
        recordThreadAnnouncements();

        await expect(post(kind, empty)).rejects.toBeInstanceOf(NotFoundError);

        expect(events).toEqual([]);
      });
    });

    it.each<MoveKind>(["archive", "trash"])(
      "%s: translates the id of a merged thread and announces the thread that absorbed it",
      async (kind) => {
        await runInTenant(tenant, async () => {
          const t = await offerThread();
          const mergedAway = await withTransaction(runtime, async (client) => {
            const thread = await createMailThread(client);
            await reassignThread(client, thread.id, t.threadId);
            return thread.id;
          });
          recordThreadAnnouncements();

          const result = await post(kind, mergedAway);

          expect(result.body.threadId).toBe(t.threadId);
          expect(result.body.moved).toBeGreaterThan(0);
          expect(events).toEqual([{ scope: "mailThread", threadId: t.threadId }]);
        });
      },
    );

    it.each<MoveKind>(["archive", "trash"])(
      "%s: answers another tenant's thread like an unknown one and leaves its messages as they were",
      async (kind) => {
        const { t, before } = await runInTenant(tenant, async () => {
          const fixture = await offerThread();
          return { t: fixture, before: await snapshotOf([fixture.inboxGmail, fixture.inboxImap]) };
        });
        recordThreadAnnouncements();

        const refused = await post(kind, t.threadId, foreign).catch((error: unknown) => error);
        const unknown = await post(kind, randomUUID(), foreign).catch((error: unknown) => error);

        if (!(refused instanceof NotFoundError) || !(unknown instanceof NotFoundError)) {
          throw new Error("Both calls must be refused with a NotFoundError");
        }
        expect(refused.message).toBe(unknown.message);
        expect(events).toEqual([]);
        await runInTenant(tenant, async () => {
          expect(await snapshotOf([t.inboxGmail, t.inboxImap])).toEqual(before);
          expect(await moveRows()).toEqual([]);
          // The owner's call reaches the same messages, so the refusal above was a real one.
          expect((await post(kind, t.threadId)).body.moved).toBeGreaterThan(0);
        });
      },
    );

    it("rolls back every move, announces nothing and enqueues nothing when a write of the call fails", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        const all = [t.inboxGmail, t.inboxImap, t.archived, t.sentOwn, t.junk];
        const before = await snapshotOf(all);
        recordThreadAnnouncements();

        // A trigger is the only way to fail the second write of the call; no production code exposes that seam.
        await admin.query(`CREATE FUNCTION test_mail_thread_move_fail() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (SELECT 1 FROM mail_message_move_sync_state) THEN
              RAISE EXCEPTION 'test mail thread move failure';
            END IF;
            RETURN NEW;
          END $$`);
        await admin.query(
          "CREATE TRIGGER test_mail_thread_move_fail BEFORE INSERT ON mail_message_move_sync_state FOR EACH ROW EXECUTE FUNCTION test_mail_thread_move_fail()",
        );
        try {
          await expect(post("archive", t.threadId)).rejects.toThrow("test mail thread move failure");
        } finally {
          await admin.query("DROP TRIGGER test_mail_thread_move_fail ON mail_message_move_sync_state");
          await admin.query("DROP FUNCTION test_mail_thread_move_fail()");
        }

        expect(await snapshotOf(all)).toEqual(before);
        expect(await moveRows()).toEqual([]);
        expect(await accountSyncJobs()).toEqual([]);
        expect(events).toEqual([]);
      });
    });

    it("waits for the tenant's mail-thread guard before it reads or writes the thread", async () => {
      await runInTenant(tenant, async () => {
        const t = await offerThread();
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let held!: () => void;
        const guardHeld = new Promise<void>((resolve) => {
          held = resolve;
        });
        // A reconcile pass holds the guard for its whole transaction.
        const pass = withTransaction(runtime, async (client) => {
          await lockMailThreadMutation(client);
          held();
          await released;
        });
        await guardHeld;
        const route = post("archive", t.threadId);

        const deadline = Date.now() + 5000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const { rows } = await admin.query(
            "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted LIMIT 1",
          );
          waiting = rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await purposesOf(t.inboxGmail)).toEqual(["inbox"]);
        release();
        await pass;
        expect(waiting, "the route must wait for the guard the pass holds").toBe(true);

        expect((await route).body.moved).toBe(2);
      });
    });
  });
});
