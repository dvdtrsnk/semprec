import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDocStore, putBlockWithClient, type DocStore } from "../docs/docStore.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { ConflictError, HistoryNotRetainedError, NotFoundError, ValidationError } from "../errors.js";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  handleDocCompactionSweepTask,
  loadDoc,
  mutateDoc,
  runCompactionSweep,
} from "../docs/docPersistence.js";
import {
  cleanupExpiredDocHistory,
  rebaselineDocHistory,
  runDocHistoryRetentionSweep,
  openDocVersionAt,
} from "../docs/docHistory.js";
import { getBlock as readBlock, listBlocks as readBlocks } from "../docs/blocks.js";
import { setDocUpdateHook, type DocUpdateEvent } from "../realtimeHook.js";
import { getBlocksMap, readPageBlocks, writeBlock } from "@semprec/block-model";
import { docEtag, readPageMarkdown } from "../docs/pageMarkdown.js";

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;

// `SET TIME ZONE` is session-scoped, not transaction-scoped — issuing it via pool.query()
// would leak the UTC setting onto whichever pooled connection served that query, for
// whichever later, unrelated test next borrows it. Pinning to a dedicated client and
// resetting before release keeps this test's determinism fix from leaking state.
async function withUtcReferenceTime(pool: Pool): Promise<Date> {
  const client = await pool.connect();
  try {
    await client.query(`SET TIME ZONE 'UTC'`);
    const { rows } = await client.query<{ reference: Date }>(`SELECT transaction_timestamp() AS reference`);
    return rows[0]!.reference;
  } finally {
    await client.query(`RESET TIME ZONE`);
    client.release();
  }
}

/**
 * The same live cutoff formula openDocVersionAt/rebaselineDocHistory compute internally,
 * read fresh at call time. A fixed buffer added to a timestamp captured earlier in a test
 * can't outrun this: the retention window keeps sliding forward with the wall clock, so on a
 * loaded CI host enough time can pass between two calls to make an "of course it's still
 * retained" timestamp fall behind the live cutoff by the second call. Computing this
 * immediately before the call it guards gives an exact, non-flaky lower bound instead.
 */
async function currentRetentionCutoff(pool: Pool, retentionDays: number): Promise<Date> {
  const { rows } = await pool.query<{ cutoff: Date }>(
    `SELECT transaction_timestamp() - make_interval(hours => $1::int) AS cutoff`,
    [retentionDays * 24],
  );
  return rows[0]!.cutoff;
}

