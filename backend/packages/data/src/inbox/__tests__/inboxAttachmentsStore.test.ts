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
import { readJobPayloadsByIdentifier } from "@alldots/queue/testSupport";
import { createBlob, deleteBlobIfUnreferenced, getBlob } from "../../blobs/blobsStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { z } from "zod";
import {
  deleteInboxAttachment as deleteWithClient,
  deleteInboxAttachmentsForItem as deleteAllWithClient,
  getInboxAttachment,
  insertInboxAttachments as insertWithClient,
  listInboxAttachments,
  readInboxAttachmentForMetadata,
  recordInboxAttachmentMetadata as recordWithClient,
  type DerivedImageBlob,
  type RecordInboxAttachmentMetadataInput,
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

function recordInboxAttachmentMetadata(owner: Pool, input: RecordInboxAttachmentMetadataInput) {
  return withTransaction(owner, (client) => recordWithClient(client, input));
}

/** A rendered image as the metadata job hands it over: the bytes are in storage, `contentHash` names them. */
function derivedImage(label: string, contentHash = randomUUID().replaceAll("-", "").repeat(2)): DerivedImageBlob {
  return { mimeType: "image/jpeg", byteSize: 1200, storageKey: `t/inbox-attachments/${label}.jpg`, contentHash };
}

const tickJobSchema = z.object({ payload: z.object({ heartbeatId: z.string(), itemId: z.string() }) });

async function updateTicksFor(itemId: string): Promise<string[]> {
  const heartbeats = await pool.query<{ id: string }>(
    "SELECT id FROM project_heartbeats WHERE rule ->> 'databaseId' = $1 AND rule ->> 'event' = 'update'",
    [inboxId],
  );
  const updateIds = new Set(heartbeats.rows.map((row) => row.id));
  expect(updateIds.size).toBeGreaterThan(0);
  return (await readJobPayloadsByIdentifier(pool, "heartbeatFireCore"))
    .map((raw) => tickJobSchema.parse(raw).payload)
    .filter((payload) => payload.itemId === itemId && updateIds.has(payload.heartbeatId))
    .map((payload) => payload.heartbeatId);
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

    expect(await deleteInboxAttachment(pool, listed!.attachmentId)).toEqual({ deleted: true, releasedStorageKeys: [] });
    expect(await getInboxAttachment(pool, listed!.attachmentId)).toBeNull();
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(await deleteInboxAttachment(pool, listed!.attachmentId)).toEqual({
      deleted: false,
      releasedStorageKeys: [],
    });
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
    expect(await deleteInboxAttachment(pool, attachment.attachmentId)).toEqual({
      deleted: true,
      releasedStorageKeys: [],
    });
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
      const runtime = await createRuntimeRolePool(pool, "alldots_data");
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
  describe("the facts of an attachment (issue gh-1965)", () => {
    async function attachmentOf(itemId: string, label: string) {
      const blob = await newBlob(`t/blobs/${label}`);
      await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
      const row = (await listInboxAttachments(pool, [itemId])).find((candidate) => candidate.blobId === blob.id);
      if (!row) throw new Error("Missing attachment");
      return row;
    }

    it("reads no metadata and no derived blob for an attachment the job has not reached", async () => {
      const itemId = await newInboxItem();

      const row = await attachmentOf(itemId, "unreached");

      expect(row).toMatchObject({ metadata: null, thumbnailBlobId: null, reducedBlobId: null });
      expect(await readInboxAttachmentForMetadata(pool, row.attachmentId)).toEqual({
        attachmentId: row.attachmentId,
        mimeType: "image/jpeg",
        storageKey: "t/blobs/unreached",
        metadataRecorded: false,
      });
      expect(await readInboxAttachmentForMetadata(pool, randomUUID())).toBeNull();
    });

    it("records the metadata and the two derived blobs once, and announces one update of the Inbox item", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "recorded");
      const ticksBefore = await updateTicksFor(itemId);

      const recorded = await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { width: 3000, height: 2000, pages: null },
        thumbnail: derivedImage("thumbnail"),
        reduced: derivedImage("reduced"),
      });

      expect(recorded).toEqual({ recorded: true, unusedStorageKeys: [] });
      const stored = await getInboxAttachment(pool, row.attachmentId);
      expect(stored).toMatchObject({ metadata: { width: 3000, height: 2000, pages: null } });
      expect(stored?.thumbnailBlobId).not.toBeNull();
      expect(stored?.reducedBlobId).not.toBeNull();
      expect(stored?.thumbnailBlobId).not.toBe(stored?.reducedBlobId);
      expect(await getBlob(pool, stored?.thumbnailBlobId ?? "")).toMatchObject({
        mimeType: "image/jpeg",
        byteSize: "1200",
        storageKey: "t/inbox-attachments/thumbnail.jpg",
      });
      expect(await readInboxAttachmentForMetadata(pool, row.attachmentId)).toMatchObject({ metadataRecorded: true });
      expect(ticksBefore).toEqual([]);
      expect((await updateTicksFor(itemId)).length).toBe(1);
    });

    it("records metadata without blobs for audio, a PDF and a file that could not be read", async () => {
      const itemId = await newInboxItem();
      const inputs = [
        { label: "audio", metadata: { durationSeconds: 40, audioKind: "voiceNote" as const, pages: null } },
        { label: "pdf", metadata: { pages: null } },
        { label: "broken", metadata: { error: "mediaUnreadable" as const, pages: null } },
      ];
      for (const input of inputs) {
        const row = await attachmentOf(itemId, input.label);

        expect(
          await recordInboxAttachmentMetadata(pool, {
            attachmentId: row.attachmentId,
            metadata: input.metadata,
            thumbnail: null,
            reduced: null,
          }),
        ).toEqual({ recorded: true, unusedStorageKeys: [] });
        expect(await getInboxAttachment(pool, row.attachmentId)).toMatchObject({
          metadata: input.metadata,
          thumbnailBlobId: null,
          reducedBlobId: null,
        });
      }
    });

    it("writes nothing the second time: the stored metadata and blobs stay, nothing more is announced, and both keys are unused", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "twice");
      await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { width: 10, height: 20, pages: null },
        thumbnail: derivedImage("first-thumbnail"),
        reduced: derivedImage("first-reduced"),
      });
      const afterFirst = await getInboxAttachment(pool, row.attachmentId);
      const blobsAfterFirst = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs")).rows[0]?.n;

      const second = await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { width: 99, height: 99, pages: null },
        thumbnail: derivedImage("second-thumbnail"),
        reduced: derivedImage("second-reduced"),
      });

      expect(second).toEqual({
        recorded: false,
        unusedStorageKeys: ["t/inbox-attachments/second-thumbnail.jpg", "t/inbox-attachments/second-reduced.jpg"],
      });
      expect(await getInboxAttachment(pool, row.attachmentId)).toEqual(afterFirst);
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs")).rows[0]?.n).toBe(
        blobsAfterFirst,
      );
      expect((await updateTicksFor(itemId)).length).toBe(1);
    });

    it("writes nothing for an attachment that does not exist, and reports its keys as unused", async () => {
      const blobsBefore = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs")).rows[0]?.n;

      const recorded = await recordInboxAttachmentMetadata(pool, {
        attachmentId: randomUUID(),
        metadata: { width: 1, height: 1, pages: null },
        thumbnail: derivedImage("missing-thumbnail"),
        reduced: null,
      });

      expect(recorded).toEqual({ recorded: false, unusedStorageKeys: ["t/inbox-attachments/missing-thumbnail.jpg"] });
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs")).rows[0]?.n).toBe(blobsBefore);
    });

    it("rejects metadata of a shape the column does not hold, before anything is written", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "bad-shape");

      await expect(
        recordInboxAttachmentMetadata(pool, {
          attachmentId: row.attachmentId,
          metadata: { width: -5, pages: null },
          thumbnail: null,
          reduced: null,
        }),
      ).rejects.toThrow();
      expect((await getInboxAttachment(pool, row.attachmentId))?.metadata).toBeNull();
    });

    it("records for an Inbox item in the Trash without announcing an update to its heartbeats", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "trashed");
      await createChokePoint(pool).softDeleteItem(inboxId, itemId);

      const recorded = await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { pages: null },
        thumbnail: null,
        reduced: null,
      });

      expect(recorded.recorded).toBe(true);
      expect((await getInboxAttachment(pool, row.attachmentId))?.metadata).toEqual({ pages: null });
      expect(await updateTicksFor(itemId)).toEqual([]);
    });

    it("gives identical bytes the blob the tenant already stores and reports the new key unused", async () => {
      const itemId = await newInboxItem();
      const first = await attachmentOf(itemId, "dedupe-first");
      const second = await attachmentOf(itemId, "dedupe-second");
      const sameBytes = "ab".repeat(32);
      await recordInboxAttachmentMetadata(pool, {
        attachmentId: first.attachmentId,
        metadata: { width: 5, height: 5, pages: null },
        thumbnail: derivedImage("dedupe-a", sameBytes),
        reduced: null,
      });

      const recorded = await recordInboxAttachmentMetadata(pool, {
        attachmentId: second.attachmentId,
        metadata: { width: 5, height: 5, pages: null },
        thumbnail: derivedImage("dedupe-b", sameBytes),
        reduced: null,
      });

      expect(recorded).toEqual({ recorded: true, unusedStorageKeys: ["t/inbox-attachments/dedupe-b.jpg"] });
      expect((await getInboxAttachment(pool, second.attachmentId))?.thumbnailBlobId).toBe(
        (await getInboxAttachment(pool, first.attachmentId))?.thumbnailBlobId,
      );
    });

    it("counts a derived blob as a reference: it is kept while an attachment names it as preview or reduced copy", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "referenced");
      await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { width: 5, height: 5, pages: null },
        thumbnail: derivedImage("referenced-thumbnail"),
        reduced: derivedImage("referenced-reduced"),
      });
      const stored = await getInboxAttachment(pool, row.attachmentId);

      expect(await deleteBlobIfUnreferenced(pool, stored?.thumbnailBlobId ?? "")).toBeNull();
      expect(await deleteBlobIfUnreferenced(pool, stored?.reducedBlobId ?? "")).toBeNull();
      expect(await getBlob(pool, stored?.thumbnailBlobId ?? "")).not.toBeNull();
      expect(await getBlob(pool, stored?.reducedBlobId ?? "")).not.toBeNull();
    });

    it("releases the derived blobs of a deleted attachment and returns their keys, but not the attachment's own blob", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "released");
      await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { width: 5, height: 5, pages: null },
        thumbnail: derivedImage("released-thumbnail"),
        reduced: derivedImage("released-reduced"),
      });
      const stored = await getInboxAttachment(pool, row.attachmentId);

      const deleted = await deleteInboxAttachment(pool, row.attachmentId);

      expect(deleted.deleted).toBe(true);
      expect([...deleted.releasedStorageKeys].sort()).toEqual([
        "t/inbox-attachments/released-reduced.jpg",
        "t/inbox-attachments/released-thumbnail.jpg",
      ]);
      expect(await getBlob(pool, stored?.thumbnailBlobId ?? "")).toBeNull();
      expect(await getBlob(pool, stored?.reducedBlobId ?? "")).toBeNull();
      expect(await getBlob(pool, row.blobId)).not.toBeNull();
    });

    it("keeps a derived blob that another attachment still names, and frees it with the last one", async () => {
      const itemId = await newInboxItem();
      const first = await attachmentOf(itemId, "shared-first");
      const second = await attachmentOf(itemId, "shared-second");
      const sameBytes = "cd".repeat(32);
      for (const row of [first, second]) {
        await recordInboxAttachmentMetadata(pool, {
          attachmentId: row.attachmentId,
          metadata: { width: 5, height: 5, pages: null },
          thumbnail: derivedImage(`shared-${row.attachmentId}`, sameBytes),
          reduced: null,
        });
      }
      const sharedId = (await getInboxAttachment(pool, first.attachmentId))?.thumbnailBlobId ?? "";

      expect(await deleteInboxAttachment(pool, first.attachmentId)).toEqual({ deleted: true, releasedStorageKeys: [] });
      expect(await getBlob(pool, sharedId)).not.toBeNull();
      expect((await deleteInboxAttachment(pool, second.attachmentId)).releasedStorageKeys).toHaveLength(1);
      expect(await getBlob(pool, sharedId)).toBeNull();
    });

    it("does not release a derived blob that is the attachment's own blob", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "own-blob");
      // The state a preview deduplicated onto the uploaded bytes leaves; `recordInboxAttachmentMetadata` cannot
      // produce it without the very same bytes, so the column is set directly.
      await pool.query(
        "UPDATE inbox_attachments SET thumbnail_blob_id = blob_id, metadata = '{\"pages\":null}' WHERE attachment_id = $1",
        [row.attachmentId],
      );

      expect(await deleteInboxAttachment(pool, row.attachmentId)).toEqual({ deleted: true, releasedStorageKeys: [] });
      expect(await getBlob(pool, row.blobId)).not.toBeNull();
    });

    it("returns the derived blob ids of every attachment of a deleted item with the blobs they named", async () => {
      const itemId = await newInboxItem();
      const row = await attachmentOf(itemId, "item-delete");
      await recordInboxAttachmentMetadata(pool, {
        attachmentId: row.attachmentId,
        metadata: { width: 5, height: 5, pages: null },
        thumbnail: derivedImage("item-delete-thumbnail"),
        reduced: derivedImage("item-delete-reduced"),
      });
      const stored = await getInboxAttachment(pool, row.attachmentId);

      const released = await deleteInboxAttachmentsForItem(pool, itemId);

      expect([...released].sort()).toEqual(
        [row.blobId, stored?.thumbnailBlobId ?? "", stored?.reducedBlobId ?? ""].sort(),
      );
    });
  });
});
