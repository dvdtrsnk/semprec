import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { withClient } from "../../db/pool.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { purgeExpiredTrash } from "../purgeExpiredTrash.js";

// Passthrough spy, so the paging test can see how many candidates each page loaded.
vi.mock("../../chokePoint/itemsStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chokePoint/itemsStore.js")>();
  return { ...actual, findItemsDeletedBefore: vi.fn(actual.findItemsDeletedBefore) };
});

let pool: Pool;
let chokePoint: ChokePoint;

/** A storage double whose only exercised method is `delete`; the purge never reads or writes bytes. */
function fakeStorage(onDelete: (storageKey: string) => Promise<void> = async () => {}) {
  const deleteMock = vi.fn(onDelete);
  const storage: BlobStorageWriter = {
    writeStream: () => Promise.reject(new Error("not used by the purge")),
    readStream: () => {
      throw new Error("not used by the purge");
    },
    delete: deleteMock,
  };
  return { storage, deleteMock };
}

/** Backdates an already soft-deleted item's `deleted_at` past the retention cutoff, the way real trash ages over time. */
async function ageDeletion(itemId: string, daysAgo: number): Promise<void> {
  await pool.query(`UPDATE items SET deleted_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
    itemId,
    String(daysAgo),
  ]);
}

describe("purgeExpiredTrash (issue #156)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    vi.mocked(itemsStore.findItemsDeletedBefore).mockClear();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeMoviesDb() {
    return chokePoint.createDatabase({ name: "Movies" });
  }

  it("permanently removes an item trashed more than 30 days ago", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await chokePoint.softDeleteItem(db.id, item.id);
    await ageDeletion(item.id, 31);

    const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
    expect(purgedCount).toBe(1);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(0);
  });

  it("leaves a live item untouched", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });

    const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
    expect(purgedCount).toBe(0);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(1);
  });

  it("leaves an item trashed less than 30 days ago untouched", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await chokePoint.softDeleteItem(db.id, item.id);
    await ageDeletion(item.id, 5);

    const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
    expect(purgedCount).toBe(0);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(1);
  });

  it("purges the whole cascade subtree together with an eligible root", async () => {
    const rootDb = await makeMoviesDb();
    const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
    const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
    const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
    const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
    const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

    await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
    await ageDeletion(rootItem.id, 31);
    await ageDeletion(midItem.id, 31);
    await ageDeletion(leafItem.id, 31);

    const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
    expect(purgedCount).toBe(3);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = ANY($1)", [
      [rootItem.id, midItem.id, leafItem.id],
    ]);
    expect(rows).toHaveLength(0);
  });

  it("stops the cascade at a branch that is still live, leaving it and everything under it in place", async () => {
    const rootDb = await makeMoviesDb();
    const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
    await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
    await ageDeletion(rootItem.id, 31);

    // Added under the already-trashed root after the fact, so it was never part of the delete
    // cascade and is still live — the purge sweep must not treat it as part of the old root's subtree.
    const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
    const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
    const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
    const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

    const midBefore = await chokePoint.getItem(midDb.id, midItem.id);
    expect(midBefore?.deletedAt).toBeNull();

    const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
    expect(purgedCount).toBe(1);

    const { rows: midRows } = await pool.query("SELECT id FROM items WHERE id = $1", [midItem.id]);
    expect(midRows).toHaveLength(1);
    const { rows: leafRows } = await pool.query("SELECT id FROM items WHERE id = $1", [leafItem.id]);
    expect(leafRows).toHaveLength(1);
  });

  describe("chokePoint.purgeExpiredTrashSubtree", () => {
    const retentionCutoff = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    it("purges a subtree whose rows were all trashed before the cutoff entirely", async () => {
      const rootDb = await makeMoviesDb();
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
      const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });
      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      for (const id of [rootItem.id, midItem.id, leafItem.id]) await ageDeletion(id, 31);

      const { purgedItemIds: purgedIds } = await chokePoint.purgeExpiredTrashSubtree(rootItem.id, retentionCutoff());

      expect([...purgedIds].sort()).toEqual([rootItem.id, midItem.id, leafItem.id].sort());
      const { rows } = await pool.query("SELECT id FROM items WHERE id = ANY($1)", [
        [rootItem.id, midItem.id, leafItem.id],
      ]);
      expect(rows).toHaveLength(0);
    });

    it("keeps a nested live row and a nested too-fresh row with everything under them, purging their eligible sibling", async () => {
      const rootDb = await makeMoviesDb();
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const eligibleItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const freshItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const liveItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const freshLeafDb = await chokePoint.createInlineDatabase({ name: "FreshLeaf", parentItemId: freshItem.id });
      const freshLeaf = await chokePoint.createItem({ databaseId: freshLeafDb.id, properties: {} });
      const liveLeafDb = await chokePoint.createInlineDatabase({ name: "LiveLeaf", parentItemId: liveItem.id });
      const liveLeaf = await chokePoint.createItem({ databaseId: liveLeafDb.id, properties: {} });

      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      for (const id of [rootItem.id, eligibleItem.id, freshLeaf.id]) await ageDeletion(id, 31);
      await ageDeletion(freshItem.id, 5);
      // Restoring liveItem cascades to its leaf, leaving both live under an expired root.
      const restored = await chokePoint.restoreItem(midDb.id, liveItem.id);
      expect(restored?.deletedAt).toBeNull();

      const { purgedItemIds: purgedIds } = await chokePoint.purgeExpiredTrashSubtree(rootItem.id, retentionCutoff());

      expect([...purgedIds].sort()).toEqual([rootItem.id, eligibleItem.id].sort());
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE id = ANY($1)", [
        [freshItem.id, freshLeaf.id, liveItem.id, liveLeaf.id],
      ]);
      expect(rows.map((row) => row.id).sort()).toEqual([freshItem.id, freshLeaf.id, liveItem.id, liveLeaf.id].sort());
    });

    it("terminates on a parent_item_id cycle", async () => {
      const rootDb = await makeMoviesDb();
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      await ageDeletion(rootItem.id, 31);
      await ageDeletion(midItem.id, 31);
      // Corrupt the tree into a loop: the root's own database now hangs under its descendant.
      await pool.query("UPDATE databases SET parent_item_id = $1 WHERE id = $2", [midItem.id, rootDb.id]);

      const { purgedItemIds: purgedIds } = await chokePoint.purgeExpiredTrashSubtree(rootItem.id, retentionCutoff());

      expect([...purgedIds].sort()).toEqual([rootItem.id, midItem.id].sort());
    });
  });

  it("never hard-deletes an eligible item whose database has since been archived, leaving it for a future run", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await chokePoint.softDeleteItem(db.id, item.id);
    await ageDeletion(item.id, 31);
    await chokePoint.archiveDatabase(db.id);

    const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
    expect(purgedCount).toBe(0);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(1);
  });

  it("never destroys an item a concurrent restore un-deletes between the purge's eligibility scan and its delete loop", async () => {
    // itemsStore.hardDeleteItem is purgeExpiredTrashSubtree's only path to a permanent delete, and
    // its eligibility read has no row lock — this is the one guard standing between a race and
    // silently destroying an item a concurrent restoreItem just brought back to life. Exercised
    // directly here since the actual race (an interleaved restoreItem call mid-transaction) isn't
    // reproducible deterministically from a test.
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await chokePoint.softDeleteItem(db.id, item.id);
    await ageDeletion(item.id, 31);

    // Simulates a concurrent restoreItem committing after purgeExpiredTrashSubtree's eligibility
    // scan already read this row as trashed, but before its delete loop reaches it.
    const restored = await chokePoint.restoreItem(db.id, item.id);
    expect(restored?.deletedAt).toBeNull();

    const wasDeleted = await itemsStore.hardDeleteItem(pool, db.id, item.id);
    expect(wasDeleted).toBe(false);

    const { rows } = await pool.query("SELECT id, deleted_at FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).toBeNull();
  });
  describe("dependents, blobs and inline databases (issue #675)", () => {
    async function countRows(sql: string, params: unknown[]): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${sql}`, params);
      return Number(rows[0]?.count);
    }

    async function partitionExists(databaseId: string): Promise<boolean> {
      const { rows } = await pool.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [
        `items_p_${databaseId.replace(/-/g, "")}`,
      ]);
      return rows[0]?.exists === true;
    }

    async function makeFilesItem(databaseId: string, blobId: string) {
      const item = await chokePoint.createItem({ databaseId, properties: {} });
      await pool.query(
        `UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $2::text)) WHERE id = $1`,
        [item.id, blobId],
      );
      return item;
    }

    it("removes every dependent row of a purged page, its doc history and its emptied inline database", async () => {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const other = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const page = await chokePoint.createItem({ databaseId: db.id, properties: {}, idempotencyKey: "purge-page-key" });
      const inlineDb = await chokePoint.createInlineDatabase({ name: "Inline", parentItemId: page.id });
      const inlineRow = await chokePoint.createItem({ databaseId: inlineDb.id, properties: {} });

      const { rows: propRows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type) VALUES ($1, 'related', 'Related', 'relation') RETURNING id`,
        [db.id],
      );
      const { rows: relDefRows } = await pool.query<{ id: string }>(
        "INSERT INTO relation_definitions (property_id_a) VALUES ($1) RETURNING id",
        [propRows[0]?.id],
      );
      await pool.query(
        "INSERT INTO item_relations (relation_definition_id, item_a, item_b) VALUES ($1, $2, $3), ($1, $3, $4)",
        [relDefRows[0]?.id, page.id, other.id, inlineRow.id],
      );
      const { rows: viewRows } = await pool.query<{ id: string }>(
        `INSERT INTO views (database_id, type, name, config) VALUES (NULL, 'list', 'Curated', '{"membership":"manual"}') RETURNING id`,
      );
      await pool.query("INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, 0), ($1, $3, 1)", [
        viewRows[0]?.id,
        page.id,
        other.id,
      ]);
      const { rows: docRows } = await pool.query<{ id: string }>(
        "INSERT INTO docs (item_id, kind) VALUES ($1, 'page') RETURNING id",
        [page.id],
      );
      const docId = docRows[0]?.id;
      await pool.query("INSERT INTO doc_snapshots (doc_id, state, state_vector) VALUES ($1, '\\x00', '\\x00')", [
        docId,
      ]);
      await pool.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, '\\x00')", [docId]);
      await pool.query(
        `INSERT INTO doc_history_updates (update_id, doc_id, update, created_by, created_at, expires_at)
         VALUES (1, $1, '\\x00', 'user', now(), now() + interval '1 day')`,
        [docId],
      );
      await pool.query(
        `INSERT INTO doc_snapshot_history (doc_id, state, represented_at, expires_at, created_by) VALUES ($1, '\\x00', now(), now() + interval '1 day', 'user')`,
        [docId],
      );
      await pool.query(
        `INSERT INTO task_recurrence (item_id, mode, rule) VALUES ($1, 'fixed', '{}'), ($2, 'fixed', '{}')`,
        [page.id, inlineRow.id],
      );
      await pool.query("INSERT INTO item_automation (item_id) VALUES ($1)", [page.id]);
      await pool.query(
        `INSERT INTO item_search_index (item_id, database_id, search_vector)
         VALUES ($1, $2, to_tsvector('simple', 'page')), ($3, $4, to_tsvector('simple', 'row'))`,
        [page.id, db.id, inlineRow.id, inlineDb.id],
      );

      await chokePoint.softDeleteItem(db.id, page.id);
      await ageDeletion(page.id, 31);
      await ageDeletion(inlineRow.id, 31);

      const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
      expect(purgedCount).toBe(2);

      const purged = [page.id, inlineRow.id];
      expect(await countRows("item_relations WHERE item_a = ANY($1) OR item_b = ANY($1)", [purged])).toBe(0);
      expect(await countRows("view_items WHERE item_id = ANY($1)", [purged])).toBe(0);
      expect(await countRows("idempotency_keys WHERE item_id = ANY($1)", [purged])).toBe(0);
      expect(await countRows("docs WHERE item_id = ANY($1)", [purged])).toBe(0);
      for (const table of ["doc_snapshots", "doc_updates", "doc_history_updates", "doc_snapshot_history"]) {
        expect(await countRows(`${table} WHERE doc_id = $1`, [docId])).toBe(0);
      }
      expect(await countRows("task_recurrence WHERE item_id = ANY($1)", [purged])).toBe(0);
      expect(await countRows("item_automation WHERE item_id = ANY($1)", [purged])).toBe(0);
      expect(await countRows("item_search_index WHERE item_id = ANY($1)", [purged])).toBe(0);
      // The surviving item's own curated-view membership is untouched.
      const { rows: keptViewItems } = await pool.query<{ item_id: string }>("SELECT item_id FROM view_items");
      expect(keptViewItems.map((row) => row.item_id)).toEqual([other.id]);

      expect(await countRows("databases WHERE id = $1", [inlineDb.id])).toBe(0);
      expect(await countRows("properties WHERE database_id = $1", [inlineDb.id])).toBe(0);
      expect(await countRows("views WHERE database_id = $1", [inlineDb.id])).toBe(0);
      expect(await partitionExists(inlineDb.id)).toBe(false);
      const children = await withClient(pool, (client) => databasesStore.listDatabasesByParentItem(client, page.id));
      expect(children).toEqual([]);
      // The root's own database keeps its row and partition.
      expect(await partitionExists(db.id)).toBe(true);
    });

    it("drops an inline database whose rows an earlier root purged once its owning page is purged", async () => {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const page = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const inlineDb = await chokePoint.createInlineDatabase({ name: "Inline", parentItemId: page.id });
      const inlineRow = await chokePoint.createItem({ databaseId: inlineDb.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, page.id);
      await ageDeletion(page.id, 31);
      await ageDeletion(inlineRow.id, 31);
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // The nested row is a candidate of its own and may be reached first: its own database is
      // never dropped by that call.
      const first = await chokePoint.purgeExpiredTrashSubtree(inlineRow.id, cutoff);
      expect(first.purgedItemIds).toEqual([inlineRow.id]);
      expect(await partitionExists(inlineDb.id)).toBe(true);

      const second = await chokePoint.purgeExpiredTrashSubtree(page.id, cutoff);
      expect(second.purgedItemIds).toEqual([page.id]);
      expect(await countRows("databases WHERE id = $1", [inlineDb.id])).toBe(0);
      expect(await partitionExists(inlineDb.id)).toBe(false);
    });

    it("keeps an inline database and its partition when a nested live row stopped the cascade", async () => {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const page = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const inlineDb = await chokePoint.createInlineDatabase({ name: "Inline", parentItemId: page.id });
      const expiredRow = await chokePoint.createItem({ databaseId: inlineDb.id, properties: {} });
      const liveRow = await chokePoint.createItem({ databaseId: inlineDb.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, page.id);
      await ageDeletion(page.id, 31);
      await ageDeletion(expiredRow.id, 31);
      await chokePoint.restoreItem(inlineDb.id, liveRow.id);

      const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);
      expect(purgedCount).toBe(2);

      expect(await countRows("databases WHERE id = $1", [inlineDb.id])).toBe(1);
      expect(await partitionExists(inlineDb.id)).toBe(true);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [inlineDb.id]);
      expect(rows.map((row) => row.id)).toEqual([liveRow.id]);
    });

    it("keeps a blob shared with a live Files item and never deletes its bytes", async () => {
      const db = await chokePoint.createDatabase({ name: "Files" });
      const blob = await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "shared-key" });
      const purgedFile = await makeFilesItem(db.id, blob.id);
      await makeFilesItem(db.id, blob.id);
      await chokePoint.softDeleteItem(db.id, purgedFile.id);
      await ageDeletion(purgedFile.id, 31);

      const { storage, deleteMock } = fakeStorage();
      const purgedCount = await purgeExpiredTrash(pool, storage);

      expect(purgedCount).toBe(1);
      expect(await countRows("blobs WHERE id = $1", [blob.id])).toBe(1);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it("deletes an unshared blob's row in the purge transaction and its bytes after that transaction commits", async () => {
      const db = await chokePoint.createDatabase({ name: "Files" });
      const blob = await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "unshared-key" });
      const purgedFile = await makeFilesItem(db.id, blob.id);
      await chokePoint.softDeleteItem(db.id, purgedFile.id);
      await ageDeletion(purgedFile.id, 31);

      // Read on a separate connection: the row is only invisible there once the purge has committed.
      const blobRowsSeenByDelete: number[] = [];
      const { storage, deleteMock } = fakeStorage(async () => {
        blobRowsSeenByDelete.push(await countRows("blobs WHERE id = $1", [blob.id]));
      });
      const purgedCount = await purgeExpiredTrash(pool, storage);

      expect(purgedCount).toBe(1);
      expect(await countRows("blobs WHERE id = $1", [blob.id])).toBe(0);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith("unshared-key");
      expect(blobRowsSeenByDelete).toEqual([0]);
    });

    it("keeps a blob a mail attachment references", async () => {
      const db = await chokePoint.createDatabase({ name: "Files" });
      const blob = await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "mail-key" });
      const purgedFile = await makeFilesItem(db.id, blob.id);
      await pool.query(
        `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, disposition, byte_size)
         VALUES (gen_random_uuid(), $1, 'a.txt', 'text/plain', 'attachment', 3)`,
        [blob.id],
      );
      await chokePoint.softDeleteItem(db.id, purgedFile.id);
      await ageDeletion(purgedFile.id, 31);

      const { storage, deleteMock } = fakeStorage();
      expect(await purgeExpiredTrash(pool, storage)).toBe(1);

      expect(await countRows("blobs WHERE id = $1", [blob.id])).toBe(1);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it("logs a storage failure and carries on purging the rest of the sweep", async () => {
      const db = await chokePoint.createDatabase({ name: "Files" });
      const first = await makeFilesItem(
        db.id,
        (await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "failing-key" })).id,
      );
      const second = await makeFilesItem(
        db.id,
        (await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "working-key" })).id,
      );
      for (const item of [first, second]) {
        await chokePoint.softDeleteItem(db.id, item.id);
        await ageDeletion(item.id, 31);
      }
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { storage, deleteMock } = fakeStorage(async (key) => {
        if (key === "failing-key") throw new Error("storage down");
      });

      try {
        expect(await purgeExpiredTrash(pool, storage)).toBe(2);
        expect(deleteMock.mock.calls.map(([key]) => key).sort()).toEqual(["failing-key", "working-key"]);
        expect(errorSpy).toHaveBeenCalledTimes(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("purges more than one page of expired items, loading at most one page of candidates at a time", async () => {
      const db = await chokePoint.createDatabase({ name: "Bulk" });
      await pool.query(
        `INSERT INTO items (database_id, deleted_at)
         SELECT $1, now() - interval '31 days' FROM generate_series(1, 1001)`,
        [db.id],
      );

      const purgedCount = await purgeExpiredTrash(pool, fakeStorage().storage);

      expect(purgedCount).toBe(1001);
      expect(await countRows("items WHERE database_id = $1", [db.id])).toBe(0);
      const pageCalls = vi.mocked(itemsStore.findItemsDeletedBefore).mock;
      expect(pageCalls.calls).toHaveLength(3);
      expect(pageCalls.calls.map(([, , , limit]) => limit)).toEqual([500, 500, 500]);
      const pageSizes = await Promise.all(pageCalls.results.map(async (result) => (await result.value).length));
      expect(pageSizes).toEqual([500, 500, 1]);
    }, 120_000);
  });
});
