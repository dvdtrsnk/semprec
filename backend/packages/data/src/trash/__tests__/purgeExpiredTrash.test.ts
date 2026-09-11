import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { purgeExpiredTrash } from "../purgeExpiredTrash.js";

let pool: Pool;
let chokePoint: ChokePoint;

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

    const purgedCount = await purgeExpiredTrash(pool);
    expect(purgedCount).toBe(1);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(0);
  });

  it("leaves a live item untouched", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });

    const purgedCount = await purgeExpiredTrash(pool);
    expect(purgedCount).toBe(0);

    const { rows } = await pool.query("SELECT id FROM items WHERE id = $1", [item.id]);
    expect(rows).toHaveLength(1);
  });

  it("leaves an item trashed less than 30 days ago untouched", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await chokePoint.softDeleteItem(db.id, item.id);
    await ageDeletion(item.id, 5);

    const purgedCount = await purgeExpiredTrash(pool);
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

    const purgedCount = await purgeExpiredTrash(pool);
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

    const purgedCount = await purgeExpiredTrash(pool);
    expect(purgedCount).toBe(1);

    const { rows: midRows } = await pool.query("SELECT id FROM items WHERE id = $1", [midItem.id]);
    expect(midRows).toHaveLength(1);
    const { rows: leafRows } = await pool.query("SELECT id FROM items WHERE id = $1", [leafItem.id]);
    expect(leafRows).toHaveLength(1);
  });

  it("never hard-deletes an eligible item whose database has since been archived, leaving it for a future run", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await chokePoint.softDeleteItem(db.id, item.id);
    await ageDeletion(item.id, 31);
    await chokePoint.archiveDatabase(db.id);

    const purgedCount = await purgeExpiredTrash(pool);
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
});
