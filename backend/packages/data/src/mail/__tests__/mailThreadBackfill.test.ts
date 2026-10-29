import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { requireSingleRow, withTransaction, type Queryable } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS } from "../ingest.js";
import { createMailThread, upsertMailMessageMeta } from "../mailMessageMetaStore.js";
import { handleMailThreadBackfillTask } from "../mailThreadBackfillJob.js";
import { resolveThreadId } from "../threading.js";

// Fault injection for the failing-tenant test: `resolveThreadId` throws for one Message-ID and passes every other
// call through to the real function.
vi.mock("../threading.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../threading.js")>();
  return {
    ...actual,
    async resolveThreadId(...args: Parameters<typeof actual.resolveThreadId>) {
      const [, input] = args;
      if (input.messageId.startsWith("<injected-failure@")) throw new Error("injected failure for one tenant");
      return actual.resolveThreadId(...args);
    },
  };
});

const MAILBOX_A = "00000000-0000-4000-8000-00000000000a";
const MAILBOX_B = "00000000-0000-4000-8000-00000000000b";
/** One more row than the job's page size of 200, so each pass has to read a second page. */
const ROWS_PAST_ONE_PAGE = 201;

let admin: Pool;
let pool: Pool;
let tenantZero: string;
let tenantB: string;

interface StoredMessage {
  itemId: string;
  mailboxItemId: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
}

/** Writes one `mail_message_meta` row through the store. No thread unless one is given. */
async function writeMessage(client: Queryable, message: StoredMessage): Promise<void> {
  await upsertMailMessageMeta(client, {
    itemId: message.itemId,
    mailboxItemId: message.mailboxItemId,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? null,
    references: message.references ?? [],
    threadId: message.threadId ?? null,
    envelope: {},
  });
}

async function store(tenantId: string, message: StoredMessage): Promise<void> {
  await runInTenant(tenantId, () => withTransaction(pool, (client) => writeMessage(client, message)));
}

/** A message synced before #1570, threaded the way live ingest threads it. Returns its thread id. */
async function synced(tenantId: string, message: Omit<StoredMessage, "threadId">): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const threadId = await resolveThreadId(client, {
        messageId: message.messageId,
        inReplyTo: message.inReplyTo ?? null,
        references: message.references ?? [],
      });
      await writeMessage(client, { ...message, threadId });
      return threadId;
    }),
  );
}

async function newThread(tenantId: string): Promise<string> {
  const thread = await runInTenant(tenantId, () => withTransaction(pool, (client) => createMailThread(client)));
  return thread.id;
}

/** An Emails item named `name`, created through the production item writer. */
async function emailItem(tenantId: string, name: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const emails = await getDatabaseByModuleId(client, "emails");
      if (!emails) throw new Error("Emails database was not seeded");
      const item = await createItemWithClient(
        client,
        { databaseId: emails.id, properties: { name } },
        { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
      );
      return item.id;
    }),
  );
}

// The reads below run inside the tenant they name, so row-level security applies to them.

async function threadOf(tenantId: string, itemId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM mail_message_meta WHERE item_id = $1",
      [itemId],
    );
    return requireSingleRow(rows, `mail_message_meta row ${itemId}`).thread_id;
  });
}

async function subjectHintOf(tenantId: string, threadId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ subject_hint: string | null }>(
      "SELECT subject_hint FROM mail_threads WHERE id = $1",
      [threadId],
    );
    return requireSingleRow(rows, `mail_threads row ${threadId}`).subject_hint;
  });
}

async function threadIds(tenantId: string): Promise<string[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM mail_threads ORDER BY id");
    return rows.map((row) => row.id);
  });
}

async function unthreadedRows(tenantId: string): Promise<number> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM mail_message_meta WHERE thread_id IS NULL",
    );
    return requireSingleRow(rows, "unthreaded row count").n;
  });
}

async function orphanThreads(tenantId: string): Promise<number> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM mail_threads t WHERE NOT EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.thread_id = t.id)",
    );
    return requireSingleRow(rows, "orphan thread count").n;
  });
}

async function messageIdsInSeveralThreads(tenantId: string): Promise<number> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM (SELECT message_id FROM mail_message_meta GROUP BY message_id HAVING COUNT(DISTINCT thread_id) > 1) split",
    );
    return requireSingleRow(rows, "split message count").n;
  });
}

/** Every row and every thread of `tenantId`, to compare the state before and after a run. */
async function snapshot(
  tenantId: string,
): Promise<{ rows: Array<{ item_id: string; thread_id: string | null }>; threads: string[] }> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ item_id: string; thread_id: string | null }>(
      "SELECT item_id, thread_id FROM mail_message_meta ORDER BY item_id",
    );
    const { rows: threadRows } = await pool.query<{ id: string }>("SELECT id FROM mail_threads ORDER BY id");
    return { rows, threads: threadRows.map((row) => row.id) };
  });
}

