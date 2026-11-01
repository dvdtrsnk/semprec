import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import * as Y from "yjs";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, getTenantZeroId } from "../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { CANVAS_ELEMENT_TYPES } from "../docs/canvas.js";
import { loadDoc, mutateDoc, mutateDocWithClient } from "../docs/docPersistence.js";
import { withTransaction } from "../db/pool.js";
import { HistoryNotRetainedError, NotFoundError, ValidationError } from "../errors.js";
import { setDocUpdateHook } from "../realtimeHook.js";

const HOUR_MS = 60 * 60 * 1000;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Captures the backend on the very client that issues the matched production statement. */
function observeStatementPid(runtime: Pool, statement: RegExp) {
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  const wrapped = new Map<PoolClient, PoolClient["query"]>();
  let captured = false;
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    wrapped.set(client, client.query);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        if (captured || typeof args[0] !== "string" || !statement.test(args[0])) {
          return Reflect.apply(target, receiver, args);
        }
        captured = true;
        return (async () => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const actual = result.rows[0]?.pid;
          if (actual === undefined) throw new Error("missing competing backend pid");
          resolvePid(actual);
          return Reflect.apply(target, receiver, args);
        })();
      },
    });
  };
  runtime.on("acquire", instrument);
  return {
    pid,
    restore() {
      runtime.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    },
  };
}

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;

/**
 * A page of one database whose history starts three hours before the database's own clock. Every
 * instant the tests use is relative to `now`, so each write's `created_at` is set by the test and
 * never by the wall clock: an edit is dated when the test says it happened.
 */
interface Page {
  databaseId: string;
  itemId: string;
  docId: string;
  now: Date;
  /** The instant `hoursFromNow` hours away from the database clock at setup. */
  at(hoursFromNow: number): Date;
}

async function databaseNow(): Promise<Date> {
  const { rows } = await pool.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
  return rows[0]!.now;
}

/** Moves the doc's availability and its initial baseline checkpoint back to `at`. */
async function backdateBaseline(docId: string, at: Date): Promise<void> {
  const docs = await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [docId, at]);
  const baseline = await pool.query(
    `UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0`,
    [docId, at],
  );
  expect(docs.rowCount).toBe(1);
  expect(baseline.rowCount).toBe(1);
}

async function newPage(): Promise<Page> {
  const now = await databaseNow();
  const db = await chokePoint.createDatabase({ name: "Pages" });
  const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
  const doc = await docStore.getOrCreateDoc(item.id, "page");
  await backdateBaseline(doc.id, new Date(now.getTime() - 3 * HOUR_MS));
  return {
    databaseId: db.id,
    itemId: item.id,
    docId: doc.id,
    now,
    at: (hoursFromNow) => new Date(now.getTime() + hoursFromNow * HOUR_MS),
  };
}

/** Runs `write` and dates the update rows it appended to `at`, so the history reads as if the write happened then. */
async function datedWrite(docId: string, at: Date, write: () => Promise<void>): Promise<void> {
  const { rows } = await pool.query<{ max: string | null }>(
    `SELECT max(update_id)::text AS max FROM doc_history_updates WHERE doc_id = $1`,
    [docId],
  );
  const before = rows[0]?.max ?? "0";
  await write();
  await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1 AND id > $3`, [docId, at, before]);
  await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1 AND update_id > $3`, [
    docId,
    at,
    before,
  ]);
}

/** The user's first state: blocks `b1` and `b2`, written two hours before `now`. */
async function pageWithUserBlocks(): Promise<Page> {
  const page = await newPage();
  await datedWrite(page.docId, page.at(-2), async () => {
    await docStore.putBlock(page.itemId, { id: "b1", flavour: "paragraph", fields: { content: "first" } }, "user");
    await docStore.putBlock(page.itemId, { id: "b2", flavour: "paragraph", fields: { content: "second" } }, "user");
  });
  return page;
}

