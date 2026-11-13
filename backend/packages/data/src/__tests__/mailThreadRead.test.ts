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
import { createMailThreadReadRouteHandler } from "../mail/mailThreadRoutes.js";
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

const USER_ID = randomUUID();
const OWN_ADDRESS = "me@example.test";
const CLIENT_ADDRESS = "klient@example.test";

describe("POST /api/mail/threads/:threadId/read (issue gh-1865)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-thread-read-"));
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
          attachments: [],
          storage,
          storageKeyPrefix: "thread-read-fixtures",
        }),
      );
      return result.itemId;
    };
    return { boxA, boxB, folders, ingest };
  }

  /**
   * The conversation "Re: Nabídka na web": the user's sent offer, an incoming reply that was also delivered to
   * a second mailbox, the user's sent answer and a last incoming reply. Both of Petr's messages are incoming.
   */
  async function offerThread() {
    const f = await setup();
    const offer = await f.ingest({ id: "<offer@example.test>", day: 1, from: OWN_ADDRESS, folder: f.folders.sent.id });
    const reply1 = await f.ingest({ id: "<reply-1@example.test>", day: 2, refs: ["<offer@example.test>"] });
    const reply1Copy = await f.ingest({
      id: "<reply-1@example.test>",
      day: 2,
      mailbox: f.boxB.id,
      refs: ["<offer@example.test>"],
    });
    const answer = await f.ingest({
      id: "<reply-2@example.test>",
      day: 3,
      refs: ["<offer@example.test>", "<reply-1@example.test>"],
      from: OWN_ADDRESS,
      folder: f.folders.sent.id,
    });
    const reply3 = await f.ingest({
      id: "<reply-3@example.test>",
      day: 4,
      refs: ["<offer@example.test>", "<reply-2@example.test>"],
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

  /** The `read` property of each item (`null` when the item has none) and the time of its last update. */
  async function stateOf(itemIds: string[]): Promise<Map<string, { read: boolean | null; updatedAt: string }>> {
    const { rows } = await runtime.query<{ id: string; read: boolean | null; updated_at: string }>(
      `SELECT id, (properties->'read')::boolean AS read, updated_at::text AS updated_at
       FROM items WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])`,
      [itemIds],
    );
    return new Map(rows.map((row) => [row.id, { read: row.read, updatedAt: row.updated_at }]));
  }

  async function readsOf(itemIds: string[]): Promise<(boolean | null)[]> {
    const state = await stateOf(itemIds);
    return itemIds.map((id) => state.get(id)?.read ?? null);
  }

  /** The `read` rows of the flag write-back table: one per message whose read state was written by a user or an agent. */
  async function desiredReadStates(): Promise<{ itemId: string; desired: boolean }[]> {
    const { rows } = await runtime.query<{ item_id: string; desired_state: boolean }>(
      `SELECT message_item_id AS item_id, desired_state FROM mail_message_flag_sync_state
       WHERE tenant_id = app_tenant_default() AND property_key = 'read' ORDER BY message_item_id`,
    );
    return rows.map((row) => ({ itemId: row.item_id, desired: row.desired_state }));
  }

  /** Calls the route handler as the session user, in the tenant of the session. */
  function post(threadId: string, body: unknown, inTenant = tenant) {
    return runInTenant(inTenant, () =>
      createMailThreadReadRouteHandler(runtime)({
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

  it("marks both incoming messages of the conversation read, with the copy in the second mailbox, and leaves the sent ones", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread();
      const sentBefore = await stateOf([offer, answer]);
      recordThreadAnnouncements();

      const result = await post(threadId, { read: true });

      expect(result).toEqual({ status: 200, body: { threadId, unread: false } });
      expect(await readsOf([reply1, reply1Copy, reply3])).toEqual([true, true, true]);
      expect(await stateOf([offer, answer])).toEqual(sentBefore);
      expect(await readsOf([offer, answer])).toEqual([null, null]);
    });
  });

  it("marks only the last incoming message unread and leaves the earlier incoming message read", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread();
      await post(threadId, { read: true });
      const untouchedBefore = await stateOf([offer, answer, reply1, reply1Copy]);
      recordThreadAnnouncements();

      const result = await post(threadId, { read: false });

      expect(result).toEqual({ status: 200, body: { threadId, unread: true } });
      expect(await readsOf([reply3])).toEqual([false]);
      expect(await stateOf([offer, answer, reply1, reply1Copy])).toEqual(untouchedBefore);
      expect(await readsOf([reply1, reply1Copy])).toEqual([true, true]);
    });
  });

  it("marks every copy of the last incoming message unread, also the one in another mailbox", async () => {
    await runInTenant(tenant, async () => {
      const { f, threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const reply3Copy = await f.ingest({
        id: "<reply-3@example.test>",
        day: 4,
        mailbox: f.boxB.id,
        refs: ["<offer@example.test>", "<reply-2@example.test>"],
      });
      await post(threadId, { read: true });
      expect(await readsOf([reply3, reply3Copy])).toEqual([true, true]);

      await post(threadId, { read: false });

      expect(await readsOf([reply3, reply3Copy])).toEqual([false, false]);
      expect(await readsOf([reply1, reply1Copy])).toEqual([true, true]);
    });
  });

  it("never writes mail the user sent from an Inbox, mail in Sent or mail in Drafts, and picks the last incoming message among the rest", async () => {
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

      const opened = await post(threadId, { read: true });
      expect(await readsOf([first, second])).toEqual([true, true]);
      expect(await stateOf(excluded)).toEqual(excludedBefore);
      // The answer is the unread state the thread detail reports, which counts the draft of a sender that is no
      // mailbox address of the tenant. The route never writes the draft, so it keeps the thread unread.
      expect(opened.body.unread).toBe(true);

      const result = await post(threadId, { read: false });
      expect(result.body.unread).toBe(true);
      expect(await readsOf([first, second])).toEqual([true, false]);
      expect(await stateOf(excluded)).toEqual(excludedBefore);
      expect(await readsOf(excluded)).toEqual([null, null, null]);
    });
  });

  it("records the desired read state of every message it changed and of no other", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread();
      expect(await desiredReadStates()).toEqual([]);
      recordThreadAnnouncements();

      await post(threadId, { read: true });
      const expectedRead = [reply1, reply1Copy, reply3].sort().map((itemId) => ({ itemId, desired: true }));
      expect(await desiredReadStates()).toEqual(expectedRead);
      expect(await desiredReadStates()).not.toContainEqual(expect.objectContaining({ itemId: offer }));
      expect(await desiredReadStates()).not.toContainEqual(expect.objectContaining({ itemId: answer }));

      await post(threadId, { read: false });
      expect(await desiredReadStates()).toEqual(
        [reply1, reply1Copy, reply3].sort().map((itemId) => ({ itemId, desired: itemId !== reply3 })),
      );
    });
  });

  it("writes nothing for a message whose read state already matches, but still announces the call", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      await post(threadId, { read: true });
      const before = await stateOf([reply1, reply1Copy, reply3]);
      const desiredBefore = await desiredReadStates();
      recordThreadAnnouncements();

      const again = await post(threadId, { read: true });

      expect(again).toEqual({ status: 200, body: { threadId, unread: false } });
      expect(await stateOf([reply1, reply1Copy, reply3])).toEqual(before);
      expect(await desiredReadStates()).toEqual(desiredBefore);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("writes nothing for read:false when the last incoming message is unread already", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      await post(threadId, { read: true });
      await post(threadId, { read: false });
      const before = await stateOf([reply1, reply1Copy, reply3]);
      recordThreadAnnouncements();

      const again = await post(threadId, { read: false });

      expect(again.body.unread).toBe(true);
      expect(await stateOf([reply1, reply1Copy, reply3])).toEqual(before);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("writes nothing for read:false on a conversation that was never opened, whose messages have no read property", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, offer, reply1, reply1Copy, answer, reply3 } = await offerThread();
      const all = [offer, reply1, reply1Copy, answer, reply3];
      // A freshly synced message carries no `read` property, which reads as unread.
      expect(await readsOf(all)).toEqual([null, null, null, null, null]);
      const before = await stateOf(all);
      expect(await desiredReadStates()).toEqual([]);
      recordThreadAnnouncements();

      const result = await post(threadId, { read: false });

      expect(result).toEqual({ status: 200, body: { threadId, unread: true } });
      expect(await stateOf(all)).toEqual(before);
      expect(await desiredReadStates()).toEqual([]);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("serializes with a reconcile pass that locks the copies in another order instead of deadlocking with it", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      // The route locks the copies in item id order; the pass below locks the highest id first.
      const byId = [reply1, reply1Copy, reply3].sort();
      const lowest = byId[0];
      const highest = byId[2];
      if (lowest === undefined || highest === undefined) throw new Error("Expected three copies");
      const seen = (messageItemId: string) => ({ emailsDatabaseId, messageItemId, flags: ["\\Seen"] });

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
        await applyObservedMailMessageFlags(client, seen(highest));
        passHoldsHighest();
        await routeWaits;
        await applyObservedMailMessageFlags(client, seen(lowest));
      });
      await highestHeld;
      const route = post(threadId, { read: true });

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

      expect(await route).toEqual({ status: 200, body: { threadId, unread: false } });
      expect(await readsOf([reply1, reply1Copy, reply3])).toEqual([true, true, true]);
    });
  });

  it("answers a thread of sent mail only with unread false and writes nothing", async () => {
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

      for (const read of [true, false]) {
        expect(await post(threadId, { read })).toEqual({ status: 200, body: { threadId, unread: false } });
      }

      expect(await stateOf([sentOnly])).toEqual(before);
      expect(await desiredReadStates()).toEqual([]);
    });
  });

  it("sends exactly one mailThread invalidation per call, after the commit", async () => {
    await runInTenant(tenant, async () => {
      const { threadId } = await offerThread();
      recordThreadAnnouncements();

      await post(threadId, { read: true });
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
      expect(events[0]).not.toHaveProperty("userId");

      await post(threadId, { read: false });
      expect(events).toEqual([
        { scope: "mailThread", threadId },
        { scope: "mailThread", threadId },
      ]);
    });
  });

  it("sends no invalidation and keeps every message as it was when a write of the call fails", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const before = await stateOf([reply1, reply1Copy, reply3]);
      expect(await desiredReadStates()).toEqual([]);
      recordThreadAnnouncements();

      // A trigger is the only way to fail the second write of the call; no production code exposes that seam.
      await admin.query(`CREATE FUNCTION test_mail_thread_read_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM mail_message_flag_sync_state) THEN RAISE EXCEPTION 'test mail thread read failure'; END IF;
          RETURN NEW;
        END $$`);
      await admin.query(
        "CREATE TRIGGER test_mail_thread_read_fail BEFORE INSERT ON mail_message_flag_sync_state FOR EACH ROW EXECUTE FUNCTION test_mail_thread_read_fail()",
      );
      try {
        await expect(post(threadId, { read: true })).rejects.toThrow("test mail thread read failure");
      } finally {
        await admin.query("DROP TRIGGER test_mail_thread_read_fail ON mail_message_flag_sync_state");
        await admin.query("DROP FUNCTION test_mail_thread_read_fail()");
      }

      expect(events).toEqual([]);
      expect(await stateOf([reply1, reply1Copy, reply3])).toEqual(before);
      expect(await desiredReadStates()).toEqual([]);
    });
  });

  it("skips a copy that was trashed after the thread was listed and still writes the others", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const trashed = [reply1, reply1Copy, reply3].sort()[0]!;
      const others = [reply1, reply1Copy, reply3].filter((id) => id !== trashed);
      vi.mocked(lockItemForObservedMailFlags).mockImplementationOnce(async (client, databaseId, itemId) => {
        // The copy is trashed by another transaction between the listing and this lock.
        await itemDeleteWithClient(client, databaseId, itemId, { queueAffinity: createActionQueueAffinity() });
        const actual =
          await vi.importActual<typeof import("../chokePoint/itemWrites.js")>("../chokePoint/itemWrites.js");
        return actual.lockItemForObservedMailFlags(client, databaseId, itemId);
      });
      recordThreadAnnouncements();

      const result = await post(threadId, { read: true });

      expect(result.status).toBe(200);
      expect(await readsOf([trashed])).toEqual([null]);
      expect(await readsOf(others)).toEqual([true, true]);
      expect(await desiredReadStates()).toEqual(others.sort().map((itemId) => ({ itemId, desired: true })));
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("skips a copy that is gone when it is locked and still writes the others", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const vanished = [reply1, reply1Copy, reply3].sort()[0]!;
      const others = [reply1, reply1Copy, reply3].filter((id) => id !== vanished);
      vi.mocked(lockItemForObservedMailFlags).mockImplementationOnce(async () => null);

      const result = await post(threadId, { read: true });

      expect(result.status).toBe(200);
      expect(await readsOf([vanished])).toEqual([null]);
      expect(await readsOf(others)).toEqual([true, true]);
    });
  });

  it("translates the id of a merged thread, writes the thread that absorbed it and announces that one", async () => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1, reply1Copy, reply3 } = await offerThread();
      const mergedAway = await withTransaction(runtime, async (client) => {
        const thread = await createMailThread(client);
        await reassignThread(client, thread.id, threadId);
        return thread.id;
      });
      recordThreadAnnouncements();

      const result = await post(mergedAway, { read: true });

      expect(result).toEqual({ status: 200, body: { threadId, unread: false } });
      expect(await readsOf([reply1, reply1Copy, reply3])).toEqual([true, true, true]);
      expect(events).toEqual([{ scope: "mailThread", threadId }]);
    });
  });

  it("answers 404 for an unknown thread id and writes and announces nothing", async () => {
    await runInTenant(tenant, async () => {
      const { reply1, reply3 } = await offerThread();
      const before = await stateOf([reply1, reply3]);
      recordThreadAnnouncements();

      await expect(post(randomUUID(), { read: true })).rejects.toBeInstanceOf(NotFoundError);

      expect(await stateOf([reply1, reply3])).toEqual(before);
      expect(events).toEqual([]);
    });
  });

  it("answers 404 for a thread without a live message", async () => {
    await runInTenant(tenant, async () => {
      const empty = await withTransaction(runtime, async (client) => (await createMailThread(client)).id);
      recordThreadAnnouncements();

      await expect(post(empty, { read: true })).rejects.toBeInstanceOf(NotFoundError);

      expect(events).toEqual([]);
    });
  });

  it("answers another tenant's thread like an unknown one and leaves that tenant's messages as they were", async () => {
    const { threadId, before, messages } = await runInTenant(tenant, async () => {
      const fixture = await offerThread();
      const items = [fixture.reply1, fixture.reply1Copy, fixture.reply3];
      return { threadId: fixture.threadId, before: await stateOf(items), messages: items };
    });
    recordThreadAnnouncements();

    const refused = await post(threadId, { read: true }, foreign).catch((error: unknown) => error);
    const unknown = await post(randomUUID(), { read: true }, foreign).catch((error: unknown) => error);

    if (!(refused instanceof NotFoundError) || !(unknown instanceof NotFoundError)) {
      throw new Error("Both calls must be refused with a NotFoundError");
    }
    expect(refused.message).toBe(unknown.message);
    expect(events).toEqual([]);
    await runInTenant(tenant, async () => {
      expect(await stateOf(messages)).toEqual(before);
      expect(await readsOf(messages)).toEqual([null, null, null]);
      // The owner's call reaches the same messages, so the refusal above was a real one.
      expect((await post(threadId, { read: true })).body.unread).toBe(false);
      expect(await readsOf(messages)).toEqual([true, true, true]);
    });
  });

  it.each([
    ["a thread id that is no UUID", "not-a-uuid", { read: true }],
    ["a body without read", null, {}],
    ["a read that is no boolean", null, { read: "true" }],
    ["a body with another key", null, { read: true, unread: false }],
    ["a body that is null", null, null],
    ["a body that is an array", null, [true]],
  ])("answers 400 for %s and writes and announces nothing", async (_name, threadIdOverride, body) => {
    await runInTenant(tenant, async () => {
      const { threadId, reply1 } = await offerThread();
      const before = await stateOf([reply1]);
      recordThreadAnnouncements();

      await expect(post(threadIdOverride ?? threadId, body)).rejects.toBeInstanceOf(ValidationError);

      expect(await stateOf([reply1])).toEqual(before);
      expect(events).toEqual([]);
    });
  });
});
