import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createBlob } from "../blobs/blobsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { clearHooksForTests, registerItemPurgeHook, type ItemPurgeHookContext } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { beginTenantDeletion } from "../tenancy/deleteAccount.js";
import { handleTenantPurgeTask } from "../tenancy/tenantPurgeJob.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { TRANSCRIPTION_PREPARE_COMPUTED_KEY } from "../transcription/transcriptionComputedKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";

// The item purge hook registry and its call from the permanent purge:
// docs/adr/2026-11-10-item-purge-domain-hooks.md.

/** The superuser pool: resets, DDL, backdating, and reads from outside a purge transaction that see every tenant's rows. */
let admin: Pool;
/** The `semprec_data` runtime role, subject to row-level security: every production call and every hook runs on it. */
let pool: Pool;
let cp: ChokePoint;
let tenant: string;

/** A cutoff every trashed row is older than, so a test needs no backdating to make its trash eligible. */
const EVERYTHING_EXPIRED = new Date("2999-01-01T00:00:00Z");

/** Registers a purge hook that records every context it receives and then runs `act`. */
function recordPurgeHook(act: (context: ItemPurgeHookContext) => Promise<void> = async () => {}) {
  const calls: ItemPurgeHookContext[] = [];
  registerItemPurgeHook(async (context) => {
    calls.push(context);
    await act(context);
  });
  return calls;
}

/** A page with two rows in an inline database and one row nested under the first of them; every item reserves an idempotency key. */
async function makePage() {
  const rootDb = await cp.createDatabase({ name: "Root" });
  await cp.createProperty({ databaseId: rootDb.id, key: "title", name: "Title", type: "text" });
  const root = await cp.createItem({
    databaseId: rootDb.id,
    properties: { title: "Page" },
    idempotencyKey: "page-root",
  });
  const midDb = await cp.createInlineDatabase({ name: "Mid", parentItemId: root.id });
  const mid = await cp.createItem({ databaseId: midDb.id, properties: {}, idempotencyKey: "page-mid" });
  const sibling = await cp.createItem({ databaseId: midDb.id, properties: {}, idempotencyKey: "page-sibling" });
  const leafDb = await cp.createInlineDatabase({ name: "Leaf", parentItemId: mid.id });
  const leaf = await cp.createItem({ databaseId: leafDb.id, properties: {}, idempotencyKey: "page-leaf" });
  return { rootDb, root, midDb, mid, sibling, leafDb, leaf, ids: [root.id, mid.id, sibling.id, leaf.id] };
}