/** The agent's edit an hour before `now`: `b1` changed, `b3` added, `b2` removed. */
async function agentEdit(page: Page): Promise<void> {
  await datedWrite(page.docId, page.at(-1), async () => {
    await docStore.putBlock(
      page.itemId,
      { id: "b1", flavour: "paragraph", fields: { content: "agent edit" } },
      "ai_agent",
    );
    await docStore.putBlock(
      page.itemId,
      { id: "b3", flavour: "paragraph", fields: { content: "agent added" } },
      "ai_agent",
    );
    await docStore.deleteBlock(page.itemId, "b2", "ai_agent");
  });
}

/** Block id to its `content`, the only field these tests compare. */
async function blockContents(itemId: string): Promise<Record<string, unknown>> {
  const blocks = await docStore.listBlocks(itemId);
  return Object.fromEntries(blocks.map((block) => [String(block["sys:id"]), block.content]));
}

async function updateCount(docId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM doc_updates WHERE doc_id = $1`, [
    docId,
  ]);
  return Number(rows[0]!.count);
}

async function historyCount(docId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM doc_history_updates WHERE doc_id = $1`,
    [docId],
  );
  return Number(rows[0]!.count);
}

async function lastUpdateAuthor(docId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT created_by FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
    [docId],
  );
  return rows[0]?.created_by;
}

