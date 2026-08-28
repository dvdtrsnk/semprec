import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { ConflictError, ValidationError } from "../errors.js";
import { DEFAULT_COMPACTION_THRESHOLD, loadDoc, mutateDoc, runCompactionSweep } from "../docs/docPersistence.js";
import { runHistorySquashSweep, cleanupExpiredDocHistory, squashDocHistory } from "../docs/docHistory.js";
import { getBlock as readBlock, listBlocks as readBlocks } from "../docs/blocks.js";
import { setDocUpdateHook, type DocUpdateEvent } from "../realtimeHook.js";

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;

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
      await expect(docStore.putCanvasElement(item.id, { id: "e1", type: "shape", xywh: [0, 0, 10, 10], index: "a0" }, "user")).rejects.toBeInstanceOf(
        ConflictError,
      );
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
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph", fields: { "sys:id": "spoofed", "sys:flavour": "spoofed" } }, "user");
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
      await docStore.putCanvasElement(item.id, { id: "e1", type: "shape", xywh: [0, 0, 1, 1], index: "a0", fields: { id: "spoofed", type: "text" } }, "user");
      const el = await docStore.getCanvasElement(item.id, "e1");
      expect(el).toMatchObject({ id: "e1", type: "shape" });
    });
  });

  describe("write attribution", () => {
    it("propagates the Yjs transaction origin into doc_updates.created_by", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "ai_agent");

      const doc = await docStore.getDoc(item.id);
      const { rows } = await pool.query<{ created_by: string }>(`SELECT created_by FROM doc_updates WHERE doc_id = $1`, [doc?.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].created_by).toBe("ai_agent");
    });

    it("notifies the realtime doc-update hook with the doc id, origin, and a base64 update", async () => {
      const events: DocUpdateEvent[] = [];
      setDocUpdateHook((event) => events.push(event));

      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");

      expect(events).toHaveLength(1);
      expect(events[0].createdBy).toBe("user");
      expect(typeof events[0].update).toBe("string");
      expect(Buffer.from(events[0].update, "base64").length).toBeGreaterThan(0);
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
        await pool.query(`INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, 'user')`, [doc.id, Buffer.from(update)]);
      }

      const { rows: pendingBefore } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [doc.id]);
      expect(pendingBefore[0].n).toBe(threshold + 1); // the seed write, plus these

      const reloaded = await loadDoc(pool, doc.id, threshold);

      const { rows: pendingAfter } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [doc.id]);
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

      const { rows: beforeSweep } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [doc.id]);
      expect(beforeSweep[0].n).toBe(threshold + 1); // the seed write, plus these

      const compactedCount = await runCompactionSweep(pool, threshold);
      expect(compactedCount).toBeGreaterThanOrEqual(1);

      const { rows: afterSweep } = await pool.query(`SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1`, [doc.id]);
      expect(afterSweep[0].n).toBe(0);
    });

    it("compaction leaves behind a doc_snapshot_history checkpoint, so version reconstruction never loses granularity it merged away", async () => {
      const item = await makeItem();
      const threshold = 3;
      await docStore.putBlock(item.id, { id: "seed", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const { rows: beforeCompaction } = await pool.query(`SELECT count(*)::int AS n FROM doc_snapshot_history WHERE doc_id = $1`, [doc.id]);
      expect(beforeCompaction[0].n).toBe(0); // no periodic squash has run yet

      const scratch = new Y.Doc();
      scratch.gc = false;
      for (let i = 0; i < threshold; i++) {
        const update = captureUpdate(scratch, () => {
          scratch.getMap("blocks").set(`b${i}`, new Y.Map());
        });
        await pool.query(`INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, 'user')`, [doc.id, Buffer.from(update)]);
      }

      await loadDoc(pool, doc.id, threshold); // crosses the threshold, triggers compact()

      const { rows: afterCompaction } = await pool.query(
        `SELECT created_by FROM doc_snapshot_history WHERE doc_id = $1`,
        [doc.id],
      );
      expect(afterCompaction).toHaveLength(1);
      expect(afterCompaction[0].created_by).toBe("system");
    });
  });

  describe("version history", () => {
    it("squashDocHistory's read-then-checkpoint is atomic: a concurrent compaction on the same doc blocks instead of interleaving", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      // Manually reproduce squashDocHistory's read step (loadDocWithClient's FOR UPDATE
      // queries) on a held-open transaction, standing in for "squashDocHistory has read
      // the doc but not yet committed its checkpoint insert". If this doesn't block a
      // concurrent mutateDoc-triggered compaction on the same doc, the two can
      // interleave and produce the stale-checkpoint race this atomicity fix closes.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT state FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [doc.id]);
        await client.query(`SELECT id, update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC FOR UPDATE`, [doc.id]);

        let concurrentCompactionFinished = false;
        const concurrentCompaction = mutateDoc(
          pool,
          doc.id,
          "user",
          (ydoc) => {
            ydoc.getMap("blocks").set("b2", new Y.Map());
          },
          1,
        ).then(() => {
          concurrentCompactionFinished = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(concurrentCompactionFinished).toBe(false);

        await client.query("COMMIT");
        await concurrentCompaction;
        expect(concurrentCompactionFinished).toBe(true);
      } finally {
        client.release();
      }
    });

    it("squashHistory writes a checkpoint with an expiry, and cleanup removes it once expired", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      await squashDocHistory(pool, doc.id, "system", 0); // expires immediately
      const { rows: before } = await pool.query(`SELECT count(*)::int AS n FROM doc_snapshot_history WHERE doc_id = $1`, [doc.id]);
      expect(before[0].n).toBe(1);

      const removed = await cleanupExpiredDocHistory(pool);
      expect(removed).toBeGreaterThanOrEqual(1);
      const { rows: after } = await pool.query(`SELECT count(*)::int AS n FROM doc_snapshot_history WHERE doc_id = $1`, [doc.id]);
      expect(after[0].n).toBe(0);
    });

    it("runHistorySquashSweep checkpoints every existing doc", async () => {
      const itemA = await makeItem();
      const itemB = await makeItem();
      await docStore.putBlock(itemA.id, { id: "b1", flavour: "paragraph" }, "user");
      await docStore.putBlock(itemB.id, { id: "b1", flavour: "paragraph" }, "user");

      const squashed = await runHistorySquashSweep(pool, "system");
      expect(squashed).toBe(2);

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM doc_snapshot_history`);
      expect(rows[0].n).toBe(2);
    });

    it("openVersionAt reconstructs content as of a past checkpoint plus the updates since", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      await squashDocHistory(pool, doc.id, "system");
      const checkpointTime = new Date();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await docStore.putBlock(item.id, { id: "b2", flavour: "paragraph" }, "user");

      const atCheckpoint = await docStore.openVersionAt(item.id, checkpointTime);
      expect(atCheckpoint?.blocks?.map((b) => b["sys:id"])).toEqual(["b1"]);

      const atNow = await docStore.openVersionAt(item.id, new Date());
      expect(atNow?.blocks?.map((b) => b["sys:id"]).sort()).toEqual(["b1", "b2"]);
    });

    it("openVersionAt with no checkpoint yet falls back to replaying doc_updates from the start", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");

      const version = await docStore.openVersionAt(item.id, new Date());
      expect(version?.blocks?.map((b) => b["sys:id"])).toEqual(["b1"]);
    });

    it("openVersionAt raises a clear error instead of silently returning wrong content for a time inside an already-compacted, never-checkpointed window", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      const beforeCompaction = new Date();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Force a compaction with no preceding checkpoint (a low threshold, crossed by a
      // single further write) — this deletes the doc_updates row for "b1" and drops the
      // *only* checkpoint after `beforeCompaction`, so that timestamp becomes unrecoverable.
      await mutateDoc(
        pool,
        doc.id,
        "user",
        (ydoc) => {
          ydoc.getMap("blocks").set("b2", new Y.Map());
        },
        1,
      );

      await expect(docStore.openVersionAt(item.id, beforeCompaction)).rejects.toBeInstanceOf(ValidationError);
    });

    it("openVersionAt raises a clear error when a checkpoint exists but a later compaction already deleted the updates between it and the queried time", async () => {
      const item = await makeItem();
      await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
      const doc = await docStore.getDoc(item.id);
      if (!doc) throw new Error("doc not created");

      await squashDocHistory(pool, doc.id, "system"); // checkpoint sh1, contains only b1
      await docStore.putBlock(item.id, { id: "b2", flavour: "paragraph" }, "user");

      await new Promise((resolve) => setTimeout(resolve, 10));
      const queryTime = new Date(); // strictly after sh1 and after b2 — the correct answer here is [b1, b2]
      await new Promise((resolve) => setTimeout(resolve, 10));

      // A low-threshold compaction now merges *both* b1 and b2 away and drops a new
      // checkpoint sh2 after queryTime — sh1 is still "the nearest checkpoint before
      // queryTime", but its remainder (b2's update) is gone, so naively replaying from
      // sh1 would silently omit b2.
      await mutateDoc(
        pool,
        doc.id,
        "user",
        (ydoc) => {
          ydoc.getMap("blocks").set("b3", new Y.Map());
        },
        1,
      );

      await expect(docStore.openVersionAt(item.id, queryTime)).rejects.toBeInstanceOf(ValidationError);
    });

    it("openVersionAt on an item with no doc returns null", async () => {
      const item = await makeItem();
      expect(await docStore.openVersionAt(item.id, new Date())).toBeNull();
    });
  });
});
