import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point itemTrash", () => {
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

  async function expectDatabaseArchived(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      expect.unreachable("expected a database_archived ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("database_archived");
    }
  }

  it("soft delete hides an item from getItem-via-list and restore brings it back", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.softDeleteItem(db.id, item.id);

    const { items: afterDelete } = await chokePoint.listItems(db.id);
    expect(afterDelete).toHaveLength(0);

    await chokePoint.restoreItem(db.id, item.id);
    const { items: afterRestore } = await chokePoint.listItems(db.id);
    expect(afterRestore).toHaveLength(1);
  });

  it("soft delete and restore of an item are rejected in an archived database", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.softDeleteItem(db.id, item.id);
    await chokePoint.restoreItem(db.id, item.id);

    await chokePoint.archiveDatabase(db.id);
    await expectDatabaseArchived(chokePoint.softDeleteItem(db.id, item.id));

    await chokePoint.restoreDatabase(db.id);
    await chokePoint.softDeleteItem(db.id, item.id);
    await chokePoint.archiveDatabase(db.id);
    await expectDatabaseArchived(chokePoint.restoreItem(db.id, item.id));
  });

  describe("item trash: cascade delete, restore, and archived rejection (issue #156)", () => {
    async function makePageWithInlineSubtree() {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });

      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const midSibling = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
      const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

      return { rootDb, rootItem, midDb, midItem, midSibling, leafDb, leafItem };
    }

    it("deleting a page cascades to every row in its inline databases, recursively, in one transaction", async () => {
      const { rootDb, rootItem, midDb, midItem, midSibling, leafDb, leafItem } = await makePageWithInlineSubtree();

      const deleted = await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      expect(deleted?.deletedAt).not.toBeNull();

      const midItemAfter = await chokePoint.getItem(midDb.id, midItem.id);
      const midSiblingAfter = await chokePoint.getItem(midDb.id, midSibling.id);
      const leafItemAfter = await chokePoint.getItem(leafDb.id, leafItem.id);
      expect(midItemAfter?.deletedAt).not.toBeNull();
      expect(midSiblingAfter?.deletedAt).not.toBeNull();
      expect(leafItemAfter?.deletedAt).not.toBeNull();
    });

    it("restoring the page brings back exactly the subtree the delete cascade trashed", async () => {
      const { rootDb, rootItem, midDb, midItem, midSibling, leafDb, leafItem } = await makePageWithInlineSubtree();
      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);

      const restored = await chokePoint.restoreItem(rootDb.id, rootItem.id);
      expect(restored?.deletedAt).toBeNull();

      const midItemAfter = await chokePoint.getItem(midDb.id, midItem.id);
      const midSiblingAfter = await chokePoint.getItem(midDb.id, midSibling.id);
      const leafItemAfter = await chokePoint.getItem(leafDb.id, leafItem.id);
      expect(midItemAfter?.deletedAt).toBeNull();
      expect(midSiblingAfter?.deletedAt).toBeNull();
      expect(leafItemAfter?.deletedAt).toBeNull();
    });

    it("rejects the entire cascade, writing nothing, when an inline database anywhere in the subtree is archived", async () => {
      const { rootDb, rootItem, midDb, leafDb } = await makePageWithInlineSubtree();
      await chokePoint.archiveDatabase(leafDb.id);

      await expectDatabaseArchived(chokePoint.softDeleteItem(rootDb.id, rootItem.id));

      const rootAfter = await chokePoint.getItem(rootDb.id, rootItem.id);
      expect(rootAfter?.deletedAt).toBeNull();
      const { items: midItemsAfter } = await chokePoint.listItems(midDb.id);
      expect(midItemsAfter).toHaveLength(2);
    });

    it("rejects the entire restore cascade when an inline database anywhere in the subtree is archived", async () => {
      const { rootDb, rootItem, leafDb } = await makePageWithInlineSubtree();
      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      await chokePoint.archiveDatabase(leafDb.id);

      await expectDatabaseArchived(chokePoint.restoreItem(rootDb.id, rootItem.id));

      const rootAfter = await chokePoint.getItem(rootDb.id, rootItem.id);
      expect(rootAfter?.deletedAt).not.toBeNull();
    });

    it("a repeat delete of an already-trashed page is an idempotent no-op, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const first = await chokePoint.softDeleteItem(db.id, item.id);

      const second = await chokePoint.softDeleteItem(db.id, item.id);
      expect(second?.id).toBe(item.id);
      expect(second?.deletedAt).toBe(first?.deletedAt);
    });

    it("a repeat restore of an already-live item is an idempotent no-op, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });

      const restored = await chokePoint.restoreItem(db.id, item.id);
      expect(restored?.id).toBe(item.id);
      expect(restored?.deletedAt).toBeNull();
    });

    it("restoring a page never resurrects a row that was independently trashed before the cascade, even though it sits in the same subtree", async () => {
      const { rootDb, rootItem, midDb, midItem } = await makePageWithInlineSubtree();

      // Trashed on its own, before the page above it was ever deleted — a deliberate, separate act.
      const independentlyDeleted = await chokePoint.softDeleteItem(midDb.id, midItem.id);
      expect(independentlyDeleted?.deletedAt).not.toBeNull();

      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      const restored = await chokePoint.restoreItem(rootDb.id, rootItem.id);
      expect(restored?.deletedAt).toBeNull();

      // The cascade restored everything it itself trashed, but must leave the independently
      // deleted row exactly as it found it — restoring it would silently undo an unrelated,
      // intentional delete.
      const midItemAfter = await chokePoint.getItem(midDb.id, midItem.id);
      expect(midItemAfter?.deletedAt).toBe(independentlyDeleted?.deletedAt);
    });

    it("two concurrent restores of the same trashed item both resolve to the live row, never a spurious 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.softDeleteItem(db.id, item.id);

      const [first, second] = await Promise.all([
        chokePoint.restoreItem(db.id, item.id),
        chokePoint.restoreItem(db.id, item.id),
      ]);
      expect(first?.id).toBe(item.id);
      expect(second?.id).toBe(item.id);
      expect(first?.deletedAt).toBeNull();
      expect(second?.deletedAt).toBeNull();
    });
  });
});
