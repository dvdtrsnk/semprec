import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDocStore, putBlockWithClient, type DocStore } from "../docs/docStore.js";
import { ConflictError, HistoryNotRetainedError, ValidationError } from "../errors.js";
import { DEFAULT_COMPACTION_THRESHOLD, loadDoc, mutateDoc, runCompactionSweep } from "../docs/docPersistence.js";
import {
  cleanupExpiredDocHistory,
  rebaselineDocHistory,
  runDocHistoryRetentionSweep,
  openDocVersionAt,
} from "../docs/docHistory.js";
import { getBlock as readBlock, listBlocks as readBlocks } from "../docs/blocks.js";
import { setDocUpdateHook, type DocUpdateEvent } from "../realtimeHook.js";

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

      const compactedCount = await runCompactionSweep(pool, threshold);
      expect(compactedCount).toBeGreaterThanOrEqual(1);

      const { rows: afterSweep } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [
        doc.id,
      ]);
      expect(afterSweep[0].n).toBe(0);
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

      // The reconstructed baseline itself contains exactly b1 (state as of the cutoff). A
      // few seconds' buffer keeps this from flaking against the retention window's own live
      // cutoff (which keeps sliding forward with the wall clock) the instant this runs.
      const justAfterHistoryAvailableFrom = new Date(docRows[0]!.history_available_from.getTime() + 5000);
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

      const succeeded = await runDocHistoryRetentionSweep(pool, 30);
      expect(succeeded).toBe(1); // only docA rebaselined; docB wasn't eligible, docC's threw

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
});
