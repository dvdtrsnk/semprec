import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import {
  registerItemDeleteHook,
  registerItemRestoreHook,
  type ItemDeleteHookContext,
  type ItemRestoreHookContext,
} from "../chokePoint/hooks.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

let pool: Pool;
let chokePoint: ChokePoint;

/**
 * What the delete and restore hooks of issue #1601 saw. The recorders are registered once for the file
 * (a registry has no unregister); each test starts with empty lists, and `veto` names the item whose
 * hook call rejects.
 */
const hookCalls: { delete: ItemDeleteHookContext[]; restore: ItemRestoreHookContext[] } = { delete: [], restore: [] };
let veto: { op: "delete" | "restore"; itemId: string } | null = null;

describe("choke-point itemTrash", () => {
  beforeAll(() => {
    registerItemDeleteHook(async (context) => {
      hookCalls.delete.push(context);
      if (veto?.op === "delete" && veto.itemId === context.item.id) throw new ValidationError("delete vetoed");
    });
    registerItemRestoreHook(async (context) => {
      hookCalls.restore.push(context);
      if (veto?.op === "restore" && veto.itemId === context.item.id) throw new ValidationError("restore vetoed");
    });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    hookCalls.delete = [];
    hookCalls.restore = [];
    veto = null;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeMoviesDb() {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
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

  describe("item delete and restore hooks (issue #1601)", () => {
    const rowState = z.array(z.object({ id: z.string(), deleted_at: z.string().nullable(), updated_at: z.string() }));

    /** Every row's `deleted_at` and `updated_at` as UTC text at full precision, to compare cascades exactly. */
    async function snapshot(ids: string[]) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT id::text,
                to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
           FROM items WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [ids],
      );
      return rowState.parse(rows);
    }

    async function makePage() {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const root = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: root.id });
      const mid = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const sibling = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: mid.id });
      const leaf = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });
      return { rootDb, root, midDb, mid, sibling, leafDb, leaf, ids: [root.id, mid.id, sibling.id, leaf.id] };
    }

    it("calls the delete hook once for every newly trashed row, root first, with the cascade's shared deletedAt", async () => {
      const { rootDb, root, midDb, mid, sibling, leafDb, leaf } = await makePage();
      await chokePoint.softDeleteItem(leafDb.id, leaf.id);
      hookCalls.delete = [];

      const deleted = await chokePoint.softDeleteItem(rootDb.id, root.id, "user-1", {
        writerKind: "agent",
        agentRunId: "run-1",
        onBehalfOfUserId: "user-1",
      });

      // The leaf was already in the trash, so the cascade did not trash it and its hook did not run. Rows of
      // one level come in no defined order; the root comes first.
      expect(hookCalls.delete[0]?.item.id).toBe(root.id);
      expect(hookCalls.delete.map((call) => call.item.id).sort()).toEqual([root.id, mid.id, sibling.id].sort());
      for (const call of hookCalls.delete) {
        expect(call.database.id).toBe(call.item.databaseId);
        expect([rootDb.id, midDb.id]).toContain(call.database.id);
        expect(call).toMatchObject({
          rootItemId: root.id,
          deletedAt: deleted?.deletedAt,
          writerKind: "agent",
          agentRunId: "run-1",
          actingUserId: "user-1",
        });
        expect(call.item.deletedAt).toBe(deleted?.deletedAt);
        expect(Object.keys(call).sort()).toEqual(
          ["actingUserId", "agentRunId", "client", "database", "deletedAt", "item", "rootItemId", "writerKind"].sort(),
        );
      }
      expect(hookCalls.restore).toEqual([]);
    });

    it("passes the system writer and no agent or user fields when the caller supplies none", async () => {
      const { rootDb, root } = await makePage();
      await chokePoint.softDeleteItem(rootDb.id, root.id);
      expect(hookCalls.delete).toHaveLength(4);
      for (const call of hookCalls.delete) {
        expect(call.writerKind).toBe("system");
        expect(Object.hasOwn(call, "agentRunId")).toBe(false);
        expect(Object.hasOwn(call, "actingUserId")).toBe(false);
      }
    });

    it("calls the restore hook only for the rows of the cascade epoch and skips a child trashed separately", async () => {
      const { rootDb, root, midDb, mid, sibling, leaf } = await makePage();
      // Trashed on its own (with its leaf) before the page: a different cascade.
      await chokePoint.softDeleteItem(midDb.id, mid.id);
      const deleted = await chokePoint.softDeleteItem(rootDb.id, root.id);
      hookCalls.delete = [];

      await chokePoint.restoreItem(rootDb.id, root.id, "user-1", { writerKind: "user" });

      expect(hookCalls.restore.map((call) => call.item.id)).toEqual([root.id, sibling.id]);
      for (const call of hookCalls.restore) {
        expect(call).toMatchObject({
          rootItemId: root.id,
          deletedAt: deleted?.deletedAt,
          writerKind: "user",
          actingUserId: "user-1",
        });
        expect(call.item.deletedAt).toBeNull();
      }
      expect((await chokePoint.getItem(midDb.id, mid.id))?.deletedAt).not.toBeNull();
      expect((await snapshot([leaf.id]))[0]?.deleted_at).not.toBeNull();
      expect(hookCalls.delete).toEqual([]);
    });

    it("tells a child trashed separately within the same millisecond apart from the cascade", async () => {
      const { rootDb, root, midDb, mid, sibling, leaf } = await makePage();
      await chokePoint.softDeleteItem(midDb.id, mid.id);
      await chokePoint.softDeleteItem(rootDb.id, root.id);
      // Two separate trash transactions starting within one millisecond cannot be produced on demand, so
      // the two epochs are relabelled on the admin pool to instants one microsecond apart. Each group keeps
      // one shared value, as a cascade leaves it.
      const cascade = await pool.query(
        "UPDATE items SET deleted_at = '2026-11-07 10:00:00.000100+00' WHERE id = ANY($1::uuid[])",
        [[root.id, sibling.id]],
      );
      const separate = await pool.query(
        "UPDATE items SET deleted_at = '2026-11-07 10:00:00.000101+00' WHERE id = ANY($1::uuid[])",
        [[mid.id, leaf.id]],
      );
      expect([cascade.rowCount, separate.rowCount]).toEqual([2, 2]);
      // An ItemRow keeps whole milliseconds, so both epochs read as the same string.
      const [rootRow, midRow] = [
        await chokePoint.getItem(rootDb.id, root.id),
        await chokePoint.getItem(midDb.id, mid.id),
      ];
      expect(rootRow?.deletedAt).toBe("2026-11-07T10:00:00.000Z");
      expect(midRow?.deletedAt).toBe(rootRow?.deletedAt);

      await chokePoint.restoreItem(rootDb.id, root.id);

      expect(hookCalls.restore.map((call) => call.item.id)).toEqual([root.id, sibling.id]);
      expect(Object.fromEntries((await snapshot([mid.id, leaf.id])).map((row) => [row.id, row.deleted_at]))).toEqual({
        [mid.id]: "2026-11-07T10:00:00.000101Z",
        [leaf.id]: "2026-11-07T10:00:00.000101Z",
      });
    });

    it("calls no hook for a delete of an already-trashed item or a restore of a live item", async () => {
      const { rootDb, root } = await makePage();
      await chokePoint.restoreItem(rootDb.id, root.id);
      expect(hookCalls.restore).toEqual([]);
      await chokePoint.softDeleteItem(rootDb.id, root.id);
      hookCalls.delete = [];
      await chokePoint.softDeleteItem(rootDb.id, root.id);
      expect(hookCalls.delete).toEqual([]);
      expect(hookCalls.restore).toEqual([]);
    });

    it("rolls the whole delete cascade back when a delete hook throws", async () => {
      const { rootDb, root, leaf, ids } = await makePage();
      const before = await snapshot(ids);
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        // The leaf is the last row of the cascade, so every other row was soft-deleted before the veto.
        veto = { op: "delete", itemId: leaf.id };
        await expect(chokePoint.softDeleteItem(rootDb.id, root.id)).rejects.toThrow("delete vetoed");
      } finally {
        setInvalidationHook(() => {});
      }
      expect(hookCalls.delete).toHaveLength(4);
      expect(hookCalls.delete.at(-1)?.item.id).toBe(leaf.id);
      expect(await snapshot(ids)).toEqual(before);
      expect(events).toEqual([]);
    });

    it("rolls the whole restore cascade back when a restore hook throws", async () => {
      const { rootDb, root, leaf, ids } = await makePage();
      await chokePoint.softDeleteItem(rootDb.id, root.id);
      const before = await snapshot(ids);
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        veto = { op: "restore", itemId: leaf.id };
        await expect(chokePoint.restoreItem(rootDb.id, root.id)).rejects.toThrow("restore vetoed");
      } finally {
        setInvalidationHook(() => {});
      }
      expect(hookCalls.restore).toHaveLength(4);
      expect(hookCalls.restore.at(-1)?.item.id).toBe(leaf.id);
      expect(await snapshot(ids)).toEqual(before);
      expect(before.every((row) => row.deleted_at !== null)).toBe(true);
      expect(events).toEqual([]);
    });
  });
});
