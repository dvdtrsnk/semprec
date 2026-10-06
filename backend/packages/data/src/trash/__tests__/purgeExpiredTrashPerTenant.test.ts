import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { logger } from "../../tenancy/logger.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { handleItemTrashPurgeSweepTask } from "../purgeExpiredTrash.js";

let adminPool: Pool;
let pool: Pool;
let chokePoint: ChokePoint;
let tenantZero: string;
let tenantB: string;

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

/** Soft-deletes `itemId` through the choke point, then backdates `deleted_at` (tenant scope required). */
async function trash(databaseId: string, itemId: string, daysAgo: number): Promise<void> {
  await chokePoint.softDeleteItem(databaseId, itemId);
  await pool.query(
    `UPDATE items SET deleted_at = now() - ($2 || ' days')::interval WHERE id = $1 AND database_id = $3`,
    [itemId, String(daysAgo), databaseId],
  );
}

/** Creates a database with an expired and a recently trashed item in `tenantId`. */
async function seedTrash(tenantId: string): Promise<{ databaseId: string; expiredId: string; recentId: string }> {
  return runInTenant(tenantId, async () => {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    const expired = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    const recent = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    await trash(db.id, expired.id, 31);
    await trash(db.id, recent.id, 1);
    return { databaseId: db.id, expiredId: expired.id, recentId: recent.id };
  });
}

async function itemExists(itemId: string): Promise<boolean> {
  const { rows } = await adminPool.query("SELECT 1 FROM items WHERE id = $1", [itemId]);
  return rows.length === 1;
}

async function databaseExists(databaseId: string): Promise<boolean> {
  const { rows } = await adminPool.query("SELECT 1 FROM databases WHERE id = $1", [databaseId]);
  return rows.length === 1;
}

async function partitionExists(databaseId: string): Promise<boolean> {
  const { rows } = await adminPool.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [
    `items_p_${databaseId.replace(/-/g, "")}`,
  ]);
  return rows[0]?.exists === true;
}

async function blobExists(blobId: string): Promise<boolean> {
  const { rows } = await adminPool.query("SELECT 1 FROM blobs WHERE id = $1", [blobId]);
  return rows.length === 1;
}

async function makeFilesItem(databaseId: string, blobId: string) {
  const item = await chokePoint.createItem({ databaseId, properties: {} });
  await pool.query(
    `UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $2::text)) WHERE id = $1`,
    [item.id, blobId],
  );
  return item;
}

describe("purgeExpiredTrash runs per tenant (issue #986)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("purges each tenant's expired item and keeps its recently trashed one", async () => {
    const zero = await seedTrash(tenantZero);
    const b = await seedTrash(tenantB);

    await runAsSystem("test", () => handleItemTrashPurgeSweepTask(pool, fakeStorage().storage));

    expect(await itemExists(zero.expiredId)).toBe(false);
    expect(await itemExists(b.expiredId)).toBe(false);
    expect(await itemExists(zero.recentId)).toBe(true);
    expect(await itemExists(b.recentId)).toBe(true);
  });

  it("deletes the blob row and, after commit, the bytes of tenant B's expired file, sparing tenant zero's live blob", async () => {
    const liveBlob = await runInTenant(tenantZero, async () => {
      const db = await chokePoint.createDatabase({ name: "Files" });
      const blob = await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "zero-live-key" });
      await makeFilesItem(db.id, blob.id);
      return blob;
    });
    const blobB = await runInTenant(tenantB, async () => {
      const db = await chokePoint.createDatabase({ name: "Files" });
      const blob = await createBlob(pool, { mimeType: "text/plain", byteSize: 3, storageKey: "b-expired-key" });
      const file = await makeFilesItem(db.id, blob.id);
      await trash(db.id, file.id, 31);
      return blob;
    });

    // The admin pool is a separate connection: the row is only gone there once the purge committed.
    const blobRowSeenAtDelete: boolean[] = [];
    const { storage, deleteMock } = fakeStorage(async () => {
      blobRowSeenAtDelete.push(await blobExists(blobB.id));
    });
    await runAsSystem("test", () => handleItemTrashPurgeSweepTask(pool, storage));

    expect(await blobExists(blobB.id)).toBe(false);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("b-expired-key");
    expect(blobRowSeenAtDelete).toEqual([false]);
    expect(await blobExists(liveBlob.id)).toBe(true);
  });

  it("drops tenant B's emptied inline database and its partition, leaving tenant zero's databases", async () => {
    const zero = await seedTrash(tenantZero);
    const { inlineDbId, parentId } = await runInTenant(tenantB, async () => {
      const db = await chokePoint.createDatabase({ name: "Pages" });
      const parent = await chokePoint.createItem({ databaseId: db.id, properties: {} });
      const inlineDb = await chokePoint.createInlineDatabase({ name: "Inline", parentItemId: parent.id });
      const row = await chokePoint.createItem({ databaseId: inlineDb.id, properties: {} });
      await chokePoint.softDeleteItem(db.id, parent.id);
      await pool.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = ANY($1)", [
        [parent.id, row.id],
      ]);
      return { inlineDbId: inlineDb.id, parentId: parent.id };
    });
    expect(await partitionExists(inlineDbId)).toBe(true);

    await runAsSystem("test", () => handleItemTrashPurgeSweepTask(pool, fakeStorage().storage));

    expect(await itemExists(parentId)).toBe(false);
    expect(await databaseExists(inlineDbId)).toBe(false);
    expect(await partitionExists(inlineDbId)).toBe(false);
    expect(await databaseExists(zero.databaseId)).toBe(true);
    expect(await partitionExists(zero.databaseId)).toBe(true);
  });

  it("logs and skips tenant B's candidate in an archived database while purging the rest", async () => {
    const zero = await seedTrash(tenantZero);
    const { archivedItemId, writableItemId } = await runInTenant(tenantB, async () => {
      const archivedDb = await chokePoint.createDatabase({ name: "Archived" });
      const writableDb = await chokePoint.createDatabase({ name: "Writable" });
      const archivedItem = await chokePoint.createItem({ databaseId: archivedDb.id, properties: {} });
      const writableItem = await chokePoint.createItem({ databaseId: writableDb.id, properties: {} });
      await trash(archivedDb.id, archivedItem.id, 31);
      await trash(writableDb.id, writableItem.id, 31);
      await chokePoint.archiveDatabase(archivedDb.id);
      return { archivedItemId: archivedItem.id, writableItemId: writableItem.id };
    });

    await runAsSystem("test", () => handleItemTrashPurgeSweepTask(pool, fakeStorage().storage));

    expect(console.error).toHaveBeenCalledWith(`Failed to purge trashed item ${archivedItemId}`, expect.anything());
    expect(await itemExists(archivedItemId)).toBe(true);
    expect(await itemExists(writableItemId)).toBe(false);
    expect(await itemExists(zero.expiredId)).toBe(false);
  });

  it("does not purge the expired item of a suspended tenant", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const seeded = await seedTrash(suspended);

    await runAsSystem("test", () => handleItemTrashPurgeSweepTask(pool, fakeStorage().storage));

    expect(await itemExists(seeded.expiredId)).toBe(true);
  });
});
