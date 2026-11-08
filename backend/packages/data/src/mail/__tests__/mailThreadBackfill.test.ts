import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { requireSingleRow, withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { EMAIL_INGEST_ALLOWED_SYSTEM_KEYS } from "../ingest.js";
import { createMailThread, resolveMergedThreadId, upsertMailMessageMeta } from "../mailMessageMetaStore.js";
import { handleMailThreadBackfillTask } from "../mailThreadBackfillJob.js";
import { resolveThreadId } from "../threading.js";
import { lockMailThreadMutation } from "../mailThreadMutationGuard.js";

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

// Most paging and coordination cases below use synthetic metadata identifiers to isolate the
// algorithm; they are not historical deployed rows. The real-item test covers the supported legacy shape.
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
async function writeMessage(client: PoolClient, message: StoredMessage): Promise<void> {
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

function runBackfill(operationPool: Pool = pool): Promise<void> {
  return runAsSystem("test", () => handleMailThreadBackfillTask(operationPool));
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

  it("rejects missing, system, nontransactional, mismatched tenant, and non-READ COMMITTED scopes", async () => {
    const client = await runInTenant(tenantZero, () => pool.connect());
    try {
      await expect(lockMailThreadMutation(client)).rejects.toMatchObject({ name: "TenantScopeMissingError" });
      await expect(runAsSystem("test", () => lockMailThreadMutation(client))).rejects.toMatchObject({
        name: "TenantScopeMissingError",
      });
      await expect(runInTenant(tenantZero, () => lockMailThreadMutation(client))).rejects.toThrow(
        "Mail thread mutation requires a READ COMMITTED tenant transaction",
      );
      await client.query("BEGIN");
      await expect(runInTenant(tenantB, () => lockMailThreadMutation(client))).rejects.toThrow(
        "Mail thread mutation requires a READ COMMITTED tenant transaction",
      );
      await client.query("ROLLBACK");
      for (const isolation of ["repeatable_read", "serializable"] as const) {
        await expect(
          runInTenant(tenantZero, () => withTransaction(pool, lockMailThreadMutation, { isolation })),
        ).rejects.toThrow("Mail thread mutation requires a READ COMMITTED tenant transaction");
      }
      await expect(
        runInTenant(tenantZero, () => withTransaction(pool, lockMailThreadMutation)),
      ).resolves.toBeUndefined();
    } finally {
      if (client.getTransactionStatus() === "T" || client.getTransactionStatus() === "E")
        await client.query("ROLLBACK");
      client.release();
    }
  });

  it("releases the tenant guard on rollback while another tenant proceeds", async () => {
    const operationPool = await createRuntimeRolePool(admin, "semprec_data");
    const operationPids: Array<Promise<number>> = [];
    operationPool.on("acquire", (client: PoolClient) => {
      operationPids.push(
        client
          .query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          .then(({ rows }) => requireSingleRow(rows, "participant pid").pid),
      );
    });
    let release: () => void = () => undefined;
    let reportHolder: (pid: number) => void = () => undefined;
    let reportWaiter: (pid: number) => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holderStarted = new Promise<number>((resolve) => {
      reportHolder = resolve;
    });
    const waiterStarted = new Promise<number>((resolve) => {
      reportWaiter = resolve;
    });
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Guard overlap timed out")), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const holder = runInTenant(tenantZero, () =>
      withTransaction(operationPool, async (client) => {
        await lockMailThreadMutation(client);
        const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        reportHolder(requireSingleRow(result.rows, "holder pid").pid);
        await gate;
        throw new Error("forced rollback");
      }),
    ).then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    let waiter: Promise<void> | undefined;
    let otherTenant: Promise<void> | undefined;
    try {
      const holderPid = await bounded(holderStarted);
      waiter = runInTenant(tenantZero, () =>
        withTransaction(operationPool, async (client) => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          reportWaiter(requireSingleRow(result.rows, "waiter pid").pid);
          await lockMailThreadMutation(client);
        }),
      );
      const waiterSettled = waiter.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      const waiterPid = await bounded(waiterStarted);
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await admin.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [holderPid, waiterPid],
        );
        if (result.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      otherTenant = runInTenant(tenantB, () => withTransaction(operationPool, lockMailThreadMutation));
      await bounded(otherTenant);
      console.info("MAIL_GUARD_ROLLBACK", { holderPid, waiterPid });
      release();
      expect(await bounded(holder)).toMatchObject({
        ok: false,
        error: expect.objectContaining({ message: "forced rollback" }),
      });
      expect(await bounded(waiterSettled)).toEqual({ ok: true });
    } finally {
      release();
      const operations = Promise.allSettled([
        holder,
        ...(waiter ? [waiter] : []),
        ...(otherTenant ? [otherTenant] : []),
      ]);
      try {
        await bounded(operations).catch(async (error: unknown) => {
          const pids = await bounded(Promise.all(operationPids));
          for (const pid of new Set(pids)) await bounded(admin.query("SELECT pg_terminate_backend($1)", [pid]));
          await bounded(operations);
          throw error;
        });
      } finally {
        await bounded(operationPool.end());
      }
    }
  }, 30000);

  it.each(["backfill-first", "bridge-first"] as const)(
    "serializes a multi-thread bridge with backfill in %s order",
    async (order) => {
      const first = await newThread(tenantZero);
      const second = await newThread(tenantZero);
      const third = await newThread(tenantZero);
      // Historical split copies are the input the backfill was created to repair.
      await store(tenantZero, {
        itemId: randomUUID(),
        mailboxItemId: MAILBOX_A,
        messageId: "<split@x>",
        threadId: first,
      });
      await store(tenantZero, {
        itemId: randomUUID(),
        mailboxItemId: MAILBOX_B,
        messageId: "<split@x>",
        threadId: second,
      });
      await store(tenantZero, {
        itemId: randomUUID(),
        mailboxItemId: MAILBOX_A,
        messageId: "<other@x>",
        threadId: third,
      });
      const control = await admin.connect();
      await control.query("SET statement_timeout = '3s'");
      await control.query("SET lock_timeout = '2s'");
      const backfillPool = await createRuntimeRolePool(admin, "semprec_data");
      const bridgePool = await createRuntimeRolePool(admin, "semprec_data");
      const backfillPids: Array<Promise<number>> = [];
      const bridgePids: Array<Promise<number>> = [];
      const recordPid = (client: PoolClient, pids: Array<Promise<number>>) => {
        pids.push(
          client
            .query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            .then(({ rows }) => requireSingleRow(rows, "participant pid").pid),
        );
      };
      backfillPool.on("acquire", (client: PoolClient) => recordPid(client, backfillPids));
      bridgePool.on("acquire", (client: PoolClient) => recordPid(client, bridgePids));
      const controlPid = requireSingleRow(
        (await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows,
        "control pid",
      ).pid;
      let backfill: Promise<void> | undefined;
      let bridge: Promise<void> | undefined;
      const waitBlocked = async (holder: number, query: string, pids: Array<Promise<number>>): Promise<number> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const result = await admin.query<{ pid: number; blockers: number[]; query: string }>(
            "SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
          );
          const owned = await bounded(Promise.all(pids));
          const match = result.rows.find(
            (row) => owned.includes(row.pid) && row.blockers.includes(holder) && row.query.includes(query),
          );
          if (match) return match.pid;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`No backend blocked by ${holder} at ${query}`);
      };
      async function bounded<T>(promise: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Bridge overlap timed out")), 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      try {
        await control.query("SELECT pg_advisory_lock(712340003)");
        await admin.query(
          "CREATE FUNCTION test_mail_bridge_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(712340003); RETURN NEW; END $$",
        );
        await admin.query(
          "CREATE TRIGGER test_mail_bridge_gate BEFORE UPDATE OF thread_id ON mail_message_meta FOR EACH ROW WHEN (OLD.thread_id IS DISTINCT FROM NEW.thread_id) EXECUTE FUNCTION test_mail_bridge_gate()",
        );
        const startBridge = () =>
          runInTenant(tenantZero, () =>
            withTransaction(bridgePool, async (client) => {
              const threadId = await resolveThreadId(client, {
                messageId: "<bridge@x>",
                references: ["<split@x>", "<other@x>"],
              });
              await writeMessage(client, {
                itemId: randomUUID(),
                mailboxItemId: MAILBOX_A,
                messageId: "<bridge@x>",
                references: ["<split@x>", "<other@x>"],
                threadId,
              });
            }),
          );
        let holderPid: number;
        let waiterPid: number;
        if (order === "backfill-first") {
          backfill = runBackfill(backfillPool);
          const observed = backfill.then(
            () => null,
            (error: unknown) => error,
          );
          holderPid = await waitBlocked(controlPid, "UPDATE mail_message_meta", backfillPids);
          bridge = startBridge();
          const bridgeObserved = bridge.then(
            () => null,
            (error: unknown) => error,
          );
          waiterPid = await waitBlocked(holderPid, "pg_advisory_xact_lock", bridgePids);
          await control.query("SELECT pg_advisory_unlock(712340003)");
          expect(await bounded(observed)).toBeNull();
          expect(await bounded(bridgeObserved)).toBeNull();
        } else {
          bridge = startBridge();
          const observed = bridge.then(
            () => null,
            (error: unknown) => error,
          );
          holderPid = await waitBlocked(controlPid, "UPDATE mail_message_meta", bridgePids);
          backfill = runBackfill(backfillPool);
          const backfillObserved = backfill.then(
            () => null,
            (error: unknown) => error,
          );
          waiterPid = await waitBlocked(holderPid, "pg_advisory_xact_lock", backfillPids);
          await control.query("SELECT pg_advisory_unlock(712340003)");
          expect(await bounded(observed)).toBeNull();
          expect(await bounded(backfillObserved)).toBeNull();
        }
        expect(holderPid).not.toBe(waiterPid);
        console.info("MAIL_GUARD_BRIDGE", { order, holderPid, waiterPid });
        const remaining = await threadIds(tenantZero);
        expect(remaining).toHaveLength(1);
        for (const id of [first, second, third]) {
          expect(
            await runInTenant(tenantZero, () => withTransaction(pool, (client) => resolveMergedThreadId(client, id))),
          ).toBe(remaining[0]);
        }
        expect(await orphanThreads(tenantZero)).toBe(0);
      } finally {
        const operations = Promise.allSettled([...(backfill ? [backfill] : []), ...(bridge ? [bridge] : [])]);
        try {
          await bounded(control.query("SELECT pg_advisory_unlock_all()"));
          await bounded(operations).catch(async (error: unknown) => {
            const pids = await bounded(Promise.all([...backfillPids, ...bridgePids]));
            for (const pid of new Set(pids)) await bounded(control.query("SELECT pg_terminate_backend($1)", [pid]));
            await bounded(operations);
            throw error;
          });
        } finally {
          try {
            await bounded(control.query("DROP TRIGGER IF EXISTS test_mail_bridge_gate ON mail_message_meta"));
            await bounded(control.query("DROP FUNCTION IF EXISTS test_mail_bridge_gate()"));
          } finally {
            control.release(true);
            await bounded(Promise.all([backfillPool.end(), bridgePool.end()]));
          }
        }
      }
    },
    30000,
  );

  it("repairs historical unthreaded sends and split copies backed by actual mailbox and Email items", async () => {
    const fixture = await runInTenant(tenantZero, () =>
      withTransaction(pool, async (client) => {
        const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
        const emails = await getDatabaseByModuleId(client, "emails");
        if (!mailboxes || !emails) throw new Error("Mail databases were not seeded");
        const mailboxA = await createItemWithClient(client, {
          databaseId: mailboxes.id,
          properties: { name: "A", provider: "generic" },
        });
        const mailboxB = await createItemWithClient(client, {
          databaseId: mailboxes.id,
          properties: { name: "B", provider: "generic" },
        });
        const createEmail = (name: string) =>
          createItemWithClient(
            client,
            { databaseId: emails.id, properties: { name } },
            { allowedSystemKeys: EMAIL_INGEST_ALLOWED_SYSTEM_KEYS },
          );
        const parent = await createEmail("Parent");
        const reply = await createEmail("Reply");
        const copyA = await createEmail("Copy A");
        const copyB = await createEmail("Copy B");
        const parentThread = await createMailThread(client);
        const firstThread = await createMailThread(client);
        const secondThread = await createMailThread(client);
        await writeMessage(client, {
          itemId: parent.id,
          mailboxItemId: mailboxA.id,
          messageId: "<real-parent@x>",
          threadId: parentThread.id,
        });
        // Before the send-threading fix, sent Email items had a null thread_id.
        await writeMessage(client, {
          itemId: reply.id,
          mailboxItemId: mailboxA.id,
          messageId: "<real-reply@x>",
          inReplyTo: "<real-parent@x>",
        });
        // Before cross-mailbox deduplication, independently ingested copies could have distinct threads.
        await writeMessage(client, {
          itemId: copyA.id,
          mailboxItemId: mailboxA.id,
          messageId: "<real-copy@x>",
          threadId: firstThread.id,
        });
        await writeMessage(client, {
          itemId: copyB.id,
          mailboxItemId: mailboxB.id,
          messageId: "<real-copy@x>",
          threadId: secondThread.id,
        });
        return { parentThread, reply, copyA, copyB, firstThread, secondThread };
      }),
    );
    await runBackfill();
    expect(await threadOf(tenantZero, fixture.reply.id)).toBe(fixture.parentThread.id);
    const survivor = [fixture.firstThread.id, fixture.secondThread.id].sort()[0];
    expect(await threadOf(tenantZero, fixture.copyA.id)).toBe(survivor);
    expect(await threadOf(tenantZero, fixture.copyB.id)).toBe(survivor);
    expect(await orphanThreads(tenantZero)).toBe(0);
    const first = await snapshot(tenantZero);
    await runBackfill();
    expect(await snapshot(tenantZero)).toEqual(first);
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
