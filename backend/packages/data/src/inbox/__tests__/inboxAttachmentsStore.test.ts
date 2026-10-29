import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createBlob, getBlob } from "../../blobs/blobsStore.js";
import {
  deleteInboxAttachment,
  deleteInboxAttachmentsForItem,
  getInboxAttachment,
  insertInboxAttachments,
  listInboxAttachments,
} from "../inboxAttachmentsStore.js";

// The table has no foreign key to `items` (they are partitioned), so the store is exercised with item
// ids that name no row. The blobs are real rows created by the blob store.

let pool: Pool;

function newBlob(storageKey: string) {
  return createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey });
}

describe("inboxAttachmentsStore (issue #1564)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("appends attachments in the order given, positions from 0, and continues after the current maximum", async () => {
    const itemId = randomUUID();
    const first = await newBlob("t/blobs/first");
    const second = await newBlob("t/blobs/second");
    const third = await newBlob("t/blobs/third");

    await insertInboxAttachments(pool, itemId, [
      { blobId: first.id, source: "camera" },
      { blobId: second.id, source: "scan" },
    ]);
    await insertInboxAttachments(pool, itemId, [{ blobId: third.id, source: "share" }]);

    const rows = await listInboxAttachments(pool, [itemId]);
    expect(rows.map((row) => [row.blobId, row.source, row.position])).toEqual([
      [first.id, "camera", 0],
      [second.id, "scan", 1],
      [third.id, "share", 2],
    ]);
  });

  it("joins each attachment with its blob's mime type and byte size", async () => {
    const itemId = randomUUID();
    const blob = await createBlob(pool, { mimeType: "image/heic", byteSize: 4096, storageKey: "t/blobs/heic" });
    await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "photoLibrary" }]);

    const [row] = await listInboxAttachments(pool, [itemId]);
    expect(row).toMatchObject({
      inboxItemId: itemId,
      blobId: blob.id,
      mimeType: "image/heic",
      byteSize: "4096",
      source: "photoLibrary",
      position: 0,
    });
  });

  it("lists only the requested items, ordered by item and position, and an empty request yields nothing", async () => {
    const itemId = randomUUID();
    const otherItemId = randomUUID();
    const unusedItemId = randomUUID();
    const blob = await newBlob("t/blobs/listed");
    await insertInboxAttachments(pool, itemId, [
      { blobId: blob.id, source: "files" },
      { blobId: blob.id, source: "files" },
    ]);
    await insertInboxAttachments(pool, otherItemId, [{ blobId: blob.id, source: "share" }]);

    const rows = await listInboxAttachments(pool, [itemId, unusedItemId]);
    expect(rows.map((row) => [row.inboxItemId, row.position])).toEqual([
      [itemId, 0],
      [itemId, 1],
    ]);
    expect(await listInboxAttachments(pool, [])).toEqual([]);
  });

  it("gets one attachment by id, and returns null for an id with no row", async () => {
    const itemId = randomUUID();
    const blob = await newBlob("t/blobs/one");
    await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "scan" }]);
    const [listed] = await listInboxAttachments(pool, [itemId]);

    expect(await getInboxAttachment(pool, listed!.attachmentId)).toEqual(listed);
    expect(await getInboxAttachment(pool, randomUUID())).toBeNull();
  });

  it("deletes one attachment row, leaves its blob in place, and reports a missing row as not deleted", async () => {
    const itemId = randomUUID();
    const blob = await newBlob("t/blobs/deleted");
    await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
    const [listed] = await listInboxAttachments(pool, [itemId]);

    expect(await deleteInboxAttachment(pool, listed!.attachmentId)).toBe(true);
    expect(await getInboxAttachment(pool, listed!.attachmentId)).toBeNull();
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(await deleteInboxAttachment(pool, listed!.attachmentId)).toBe(false);
  });

  it("removes every attachment of one item, returns the blob ids they named, and leaves other items alone", async () => {
    const itemId = randomUUID();
    const otherItemId = randomUUID();
    const first = await newBlob("t/blobs/item-first");
    const second = await newBlob("t/blobs/item-second");
    const kept = await newBlob("t/blobs/other-item");
    await insertInboxAttachments(pool, itemId, [
      { blobId: first.id, source: "camera" },
      { blobId: second.id, source: "scan" },
    ]);
    await insertInboxAttachments(pool, otherItemId, [{ blobId: kept.id, source: "share" }]);

    const releasedBlobIds = await deleteInboxAttachmentsForItem(pool, itemId);

    expect([...releasedBlobIds].sort()).toEqual([first.id, second.id].sort());
    expect(await listInboxAttachments(pool, [itemId])).toEqual([]);
    expect((await listInboxAttachments(pool, [otherItemId])).map((row) => row.blobId)).toEqual([kept.id]);
    expect(await deleteInboxAttachmentsForItem(pool, itemId)).toEqual([]);
  });
});
