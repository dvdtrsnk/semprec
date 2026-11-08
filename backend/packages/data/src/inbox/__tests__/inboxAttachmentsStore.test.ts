import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createBlob, getBlob } from "../../blobs/blobsStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import {
  deleteInboxAttachment as deleteWithClient,
  deleteInboxAttachmentsForItem as deleteAllWithClient,
  getInboxAttachment,
  insertInboxAttachments as insertWithClient,
  listInboxAttachments,
} from "../inboxAttachmentsStore.js";

let pool: Pool;
let inboxId: string;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Attachment barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function insertInboxAttachments(owner: Pool, itemId: string, attachments: Parameters<typeof insertWithClient>[2]) {
  return withTransaction(owner, (client) => insertWithClient(client, itemId, attachments));
}
function deleteInboxAttachment(owner: Pool, id: string) {
  return withTransaction(owner, (client) => deleteWithClient(client, id));
}
function deleteInboxAttachmentsForItem(owner: Pool, id: string) {
  return withTransaction(owner, (client) => deleteAllWithClient(client, id));
}
async function newInboxItem(): Promise<string> {
  return (
    await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Attachment fixture",
      }),
    )
  ).id;
}

function newBlob(storageKey: string) {
  return createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey });
}

describe("inboxAttachmentsStore (issue #1564)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    const result = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'inbox'");
    if (!result.rows[0]) throw new Error("Missing Inbox database");
    inboxId = result.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("appends attachments in the order given, positions from 0, and continues after the current maximum", async () => {
    const itemId = await newInboxItem();
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
    const itemId = await newInboxItem();
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
    const itemId = await newInboxItem();
    const otherItemId = await newInboxItem();
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
    const itemId = await newInboxItem();
    const blob = await newBlob("t/blobs/one");
    await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "scan" }]);
    const [listed] = await listInboxAttachments(pool, [itemId]);

    expect(await getInboxAttachment(pool, listed!.attachmentId)).toEqual(listed);
    expect(await getInboxAttachment(pool, randomUUID())).toBeNull();
  });

  it("deletes one attachment row, leaves its blob in place, and reports a missing row as not deleted", async () => {
    const itemId = await newInboxItem();
    const blob = await newBlob("t/blobs/deleted");
    await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
    const [listed] = await listInboxAttachments(pool, [itemId]);

    expect(await deleteInboxAttachment(pool, listed!.attachmentId)).toBe(true);
    expect(await getInboxAttachment(pool, listed!.attachmentId)).toBeNull();
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(await deleteInboxAttachment(pool, listed!.attachmentId)).toBe(false);
  });

  it("removes an existing attachment from a trashed source while refusing new attachments", async () => {
    const itemId = await newInboxItem();
    const blob = await newBlob("t/blobs/trashed-source");
    await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
    const attachment = (await listInboxAttachments(pool, [itemId]))[0];
    if (!attachment) throw new Error("Missing attachment");
    await createChokePoint(pool).softDeleteItem(inboxId, itemId);
    await expect(insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "scan" }])).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await deleteInboxAttachment(pool, attachment.attachmentId)).toBe(true);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
  });

  it("removes every attachment of one item, returns the blob ids they named, and leaves other items alone", async () => {
    const itemId = await newInboxItem();
    const otherItemId = await newInboxItem();
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

  it.each([false, true])(
    "serializes appenders and handles holder rollback: %s",
    async (rollback) => {
      const itemId = await newInboxItem();
      const first = await newBlob("t/blobs/concurrent-first");
      const second = await newBlob("t/blobs/concurrent-second");
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release = () => {};
      let holderReady = () => {};
      let competitorReady = () => {};
      let holderPid: number | undefined;
      let competitorPid: number | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holderStarted = new Promise<void>((resolve) => {
        holderReady = resolve;
      });
      const competitorStarted = new Promise<void>((resolve) => {
        competitorReady = resolve;
      });
      const rollbackMarker = new Error("intentional holder rollback");
      const holder = withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        await insertWithClient(client, itemId, [{ blobId: first.id, source: "camera" }]);
        holderReady();
        await gate;
        if (rollback) throw rollbackMarker;
      });
      const holderOutcome = holder.then(
        () => null,
        (error: unknown) => error,
      );
      let competitor: Promise<void> | undefined;
      try {
        await bounded(holderStarted);
        competitor = withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          competitorPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          competitorReady();
          await insertWithClient(client, itemId, [{ blobId: second.id, source: "scan" }]);
        });
        competitor.catch(() => {});
        await bounded(competitorStarted);
        let blocked = false;
        for (let n = 0; n < 100 && !blocked; n++) {
          const result = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holderPid, competitorPid],
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(holderPid).not.toBe(competitorPid);
        expect(blocked).toBe(true);
        release();
        expect(await holderOutcome).toBe(rollback ? rollbackMarker : null);
        await competitor;
        const rows = await listInboxAttachments(pool, [itemId]);
        expect(rows.map((row) => [row.blobId, row.position])).toEqual(
          rollback
            ? [[second.id, 0]]
            : [
                [first.id, 0],
                [second.id, 1],
              ],
        );
      } finally {
        release();
        await Promise.allSettled([holderOutcome, ...(competitor ? [competitor] : [])]);
        await runtime.end();
      }
    },
    15000,
  );
});