describe("docs (CRDT layer)", () => {
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

  async function makeItem() {
    const db = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    return item;
  }

  describe("explicit page ensure", () => {
    it("waits for a concurrent trash and refuses both absent and existing documents", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runAsSystem("check page reservation role", () =>
          runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          ),
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tenant = await createTestTenant(pool);
        await runInTenant(tenant, async () => {
          const cp = createChokePoint(runtime);
          const store = createDocStore(runtime);
          const db = await cp.createDatabase({ name: "Page reservation" });
          for (const existing of [false, true]) {
            const item = await cp.createItem({ databaseId: db.id, properties: {} });
            if (existing) await store.ensurePage(item.id);
            const before = await runtime.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [item.id]);
            let ready!: (pid: number) => void;
            let release!: () => void;
            const started = new Promise<number>((resolve) => {
              ready = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            const trash = withTransaction(runtime, async (client) => {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (pid === undefined) throw new Error("Missing trash PID");
              await itemDeleteWithClient(client, db.id, item.id, { queueAffinity: createActionQueueAffinity() });
              ready(pid);
              await gate;
            });
            const trashSettled = Promise.allSettled([trash]);
            let ensureSettled: Promise<PromiseSettledResult<{ docId: string }>[]> | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const pid = await Promise.race([
                started,
                trash.then(() => {
                  throw new Error("Trash finished before barrier");
                }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("Trash barrier timed out")), 5_000);
                }),
              ]);
              const ensuring = store.ensurePage(item.id);
              ensureSettled = Promise.allSettled([ensuring]);
              let blocked = false;
              for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
                const waiting = await pool.query<{ present: boolean }>(
                  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM items%FOR UPDATE%') AS present",
                  [pid],
                );
                blocked = waiting.rows[0]?.present === true;
                if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
              }
              expect(blocked).toBe(true);
            } finally {
              release();
              if (timer) clearTimeout(timer);
              await trashSettled;
              if (ensureSettled !== undefined) await ensureSettled;
            }
            const [deleted] = await trashSettled;
            if (deleted?.status === "rejected") throw deleted.reason;
            const [ensured] = ensureSettled !== undefined ? await ensureSettled : [];
            expect(ensured).toMatchObject({ status: "rejected", reason: { status: 404 } });
            expect((await runtime.query("SELECT id FROM docs WHERE item_id = $1", [item.id])).rows).toEqual(
              before.rows,
            );
          }
        });
      } finally {
        await runtime.end();
      }
    });

    it("converges concurrent creates, reuses the row and refuses trashed or wrong-kind items", async () => {
      const item = await makeItem();
      const [first, second] = await Promise.all([docStore.ensurePage(item.id), docStore.ensurePage(item.id)]);
      expect(second).toEqual(first);
      expect(await docStore.ensurePage(item.id)).toEqual(first);
      const stored = await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [item.id]);
      expect(stored.rows).toEqual([{ id: first.docId }]);
      await chokePoint.softDeleteItem(item.databaseId, item.id);
      await expect(docStore.ensurePage(item.id)).rejects.toMatchObject({ status: 404 });
      const canvas = await makeItem();
      await docStore.getOrCreateDoc(canvas.id, "canvas");
      await expect(docStore.ensurePage(canvas.id)).rejects.toMatchObject({ status: 409 });
      expect((await pool.query("SELECT id FROM docs WHERE item_id = $1", [canvas.id])).rows).toHaveLength(1);
    });
  });

  describe("lazy creation", () => {
    it("an item has no doc until the first content-write", async () => {
      const item = await makeItem();
      expect(await docStore.getDoc(item.id)).toBeNull();
      expect(await docStore.listBlocks(item.id)).toEqual([]);
    });

    it("putBlock creates the docs row (+ empty snapshot) on first write, idempotently on repeat writes", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph", fields: { text: "hello" } }, "user");

      const doc = await docStore.getDoc(item.id);
      expect(doc).not.toBeNull();
      expect(doc?.kind).toBe("page");
      expect(doc?.itemId).toBe(item.id);

      await docStore.putBlock(item.id, { id: "b2", flavour: "paragraph" }, "user");
      const again = await docStore.getDoc(item.id);
      expect(again?.id).toBe(doc?.id); // same doc, not a second one
    });

    it("an item can carry at most one doc — creating a doc of a different kind conflicts", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      await expect(
        docStore.putCanvasElement(item.id, { id: "e1", type: "shape", xywh: [0, 0, 10, 10], index: "a0" }, "user"),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("getOrCreateDoc requires a live item (issue #669)", () => {
    it("rejects a random uuid with NotFoundError and creates no docs row", async () => {
      const itemId = "00000000-0000-0000-0000-000000000000";
      await expect(withTransaction(pool, (client) => getOrCreateDoc(client, itemId, "page"))).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const { rows } = await pool.query(`SELECT id FROM docs WHERE item_id = $1`, [itemId]);
      expect(rows).toHaveLength(0);
    });

    it("rejects a soft-deleted item with NotFoundError and creates no docs row", async () => {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, item.id);

      await expect(withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"))).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const { rows } = await pool.query(`SELECT id FROM docs WHERE item_id = $1`, [item.id]);
      expect(rows).toHaveLength(0);
    });

    it("creates the doc for a live item", async () => {
      const item = await makeItem();
      const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
      expect(doc.itemId).toBe(item.id);

      const { rows } = await pool.query(`SELECT id FROM docs WHERE item_id = $1`, [item.id]);
      expect(rows).toHaveLength(1);
    });

    it("still returns an existing doc of a trashed item, so restore keeps working", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const existingDoc = await docStore.getDoc(item.id);
      if (!existingDoc) throw new Error("doc not created");

      const db = await pool.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [item.id]);
      await chokePoint.softDeleteItem(db.rows[0]!.database_id, item.id);

      const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
      expect(doc.id).toBe(existingDoc.id);
    });
  });

  describe("blocks", () => {
    it("putBlock/getBlock/listBlocks/deleteBlock round-trip sys:id, sys:flavour, sys:children, and custom fields", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "root", flavour: "page", children: ["b1"] }, "user");
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph", fields: { text: "hello" } }, "user");

      const root = await docStore.getBlock(item.id, "root");
      expect(root).toMatchObject({ "sys:id": "root", "sys:flavour": "page", "sys:children": ["b1"] });

      const b1 = await docStore.getBlock(item.id, "b1");
      expect(b1).toMatchObject({ "sys:id": "b1", "sys:flavour": "paragraph", text: "hello" });

      const all = await docStore.listBlocks(item.id);
      expect(all).toHaveLength(2);

      await docStore.deleteBlock(item.id, "b1", "user");
      expect(await docStore.getBlock(item.id, "b1")).toBeNull();
      expect(await docStore.listBlocks(item.id)).toHaveLength(1);
    });

    it("a caller-supplied field cannot overwrite the reserved sys: identity fields", async () => {
      const item = await makeItem();
      await docStore.putBlock(
        item.id,
        { id: "b1", flavour: "paragraph", fields: { "sys:id": "spoofed", "sys:flavour": "spoofed" } },
        "user",
      );
      const b1 = await docStore.getBlock(item.id, "b1");
      expect(b1).toMatchObject({ "sys:id": "b1", "sys:flavour": "paragraph" });
    });

    it("rejects block operations against a canvas doc", async () => {
      const item = await makeItem();
      await docStore.putCanvasElement(item.id, { id: "e1", type: "shape", xywh: [0, 0, 10, 10], index: "a0" }, "user");
      await expect(docStore.getBlock(item.id, "b1")).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("canvas elements", () => {
    it("putCanvasElement/getCanvasElement/listCanvasElements/deleteCanvasElement round-trip type, xywh, index", async () => {
      const item = await makeItem();
      await docStore.putCanvasElement(item.id, { id: "e1", type: "shape", xywh: [1, 2, 3, 4], index: "a0" }, "user");

      const el = await docStore.getCanvasElement(item.id, "e1");
      expect(el).toMatchObject({ id: "e1", type: "shape", xywh: [1, 2, 3, 4], index: "a0" });

      expect(await docStore.listCanvasElements(item.id)).toHaveLength(1);

      await docStore.deleteCanvasElement(item.id, "e1", "user");
      expect(await docStore.getCanvasElement(item.id, "e1")).toBeNull();
    });

    it("a caller-supplied field cannot overwrite the required id/type fields", async () => {
      const item = await makeItem();
      await docStore.putCanvasElement(
        item.id,
        { id: "e1", type: "shape", xywh: [0, 0, 1, 1], index: "a0", fields: { id: "spoofed", type: "text" } },
        "user",
      );
      const el = await docStore.getCanvasElement(item.id, "e1");
      expect(el).toMatchObject({ id: "e1", type: "shape" });
    });
  });

  describe("write attribution", () => {
    it("propagates the Yjs transaction origin into doc_updates.created_by", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "ai_agent");

      const doc = await docStore.getDoc(item.id);
      const { rows } = await pool.query<{ created_by: string }>(
        `SELECT created_by FROM doc_updates WHERE doc_id = $1`,
        [doc?.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.created_by).toBe("ai_agent");
    });

    describe("last edited tracking", () => {
      async function readLastEdited(docId: string) {
        const { rows } = await pool.query<{ last_edited_at: Date | null; last_edited_by: string | null }>(
          `SELECT last_edited_at, last_edited_by FROM docs WHERE id = $1`,
          [docId],
        );
        return rows[0]!;
      }

      it("a user write records last_edited_by 'user' and the update's own created_at", async () => {
        const item = await makeItem();
        await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
        const doc = (await docStore.getDoc(item.id))!;
        const edited = await readLastEdited(doc.id);
        const { rows } = await pool.query<{ created_at: Date }>(
          `SELECT created_at FROM doc_updates WHERE doc_id = $1`,
          [doc.id],
        );
        expect(edited.last_edited_by).toBe("user");
        expect(edited.last_edited_at).toEqual(rows[0]!.created_at);
      });

      it("an ai_agent write records last_edited_by 'ai_agent'", async () => {
        const item = await makeItem();
        await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "ai_agent");
        const doc = (await docStore.getDoc(item.id))!;
        expect((await readLastEdited(doc.id)).last_edited_by).toBe("ai_agent");
      });

      it("a sync-style mutateDoc update moves last_edited_at forward", async () => {
        const item = await makeItem();
        await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "ai_agent");
        const doc = (await docStore.getDoc(item.id))!;
        const first = await readLastEdited(doc.id);
        await mutateDoc(pool, doc.id, "user", (ydoc) => {
          ydoc.getMap("sync-test").set("k", "v");
        });
        const second = await readLastEdited(doc.id);
        expect(second.last_edited_by).toBe("user");
        expect(second.last_edited_at!.getTime()).toBeGreaterThan(first.last_edited_at!.getTime());
      });

      it("a mutation that changes nothing leaves the columns untouched", async () => {
        const item = await makeItem();
        await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "ai_agent");
        const doc = (await docStore.getDoc(item.id))!;
        const before = await readLastEdited(doc.id);
        await mutateDoc(pool, doc.id, "user", () => {});
        expect(await readLastEdited(doc.id)).toEqual(before);
      });

      it("a docs row with NULL columns reads lastEditedAt equal to createdAt and lastEditedBy null", async () => {
        const item = await makeItem();
        await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
        const doc = (await docStore.getDoc(item.id))!;
        expect(doc.lastEditedAt).toBe(doc.createdAt);
        expect(doc.lastEditedBy).toBeNull();
        await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "system");
        const edited = (await docStore.getDoc(item.id))!;
        expect(edited.lastEditedBy).toBe("system");
      });
    });

    it("notifies the realtime doc-update hook with the doc id, origin, and the persisted update's id", async () => {
      const events: DocUpdateEvent[] = [];
      setDocUpdateHook((event) => events.push(event));

      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");

      expect(events).toHaveLength(1);
      expect(events[0]!.createdBy).toBe("user");
      expect(typeof events[0]!.updateId).toBe("string");

      const doc = await docStore.getDoc(item.id);
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM doc_updates WHERE doc_id = $1`, [doc?.id]);
      expect(rows.map((r) => r.id)).toContain(events[0]!.updateId);
    });

    it("does not fire the realtime doc-update hook if the enclosing transaction rolls back (issue #105 review fix)", async () => {
      const events: DocUpdateEvent[] = [];
      setDocUpdateHook((event) => events.push(event));
      const item = await makeItem();

      await expect(
        withTransaction(pool, async (client) => {
          await putBlockWithClient(client, item.id, { id: "b1", flavour: "paragraph" }, "user");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(events).toHaveLength(0);
      expect(await docStore.getBlock(item.id, "b1")).toBeNull();
    });

    it("fires the realtime doc-update hook only once the enclosing transaction has committed, not while it is still open", async () => {
      const events: DocUpdateEvent[] = [];
      setDocUpdateHook((event) => events.push(event));
      const item = await makeItem();

      await withTransaction(pool, async (client) => {
        await putBlockWithClient(client, item.id, { id: "b1", flavour: "paragraph" }, "user");
        expect(events).toHaveLength(0);
      });

      expect(events).toHaveLength(1);
    });
  });

  /** Captures the binary diff produced by one `doc.transact(...)` call, the same way docPersistence.mutateDoc does — used here to seed `doc_updates` directly, bypassing mutateDoc's own lazy compaction check so the test controls exactly when the threshold is crossed. */
  function captureUpdate(doc: Y.Doc, fn: () => void): Uint8Array {
    let captured: Uint8Array | null = null;
    const onUpdate = (update: Uint8Array) => {
      captured = update;
    };
    doc.on("update", onUpdate);
    doc.transact(fn);
    doc.off("update", onUpdate);
    if (!captured) throw new Error("transact produced no update");
    return captured;
  }

  describe("compaction", () => {
    it("merges doc_updates into doc_snapshots once the pending count crosses the threshold, preserving content", async () => {
      const item = await makeItem();
      const threshold = 5;
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const scratch = new Y.Doc();
      scratch.gc = false;
      for (let i = 0; i < threshold; i++) {
        const update = captureUpdate(scratch, () => {
          scratch.getMap("blocks").set(`b${i}`, new Y.Map());
        });
        await pool.query(`INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, 'user')`, [
          doc.id,
          Buffer.from(update),
        ]);
      }

      const { rows: pendingBefore } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        doc.id,
      ]);
      expect(pendingBefore[0].n).toBe(threshold + 1); // the seed write, plus these

      const reloaded = await loadDoc(pool, doc.id, threshold);

      const { rows: pendingAfter } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        doc.id,
      ]);
      expect(pendingAfter[0].n).toBe(0);

      const { rows: snapshotRows } = await pool.query(`SELECT state FROM doc_snapshots WHERE doc_id = $1`, [doc.id]);
      expect(snapshotRows).toHaveLength(1);

      expect(readBlocks(reloaded)).toHaveLength(1 + threshold);
      expect(readBlock(reloaded, "seed")).not.toBeNull();
    });

    it("the periodic sweep compacts documents that are never read directly", async () => {
      const item = await makeItem();
      const threshold = 3;
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      // A large per-call threshold means mutateDoc's own lazy-on-read check never fires,
      // so these updates accumulate untouched until the sweep visits the doc.
      for (let i = 0; i < threshold; i++) {
        await mutateDoc(
          pool,
          doc.id,
          "user",
          (ydoc) => {
            ydoc.getMap("blocks").set(`sweep${i}`, new Y.Map());
          },
          DEFAULT_COMPACTION_THRESHOLD,
        );
      }

      const { rows: beforeSweep } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        doc.id,
      ]);
      expect(beforeSweep[0].n).toBe(threshold + 1); // the seed write, plus these

      const outcome = await runCompactionSweep(pool, threshold);
      expect(outcome.succeeded).toBeGreaterThanOrEqual(1);

      const { rows: afterSweep } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        doc.id,
      ]);
      expect(afterSweep[0].n).toBe(0);
    });

    it("runCompactionSweep isolates a corrupted doc's failure from another doc's success", async () => {
      const itemA = await makeItem();
      await docStore.putBlock(itemA.id, { id: "seed", flavour: "paragraph" }, "user");
      const docA = await docStore.getDoc(itemA.id);
      if (!docA) throw new Error("doc not created");

      const scratch = new Y.Doc();
      scratch.gc = false;
      const validUpdates: Buffer[] = [];
      for (let i = 0; i < DEFAULT_COMPACTION_THRESHOLD; i++) {
        validUpdates.push(
          Buffer.from(
            captureUpdate(scratch, () => {
              scratch.getMap("blocks").set(`a${i}`, new Y.Map());
            }),
          ),
        );
      }
      await pool.query(
        `INSERT INTO doc_updates (doc_id, update, created_by) SELECT $1, u, 'user' FROM unnest($2::bytea[]) AS u`,
        [docA.id, validUpdates],
      );

      const itemB = await makeItem();
      await docStore.putBlock(itemB.id, { id: "seed", flavour: "paragraph" }, "user");
      const docB = await docStore.getDoc(itemB.id);
      if (!docB) throw new Error("doc not created");
      // A doc_updates row whose bytes are not a valid Yjs update: Y.applyUpdate throws while
      // replaying docB, so the whole doc is counted as failed rather than partially compacted.
      await pool.query(
        `INSERT INTO doc_updates (doc_id, update, created_by) SELECT $1, $2, 'user' FROM generate_series(1, $3)`,
        [docB.id, Buffer.from([0x00, 0xff]), DEFAULT_COMPACTION_THRESHOLD],
      );

      const outcome = await runCompactionSweep(pool);
      expect(outcome).toEqual({ succeeded: 1, failed: 1 });

      const { rows: docARows } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        docA.id,
      ]);
      expect(docARows[0].n).toBe(0); // docA compacted

      const { rows: docBRows } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        docB.id,
      ]);
      expect(docBRows[0].n).toBeGreaterThan(0); // docB's failed transaction never compacted or deleted its rows

      // docA is already compacted, so pair docB's still-failing doc with a fresh, valid
      // one: a mixed outcome (some succeed, some fail) must still resolve the task, not reject it.
      const itemC = await makeItem();
      await docStore.putBlock(itemC.id, { id: "seed", flavour: "paragraph" }, "user");
      const docC = await docStore.getDoc(itemC.id);
      if (!docC) throw new Error("doc not created");
      const validUpdatesC: Buffer[] = [];
      for (let i = 0; i < DEFAULT_COMPACTION_THRESHOLD; i++) {
        validUpdatesC.push(
          Buffer.from(
            captureUpdate(scratch, () => {
              scratch.getMap("blocks").set(`c${i}`, new Y.Map());
            }),
          ),
        );
      }
      await pool.query(
        `INSERT INTO doc_updates (doc_id, update, created_by) SELECT $1, u, 'user' FROM unnest($2::bytea[]) AS u`,
        [docC.id, validUpdatesC],
      );

      await expect(handleDocCompactionSweepTask(pool)).resolves.toBeUndefined();
    });

    it("handleDocCompactionSweepTask rejects when the only over-threshold doc failed entirely", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");
      await pool.query(
        `INSERT INTO doc_updates (doc_id, update, created_by) SELECT $1, $2, 'user' FROM generate_series(1, $3)`,
        [doc.id, Buffer.from([0x00, 0xff]), DEFAULT_COMPACTION_THRESHOLD],
      );

      const err: unknown = await handleDocCompactionSweepTask(pool).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors[0]).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("docCompactionSweep: all 1 attempted doc(s) failed"),
        }),
      );
    });

    it("compaction leaves behind a doc_snapshot_history checkpoint, so version reconstruction never loses granularity it merged away", async () => {
      const item = await makeItem();
      const threshold = 3;
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const { rows: beforeCompaction } = await pool.query(
        `SELECT count(*)::int AS n FROM doc_snapshot_history WHERE doc_id = $1`,
        [doc.id],
      );
      expect(beforeCompaction[0].n).toBe(1); // just the new-doc baseline checkpoint so far

      const scratch = new Y.Doc();
      scratch.gc = false;
      for (let i = 0; i < threshold; i++) {
        const update = captureUpdate(scratch, () => {
          scratch.getMap("blocks").set(`b${i}`, new Y.Map());
        });
        await pool.query(`INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, 'user')`, [
          doc.id,
          Buffer.from(update),
        ]);
      }

      const { rows: updateRowsBefore } = await pool.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC`,
        [doc.id],
      );
      const lastPendingUpdate = updateRowsBefore[updateRowsBefore.length - 1]!;

      await loadDoc(pool, doc.id, threshold); // crosses the threshold, triggers compact()

      // The new-doc baseline checkpoint (through_update_id = 0) plus the compaction checkpoint.
      const { rows: afterCompaction } = await pool.query(
        `SELECT created_by, through_update_id, represented_at, expires_at FROM doc_snapshot_history
         WHERE doc_id = $1 ORDER BY through_update_id ASC`,
        [doc.id],
      );
      expect(afterCompaction).toHaveLength(2);
      expect(afterCompaction[0].through_update_id).toBe("0");
      expect(afterCompaction[0].expires_at).toBeNull(); // non-expiring baseline

      const compactionCheckpoint = afterCompaction[1];
      expect(compactionCheckpoint.created_by).toBe("system");
      expect(compactionCheckpoint.through_update_id).toBe(lastPendingUpdate.id);
      expect(new Date(compactionCheckpoint.represented_at).getTime()).toBe(lastPendingUpdate.created_at.getTime());
      expect(compactionCheckpoint.expires_at).not.toBeNull();
    });

    it("compaction never deletes doc_history_updates or the NULL-expiry baseline", async () => {
      const item = await makeItem();
      const threshold = 3;
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      for (let i = 0; i < threshold; i++) {
        await mutateDoc(
          pool,
          doc.id,
          "user",
          (ydoc) => {
            ydoc.getMap("blocks").set(`b${i}`, new Y.Map());
          },
          threshold,
        );
      }

      const { rows: historyUpdates } = await pool.query(
        `SELECT count(*)::int AS n FROM doc_history_updates WHERE doc_id = $1`,
        [doc.id],
      );
      expect(historyUpdates[0].n).toBe(1 + threshold); // seed write + the threshold writes, none deleted by compaction

      const { rows: baseline } = await pool.query(
        `SELECT count(*)::int AS n FROM doc_snapshot_history WHERE doc_id = $1 AND through_update_id = 0 AND expires_at IS NULL`,
        [doc.id],
      );
      expect(baseline[0].n).toBe(1);
    });
  });

  describe("version history", () => {
    it("appending an update mirrors the same id/bytes/attribution/timestamp into doc_history_updates", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "ai_agent");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const { rows: updateRows } = await pool.query<{
        id: string;
        update: Buffer;
        created_by: string;
        created_at: Date;
      }>(`SELECT id, update, created_by, created_at FROM doc_updates WHERE doc_id = $1`, [doc.id]);
      const { rows: historyRows } = await pool.query<{
        update_id: string;
        update: Buffer;
        created_by: string;
        created_at: Date;
      }>(`SELECT update_id, update, created_by, created_at FROM doc_history_updates WHERE doc_id = $1`, [doc.id]);

      expect(historyRows).toHaveLength(1);
      expect(historyRows[0]!.update_id).toBe(updateRows[0]!.id);
      expect(historyRows[0]!.update.equals(updateRows[0]!.update)).toBe(true);
      expect(historyRows[0]!.created_by).toBe(updateRows[0]!.created_by);
      expect(historyRows[0]!.created_at.getTime()).toBe(updateRows[0]!.created_at.getTime());
    });

    it("new-doc creation atomically installs a non-expiring baseline checkpoint at history_available_from", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const { rows: docRows } = await pool.query<{ created_at: Date; history_available_from: Date }>(
        `SELECT created_at, history_available_from FROM docs WHERE id = $1`,
        [doc.id],
      );
      expect(docRows[0]!.history_available_from.getTime()).toBe(docRows[0]!.created_at.getTime());

      const { rows: checkpointRows } = await pool.query<{
        through_update_id: string;
        represented_at: Date;
        expires_at: Date | null;
      }>(`SELECT through_update_id, represented_at, expires_at FROM doc_snapshot_history WHERE doc_id = $1`, [doc.id]);
      expect(checkpointRows).toHaveLength(1); // no compaction has run yet
      expect(checkpointRows[0]!.through_update_id).toBe("0");
      expect(checkpointRows[0]!.represented_at.getTime()).toBe(docRows[0]!.history_available_from.getTime());
      expect(checkpointRows[0]!.expires_at).toBeNull();
    });

    it("cleanup removes an expired checkpoint but never a NULL-expiry baseline", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      // The baseline from doc creation, plus a directly-inserted already-expired checkpoint
      // standing in for an ordinary compaction checkpoint whose retention window has passed.
      await pool.query(
        `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
         VALUES ($1, '\\x'::bytea, 1, now(), now() - interval '1 second', 'system')`,
        [doc.id],
      );

      const removed = await cleanupExpiredDocHistory(pool);
      expect(removed).toBe(1);

      const { rows } = await pool.query<{ through_update_id: string }>(
        `SELECT through_update_id FROM doc_snapshot_history WHERE doc_id = $1`,
        [doc.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.through_update_id).toBe("0"); // baseline survives
    });

    it("openVersionAt returns the empty initial doc between creation and the first update", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user"); // creates the doc
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");
      await pool.query(`DELETE FROM doc_updates WHERE doc_id = $1`, [doc.id]);
      await pool.query(`DELETE FROM doc_history_updates WHERE doc_id = $1`, [doc.id]);

      const version = await docStore.openVersionAt(item.id, new Date());
      expect(version?.blocks).toEqual([]);
    });

    it("openVersionAt reconstructs content as of a past time plus the updates since, surviving an intervening compaction", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      await new Promise((resolve) => setTimeout(resolve, 10));
      const checkpointTime = new Date();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await docStore.putBlock(item.id, { id: "b2", flavour: "paragraph" }, "user");

      // A compaction after checkpointTime used to make a naive reconstruction at
      // checkpointTime unrecoverable (its only usable checkpoint was superseded and the
      // doc_updates rows it needed were deleted). The mirrored doc_history_updates log means
      // it no longer matters how many compactions have run since.
      await mutateDoc(
        pool,
        doc.id,
        "user",
        (ydoc) => {
          const blocks = ydoc.getMap("blocks");
          const block = new Y.Map();
          block.set("sys:id", "b3");
          block.set("sys:flavour", "paragraph");
          block.set("sys:children", []);
          blocks.set("b3", block);
        },
        1,
      );

      const atCheckpoint = await docStore.openVersionAt(item.id, checkpointTime);
      expect(atCheckpoint?.blocks?.map((b) => b["sys:id"])).toEqual(["b1"]);

      const atNow = await docStore.openVersionAt(item.id, new Date());
      expect(atNow?.blocks?.map((b) => b["sys:id"]).sort()).toEqual(["b1", "b2", "b3"]);
    });

    it("openVersionAt rejects a future timestamp with ValidationError", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");

      const future = new Date(Date.now() + 60_000);
      await expect(docStore.openVersionAt(item.id, future)).rejects.toBeInstanceOf(ValidationError);
    });

    it("openVersionAt raises HistoryNotRetainedError for a time before history_available_from", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const beforeCreation = new Date(Date.now() - 60_000);
      await expect(openDocVersionAt(pool, doc.id, beforeCreation)).rejects.toBeInstanceOf(HistoryNotRetainedError);
    });

    it("openVersionAt raises HistoryNotRetainedError for a nonfuture time before the retention cutoff", async () => {
      // Session timezone pinned to UTC and every "now" derived from a single Postgres read
      // (rather than each of Node's Date.now() and Postgres's own now() drifting
      // independently) so the boundary math below is deterministic regardless of the host's
      // local timezone or clock skew between the test process and the database. `SET TIME
      // ZONE` is session-scoped, so this borrows a dedicated client (rather than pool.query,
      // which could hand the now-UTC session to a later, unrelated test) and resets it before
      // releasing the client back to the pool.
      const reference = await withUtcReferenceTime(pool);

      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      // Push history_available_from back so it doesn't itself trip the check, isolating the
      // retention-cutoff branch (retentionDays = 1 below, so 2 days ago is outside it).
      const tenDaysAgo = new Date(reference.getTime() - 10 * 24 * 60 * 60 * 1000);
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, tenDaysAgo]);
      const twoDaysAgo = new Date(reference.getTime() - 2 * 24 * 60 * 60 * 1000);

      await expect(openDocVersionAt(pool, doc.id, twoDaysAgo, 1)).rejects.toBeInstanceOf(HistoryNotRetainedError);
    });

    it("a just-after-cutoff read succeeds while a just-before-cutoff read is not retained (deterministic under a configured retention window)", async () => {
      // Session timezone pinned to UTC and every "now" derived from a single Postgres read
      // (rather than each of Node's Date.now() and Postgres's own now() drifting
      // independently) so the boundary math below is deterministic regardless of the host's
      // local timezone or clock skew between the test process and the database. `SET TIME
      // ZONE` is session-scoped, so this borrows a dedicated client (rather than pool.query,
      // which could hand the now-UTC session to a later, unrelated test) and resets it before
      // releasing the client back to the pool.
      const reference = await withUtcReferenceTime(pool);

      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const retentionDays = 1;
      const tenDaysAgo = new Date(reference.getTime() - 10 * 24 * 60 * 60 * 1000);
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, tenDaysAgo]);
      await pool.query(`UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1`, [doc.id, tenDaysAgo]);
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1`, [doc.id, tenDaysAgo]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1`, [doc.id, tenDaysAgo]);

      const justBeforeCutoff = new Date(reference.getTime() - retentionDays * 24 * 60 * 60 * 1000 - 1000);
      const justAfterCutoff = new Date(reference.getTime() - retentionDays * 24 * 60 * 60 * 1000 + 1000);

      await expect(openDocVersionAt(pool, doc.id, justBeforeCutoff, retentionDays)).rejects.toBeInstanceOf(
        HistoryNotRetainedError,
      );
      const version = await openDocVersionAt(pool, doc.id, justAfterCutoff, retentionDays);
      expect(version).toBeInstanceOf(Y.Doc);
    });

    it("openVersionAt on an item with no doc returns null", async () => {
      const item = await makeItem();
      expect(await docStore.openVersionAt(item.id, new Date())).toBeNull();
    });

    it("openDocVersionAt raises NotFoundError for a doc id that does not exist", async () => {
      await expect(openDocVersionAt(pool, "00000000-0000-0000-0000-000000000000", new Date())).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe("retention cleanup (issue #86)", () => {
    it("is a no-op when the cutoff doesn't advance past history_available_from", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const { rows: before } = await pool.query<{
        history_available_from: Date;
        checkpointCount: string;
      }>(
        `SELECT d.history_available_from, (SELECT count(*) FROM doc_snapshot_history WHERE doc_id = d.id) AS "checkpointCount"
         FROM docs d WHERE d.id = $1`,
        [doc.id],
      );

      // A brand-new doc's history_available_from is "now" — with the default 30-day
      // retention, the cutoff (30 days ago) precedes it, so nothing should change.
      const rebaselined = await rebaselineDocHistory(pool, doc.id, 30);
      expect(rebaselined).toBe(false);

      const { rows: after } = await pool.query<{
        history_available_from: Date;
        checkpointCount: string;
      }>(
        `SELECT d.history_available_from, (SELECT count(*) FROM doc_snapshot_history WHERE doc_id = d.id) AS "checkpointCount"
         FROM docs d WHERE d.id = $1`,
        [doc.id],
      );
      expect(after[0]!.history_available_from.getTime()).toBe(before[0]!.history_available_from.getTime());
      expect(after[0]!.checkpointCount).toBe(before[0]!.checkpointCount);
    });

    it("re-baselines at the cutoff, reconstructing exact state and deleting only what the new baseline makes redundant", async () => {
      // Session timezone pinned to UTC and every "now" derived from a single Postgres read,
      // per the #216 boundary-test convention, so the retention math below is deterministic
      // regardless of host timezone or test/database clock skew.
      const reference = await withUtcReferenceTime(pool);

      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");
      await docStore.putBlock(item.id, { id: "b2", flavour: "paragraph" }, "user");

      const { rows: updateRows } = await pool.query<{ update_id: string }>(
        `SELECT update_id FROM doc_history_updates WHERE doc_id = $1 ORDER BY update_id ASC`,
        [doc.id],
      );
      expect(updateRows).toHaveLength(2);
      const [b1UpdateId, b2UpdateId] = updateRows.map((r) => r.update_id);

      const retentionDays = 30;
      const beforeCutoff = new Date(reference.getTime() - (retentionDays + 10) * 24 * 60 * 60 * 1000);
      const afterCutoff = new Date(reference.getTime() - (retentionDays - 10) * 24 * 60 * 60 * 1000);
      const cutoff = new Date(reference.getTime() - retentionDays * 24 * 60 * 60 * 1000);

      // b1 (and the doc's original baseline/availability) land before the cutoff; b2 lands
      // after it — the split the re-baseline is expected to resolve.
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, beforeCutoff]);
      await pool.query(
        `UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0`,
        [doc.id, beforeCutoff],
      );
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1 AND id = $3`, [
        doc.id,
        beforeCutoff,
        b1UpdateId,
      ]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1 AND update_id = $3`, [
        doc.id,
        beforeCutoff,
        b1UpdateId,
      ]);
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1 AND id = $3`, [
        doc.id,
        afterCutoff,
        b2UpdateId,
      ]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1 AND update_id = $3`, [
        doc.id,
        afterCutoff,
        b2UpdateId,
      ]);

      const rebaselined = await rebaselineDocHistory(pool, doc.id, retentionDays);
      expect(rebaselined).toBe(true);

      const { rows: docRows } = await pool.query<{ history_available_from: Date }>(
        `SELECT history_available_from FROM docs WHERE id = $1`,
        [doc.id],
      );
      expect(Math.abs(docRows[0]!.history_available_from.getTime() - cutoff.getTime())).toBeLessThan(5000);

      const { rows: checkpointRows } = await pool.query<{
        through_update_id: string;
        represented_at: Date;
        expires_at: Date | null;
      }>(`SELECT through_update_id, represented_at, expires_at FROM doc_snapshot_history WHERE doc_id = $1`, [doc.id]);
      // The old (pre-cutover) NULL-expiry baseline is gone; exactly the new one remains.
      expect(checkpointRows).toHaveLength(1);
      expect(checkpointRows[0]!.through_update_id).toBe(b1UpdateId);
      expect(checkpointRows[0]!.expires_at).toBeNull();

      const { rows: remainingHistory } = await pool.query<{ update_id: string }>(
        `SELECT update_id FROM doc_history_updates WHERE doc_id = $1`,
        [doc.id],
      );
      // b1's history row (at/before the cutoff) is deleted as redundant; b2's (after the
      // cutoff) is kept — required for reconstruction inside the retained interval.
      expect(remainingHistory.map((r) => r.update_id)).toEqual([b2UpdateId]);

      // The reconstructed baseline itself contains exactly b1 (state as of the cutoff).
      // openDocVersionAt rejects any `at` below its own freshly-recomputed live cutoff, which
      // keeps sliding forward with the wall clock — a fixed buffer added to a timestamp
      // captured earlier in this test could be outrun by that drift on a loaded host. Reading
      // the live cutoff immediately before this call and taking the later of it and
      // history_available_from gives an exact, non-flaky lower bound instead.
      const liveCutoff = await currentRetentionCutoff(pool, retentionDays);
      const justAfterHistoryAvailableFrom = new Date(
        Math.max(docRows[0]!.history_available_from.getTime(), liveCutoff.getTime()) + 100,
      );
      const atCutoff = await openDocVersionAt(pool, doc.id, justAfterHistoryAvailableFrom, retentionDays);
      expect(readBlocks(atCutoff).map((b) => b["sys:id"])).toEqual(["b1"]);

      // A timestamp just before the new history_available_from is no longer retained...
      const justBefore = new Date(docRows[0]!.history_available_from.getTime() - 1000);
      await expect(openDocVersionAt(pool, doc.id, justBefore, retentionDays)).rejects.toBeInstanceOf(
        HistoryNotRetainedError,
      );

      // ...while "now" still reconstructs both updates, including the one kept past the boundary.
      const atNow = await openDocVersionAt(pool, doc.id, reference, retentionDays);
      expect(
        readBlocks(atNow)
          .map((b) => b["sys:id"])
          .sort(),
      ).toEqual(["b1", "b2"]);
    });

    it("the sweep re-baselines every eligible doc, isolating failures per doc", async () => {
      const itemA = await makeItem();
      await docStore.putBlock(itemA.id, { id: "a1", flavour: "paragraph" }, "user");
      const docA = await docStore.getDoc(itemA.id);
      if (!docA) throw new Error("doc not created");

      const oldEnough = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [docA.id, oldEnough]);
      await pool.query(`UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1`, [docA.id, oldEnough]);
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1`, [docA.id, oldEnough]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1`, [docA.id, oldEnough]);

      const itemB = await makeItem();
      await docStore.putBlock(itemB.id, { id: "b1", flavour: "paragraph" }, "user"); // stays recent

      // A third doc, also eligible for rebaselining, whose checkpoint state is corrupted so
      // that rebaselineDocHistory's Y.applyUpdate throws — the only way to actually exercise
      // the sweep's try/catch isolation, rather than merely assert on which docs were eligible.
      const itemC = await makeItem();
      await docStore.putBlock(itemC.id, { id: "c1", flavour: "paragraph" }, "user");
      const docC = await docStore.getDoc(itemC.id);
      if (!docC) throw new Error("doc not created");
      await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [docC.id, oldEnough]);
      await pool.query(`UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1`, [docC.id, oldEnough]);
      await pool.query(`UPDATE doc_updates SET created_at = $2 WHERE doc_id = $1`, [docC.id, oldEnough]);
      await pool.query(`UPDATE doc_history_updates SET created_at = $2 WHERE doc_id = $1`, [docC.id, oldEnough]);
      await pool.query(`UPDATE doc_snapshot_history SET state = $2 WHERE doc_id = $1`, [
        docC.id,
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
      ]);

      const outcome = await runDocHistoryRetentionSweep(pool, 30);
      expect(outcome.rebaselined).toBe(1); // only docA rebaselined; docB wasn't eligible, docC's threw

      const { rows: docARows } = await pool.query<{ history_available_from: Date }>(
        `SELECT history_available_from FROM docs WHERE id = $1`,
        [docA.id],
      );
      expect(docARows[0]!.history_available_from.getTime()).toBeGreaterThan(oldEnough.getTime());

      // docC's thrown error didn't abort the sweep for the other docs, and left docC's own
      // state untouched by the failed attempt.
      const { rows: docCRows } = await pool.query<{ history_available_from: Date }>(
        `SELECT history_available_from FROM docs WHERE id = $1`,
        [docC.id],
      );
      expect(docCRows[0]!.history_available_from.getTime()).toBe(oldEnough.getTime());
    });

    it("excludes concurrent append via the same document row lock append/compaction already use", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const clientX = await pool.connect();
      try {
        await clientX.query("BEGIN");
        // The exact row lock rebaselineDocHistory takes before reading/writing anything else.
        await clientX.query(`SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [doc.id]);

        let appended = false;
        const appendPromise = mutateDoc(pool, doc.id, "user", (ydoc) => {
          ydoc.getMap("blocks").set("b2", new Y.Map());
        }).then(() => {
          appended = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(appended).toBe(false); // append's own loadDocWithClient lock is blocked behind X

        await clientX.query("COMMIT");
        await appendPromise;
        expect(appended).toBe(true);
      } finally {
        clientX.release();
      }
    });

    it("excludes concurrent compaction via the same document row lock cleanup uses", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const clientX = await pool.connect();
      try {
        await clientX.query("BEGIN");
        // The exact row lock rebaselineDocHistory takes, standing in for a concurrent cleanup.
        await clientX.query(`SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [doc.id]);

        let compacted = false;
        // compactionThreshold=1: the single pending doc_updates row from putBlock above is
        // already at/over threshold, so loadDoc's lazy check compacts it on this very read —
        // loadSnapshotForUpdate's own `doc_snapshots ... FOR UPDATE` is the same row lock.
        const compactPromise = loadDoc(pool, doc.id, 1).then(() => {
          compacted = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(compacted).toBe(false); // compaction's own loadDocWithClient lock is blocked behind X

        await clientX.query("COMMIT");
        await compactPromise;
        expect(compacted).toBe(true);
      } finally {
        clientX.release();
      }
    });
  });

  describe("page Markdown and its version token (issue #1678)", () => {
    const readMarkdown = (itemId: string) => withTransaction(pool, (client) => readPageMarkdown(client, itemId));

    async function pageWithBlocks() {
      const item = await makeItem();
      const doc = await docStore.getOrCreateDoc(item.id, "page");
      await mutateDoc(pool, doc.id, "user", (ydoc) => {
        writeBlock(ydoc, { id: "h", type: "h1", text: "Heading" });
        writeBlock(ydoc, { id: "p", type: "text", text: "Body text" });
      });
      return { item, doc };
    }

    it("returns the same token for two reads with a compaction between them", async () => {
      const { item, doc } = await pageWithBlocks();
      const first = await readMarkdown(item.id);
      const updatesBefore = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`,
        [doc.id],
      );
      expect(updatesBefore.rows[0]!.n).toBeGreaterThan(0);

      // Threshold 1 compacts every pending update into the snapshot on this read: the stored rows change, the page does not.
      await loadDoc(pool, doc.id, 1);
      const updatesAfter = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`,
        [doc.id],
      );
      expect(updatesAfter.rows[0]!.n).toBe(0);

      const second = await readMarkdown(item.id);
      expect(second.etag).toBe(first.etag);
      expect(second.markdown).toBe(first.markdown);
      expect(first.markdown).toBe("# Heading\n\nBody text");
    });

    it("changes the token when a write only deletes text", async () => {
      const { item, doc } = await pageWithBlocks();
      const before = await readMarkdown(item.id);
      await mutateDoc(pool, doc.id, "user", (ydoc) => {
        const text = getBlocksMap(ydoc).get("p")?.get("text");
        if (!(text instanceof Y.Text)) throw new Error("expected the block text to be a Y.Text");
        text.delete(0, 5);
      });
      const after = await readMarkdown(item.id);
      expect(after.markdown).toBe("# Heading\n\ntext");
      expect(after.etag).not.toBe(before.etag);
    });

    it("reads an item without a document as an empty body with the token of an empty document, creating no row", async () => {
      const item = await makeItem();
      const result = await readMarkdown(item.id);
      expect(result).toEqual({ docId: null, markdown: "", etag: docEtag(new Y.Doc()) });
      expect((await pool.query(`SELECT 1 FROM docs WHERE item_id = $1`, [item.id])).rows).toHaveLength(0);

      // The token of an empty read is the token of a page that was created and left empty.
      const created = await docStore.getOrCreateDoc(item.id, "page");
      expect(await readMarkdown(item.id)).toEqual({ docId: created.id, markdown: "", etag: result.etag });
    });

    it("writes a page block as a link captioned with the block's own title and never writes the page title", async () => {
      const item = await makeItem();
      const doc = await docStore.getOrCreateDoc(item.id, "page");
      await mutateDoc(pool, doc.id, "user", (ydoc) => {
        ydoc.getMap("meta").set("title", "Root title");
        writeBlock(ydoc, { id: "a", type: "page", pageId: "11111111-1111-4111-8111-111111111111", text: "Subpage" });
        writeBlock(ydoc, { id: "b", type: "h1", text: "Heading block" });
      });
      const result = await readMarkdown(item.id);
      expect(result.markdown).toContain("[Subpage](semprec://page/11111111-1111-4111-8111-111111111111)");
      expect(result.markdown).toContain("# Heading block");
      expect(result.markdown).not.toContain("Root title");
      expect(readPageBlocks(await loadDoc(pool, doc.id)).map((block) => block.id)).toEqual(["a", "b"]);
    });

    it("refuses an item that already holds a canvas document, as one that cannot host a page", async () => {
      const item = await makeItem();
      await docStore.getOrCreateDoc(item.id, "canvas");
      const error = await readMarkdown(item.id).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { reason: "not_a_page_host" } });
    });
  });
});