/** The stored rows of `ids`, trashed ones included, by id; read in the caller's tenant. */
async function storedItems(ids: string[]): Promise<Map<string, ItemRow>> {
  const rows = await withTransaction(pool, (client) => itemsStore.getItemsByIdsIncludingDeleted(client, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The stored database rows of `ids`, by id; read in the caller's tenant. */
async function storedDatabases(ids: string[]): Promise<Map<string, DatabaseRow>> {
  return withTransaction(pool, async (client) => {
    const databases = new Map<string, DatabaseRow>();
    for (const id of ids) {
      const database = await databasesStore.getDatabase(client, id);
      if (!database) throw new Error(`Missing database ${id}`);
      databases.set(id, database);
    }
    return databases;
  });
}

/** Which of `ids` still have an `items` row, in any tenant, as `{ id, trashed }` ordered by id. */
async function itemStates(ids: string[]): Promise<{ id: string; trashed: boolean }[]> {
  const { rows } = await admin.query<{ id: string; trashed: boolean }>(
    "SELECT id::text AS id, deleted_at IS NOT NULL AS trashed FROM items WHERE id = ANY($1::uuid[]) ORDER BY id",
    [ids],
  );
  return rows;
}

/** Every row's `deleted_at` and `updated_at` as UTC text at full precision, to compare a rolled-back purge exactly. */
async function snapshot(ids: string[]): Promise<{ id: string; deleted_at: string | null; updated_at: string }[]> {
  const { rows } = await admin.query<{ id: string; deleted_at: string | null; updated_at: string }>(
    `SELECT id::text AS id,
            to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM items WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  return rows;
}

/** The item ids that still hold their idempotency reservation, one of the purge's built-in dependents, ordered by id. */
async function reservedItemIds(ids: string[]): Promise<string[]> {
  const { rows } = await admin.query<{ item_id: string }>(
    "SELECT item_id::text AS item_id FROM idempotency_keys WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
    [ids],
  );
  return rows.map((row) => row.item_id);
}

/**
 * Creates a table of this file's own that stands in for a domain's rows keyed by item id, which nothing
 * but a purge hook removes, with one row per id. `afterEach` drops it.
 */
async function createDomainRows(itemIds: string[]): Promise<void> {
  await admin.query("CREATE TABLE item_purge_hook_test_rows (item_id uuid PRIMARY KEY)");
  await admin.query("GRANT SELECT, DELETE ON item_purge_hook_test_rows TO semprec_data");
  // Raw SQL: no production writer exists for a table this file creates.
  await admin.query("INSERT INTO item_purge_hook_test_rows (item_id) SELECT unnest($1::uuid[])", [itemIds]);
}

async function domainRowItemIds(): Promise<string[]> {
  const { rows } = await admin.query<{ item_id: string }>(
    "SELECT item_id::text AS item_id FROM item_purge_hook_test_rows ORDER BY item_id",
  );
  return rows.map((row) => row.item_id);
}

/** Backdates trashed rows to `deletedAt`: real trash ages over time and no production write sets `deleted_at` to a past instant. */
async function setDeletedAt(ids: string[], deletedAt: string): Promise<void> {
  const result = await admin.query(
    "UPDATE items SET deleted_at = $2::timestamptz WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
    [ids, deletedAt],
  );
  expect(result.rowCount).toBe(ids.length);
}

const sorted = (ids: string[]): string[] => [...ids].sort();

/** `rows` in the order `itemStates` returns them: by id, as text. */
const byId = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

describe("item purge hooks", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    const role = await runAsSystem("verify item purge hook role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    // Every test starts with empty registries and registers the hooks it needs; a registry has no unregister.
    clearHooksForTests();
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });

  afterEach(async () => {
    await admin.query("DROP TABLE IF EXISTS item_purge_hook_test_rows");
  });

  afterAll(async () => {
    clearHooksForTests();
    await pool?.end();
    await admin?.end();
  });

  it("calls a purge hook exactly once for every row of a purged subtree, with the removed row, its database and the root id", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      const before = await storedItems(page.ids);
      const databases = await storedDatabases([page.rootDb.id, page.midDb.id, page.leafDb.id]);
      const calls = recordPurgeHook();

      const purged = await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);

      expect(sorted(purged.purgedItemIds)).toEqual(sorted(page.ids));
      // One call per removed row, in the order the purge removed them: the root first, the leaf last.
      expect(calls.map((call) => call.item.id)).toEqual(purged.purgedItemIds);
      expect(calls[0]?.item.id).toBe(page.root.id);
      expect(calls.at(-1)?.item.id).toBe(page.leaf.id);
      for (const call of calls) {
        const row = before.get(call.item.id);
        expect(row?.deletedAt).not.toBeNull();
        expect(call.item).toEqual(row);
        expect(call.database).toEqual(databases.get(call.item.databaseId));
        expect(call.rootItemId).toBe(page.root.id);
        expect(Object.keys(call).sort()).toEqual(["client", "database", "item", "rootItemId"]);
      }
      expect(calls[0]?.item.properties).toEqual({ title: "Page" });
      expect(await itemStates(page.ids)).toEqual([]);
    });
  });

  it("runs every registered hook in registration order, and a hook registered twice only once", async () => {
    await runInTenant(tenant, async () => {
      const database = await cp.createDatabase({ name: "Notes" });
      const item = await cp.createItem({ databaseId: database.id, properties: {} });
      await cp.softDeleteItem(database.id, item.id);
      const order: string[] = [];
      const first = async (context: ItemPurgeHookContext): Promise<void> => {
        order.push(`first:${context.item.id}`);
      };
      registerItemPurgeHook(first);
      registerItemPurgeHook(async (context) => {
        order.push(`second:${context.item.id}`);
      });
      registerItemPurgeHook(first);

      await cp.purgeExpiredTrashSubtree(item.id, EVERYTHING_EXPIRED);

      expect(order).toEqual([`first:${item.id}`, `second:${item.id}`]);
    });
  });

  it("runs the hook after the row and its built-in dependents are gone, and commits what the hook deletes through its client", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      const keptDb = await cp.createDatabase({ name: "Kept" });
      const kept = await cp.createItem({ databaseId: keptDb.id, properties: {}, idempotencyKey: "kept" });
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      await createDomainRows([...page.ids, kept.id]);
      expect(await reservedItemIds([...page.ids, kept.id])).toEqual(sorted([...page.ids, kept.id]));

      const seen: { itemId: string; own: number; outside: number; reservations: number; deleted: number | null }[] = [];
      recordPurgeHook(async ({ client, item }) => {
        const own = await client.query<{ id: string }>("SELECT id::text AS id FROM items WHERE id = $1", [item.id]);
        // Another connection still sees the row: its removal is uncommitted, so only the purge's own client misses it.
        const outside = await admin.query<{ id: string }>("SELECT id::text AS id FROM items WHERE id = $1", [item.id]);
        const reservations = await client.query<{ item_id: string }>(
          "SELECT item_id::text AS item_id FROM idempotency_keys WHERE item_id = $1",
          [item.id],
        );
        const deleted = await client.query("DELETE FROM item_purge_hook_test_rows WHERE item_id = $1", [item.id]);
        seen.push({
          itemId: item.id,
          own: own.rows.length,
          outside: outside.rows.length,
          reservations: reservations.rows.length,
          deleted: deleted.rowCount,
        });
      });

      const purged = await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);

      expect(seen).toEqual(
        purged.purgedItemIds.map((itemId) => ({ itemId, own: 0, outside: 1, reservations: 0, deleted: 1 })),
      );
      expect(seen).toHaveLength(4);
      // Committed with the purge: the purged items' rows are gone, the unrelated item's row is untouched.
      expect(await domainRowItemIds()).toEqual([kept.id]);
      expect(await reservedItemIds([...page.ids, kept.id])).toEqual([kept.id]);
      expect(await itemStates([...page.ids, kept.id])).toEqual([{ id: kept.id, trashed: false }]);
    });
  });

  it("calls no hook for a nested row that is live or was trashed after the cutoff, nor for anything under it", async () => {
    await runInTenant(tenant, async () => {
      const rootDb = await cp.createDatabase({ name: "Root" });
      const root = await cp.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await cp.createInlineDatabase({ name: "Mid", parentItemId: root.id });
      const eligible = await cp.createItem({ databaseId: midDb.id, properties: {} });
      const fresh = await cp.createItem({ databaseId: midDb.id, properties: {} });
      const live = await cp.createItem({ databaseId: midDb.id, properties: {} });
      const freshLeafDb = await cp.createInlineDatabase({ name: "FreshLeaf", parentItemId: fresh.id });
      const freshLeaf = await cp.createItem({ databaseId: freshLeafDb.id, properties: {} });
      await cp.softDeleteItem(rootDb.id, root.id);
      const restored = await cp.restoreItem(midDb.id, live.id);
      expect(restored?.deletedAt).toBeNull();
      await setDeletedAt([root.id, eligible.id, freshLeaf.id], "2026-01-01T00:00:00Z");
      await setDeletedAt([fresh.id], "2026-03-01T00:00:00Z");
      const calls = recordPurgeHook();

      const purged = await cp.purgeExpiredTrashSubtree(root.id, new Date("2026-02-01T00:00:00Z"));

      expect(sorted(purged.purgedItemIds)).toEqual(sorted([root.id, eligible.id]));
      expect(calls.map((call) => call.item.id)).toEqual(purged.purgedItemIds);
      // The too-fresh row stopped its branch, so the expired row under it was not reached either.
      expect(await itemStates([root.id, eligible.id, fresh.id, freshLeaf.id, live.id])).toEqual(
        byId([
          { id: fresh.id, trashed: true },
          { id: freshLeaf.id, trashed: true },
          { id: live.id, trashed: false },
        ]),
      );
    });
  });

  it("calls no hook when the root itself is live or was trashed after the cutoff", async () => {
    await runInTenant(tenant, async () => {
      const database = await cp.createDatabase({ name: "Notes" });
      const live = await cp.createItem({ databaseId: database.id, properties: {} });
      const fresh = await cp.createItem({ databaseId: database.id, properties: {} });
      await cp.softDeleteItem(database.id, fresh.id);
      const calls = recordPurgeHook();

      const liveResult = await cp.purgeExpiredTrashSubtree(live.id, EVERYTHING_EXPIRED);
      // Every real `deleted_at` is later than the epoch, so this root is too fresh for the cutoff.
      const freshResult = await cp.purgeExpiredTrashSubtree(fresh.id, new Date(0));

      expect(liveResult.purgedItemIds).toEqual([]);
      expect(freshResult.purgedItemIds).toEqual([]);
      expect(calls).toEqual([]);
      expect(await itemStates([live.id, fresh.id])).toEqual(
        byId([
          { id: live.id, trashed: false },
          { id: fresh.id, trashed: true },
        ]),
      );
    });
  });

  it("calls no hook for a row a restore brought back after the purge read it and before the purge reached it", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      // The purge removes the root first and runs its hook before it reaches another row. By then it has
      // read `mid` and `leaf` as trashed; the restore below commits on another connection inside that
      // hook call, so both are live again when the purge comes to delete them.
      const restoredDeletedAt: (string | null | undefined)[] = [];
      const calls = recordPurgeHook(async ({ item }) => {
        if (item.id !== page.root.id) return;
        restoredDeletedAt.push((await cp.restoreItem(page.midDb.id, page.mid.id))?.deletedAt);
      });

      const purged = await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);

      expect(restoredDeletedAt).toEqual([null]);
      expect(purged.purgedItemIds).toEqual([page.root.id, page.sibling.id]);
      expect(calls.map((call) => call.item.id)).toEqual([page.root.id, page.sibling.id]);
      expect(await itemStates(page.ids)).toEqual(
        byId([
          { id: page.mid.id, trashed: false },
          { id: page.leaf.id, trashed: false },
        ]),
      );
      // The restored rows keep their built-in dependents.
      expect(await reservedItemIds(page.ids)).toEqual(sorted([page.mid.id, page.leaf.id]));
    });
  });

  it("gives the hook the row as it was removed when a restore, an edit and a new trash of it committed after the purge read it", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      await cp.createProperty({ databaseId: page.midDb.id, key: "note", name: "Note", type: "text" });
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      const readByTheWalk = (await storedItems([page.mid.id])).get(page.mid.id);
      // The purge removes the root first and runs its hook before it reaches another row. By then its
      // walk has read `mid` as the row above; the three writes below commit on other connections inside
      // that hook call and leave `mid` in the trash again, with other properties and another `deletedAt`.
      const storedAfterTheWrites: (ItemRow | undefined)[] = [];
      const calls = recordPurgeHook(async ({ item }) => {
        if (item.id !== page.root.id) return;
        await cp.restoreItem(page.midDb.id, page.mid.id);
        await cp.updateItem({ databaseId: page.midDb.id, itemId: page.mid.id, propertiesPatch: { note: "edited" } });
        await cp.softDeleteItem(page.midDb.id, page.mid.id);
        storedAfterTheWrites.push((await storedItems([page.mid.id])).get(page.mid.id));
      });

      const purged = await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);

      expect(sorted(purged.purgedItemIds)).toEqual(sorted(page.ids));
      expect(calls.map((call) => call.item.id)).toEqual(purged.purgedItemIds);
      expect(readByTheWalk?.properties).toEqual({});
      expect(storedAfterTheWrites).toHaveLength(1);
      expect(storedAfterTheWrites[0]?.properties).toEqual({ note: "edited" });
      expect(storedAfterTheWrites[0]?.deletedAt).not.toBeNull();
      // Every field: the properties, `deletedAt` and `updatedAt` of the row the purge deleted.
      expect(calls.find((call) => call.item.id === page.mid.id)?.item).toEqual(storedAfterTheWrites[0]);
      expect(await itemStates(page.ids)).toEqual([]);
    });
  });

  it("gives the hook a computed value written after the purge read the row, and has already deleted the derived blob that value names", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      const blob = await withTransaction(pool, (client) =>
        createBlob(client, { mimeType: "audio/ogg", byteSize: 3, storageKey: "derived-after-the-walk" }),
      );
      const prepare = { normalizedBlobId: blob.id };
      expect((await storedItems([page.mid.id])).get(page.mid.id)?.computed).toEqual({});
      // Inside the root's hook call the purge's walk has read `mid` without a checkpoint. A computed-value
      // write needs no live row; this one commits on another connection before the purge reaches `mid`.
      const blobRowsSeenByHook: number[] = [];
      const calls = recordPurgeHook(async ({ client, item }) => {
        if (item.id === page.root.id) {
          await withTransaction(pool, (other) =>
            itemsStore.writeComputed(other, page.midDb.id, page.mid.id, TRANSCRIPTION_PREPARE_COMPUTED_KEY, prepare),
          );
        }
        if (item.id === page.mid.id) {
          const { rows } = await client.query<{ id: string }>("SELECT id::text AS id FROM blobs WHERE id = $1", [
            blob.id,
          ]);
          blobRowsSeenByHook.push(rows.length);
        }
      });

      const purged = await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);

      expect(sorted(purged.purgedItemIds)).toEqual(sorted(page.ids));
      expect(calls.find((call) => call.item.id === page.mid.id)?.item.computed).toEqual({
        [TRANSCRIPTION_PREPARE_COMPUTED_KEY]: prepare,
      });
      // A built-in dependent of the row as it was removed: gone before that row's hook ran, and reported.
      expect(blobRowsSeenByHook).toEqual([0]);
      expect(purged.blobStorageKeys).toEqual(["derived-after-the-walk"]);
      const { rows } = await admin.query<{ id: string }>("SELECT id::text AS id FROM blobs WHERE id = $1", [blob.id]);
      expect(rows).toEqual([]);
    });
  });

  it("calls no hook for a row another transaction removed after the purge read it and before the purge reached it", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      // Inside the root's hook call the purge's walk has read `leaf`. The delete below commits on another
      // connection before the purge reaches that row; it stands in for whatever removes an item row while
      // a purge call runs, since the tenant's purge lock keeps every other purge call of the tenant out.
      const removedElsewhere: boolean[] = [];
      const calls = recordPurgeHook(async ({ item }) => {
        if (item.id !== page.root.id) return;
        removedElsewhere.push(
          await withTransaction(pool, (other) => itemsStore.hardDeleteItem(other, page.leafDb.id, page.leaf.id)),
        );
      });

      const purged = await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);

      expect(removedElsewhere).toEqual([true]);
      expect(sorted(purged.purgedItemIds)).toEqual(sorted([page.root.id, page.mid.id, page.sibling.id]));
      expect(calls.map((call) => call.item.id)).toEqual(purged.purgedItemIds);
      expect(await itemStates(page.ids)).toEqual([]);
      // The purge deletes the built-in dependents of the rows it removed, not those of a row it did not.
      expect(await reservedItemIds(page.ids)).toEqual([page.leaf.id]);
    });
  });

  it("fails the purge with the hook's error and keeps every row, dependent and hook deletion of the subtree", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      await createDomainRows(page.ids);
      const before = await snapshot(page.ids);
      const failure = new ValidationError("purge vetoed");
      const deletedByHook: (number | null)[] = [];
      const calls = recordPurgeHook(async ({ client, item }) => {
        const deleted = await client.query("DELETE FROM item_purge_hook_test_rows WHERE item_id = $1", [item.id]);
        deletedByHook.push(deleted.rowCount);
      });
      // The leaf is the last row of the walk: every row was removed and every earlier hook call had
      // deleted its domain row before this rejection.
      registerItemPurgeHook(async ({ item }) => {
        if (item.id === page.leaf.id) throw failure;
      });
      const afterTheVeto = recordPurgeHook();

      await expect(cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED)).rejects.toBe(failure);

      expect(calls).toHaveLength(4);
      expect(calls.at(-1)?.item.id).toBe(page.leaf.id);
      expect(deletedByHook).toEqual([1, 1, 1, 1]);
      // The first rejection stops the hooks registered after it for that row.
      expect(sorted(afterTheVeto.map((call) => call.item.id))).toEqual(
        sorted([page.root.id, page.mid.id, page.sibling.id]),
      );
      expect(await snapshot(page.ids)).toEqual(before);
      expect(before.map((row) => row.deleted_at !== null)).toEqual([true, true, true, true]);
      expect(await reservedItemIds(page.ids)).toEqual(sorted(page.ids));
      expect(await domainRowItemIds()).toEqual(sorted(page.ids));
      expect([...(await storedDatabases([page.midDb.id, page.leafDb.id])).keys()]).toEqual([
        page.midDb.id,
        page.leafDb.id,
      ]);
    });
  });

  it("gives the hook a client in the purging tenant's scope that does not return another tenant's rows", async () => {
    const foreign = await createTestTenant(admin);
    const other = await runInTenant(foreign, async () => {
      const database = await cp.createDatabase({ name: "Foreign" });
      const item = await cp.createItem({ databaseId: database.id, properties: {} });
      return { databaseId: database.id, itemId: item.id };
    });
    await runInTenant(tenant, async () => {
      const database = await cp.createDatabase({ name: "Own" });
      const kept = await cp.createItem({ databaseId: database.id, properties: {} });
      const trashed = await cp.createItem({ databaseId: database.id, properties: {} });
      await cp.softDeleteItem(database.id, trashed.id);
      const seen: { tenantId: string | null; role: string; itemIds: string[]; databaseIds: string[] }[] = [];
      recordPurgeHook(async ({ client }) => {
        const scope = await client.query<{ tenant_id: string | null; role: string }>(
          "SELECT app_tenant_default()::text AS tenant_id, current_user::text AS role",
        );
        const items = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[kept.id, other.itemId]],
        );
        const databases = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM databases WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[database.id, other.databaseId]],
        );
        seen.push({
          tenantId: scope.rows[0]?.tenant_id ?? null,
          role: scope.rows[0]?.role ?? "",
          itemIds: items.rows.map((row) => row.id),
          databaseIds: databases.rows.map((row) => row.id),
        });
      });

      const purged = await cp.purgeExpiredTrashSubtree(trashed.id, EVERYTHING_EXPIRED);

      expect(purged.purgedItemIds).toEqual([trashed.id]);
      // The hook's own tenant's rows are returned, the other tenant's are not.
      expect(seen).toEqual([
        { tenantId: tenant, role: "semprec_data", itemIds: [kept.id], databaseIds: [database.id] },
      ]);
    });
    // Both rows the hook asked for exist: only its scope kept the foreign one out of its result.
    expect((await itemStates([other.itemId])).map((row) => row.id)).toEqual([other.itemId]);
    const { rows } = await admin.query<{ id: string }>("SELECT id::text AS id FROM databases WHERE id = $1", [
      other.databaseId,
    ]);
    expect(rows.map((row) => row.id)).toEqual([other.databaseId]);
  });

  it("calls no purge hook when an item is trashed or restored", async () => {
    await runInTenant(tenant, async () => {
      const page = await makePage();
      const calls = recordPurgeHook();

      const trashed = await cp.softDeleteItem(page.rootDb.id, page.root.id);
      const restored = await cp.restoreItem(page.rootDb.id, page.root.id);

      expect(trashed?.deletedAt).not.toBeNull();
      expect(restored?.deletedAt).toBeNull();
      expect(calls).toEqual([]);
      expect(await itemStates(page.ids)).toEqual(sorted(page.ids).map((id) => ({ id, trashed: false })));

      // The same recorder does fire on a purge, so the empty list above is not a hook that never runs.
      await cp.softDeleteItem(page.rootDb.id, page.root.id);
      await cp.purgeExpiredTrashSubtree(page.root.id, EVERYTHING_EXPIRED);
      expect(calls).toHaveLength(4);
    });
  });

  it("calls no purge hook when the tenant erase removes a tenant's items", async () => {
    const ids = await runInTenant(tenant, async () => {
      const database = await cp.createDatabase({ name: "Notes" });
      const live = await cp.createItem({ databaseId: database.id, properties: {} });
      const trashed = await cp.createItem({ databaseId: database.id, properties: {} });
      await cp.softDeleteItem(database.id, trashed.id);
      await withTransaction(pool, (client) => beginTenantDeletion(client, tenant));
      return [live.id, trashed.id];
    });
    expect((await itemStates(ids)).map((row) => row.id)).toEqual(sorted(ids));
    const calls = recordPurgeHook();
    // The erase removes `<root>/<tenant id>` under both roots; this tenant stored no bytes, so neither path is ever created.
    const root = join(tmpdir(), `semprec-test-item-purge-hooks-${randomUUID()}`);

    await handleTenantPurgeTask(pool, { files: join(root, "files"), mailAttachments: join(root, "mail") });

    expect(await itemStates(ids)).toEqual([]);
    const { rows: tenants } = await admin.query<{ id: string }>("SELECT id::text AS id FROM tenants WHERE id = $1", [
      tenant,
    ]);
    expect(tenants).toEqual([]);
    const { rows: tombstones } = await admin.query<{ tenant_id: string }>(
      "SELECT tenant_id::text AS tenant_id FROM tenant_deletions WHERE tenant_id = $1",
      [tenant],
    );
    expect(tombstones).toEqual([{ tenant_id: tenant }]);
    expect(calls).toEqual([]);
  });

  it("removes registered purge hooks with clearHooksForTests", async () => {
    await runInTenant(tenant, async () => {
      const database = await cp.createDatabase({ name: "Notes" });
      const item = await cp.createItem({ databaseId: database.id, properties: {} });
      await cp.softDeleteItem(database.id, item.id);
      const calls = recordPurgeHook();

      clearHooksForTests();
      const purged = await cp.purgeExpiredTrashSubtree(item.id, EVERYTHING_EXPIRED);

      expect(purged.purgedItemIds).toEqual([item.id]);
      expect(calls).toEqual([]);
    });
  });
});