describe("page.restoreVersion (issue #1617): restoring a page to an earlier version", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    setDocUpdateHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns the page to its blocks at the instant, re-creating removed ones and resetting changed ones", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);
    expect(await blockContents(page.itemId)).toEqual({ b1: "agent edit", b3: "agent added" });
    const updatesBefore = await updateCount(page.docId);
    const historyBefore = await historyCount(page.docId);

    const restored = await docStore.restoreVersion(page.itemId, page.at(-1.5));

    expect(await blockContents(page.itemId)).toEqual({ b1: "first", b2: "second" });
    expect(restored).toEqual({ itemId: page.itemId, at: page.at(-1.5).toISOString(), blockIds: ["b1", "b2"] });
    // The restore is one new update, authored by the user; the agent's rows stay in the history.
    expect(await updateCount(page.docId)).toBe(updatesBefore + 1);
    expect(await historyCount(page.docId)).toBe(historyBefore + 1);
    expect(await lastUpdateAuthor(page.docId)).toBe("user");
    const { rows } = await pool.query<{ last_edited_by: string }>(`SELECT last_edited_by FROM docs WHERE id = $1`, [
      page.docId,
    ]);
    expect(rows[0]!.last_edited_by).toBe("user");
  });

  it("is itself restorable: a second restore to an instant before the first returns the agent's state", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);

    await docStore.restoreVersion(page.itemId, page.at(-1.5));
    expect(await blockContents(page.itemId)).toEqual({ b1: "first", b2: "second" });

    await docStore.restoreVersion(page.itemId, page.at(-0.5));
    expect(await blockContents(page.itemId)).toEqual({ b1: "agent edit", b3: "agent added" });
  });

  it("changes nothing when restored to the current time", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);
    const contentsBefore = await blockContents(page.itemId);
    const updatesBefore = await updateCount(page.docId);
    const historyBefore = await historyCount(page.docId);

    const restored = await docStore.restoreVersion(page.itemId, await databaseNow());

    expect(await blockContents(page.itemId)).toEqual(contentsBefore);
    expect(restored.blockIds).toEqual(["b1", "b3"]);
    expect(await updateCount(page.docId)).toBe(updatesBefore);
    expect(await historyCount(page.docId)).toBe(historyBefore);
  });

  it("keeps a block another client added from a state the restore did not see", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);

    // Another client's replica, taken before the restore, adds block `b5` and nothing else.
    const replica = new Y.Doc();
    replica.gc = false;
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(await loadDoc(pool, page.docId)));
    const seen = Y.encodeStateVector(replica);
    const b5 = new Y.Map<unknown>();
    replica.getMap<Y.Map<unknown>>("blocks").set("b5", b5);
    b5.set("sys:id", "b5");
    b5.set("sys:flavour", "paragraph");
    b5.set("content", "from another client");
    const clientUpdate = Y.encodeStateAsUpdate(replica, seen);

    await docStore.restoreVersion(page.itemId, page.at(-1.5));
    await mutateDoc(pool, page.docId, "user", (doc) => Y.applyUpdate(doc, clientUpdate));

    expect(await blockContents(page.itemId)).toEqual({ b1: "first", b2: "second", b5: "from another client" });
  });

  it("waits for an in-flight document mutation before computing the restore", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);
    let releaseWriter!: () => void;
    let writerReady!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const ready = new Promise<number>((resolve) => {
      writerReady = resolve;
    });
    const writer = withTransaction(pool, async (client) => {
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("missing writer pid");
      await mutateDocWithClient(client, page.docId, "user", (doc) => {
        const block = new Y.Map<unknown>();
        doc.getMap<Y.Map<unknown>>("blocks").set("overlap", block);
        block.set("sys:id", "overlap");
        block.set("sys:flavour", "paragraph");
        block.set("content", "in-flight");
      });
      writerReady(pid);
      await release;
    });
    const writerSettled = Promise.allSettled([writer]);
    let restore: Promise<unknown> | undefined;
    let restoreSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let competing: ReturnType<typeof observeStatementPid> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pid = await Promise.race([
        ready,
        writer.then(() => {
          throw new Error("writer finished before the barrier");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("writer barrier timed out")), 5_000);
        }),
      ]);
      competing = observeStatementPid(pool, /FROM doc_snapshots\b[\s\S]*FOR UPDATE/i);
      restore = docStore.restoreVersion(page.itemId, page.at(-1.5));
      restoreSettled = Promise.allSettled([restore]);
      const restorePid = await bounded(competing.pid);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [pid, restorePid],
        );
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      releaseWriter();
      if (timer) clearTimeout(timer);
      await writerSettled;
      if (restoreSettled !== undefined) await restoreSettled;
      competing?.restore();
    }
    const settled = [...(await writerSettled), ...(restoreSettled !== undefined ? await restoreSettled : [])];
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    expect(await blockContents(page.itemId)).toEqual({ b1: "first", b2: "second" });
  });

  it("holds the live item while restore waits for the document, so deletion follows restore", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);
    const restorePool = await createRuntimeRolePool(pool, "semprec_data");
    const deletePool = await createRuntimeRolePool(pool, "semprec_data");
    const restoring = observeStatementPid(restorePool, /FROM doc_snapshots\b[\s\S]*FOR UPDATE/i);
    const deleting = observeStatementPid(deletePool, /FROM items\b[\s\S]*FOR UPDATE/i);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = withTransaction(pool, async (client) => {
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("missing document holder pid");
      await client.query("SELECT doc_id FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE", [page.docId]);
      ready(pid);
      await hold;
    });
    const holderSettled = Promise.allSettled([holder]);
    let restore: ReturnType<DocStore["restoreVersion"]> | undefined;
    let deletion: ReturnType<ChokePoint["softDeleteItem"]> | undefined;
    let restoreSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let deletionSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const ownerPid = await bounded(
        Promise.race([
          acquired,
          holder.then(() => {
            throw new Error("document holder ended before barrier");
          }),
        ]),
      );
      restore = runInTenant(getTenantZeroId(), () =>
        createDocStore(restorePool).restoreVersion(page.itemId, page.at(-1.5)),
      );
      restoreSettled = Promise.allSettled([restore]);
      const restorePid = await bounded(restoring.pid);
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                ownerPid,
                restorePid,
              ])
            ).rows[0]?.blocked,
          { timeout: 5000 },
        )
        .toBe(true);
      deletion = runInTenant(getTenantZeroId(), () =>
        createChokePoint(deletePool).softDeleteItem(page.databaseId, page.itemId),
      );
      deletionSettled = Promise.allSettled([deletion]);
      const deletePid = await bounded(deleting.pid);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked =
          (
            await pool.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
              restorePid,
              deletePid,
            ])
          ).rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      release();
      expect((await restore).blockIds).toEqual(["b1", "b2"]);
      expect((await deletion)?.deletedAt).toBeTruthy();
    } finally {
      release();
      await holderSettled;
      if (restoreSettled) await restoreSettled;
      if (deletionSettled) await deletionSettled;
      restoring.restore();
      deleting.restore();
      await Promise.all([restorePool.end(), deletePool.end()]);
    }
  }, 15000);

  it("refuses restore without appending when deletion commits first", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);
    const before = await updateCount(page.docId);
    const deletingPool = await createRuntimeRolePool(pool, "semprec_data");
    const restoringPool = await createRuntimeRolePool(pool, "semprec_data");
    const competing = observeStatementPid(restoringPool, /FROM items\b[\s\S]*FOR UPDATE/i);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const deletion = runInTenant(getTenantZeroId(), () =>
      withTransaction(deletingPool, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("missing deletion pid");
        expect(
          await itemDeleteWithClient(client, page.databaseId, page.itemId, {
            queueAffinity: createActionQueueAffinity(),
          }),
        ).not.toBeNull();
        ready(pid);
        await hold;
      }),
    );
    const deletionSettled = Promise.allSettled([deletion]);
    let restore: ReturnType<DocStore["restoreVersion"]> | undefined;
    let restoreSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pid = await bounded(
        Promise.race([
          acquired,
          deletion.then(() => {
            throw new Error("deletion ended before barrier");
          }),
        ]),
      );
      restore = runInTenant(getTenantZeroId(), () =>
        createDocStore(restoringPool).restoreVersion(page.itemId, page.at(-1.5)),
      );
      restoreSettled = Promise.allSettled([restore]);
      const restorePid = await bounded(competing.pid);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked =
          (
            await pool.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
              pid,
              restorePid,
            ])
          ).rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      release();
      await deletion;
      expect((await restoreSettled)[0]).toMatchObject({ status: "rejected", reason: expect.any(NotFoundError) });
      expect(await updateCount(page.docId)).toBe(before);
    } finally {
      release();
      await deletionSettled;
      if (restoreSettled) await restoreSettled;
      competing.restore();
      await Promise.all([deletingPool.end(), restoringPool.end()]);
    }
  }, 15000);

  it("refuses an instant outside the retention window with 410 and a future instant with 400, writing nothing", async () => {
    const page = await pageWithUserBlocks();
    await agentEdit(page);
    const updatesBefore = await updateCount(page.docId);
    const historyBefore = await historyCount(page.docId);

    await expect(docStore.restoreVersion(page.itemId, page.at(-31 * 24))).rejects.toBeInstanceOf(
      HistoryNotRetainedError,
    );
    await expect(docStore.restoreVersion(page.itemId, page.at(24))).rejects.toBeInstanceOf(ValidationError);

    expect(await blockContents(page.itemId)).toEqual({ b1: "agent edit", b3: "agent added" });
    expect(await updateCount(page.docId)).toBe(updatesBefore);
    expect(await historyCount(page.docId)).toBe(historyBefore);
  });

  it("answers an unknown item, an item without a page, a canvas and a trashed page with not found", async () => {
    const page = await pageWithUserBlocks();
    const at = page.at(-1.5);
    const withoutDoc = await chokePoint.createItem({ databaseId: page.databaseId, properties: {} });
    const canvasItem = await chokePoint.createItem({ databaseId: page.databaseId, properties: {} });
    await docStore.putCanvasElement(
      canvasItem.id,
      { id: "c1", type: CANVAS_ELEMENT_TYPES[0], xywh: [0, 0, 1, 1], index: "a0" },
      "user",
    );

    await expect(docStore.restoreVersion(randomUUID(), at)).rejects.toBeInstanceOf(NotFoundError);
    await expect(docStore.restoreVersion(withoutDoc.id, at)).rejects.toBeInstanceOf(NotFoundError);
    await expect(docStore.restoreVersion(canvasItem.id, at)).rejects.toBeInstanceOf(NotFoundError);

    await chokePoint.softDeleteItem(page.databaseId, page.itemId);
    await expect(docStore.restoreVersion(page.itemId, at)).rejects.toBeInstanceOf(NotFoundError);
  });
});
