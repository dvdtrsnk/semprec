import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createBlob, getBlob } from "../../blobs/blobsStore.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { purgeExpiredTrash } from "../../trash/purgeExpiredTrash.js";
import type { ItemRow } from "../../types.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { insertInboxAttachments, listInboxAttachments } from "../inboxAttachmentsStore.js";

// Issue #1564: an attachment keeps its blob's bytes while it exists, and the trash purge of its Inbox
// item releases the blob only when nothing else names it.

let pool: Pool;
let chokePoint: ChokePoint;

/** A storage double whose only exercised method is `delete`; the purge never reads or writes bytes. */
function fakeStorage() {
  const deleteMock = vi.fn(async (_storageKey: string) => {});
  const storage: BlobStorageWriter = {
    writeStream: () => Promise.reject(new Error("not used by the purge")),
    readStream: () => {
      throw new Error("not used by the purge");
    },
    delete: deleteMock,
  };
  return { storage, deleteMock };
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createInboxItem(text: string): Promise<ItemRow> {
  const inboxDatabaseId = await databaseIdFor("inbox");
  return withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId,
      date: "2026-08-28",
      time: "09:00",
      text,
    }),
  );
}

/** Backdates a trashed item's `deleted_at` past the 30-day retention, the way real trash ages over time. */
async function ageDeletion(itemId: string, databaseId: string): Promise<void> {
  await pool.query(`UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1 AND database_id = $2`, [
    itemId,
    databaseId,
  ]);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${sql}`, params);
  return Number(rows[0]?.count);
}

/** A Files item whose `properties.file.blobId` names `blobId`. Raw update, as `purgeExpiredTrash.test.ts` does, to name a blob from a Files item. */
async function makeFilesItem(blobId: string): Promise<ItemRow> {
  const { id: databaseId } = await chokePoint.createDatabase({ name: `Files ${blobId}` });
  const item = await chokePoint.createItem({ databaseId, properties: {} });
  await pool.query(
    `UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $2::text)) WHERE id = $1`,
    [item.id, blobId],
  );
  return item;
}

describe("Inbox attachments as counted blob references (issue #1564)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("removes an Inbox item's attachment rows on permanent delete and deletes a blob nothing else uses, with its bytes", async () => {
    const item = await createInboxItem("receipt photo");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/receipt" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await listInboxAttachments(pool, [item.id])).toEqual([]);
    expect(await getBlob(pool, blob.id)).toBeNull();
    expect(deleteMock.mock.calls).toEqual([["t/blobs/receipt"]]);
  });

  it("keeps a blob a Files item still uses when the Inbox item holding it is permanently deleted", async () => {
    const item = await createInboxItem("scanned page");
    const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 3, storageKey: "t/blobs/scan" });
    await makeFilesItem(blob.id);
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "scan" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await listInboxAttachments(pool, [item.id])).toEqual([]);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("keeps a blob an Inbox attachment names when a Files item with the same bytes is purged", async () => {
    const item = await createInboxItem("shared photo");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/shared" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "photoLibrary" }]);
    const file = await makeFilesItem(blob.id);
    await chokePoint.softDeleteItem(file.databaseId, file.id);
    await ageDeletion(file.id, file.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(await countRows("inbox_attachments WHERE blob_id = $1", [blob.id])).toBe(1);
  });

  it("keeps a trashed Inbox item's attachments and their blob until the item is permanently deleted", async () => {
    const item = await createInboxItem("trashed capture");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/trashed" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "files" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(0);

    expect(await listInboxAttachments(pool, [item.id])).toHaveLength(1);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("releases a blob named by two attachments of one item once, deleting its bytes once", async () => {
    const item = await createInboxItem("two copies");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/twice" });
    await insertInboxAttachments(pool, item.id, [
      { blobId: blob.id, source: "camera" },
      { blobId: blob.id, source: "camera" },
    ]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await getBlob(pool, blob.id)).toBeNull();
    expect(deleteMock.mock.calls).toEqual([["t/blobs/twice"]]);
  });

  it("keeps a blob another live Inbox item still attaches when one Inbox item is permanently deleted", async () => {
    const purged = await createInboxItem("deleted capture");
    const live = await createInboxItem("live capture");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/both" });
    await insertInboxAttachments(pool, purged.id, [{ blobId: blob.id, source: "share" }]);
    await insertInboxAttachments(pool, live.id, [{ blobId: blob.id, source: "share" }]);
    await chokePoint.softDeleteItem(purged.databaseId, purged.id);
    await ageDeletion(purged.id, purged.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await listInboxAttachments(pool, [purged.id])).toEqual([]);
    expect((await listInboxAttachments(pool, [live.id])).map((row) => row.blobId)).toEqual([blob.id]);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
