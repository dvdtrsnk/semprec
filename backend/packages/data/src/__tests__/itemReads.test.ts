import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point itemReads", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeMoviesDb() {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "rating",
      name: "Rating",
      type: "number",
      owner: "system",
      ownerProcess: "critics.rate",
    });
    return db;
  }

  describe("findItem", () => {
    it("returns the item for an existing id, cross-partition", async () => {
      const db = await makeMoviesDb();
      const created = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });

      const found = await chokePoint.findItem(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.databaseId).toBe(db.id);
      expect(found?.properties).toEqual({ title: "Arrival" });
    });

    it("returns null for an unknown id", async () => {
      const found = await chokePoint.findItem(randomUUID());
      expect(found).toBeNull();
    });

    it("findItemIncludingDeleted returns a live item", async () => {
      const db = await makeMoviesDb();
      const created = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });

      const found = await chokePoint.findItemIncludingDeleted(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.databaseId).toBe(db.id);
      expect(found?.properties).toEqual({ title: "Arrival" });
      expect(found?.deletedAt).toBeNull();
    });

    it("findItemIncludingDeleted returns a trashed item with deletedAt set", async () => {
      const db = await makeMoviesDb();
      const created = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
      await chokePoint.softDeleteItem(db.id, created.id);

      expect(await chokePoint.findItem(created.id)).toBeNull();
      const found = await chokePoint.findItemIncludingDeleted(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.databaseId).toBe(db.id);
      expect(found?.deletedAt).not.toBeNull();
    });

    it("findItemIncludingDeleted returns null for an unknown id", async () => {
      const found = await chokePoint.findItemIncludingDeleted(randomUUID());
      expect(found).toBeNull();
    });
  });

  describe("getItemPath", () => {
    it("walks parent_item_id outward, root-first, ending with the item itself", async () => {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const path = await chokePoint.getItemPath(midItem.id);
      expect(path.map((item) => item.id)).toEqual([rootItem.id, midItem.id]);
    });

    it("stops rather than looping forever if parent_item_id ever forms a cycle", async () => {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      // Only reachable via corrupted data, not through the choke-point's own API — closes the
      // loop root -> mid -> root, which `getItemPath`'s while loop must not spin on forever.
      await pool.query("UPDATE databases SET parent_item_id = $1 WHERE id = $2", [midItem.id, rootDb.id]);

      const path = await chokePoint.getItemPath(rootItem.id);
      expect(path.length).toBeGreaterThan(0);
      expect(path.length).toBeLessThanOrEqual(3);
      // Load-bearing for `itemsHandler.ts`'s GET route, which derives the requested item from
      // `path.at(-1)` rather than a separate lookup: the chain must still end with the item that
      // was actually asked for, even when the cycle guard cuts the walk short.
      expect(path.at(-1)?.id).toBe(rootItem.id);
    });
  });
});