function runBackfill(): Promise<void> {
  return runAsSystem("test", () => handleMailThreadBackfillTask(pool));
}

describe("mailThreadBackfill (issue #1570)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(admin);
    await runInTenant(tenantZero, () => seedSystem(pool));
    await runInTenant(tenantB, () => seedSystem(pool));
  });

  it("gives a sent message its replied-to message's thread, and a send with no ancestors a new thread named by its subject", async () => {
    const parentThread = await synced(tenantZero, {
      itemId: randomUUID(),
      mailboxItemId: MAILBOX_A,
      messageId: "<parent@x>",
    });
    // Sent before #1474 gave sends a thread: the row is stored with thread_id NULL.
    const replyItem = await emailItem(tenantZero, "Re: parent");
    await store(tenantZero, {
      itemId: replyItem,
      mailboxItemId: MAILBOX_A,
      messageId: "<reply@x>",
      inReplyTo: "<parent@x>",
      references: ["<parent@x>"],
    });
    const freshItem = await emailItem(tenantZero, "Fresh send");
    await store(tenantZero, { itemId: freshItem, mailboxItemId: MAILBOX_A, messageId: "<fresh@x>" });

    await runBackfill();

    expect(await threadOf(tenantZero, replyItem)).toBe(parentThread);
    const freshThread = await threadOf(tenantZero, freshItem);
    if (freshThread === null) throw new Error("the send with no ancestors was not threaded");
    expect(freshThread).not.toBe(parentThread);
    expect(await subjectHintOf(tenantZero, freshThread)).toBe("Fresh send");
    expect(await unthreadedRows(tenantZero)).toBe(0);
  });

  it("merges a child listed before its parent into the thread of the parent's ancestor", async () => {
    const grandparentThread = await synced(tenantZero, {
      itemId: randomUUID(),
      mailboxItemId: MAILBOX_A,
      messageId: "<grandparent@x>",
    });
    // The child has the lower item id, so the backfill threads it before its parent.
    const child = "00000000-0000-4000-8000-0000000000c1";
    const parent = "00000000-0000-4000-8000-0000000000c2";
    await store(tenantZero, {
      itemId: child,
      mailboxItemId: MAILBOX_A,
      messageId: "<child@x>",
      inReplyTo: "<parent@x>",
      references: ["<parent@x>"],
    });
    await store(tenantZero, {
      itemId: parent,
      mailboxItemId: MAILBOX_A,
      messageId: "<parent@x>",
      inReplyTo: "<grandparent@x>",
      references: ["<grandparent@x>"],
    });

    await runBackfill();

    expect(await threadOf(tenantZero, child)).toBe(grandparentThread);
    expect(await threadOf(tenantZero, parent)).toBe(grandparentThread);
    expect(await threadIds(tenantZero)).toEqual([grandparentThread]);
  });

  it("ends copies of one Message-ID in two mailboxes in one thread and leaves no empty mail_threads row", async () => {
    const copyA = randomUUID();
    const copyB = randomUUID();
    const threadA = await synced(tenantZero, { itemId: copyA, mailboxItemId: MAILBOX_A, messageId: "<copy@x>" });
    const threadB = await newThread(tenantZero);
    await store(tenantZero, { itemId: copyB, mailboxItemId: MAILBOX_B, messageId: "<copy@x>", threadId: threadB });
    expect(threadB).not.toBe(threadA);

    await runBackfill();

    const survivor = [threadA, threadB].sort()[0];
    expect(await threadOf(tenantZero, copyA)).toBe(survivor);
    expect(await threadOf(tenantZero, copyB)).toBe(survivor);
    expect(await threadIds(tenantZero)).toEqual([survivor]);
    expect(await orphanThreads(tenantZero)).toBe(0);
  });

  it("leaves a Message-ID alone when an earlier merge in the same run already joined its threads", async () => {
    const first = await newThread(tenantZero);
    const second = await newThread(tenantZero);
    // Both Message-IDs sit in the same two threads, so merging the first one also moves the second one's rows.
    const x1 = randomUUID();
    const x2 = randomUUID();
    const y1 = randomUUID();
    const y2 = randomUUID();
    await store(tenantZero, { itemId: x1, mailboxItemId: MAILBOX_A, messageId: "<x@x>", threadId: first });
    await store(tenantZero, { itemId: x2, mailboxItemId: MAILBOX_B, messageId: "<x@x>", threadId: second });
    await store(tenantZero, { itemId: y1, mailboxItemId: MAILBOX_A, messageId: "<y@x>", threadId: second });
    await store(tenantZero, { itemId: y2, mailboxItemId: MAILBOX_B, messageId: "<y@x>", threadId: first });

    await runBackfill();

    const survivor = [first, second].sort()[0];
    for (const item of [x1, x2, y1, y2]) expect(await threadOf(tenantZero, item)).toBe(survivor);
    expect(await threadIds(tenantZero)).toEqual([survivor]);
  });

  it("changes no row when it runs a second time", async () => {
    await synced(tenantZero, { itemId: randomUUID(), mailboxItemId: MAILBOX_A, messageId: "<parent2@x>" });
    await store(tenantZero, {
      itemId: randomUUID(),
      mailboxItemId: MAILBOX_A,
      messageId: "<unthreaded@x>",
      inReplyTo: "<parent2@x>",
      references: ["<parent2@x>"],
    });
    const splitA = randomUUID();
    await synced(tenantZero, { itemId: splitA, mailboxItemId: MAILBOX_A, messageId: "<split@x>" });
    await store(tenantZero, {
      itemId: randomUUID(),
      mailboxItemId: MAILBOX_B,
      messageId: "<split@x>",
      threadId: await newThread(tenantZero),
    });

    await runBackfill();
    const first = await snapshot(tenantZero);
    expect(await unthreadedRows(tenantZero)).toBe(0);
    expect(await orphanThreads(tenantZero)).toBe(0);

    await runBackfill();
    expect(await snapshot(tenantZero)).toEqual(first);
  });

  it("threads every row when they span more than one page", async () => {
    // Rows with no thread, as sends stored before #1474 left them; no production caller writes this state any more.
    await runInTenant(tenantZero, () =>
      withTransaction(pool, async (client) => {
        for (let index = 0; index < ROWS_PAST_ONE_PAGE; index += 1) {
          await writeMessage(client, {
            itemId: randomUUID(),
            mailboxItemId: MAILBOX_A,
            messageId: `<bulk-${index}@x>`,
          });
        }
      }),
    );

    await runBackfill();

    expect(await unthreadedRows(tenantZero)).toBe(0);
    expect(await threadIds(tenantZero)).toHaveLength(ROWS_PAST_ONE_PAGE);
  });

  it("merges split copies when they span more than one page", async () => {
    await runInTenant(tenantZero, () =>
      withTransaction(pool, async (client) => {
        for (let index = 0; index < ROWS_PAST_ONE_PAGE; index += 1) {
          const first = await createMailThread(client, "split");
          const second = await createMailThread(client, "split");
          await writeMessage(client, {
            itemId: randomUUID(),
            mailboxItemId: MAILBOX_A,
            messageId: `<split-${index}@x>`,
            threadId: first.id,
          });
          await writeMessage(client, {
            itemId: randomUUID(),
            mailboxItemId: MAILBOX_B,
            messageId: `<split-${index}@x>`,
            threadId: second.id,
          });
        }
      }),
    );

    await runBackfill();

    expect(await messageIdsInSeveralThreads(tenantZero)).toBe(0);
    expect(await threadIds(tenantZero)).toHaveLength(ROWS_PAST_ONE_PAGE);
    expect(await orphanThreads(tenantZero)).toBe(0);
  });

  it("merges the copies of one Message-ID inside each tenant and never into another tenant's thread", async () => {
    // Mailbox ids are per tenant: the (mailbox_item_id, message_id) arbiter is not tenant-scoped, so two tenants
    // sharing a mailbox id would collide on the same row.
    const seedSplit = async (tenantId: string): Promise<{ a: string; b: string; first: string; second: string }> => {
      const first = await newThread(tenantId);
      const second = await newThread(tenantId);
      const a = randomUUID();
      const b = randomUUID();
      await store(tenantId, { itemId: a, mailboxItemId: randomUUID(), messageId: "<shared@x>", threadId: first });
      await store(tenantId, { itemId: b, mailboxItemId: randomUUID(), messageId: "<shared@x>", threadId: second });
      return { a, b, first, second };
    };
    const zero = await seedSplit(tenantZero);
    const other = await seedSplit(tenantB);

    await runBackfill();

    const zeroThread = await threadOf(tenantZero, zero.a);
    expect(zeroThread).toBe([zero.first, zero.second].sort()[0]);
    expect(await threadOf(tenantZero, zero.b)).toBe(zeroThread);
    expect(await threadIds(tenantZero)).toEqual([zeroThread]);

    const otherThread = await threadOf(tenantB, other.a);
    expect(otherThread).toBe([other.first, other.second].sort()[0]);
    expect(await threadOf(tenantB, other.b)).toBe(otherThread);
    expect(await threadIds(tenantB)).toEqual([otherThread]);
  });

  it("still processes the other tenants when one tenant fails, and the job reports the failure", async () => {
    const failing = randomUUID();
    const healthy = randomUUID();
    await store(tenantZero, { itemId: failing, mailboxItemId: MAILBOX_A, messageId: "<injected-failure@x>" });
    await store(tenantB, { itemId: healthy, mailboxItemId: randomUUID(), messageId: "<healthy@x>" });

    await expect(runBackfill()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.objectContaining({ message: "injected failure for one tenant" })],
    });

    // The failing tenant's page was rolled back, so its row is still unthreaded; the other tenant was threaded.
    expect(await threadOf(tenantZero, failing)).toBeNull();
    expect(await threadOf(tenantB, healthy)).not.toBeNull();
  });
});
