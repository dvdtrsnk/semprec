import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, lockItemForObservedMailFlags } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { applyObservedMailMessageFlags } from "../mail/mailFlagObservation.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { lockMailThreadMutation } from "../mail/mailThreadMutationGuard.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createMailThread, reassignThread } from "../mail/mailMessageMetaStore.js";
import { createMailThreadFlagRouteHandler, createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// The real lock, wrapped so that one test can make the copy change between the thread's listing and its lock.
vi.mock("../chokePoint/itemWrites.js", async (importActual) => {
  const actual = await importActual<typeof import("../chokePoint/itemWrites.js")>();
  return { ...actual, lockItemForObservedMailFlags: vi.fn(actual.lockItemForObservedMailFlags) };
});

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

const ALL_MESSAGES = ["offer", "reply1", "reply1Copy", "answer", "reply3"] as const;
const USER_ID = randomUUID();
const OWN_ADDRESS = "me@example.test";
const CLIENT_ADDRESS = "klient@example.test";

describe("POST /api/mail/threads/:threadId/flag (issue gh-1893)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-flag-"));
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
    vi.mocked(lockItemForObservedMailFlags).mockClear();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  /** Two mailboxes with their Inbox, Sent and Drafts folders, and an ingest through the sync writer. */
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
        address: OWN_ADDRESS,
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
    const ingest = async (input: {
      id: string;
      day: number;
      mailbox?: string;
      folder?: string;
      refs?: string[];
      from?: string;
      subject?: string;
      flags?: string[];
    }) => {
      const result = await withTransaction(runtime, (client) =>
        ingestEmailMessage(client, {
          emailsDatabaseId: db("emails"),
          filesDatabaseId: db("files"),
          folderRelationPropertyId: property("folder"),
          attachmentsRelationPropertyId: property("attachments"),
          mailboxItemId: input.mailbox ?? boxA.id,
          folderItemId: input.folder ?? folders.inbox.id,
          messageId: input.id,
          references: input.refs ?? [],
          subject: input.subject ?? "Re: Nabídka na web",
          date: new Date(`2026-10-${String(input.day).padStart(2, "0")}T09:00:00Z`),
          envelope: {
            from: { name: "Sender", address: input.from ?? CLIENT_ADDRESS },
            to: [{ name: "Me", address: OWN_ADDRESS }],
          },
          bodyHtml: `<p>${input.id}</p>`,
          flags: input.flags,
          attachments: [],
          storage,
          storageKeyPrefix: "thread-flag-fixtures",
        }),
      );
      return result.itemId;
    };
    return { boxA, boxB, folders, ingest };
  }

  /**
   * The conversation "Re: Nabídka na web": the user's sent offer, an incoming reply that was also delivered to
   * a second mailbox, the user's sent answer and a last incoming reply. Both of Petr's messages are incoming.
   * A message named in `flagged` is synced with its provider flag set.
   */
  async function offerThread(flagged: readonly ("offer" | "reply1" | "reply1Copy" | "answer" | "reply3")[] = []) {
    const f = await setup();
    const flags = (name: (typeof flagged)[number]) => (flagged.includes(name) ? ["\\Flagged"] : undefined);
    const offer = await f.ingest({
      id: "<offer@example.test>",
      day: 1,
      from: OWN_ADDRESS,
      folder: f.folders.sent.id,
      flags: flags("offer"),
    });
    const reply1 = await f.ingest({
      id: "<reply-1@example.test>",
      day: 2,
      refs: ["<offer@example.test>"],
      flags: flags("reply1"),
    });
    const reply1Copy = await f.ingest({
      id: "<reply-1@example.test>",
      day: 2,
      mailbox: f.boxB.id,
      refs: ["<offer@example.test>"],
      flags: flags("reply1Copy"),
    });
    const answer = await f.ingest({
      id: "<reply-2@example.test>",
      day: 3,
      refs: ["<offer@example.test>", "<reply-1@example.test>"],
      from: OWN_ADDRESS,
      folder: f.folders.sent.id,
      flags: flags("answer"),
    });
    const reply3 = await f.ingest({
      id: "<reply-3@example.test>",
      day: 4,
      refs: ["<offer@example.test>", "<reply-2@example.test>"],
      flags: flags("reply3"),
    });
    const threadId = await threadOf(offer);
    return { f, threadId, offer, reply1, reply1Copy, answer, reply3 };
  }

  async function threadOf(emailItemId: string): Promise<string> {
    const thread = await runtime.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
      [emailItemId],
    );
    const threadId = thread.rows[0]?.thread_id;
    if (!threadId) throw new Error("Message has no thread");
    return threadId;
  }

  /** The `flagged` property of each item (`null` when the item has none) and the time of its last update. */
  async function stateOf(itemIds: string[]): Promise<Map<string, { flagged: boolean | null; updatedAt: string }>> {
    const { rows } = await runtime.query<{ id: string; flagged: boolean | null; updated_at: string }>(
      `SELECT id, (properties->'flagged')::boolean AS flagged, updated_at::text AS updated_at
       FROM items WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])`,
      [itemIds],
    );
    return new Map(rows.map((row) => [row.id, { flagged: row.flagged, updatedAt: row.updated_at }]));
  }

  async function flagsOf(itemIds: string[]): Promise<(boolean | null)[]> {
    const state = await stateOf(itemIds);
    return itemIds.map((id) => state.get(id)?.flagged ?? null);
  }

  /** The `flagged` rows of the flag write-back table: one per message whose flag was written by a user or an agent. */
  async function desiredFlagStates(): Promise<{ itemId: string; desired: boolean }[]> {
    const { rows } = await runtime.query<{ item_id: string; desired_state: boolean }>(
      `SELECT message_item_id AS item_id, desired_state FROM mail_message_flag_sync_state
       WHERE tenant_id = app_tenant_default() AND property_key = 'flagged' ORDER BY message_item_id`,
    );
    return rows.map((row) => ({ itemId: row.item_id, desired: row.desired_state }));
  }

  /** The thread ids of `box=flagged`, as the thread list answers them. */
  async function flaggedBox(): Promise<string[]> {
    const { body } = await runInTenant(tenant, () =>
      createMailThreadListRouteHandler(runtime)({ req: { url: "/api/mail/threads?box=flagged" } }),
    );
    return body.threads.map((thread) => thread.threadId);
  }

  /** Calls the route handler as the session user, in the tenant of the session. */
  function post(threadId: string, body: unknown, inTenant = tenant) {
    return runInTenant(inTenant, () =>
      createMailThreadFlagRouteHandler(runtime)({
        params: { threadId },
        body,
        identity: { user: { id: USER_ID } },
      }),
    );
  }

  /** From here on the fixture is built, so only the announcements of the call under test are recorded. */
  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }
  it("flags only the last incoming message and leaves the earlier incoming message and the sent ones", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread();
      const untouchedBefore = await stateOf([offer, reply1, reply1Copy, answer]);
      recordThreadAnnouncements();

      const result = await post(threadId, { flagged: true });

      expect(result).toEqual({ status: 200, body: { threadId, flagged: true } });
      expect(await flagsOf([reply3])).toEqual([true]);
      expect(await stateOf([offer, reply1, reply1Copy, answer])).toEqual(untouchedBefore);
      expect(await flagsOf([offer, reply1, reply1Copy, answer])).toEqual([null, null, null, null]);
    });
  });

  it("flags every copy of the last incoming message, also the one in another mailbox", async () => {
    await runInTenant(tenant, async () => {
      const { f, threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const reply3Copy = await f.ingest({
        id: "<reply-3@example.test>",
        day: 4,
        mailbox: f.boxB.id,
        refs: ["<offer@example.test>", "<reply-2@example.test>"],
      });

      await post(threadId, { flagged: true });

      expect(await flagsOf([reply3, reply3Copy])).toEqual([true, true]);
      expect(await flagsOf([reply1, reply1Copy])).toEqual([null, null]);
    });
  });

  it("keeps an earlier flagged message flagged when the last incoming message is flagged", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread(["reply1", "reply1Copy"]);

      await post(threadId, { flagged: true });

      expect(await flagsOf([reply1, reply1Copy, reply3])).toEqual([true, true, true]);
    });
  });

  it("never flags mail the user sent from an Inbox, mail in Sent or mail in Drafts, and picks the last incoming message among the rest", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const first = await f.ingest({ id: "<first@example.test>", day: 1 });
      const refs = ["<first@example.test>"];
      const second = await f.ingest({ id: "<second@example.test>", day: 2, refs });
      // Each message below is later than the incoming ones and is excluded for exactly one reason.
      const ownInInbox = await f.ingest({ id: "<own@example.test>", day: 3, refs, from: OWN_ADDRESS });
      const otherInSent = await f.ingest({ id: "<sent@example.test>", day: 4, refs, folder: f.folders.sent.id });
      const otherInDrafts = await f.ingest({ id: "<draft@example.test>", day: 5, refs, folder: f.folders.drafts.id });
      const excluded = [ownInInbox, otherInSent, otherInDrafts];
      const threadId = await threadOf(first);
      const excludedBefore = await stateOf(excluded);
      recordThreadAnnouncements();

      const result = await post(threadId, { flagged: true });

      expect(result.body.flagged).toBe(true);
      expect(await flagsOf([first, second])).toEqual([null, true]);
      expect(await stateOf(excluded)).toEqual(excludedBefore);
      expect(await flagsOf(excluded)).toEqual([null, null, null]);
    });
  });

  it("clears the flag of every message, the sent ones, an own message in an Inbox and a draft included", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const flags = ["\\Flagged"];
      const first = await f.ingest({ id: "<first@example.test>", day: 1, flags });
      const refs = ["<first@example.test>"];
      const firstCopy = await f.ingest({ id: "<first@example.test>", day: 1, mailbox: f.boxB.id, flags });
      const ownInInbox = await f.ingest({ id: "<own@example.test>", day: 2, refs, from: OWN_ADDRESS, flags });
      const sent = await f.ingest({ id: "<sent@example.test>", day: 3, refs, folder: f.folders.sent.id, flags });
      const draft = await f.ingest({ id: "<draft@example.test>", day: 4, refs, folder: f.folders.drafts.id, flags });
      const unflaggedYet = await f.ingest({ id: "<plain@example.test>", day: 5, refs });
      const threadId = await threadOf(first);
      const all = [first, firstCopy, ownInInbox, sent, draft, unflaggedYet];
      expect(await flagsOf(all)).toEqual([true, true, true, true, true, null]);
      recordThreadAnnouncements();

      const result = await post(threadId, { flagged: false });

      expect(result).toEqual({ status: 200, body: { threadId, flagged: false } });
      expect(await flagsOf(all)).toEqual([false, false, false, false, false, null]);
    });
  });

  it("lists the thread under box=flagged after flagging it and no more after unflagging it", async () => {
    await runInTenant(tenant, async () => {
      const { threadId } = await offerThread();
      expect(await flaggedBox()).toEqual([]);

      await post(threadId, { flagged: true });
      expect(await flaggedBox()).toEqual([threadId]);

      await post(threadId, { flagged: false });
      expect(await flaggedBox()).toEqual([]);
    });
  });

  it("records the desired flag state of every message it changed and of no other", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread(["reply1", "answer"]);
      // The sync of the two flagged messages observed their flags: converged rows that are no user intent.
      const observed = await desiredFlagStates();
      expect(observed.map((row) => row.itemId)).toEqual([reply1, answer].sort());
      recordThreadAnnouncements();

      await post(threadId, { flagged: true });
      expect(await desiredFlagStates()).toEqual(
        [...observed, { itemId: reply3, desired: true }].sort((a, b) => a.itemId.localeCompare(b.itemId)),
      );
      expect(await desiredFlagStates()).not.toContainEqual(expect.objectContaining({ itemId: offer }));
      expect(await desiredFlagStates()).not.toContainEqual(expect.objectContaining({ itemId: reply1Copy }));

      await post(threadId, { flagged: false });
      const cleared = await desiredFlagStates();
      expect(cleared.filter((row) => row.desired)).toEqual([]);
      // Only the three messages that had the flag are written; the others have no row at all.
      expect(cleared.map((row) => row.itemId)).toEqual([reply1, answer, reply3].sort());
    });
  });

  it("writes nothing for a message whose flag already matches, but still announces the call", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      await post(threadId, { flagged: true });
      const before = await stateOf([reply1, reply1Copy, reply3]);
      const desiredBefore = await desiredFlagStates();
      recordThreadAnnouncements();

      const again = await post(threadId, { flagged: true });

      expect(again).toEqual({ status: 200, body: { threadId, flagged: true } });
      expect(await stateOf([reply1, reply1Copy, reply3])).toEqual(before);
      expect(await desiredFlagStates()).toEqual(desiredBefore);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("writes nothing for flagged:false on a conversation whose messages have no flag, but still announces the call", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread();
      const all = [offer, reply1, reply1Copy, answer, reply3];
      // A freshly synced message carries no `flagged` property, which reads as unflagged.
      expect(await flagsOf(all)).toEqual([null, null, null, null, null]);
      const before = await stateOf(all);
      expect(await desiredFlagStates()).toEqual([]);
      recordThreadAnnouncements();

      const result = await post(threadId, { flagged: false });

      expect(result).toEqual({ status: 200, body: { threadId, flagged: false } });
      expect(await stateOf(all)).toEqual(before);
      expect(await desiredFlagStates()).toEqual([]);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("serializes with a reconcile pass that locks the copies in another order instead of deadlocking with it", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread(["offer", "answer"]);
      const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      // `flagged:false` writes the flagged copies in item id order; the pass below locks the highest id first.
      const byId = [offer, answer].sort();
      const lowest = byId[0];
      const highest = byId[1];
      if (lowest === undefined || highest === undefined) throw new Error("Expected two copies");
      const flagged = (messageItemId: string) => ({ emailsDatabaseId, messageItemId, flags: ["\\Flagged"] });

      let routeIsWaiting!: () => void;
      const routeWaits = new Promise<void>((resolve) => {
        routeIsWaiting = resolve;
      });
      let passHoldsHighest!: () => void;
      const highestHeld = new Promise<void>((resolve) => {
        passHoldsHighest = resolve;
      });
      // A reconcile pass: the guard first, then the copy with the highest id, and the one with the lowest id only
      // once the route is waiting. Without the guard in the route, the route holds the lowest copy by then and the
      // two wait for each other (40P01).
      const pass = withTransaction(runtime, async (client) => {
        await lockMailThreadMutation(client);
        await applyObservedMailMessageFlags(client, flagged(highest));
        passHoldsHighest();
        await routeWaits;
        await applyObservedMailMessageFlags(client, flagged(lowest));
      });
      await highestHeld;
      const route = post(threadId, { flagged: false });

      const deadline = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const { rows } = await admin.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted LIMIT 1",
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      routeIsWaiting();
      await pass;
      expect(waiting, "the route must wait for the guard the pass holds").toBe(true);

      expect(await route).toEqual({ status: 200, body: { threadId, flagged: false } });
      expect(await flagsOf([offer, answer])).toEqual([false, false]);
      expect(await flagsOf([reply1, reply1Copy, reply3])).toEqual([null, null, null]);
    });
  });

  it("flags nothing in a thread of sent mail only and answers flagged false, and clears nothing that is not there", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const sentOnly = await f.ingest({
        id: "<only-sent@example.test>",
        day: 1,
        from: OWN_ADDRESS,
        folder: f.folders.sent.id,
        subject: "Nothing came back",
      });
      const threadId = await threadOf(sentOnly);
      const before = await stateOf([sentOnly]);
      recordThreadAnnouncements();

      for (const flagged of [true, false]) {
        expect(await post(threadId, { flagged })).toEqual({ status: 200, body: { threadId, flagged: false } });
      }

      expect(await stateOf([sentOnly])).toEqual(before);
      expect(await desiredFlagStates()).toEqual([]);
    });
  });

  it("sends exactly one mailThread invalidation per call, after the commit", async () => {
    await runInTenant(tenant, async () => {
      const { threadId } = await offerThread();
      recordThreadAnnouncements();

      await post(threadId, { flagged: true });
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
      expect(events[0]).not.toHaveProperty("userId");

      await post(threadId, { flagged: false });
      expect(events).toEqual([
        { scope: "mailThread", threadId },
        { scope: "mailThread", threadId },
      ]);
    });
  });

  it("sends no invalidation and keeps every message as it was when a write of the call fails", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread(["offer", "answer"]);
      const all = [offer, reply1, reply1Copy, answer, reply3];
      const before = await stateOf(all);
      const desiredBefore = await desiredFlagStates();
      recordThreadAnnouncements();

      // A trigger is the only way to fail the second write of the call; no production code exposes that seam.
      await admin.query(`CREATE FUNCTION test_mail_thread_flag_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.desired_state = false AND NEW.message_item_id::text = (SELECT max(message_item_id::text) FROM mail_message_flag_sync_state WHERE desired_state) THEN
            RAISE EXCEPTION 'test mail thread flag failure';
          END IF;
          RETURN NEW;
        END $$`);
      await admin.query(
        "CREATE TRIGGER test_mail_thread_flag_fail BEFORE INSERT OR UPDATE ON mail_message_flag_sync_state FOR EACH ROW EXECUTE FUNCTION test_mail_thread_flag_fail()",
      );
      try {
        await expect(post(threadId, { flagged: false })).rejects.toThrow("test mail thread flag failure");
      } finally {
        await admin.query("DROP TRIGGER test_mail_thread_flag_fail ON mail_message_flag_sync_state");
        await admin.query("DROP FUNCTION test_mail_thread_flag_fail()");
      }

      expect(events).toEqual([]);
      expect(await stateOf(all)).toEqual(before);
      expect(await desiredFlagStates()).toEqual(desiredBefore);
    });
  });

  it("skips a copy that was trashed after the thread was listed and still writes the others", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread(ALL_MESSAGES);
      // `flagged:false` locks every copy in item id order, so the first lock is that of the lowest id.
      const [trashed, ...others] = [offer, reply1, reply1Copy, answer, reply3].sort();
      vi.mocked(lockItemForObservedMailFlags).mockImplementationOnce(async (client, databaseId, itemId) => {
        // The copy is trashed by another transaction between the listing and this lock.
        await itemDeleteWithClient(client, databaseId, itemId, { queueAffinity: createActionQueueAffinity() });
        const actual =
          await vi.importActual<typeof import("../chokePoint/itemWrites.js")>("../chokePoint/itemWrites.js");
        return actual.lockItemForObservedMailFlags(client, databaseId, itemId);
      });
      recordThreadAnnouncements();

      const result = await post(threadId, { flagged: false });

      expect(result.status).toBe(200);
      expect(await flagsOf([trashed!])).toEqual([true]);
      expect(await flagsOf(others)).toEqual([false, false, false, false]);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("skips a copy that is gone when it is locked and still writes the others", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread(ALL_MESSAGES);
      const [vanished, ...others] = [offer, reply1, reply1Copy, answer, reply3].sort();
      vi.mocked(lockItemForObservedMailFlags).mockImplementationOnce(async () => null);

      const result = await post(threadId, { flagged: false });

      expect(result.status).toBe(200);
      expect(await flagsOf([vanished!])).toEqual([true]);
      expect(await flagsOf(others)).toEqual([false, false, false, false]);
    });
  });

  it("translates the id of a merged thread, writes the thread that absorbed it and announces that one", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply3 } = await offerThread();
      const mergedAway = await withTransaction(runtime, async (client) => {
        const thread = await createMailThread(client);
        await reassignThread(client, thread.id, threadId);
        return thread.id;
      });
      recordThreadAnnouncements();

      const result = await post(mergedAway, { flagged: true });

      expect(result).toEqual({ status: 200, body: { threadId, flagged: true } });
      expect(await flagsOf([reply3])).toEqual([true]);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("answers 404 for an unknown thread id and writes and announces nothing", async () => {
    await runInTenant(tenant, async () => {
      const { reply1, reply3 } = await offerThread();
      const before = await stateOf([reply1, reply3]);
      recordThreadAnnouncements();

      await expect(post(randomUUID(), { flagged: true })).rejects.toBeInstanceOf(NotFoundError);

      expect(await stateOf([reply1, reply3])).toEqual(before);
      expect(events).toEqual([]);
    });
  });

  it("answers 404 for a thread without a live message", async () => {
    await runInTenant(tenant, async () => {
      const empty = await withTransaction(runtime, async (client) => (await createMailThread(client)).id);
      recordThreadAnnouncements();

      await expect(post(empty, { flagged: true })).rejects.toBeInstanceOf(NotFoundError);

      expect(events).toEqual([]);
    });
  });

  it("answers another tenant's thread like an unknown one and leaves that tenant's messages as they were", async () => {
    const { threadId, before, messages, reply3 } = await runInTenant(tenant, async () => {
      const fixture = await offerThread();
      const items = [fixture.reply1, fixture.reply1Copy, fixture.reply3];
      return { threadId: fixture.threadId, before: await stateOf(items), messages: items, reply3: fixture.reply3 };
    });
    recordThreadAnnouncements();

    const refused = await post(threadId, { flagged: true }, foreign).catch((error: unknown) => error);
    const unknown = await post(randomUUID(), { flagged: true }, foreign).catch((error: unknown) => error);

    if (!(refused instanceof NotFoundError) || !(unknown instanceof NotFoundError)) {
      throw new Error("Both calls must be refused with a NotFoundError");
    }
    expect(refused.message).toBe(unknown.message);
    expect(events).toEqual([]);
    await runInTenant(tenant, async () => {
      expect(await stateOf(messages)).toEqual(before);
      expect(await flagsOf(messages)).toEqual([null, null, null]);
      // The owner's call reaches the same messages, so the refusal above was a real one.
      expect((await post(threadId, { flagged: true })).body.flagged).toBe(true);
      expect(await flagsOf([reply3])).toEqual([true]);
    });
  });

  it.each([
    ["a thread id that is no UUID", "not-a-uuid", { flagged: true }],
    ["a body without flagged", null, {}],
    ["a flagged that is no boolean", null, { flagged: "true" }],
    ["a body with another key", null, { flagged: true, read: true }],
    ["a body that is null", null, null],
    ["a body that is an array", null, [true]],
  ])("answers 400 for %s and writes and announces nothing", async (_name, threadIdOverride, body) => {
    await runInTenant(tenant, async () => {
      const { threadId, reply3 } = await offerThread();
      const before = await stateOf([reply3]);
      recordThreadAnnouncements();

      await expect(post(threadIdOverride ?? threadId, body)).rejects.toBeInstanceOf(ValidationError);

      expect(await stateOf([reply3])).toEqual(before);
      expect(events).toEqual([]);
    });
  });
});
