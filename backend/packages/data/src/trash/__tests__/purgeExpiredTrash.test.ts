import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { withClient, withTransaction } from "../../db/pool.js";
import { ForbiddenError } from "../../errors.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { TRANSCRIPTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { setActionItemState } from "../../transcription/transcriptActionItemStates.js";
import { purgeExpiredTrash } from "../purgeExpiredTrash.js";
import { logger } from "../logger.js";

// Passthrough spies: the paging test sees how many candidates each page loaded, and a test can make the hard delete
// refuse or archive a database between the candidate read and the purge.
vi.mock("../../chokePoint/itemsStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chokePoint/itemsStore.js")>();
  return {
    ...actual,
    findItemsDeletedBefore: vi.fn(actual.findItemsDeletedBefore),
    hardDeleteItem: vi.fn(actual.hardDeleteItem),
  };
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
async function ageDeletion(itemId: string, daysAgo: number, databaseId: string): Promise<void> {
  await pool.query(
    `UPDATE items SET deleted_at = now() - ($2 || ' days')::interval WHERE id = $1 AND database_id = $3`,
    [itemId, String(daysAgo), databaseId],
  );
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
    await ageDeletion(item.id, 31, db.id);

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
    await ageDeletion(item.id, 5, db.id);

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
    await ageDeletion(rootItem.id, 31, rootDb.id);
    await ageDeletion(midItem.id, 31, midDb.id);
    await ageDeletion(leafItem.id, 31, leafDb.id);

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
    const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
    const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
    const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
    const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

    // Trashing the root cascades to the whole subtree; restoring the mid item brings it and its
    // leaf back to life, leaving a live branch under an expired root. Only the root is then aged.
    await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
    const restored = await chokePoint.restoreItem(midDb.id, midItem.id);
    expect(restored?.deletedAt).toBeNull();
    await ageDeletion(rootItem.id, 31, rootDb.id);

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
      for (const [id, dbId] of [
        [rootItem.id, rootDb.id],
        [midItem.id, midDb.id],
        [leafItem.id, leafDb.id],
      ] satisfies [string, string][]) {
        await ageDeletion(id, 31, dbId);
      }

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
      for (const [id, dbId] of [
        [rootItem.id, rootDb.id],
        [eligibleItem.id, midDb.id],
        [freshLeaf.id, freshLeafDb.id],
      ] satisfies [string, string][]) {
        await ageDeletion(id, 31, dbId);
      }
      await ageDeletion(freshItem.id, 5, midDb.id);
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
      await ageDeletion(rootItem.id, 31, rootDb.id);
      await ageDeletion(midItem.id, 31, midDb.id);
      // Corrupt the tree into a loop: the root's own database now hangs under its descendant.
      await pool.query("UPDATE databases SET parent_item_id = $1 WHERE id = $2", [midItem.id, rootDb.id]);

      const { purgedItemIds: purgedIds } = await chokePoint.purgeExpiredTrashSubtree(rootItem.id, retentionCutoff());

      expect([...purgedIds].sort()).toEqual([rootItem.id, midItem.id].sort());
    });
  });

  describe("items of archived databases (issue gh-1878)", () => {
    /** An item deleted `daysAgo` days ago in a fresh database, with its trash age backdated like real trash. */
    async function trashedItemInNewDatabase(name: string, daysAgo: number) {
      const db = await chokePoint.createDatabase({ name });
      const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, item.id);
      await ageDeletion(item.id, daysAgo, db.id);
      return { db, item };
    }

    const itemRows = async (itemId: string) => (await pool.query("SELECT id FROM items WHERE id = $1", [itemId])).rows;

    it("leaves an item deleted 40 days ago in an archived database alone and logs no error", async () => {
      const { db, item } = await trashedItemInNewDatabase("Old", 40);
      await chokePoint.archiveDatabase(db.id);
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

      try {
        expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(0);

        expect(await itemRows(item.id)).toHaveLength(1);
        expect(errorSpy).not.toHaveBeenCalled();
        // The item is not even a candidate, so the quiet skip of the archived-meanwhile case has nothing to log.
        expect(debugSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        debugSpy.mockRestore();
      }
    });

    it("purges the same item on the next run once its database is restored", async () => {
      const { db, item } = await trashedItemInNewDatabase("Restored", 40);
      await chokePoint.archiveDatabase(db.id);
      expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(0);
      await chokePoint.restoreDatabase(db.id);

      expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(1);

      expect(await itemRows(item.id)).toHaveLength(0);
    });

    it("purges an expired item of a live database as before, next to one in an archived database", async () => {
      const live = await trashedItemInNewDatabase("Live", 40);
      const archived = await trashedItemInNewDatabase("Archived", 40);
      await chokePoint.archiveDatabase(archived.db.id);

      expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(1);

      expect(await itemRows(live.item.id)).toHaveLength(0);
      expect(await itemRows(archived.item.id)).toHaveLength(1);
    });

    it("skips quietly an item whose database was archived between the candidate read and the purge", async () => {
      const { db, item } = await trashedItemInNewDatabase("Archived meanwhile", 40);
      const actualFind = vi.mocked(itemsStore.findItemsDeletedBefore).getMockImplementation();
      vi.mocked(itemsStore.findItemsDeletedBefore).mockImplementationOnce(async (...args) => {
        const candidates = actualFind ? await actualFind(...args) : [];
        await chokePoint.archiveDatabase(db.id);
        return candidates;
      });
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

      try {
        expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(0);

        expect(await itemRows(item.id)).toHaveLength(1);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalledWith(
          { itemId: item.id },
          "Skipped a trashed item of a database that was archived meanwhile",
        );
      } finally {
        errorSpy.mockRestore();
        debugSpy.mockRestore();
      }
    });

    it("still logs a refusal that is not the archived-database one as an error", async () => {
      const { item } = await trashedItemInNewDatabase("Refused", 40);
      vi.mocked(itemsStore.hardDeleteItem).mockRejectedValueOnce(new ForbiddenError("Another refusal"));
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

      try {
        expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(0);

        expect(await itemRows(item.id)).toHaveLength(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.objectContaining({ itemId: item.id }),
          "Failed to purge trashed item",
        );
        expect(debugSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        debugSpy.mockRestore();
      }
    });
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
    await ageDeletion(item.id, 31, db.id);

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
      // The create hooks already indexed both items; assert the purge starts with real dependent rows.
      expect(await countRows("item_search_index WHERE item_id = ANY($1)", [[page.id, inlineRow.id]])).toBe(2);

      await chokePoint.softDeleteItem(db.id, page.id);
      await ageDeletion(page.id, 31, db.id);
      await ageDeletion(inlineRow.id, 31, inlineDb.id);

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
      expect(await countRows("item_search_index WHERE item_id = $1", [other.id])).toBe(1);
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

    it("removes the action item states of a purged transcript and keeps another transcript's (issue #1754)", async () => {
      const db = await chokePoint.createDatabase({
        name: "Transcripts",
        ownerModuleId: TRANSCRIPTS_MODULE_ID,
        system: true,
      });
      const purged = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const kept = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      await withTransaction(pool, async (client) => {
        for (const [transcriptId, actionItemId] of [
          [purged.id, 0],
          [purged.id, 1],
          [kept.id, 0],
        ] as const) {
          await setActionItemState(client, {
            transcriptId,
            actionItemId,
            state: "noted",
            taskItemId: null,
            ownerPersonId: null,
          });
        }
      });
      expect(await countRows("transcript_action_item_states WHERE transcript_item_id = $1", [purged.id])).toBe(2);

      await chokePoint.softDeleteItem(db.id, purged.id);
      await ageDeletion(purged.id, 31, db.id);

      expect(await purgeExpiredTrash(pool, fakeStorage().storage)).toBe(1);

      expect(await countRows("transcript_action_item_states WHERE transcript_item_id = $1", [purged.id])).toBe(0);
      expect(await countRows("transcript_action_item_states WHERE transcript_item_id = $1", [kept.id])).toBe(1);
    });

    it("drops an inline database whose rows an earlier root purged once its owning page is purged", async () => {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const page = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const inlineDb = await chokePoint.createInlineDatabase({ name: "Inline", parentItemId: page.id });
      const inlineRow = await chokePoint.createItem({ databaseId: inlineDb.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, page.id);
      await ageDeletion(page.id, 31, db.id);
      await ageDeletion(inlineRow.id, 31, inlineDb.id);
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
      await ageDeletion(page.id, 31, db.id);
      await ageDeletion(expiredRow.id, 31, inlineDb.id);
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
      await ageDeletion(purgedFile.id, 31, db.id);

      const { storage, deleteMock } = fakeStorage();
      const purgedCount = await purgeExpiredTrash(pool, storage);

      expect(purgedCount).toBe(1);
      expect(await countRows("blobs WHERE id = $1", [blob.id])).toBe(1);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it("keeps a blob an image property of a live item names and never deletes its bytes", async () => {
      const filesDb = await chokePoint.createDatabase({ name: "Files" });
      const recipes = await chokePoint.createDatabase({ name: "Recipes" });
      await chokePoint.createProperty({ databaseId: recipes.id, key: "photo", name: "Photo", type: "image" });
      const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 3, storageKey: "image-key" });
      const purgedFile = await makeFilesItem(filesDb.id, blob.id);
      await chokePoint.createItem({ databaseId: recipes.id, properties: { photo: { blobId: blob.id } } });
      await chokePoint.softDeleteItem(filesDb.id, purgedFile.id);
      await ageDeletion(purgedFile.id, 31, filesDb.id);

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
      await ageDeletion(purgedFile.id, 31, db.id);

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

    describe("derived audio blobs", () => {
      async function setComputed(itemId: string, prepare: Record<string, string>) {
        await pool.query(`UPDATE items SET computed = jsonb_build_object('prepare', $2::jsonb) WHERE id = $1`, [
          itemId,
          JSON.stringify(prepare),
        ]);
      }
      const newBlob = (storageKey: string) => createBlob(pool, { mimeType: "audio/ogg", byteSize: 3, storageKey });
      async function trash(databaseId: string, itemId: string) {
        await chokePoint.softDeleteItem(databaseId, itemId);
        await ageDeletion(itemId, 31, databaseId);
      }

      it("removes the original, normalized and playback rows and their bytes after the commit", async () => {
        const db = await chokePoint.createDatabase({ name: "Files" });
        const [original, normalized, playback] = [
          await newBlob("orig-key"),
          await newBlob("norm-key"),
          await newBlob("play-key"),
        ];
        const file = await makeFilesItem(db.id, original.id);
        await setComputed(file.id, { normalizedBlobId: normalized.id, playbackBlobId: playback.id });
        await trash(db.id, file.id);

        const rowsSeenByDelete: number[] = [];
        const { storage, deleteMock } = fakeStorage(async () => {
          rowsSeenByDelete.push(
            await countRows("blobs WHERE id = ANY($1::uuid[])", [[original.id, normalized.id, playback.id]]),
          );
        });
        expect(await purgeExpiredTrash(pool, storage)).toBe(1);

        expect(await countRows("blobs WHERE id = ANY($1::uuid[])", [[original.id, normalized.id, playback.id]])).toBe(
          0,
        );
        expect(deleteMock.mock.calls.map(([key]) => key).sort()).toEqual(["norm-key", "orig-key", "play-key"]);
        expect(rowsSeenByDelete).toEqual([0, 0, 0]);
      });

      it("keeps the Files item and all blobs and skips byte deletion when the purge transaction rolls back", async () => {
        const db = await chokePoint.createDatabase({ name: "Files" });
        const file = await makeFilesItem(db.id, (await newBlob("rollback-orig-key")).id);
        const originalId = (
          await pool.query<{ blob_id: string }>(
            "SELECT properties #>> '{file,blobId}' AS blob_id FROM items WHERE id = $1",
            [file.id],
          )
        ).rows[0]?.blob_id;
        if (!originalId) throw new Error("Files fixture did not retain its original blob id");
        const normalized = await newBlob("rollback-norm-key");
        const playback = await newBlob("rollback-play-key");
        await setComputed(file.id, { normalizedBlobId: normalized.id, playbackBlobId: playback.id });
        const inlineDb = await chokePoint.createInlineDatabase({ name: "Rollback blocker", parentItemId: file.id });
        await trash(db.id, file.id);

        // This test-only FK makes the final inline-database cleanup fail, after deleteItemDependents
        // has deleted all three blob rows inside the same purge transaction.
        await pool.query(
          "CREATE TABLE purge_rollback_database_guard (database_id uuid NOT NULL REFERENCES databases(id))",
        );
        await pool.query("INSERT INTO purge_rollback_database_guard (database_id) VALUES ($1)", [inlineDb.id]);

        const { storage, deleteMock } = fakeStorage();
        const purgeError = vi.spyOn(logger, "error").mockImplementation(() => {});
        try {
          expect(await purgeExpiredTrash(pool, storage)).toBe(0);
          expect(purgeError).toHaveBeenCalledWith(
            expect.objectContaining({
              err: expect.objectContaining({
                code: "23503",
                constraint: "purge_rollback_database_guard_database_id_fkey",
              }),
              itemId: file.id,
            }),
            "Failed to purge trashed item",
          );

          const { rows: fileRows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE id = $1", [file.id]);
          expect(fileRows.map((row) => row.id)).toEqual([file.id]);
          const { rows: blobRows } = await pool.query<{ id: string }>(
            "SELECT id FROM blobs WHERE id = ANY($1::uuid[])",
            [[originalId, normalized.id, playback.id]],
          );
          expect(blobRows.map((row) => row.id).sort()).toEqual([originalId, normalized.id, playback.id].sort());
          expect(deleteMock).not.toHaveBeenCalled();
        } finally {
          purgeError.mockRestore();
          await pool.query("DROP TABLE purge_rollback_database_guard");
        }
      });

      it("behaves as before for an item without a checkpoint", async () => {
        const db = await chokePoint.createDatabase({ name: "Files" });
        const original = await newBlob("only-key");
        const file = await makeFilesItem(db.id, original.id);
        await trash(db.id, file.id);
        const { storage, deleteMock } = fakeStorage();
        expect(await purgeExpiredTrash(pool, storage)).toBe(1);
        expect(deleteMock.mock.calls).toEqual([["only-key"]]);
      });

      it("deletes a playback blob equal to the original once", async () => {
        const db = await chokePoint.createDatabase({ name: "Files" });
        const original = await newBlob("same-key");
        const normalized = await newBlob("norm2-key");
        const file = await makeFilesItem(db.id, original.id);
        await setComputed(file.id, { normalizedBlobId: normalized.id, playbackBlobId: original.id });
        await trash(db.id, file.id);
        const { storage, deleteMock } = fakeStorage();
        expect(await purgeExpiredTrash(pool, storage)).toBe(1);
        expect(deleteMock.mock.calls.map(([key]) => key).sort()).toEqual(["norm2-key", "same-key"]);
      });

      it("keeps the original shared with another Files item while still removing derived blobs", async () => {
        const db = await chokePoint.createDatabase({ name: "Files" });
        const original = await newBlob("shared2-key");
        const normalized = await newBlob("norm3-key");
        const file = await makeFilesItem(db.id, original.id);
        await makeFilesItem(db.id, original.id);
        await setComputed(file.id, { normalizedBlobId: normalized.id });
        await trash(db.id, file.id);
        const { storage, deleteMock } = fakeStorage();
        expect(await purgeExpiredTrash(pool, storage)).toBe(1);
        expect(await countRows("blobs WHERE id = $1", [original.id])).toBe(1);
        expect(await countRows("blobs WHERE id = $1", [normalized.id])).toBe(0);
        expect(deleteMock.mock.calls).toEqual([["norm3-key"]]);
      });

      it("does not touch a derived blob of an item that was not purged", async () => {
        const db = await chokePoint.createDatabase({ name: "Files" });
        const normalized = await newBlob("live-norm-key");
        const live = await makeFilesItem(db.id, (await newBlob("live-key")).id);
        await setComputed(live.id, { normalizedBlobId: normalized.id });
        const { storage, deleteMock } = fakeStorage();
        await purgeExpiredTrash(pool, storage);
        expect(await countRows("blobs WHERE id = $1", [normalized.id])).toBe(1);
        expect(deleteMock).not.toHaveBeenCalled();
      });
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
      await ageDeletion(purgedFile.id, 31, db.id);

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
        await ageDeletion(item.id, 31, db.id);
      }
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const { storage, deleteMock } = fakeStorage(async (key) => {
        if (key === "failing-key") throw new Error("storage down");
      });

      try {
        expect(await purgeExpiredTrash(pool, storage)).toBe(2);
        expect(deleteMock.mock.calls.map(([key]) => key).sort()).toEqual(["failing-key", "working-key"]);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith({ itemId: first.id }, "Failed to delete blob bytes of a purged item");
        const logged = JSON.stringify(errorSpy.mock.calls);
        expect(logged).not.toContain("failing-key");
        expect(logged).not.toContain("storage down");
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
