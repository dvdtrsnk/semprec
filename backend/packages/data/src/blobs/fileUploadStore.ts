import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Pool } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { safeStorageFilename } from "../mail/attachments.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { findFileItemByBlobId } from "../chokePoint/itemsStore.js";
import { findOrCreateBlob, tenantBlobStorageKey } from "./blobsStore.js";
import type { BlobRow, ItemRow } from "../types.js";

export interface IngestUploadedFileInput {
  /** The seeded system Files database's id (`getDatabaseByModuleId(client, FILES_MODULE_ID)`). */
  filesDatabaseId: string;
  /** From the upload's `X-Filename` header — becomes the Files item's `name` (title) property. */
  filename: string;
  /** From the upload's `Content-Type` header — stored as the blob's `mime_type`. */
  contentType: string;
  source: Readable;
  /** Namespacing prefix for the storage key, e.g. `"files"` — keeps this upload path's keys apart from mail attachments'. */
  storageKeyPrefix: string;
  /** Hard cap enforced while streaming — see `BlobStorageWriter.writeStream`'s `maxBytes`. */
  maxBytes: number;
  storage: BlobStorageWriter;
}

export interface IngestUploadedFileResult {
  item: ItemRow;
  blob: BlobRow;
  /** `false` when an identical upload (same content hash) already had a Files item, and this call reused it instead of creating a second one. */
  created: boolean;
}

/**
 * `POST /api/files`'s (issue #158) upload-to-Files-item pipeline: stream the request body to
 * storage (hashing/counting bytes as they flow, see `BlobStorageWriter.writeStream`), then, in one
 * transaction, dedupe the resulting blob by content hash and either reuse the Files item an
 * earlier identical upload already created for it or create a new one — the same
 * write-then-dedupe-in-a-transaction shape `mail/attachments.ts`'s `ingestAttachments` already
 * uses, minus the relation link (an upload through this route isn't attached to a source item).
 *
 * Concurrent identical uploads converge on one row deterministically without any extra locking:
 * `findOrCreateBlob`'s `INSERT ... ON CONFLICT DO NOTHING` blocks a second transaction
 * inserting the same hash until the first commits, so by the time a second caller's
 * `findFileItemByBlobId` runs, either it's racing to create the very first Files item for that
 * blob (no conflict possible — the blob row itself didn't exist for anyone else to have already
 * created one), or the first caller's whole transaction — blob insert and Files item insert
 * together — has already committed and this call simply finds it.
 *
 * `docs/adr/2026-09-10-side-effects-follow-the-commit.md`: writing the bytes has to happen before
 * the transaction (the content hash driving the dedup only exists once they're written), so both
 * ways that leaves storage and rows out of step are handled by ordering the cleanup around the
 * commit rather than by avoiding the early write. If the transaction throws, the bytes just
 * streamed are always garbage — nothing committed references them — so they're deleted after the
 * rollback, from the `catch` below. If a dedup hit means the transaction instead keeps a
 * *different* key's bytes, the ones just streamed are deleted only once that transaction has
 * committed (`runAfterCommit`), because a delete that ran inside the transaction and then failed
 * would abort a transaction whose database work was otherwise fine.
 */
export async function ingestUploadedFile(
  pool: Pool,
  input: IngestUploadedFileInput,
): Promise<IngestUploadedFileResult> {
  // Resolved before streaming, so a missing tenant fails before any byte is written.
  const storageKey = await tenantBlobStorageKey(
    pool,
    `${input.storageKeyPrefix}/${randomUUID()}-${safeStorageFilename(input.filename)}`,
  );

  let byteSize: number;
  let contentHash: string;
  try {
    ({ byteSize, contentHash } = await input.storage.writeStream(storageKey, input.source, {
      maxBytes: input.maxBytes,
    }));
  } catch (err) {
    // The write already failed (and cleaned up its own partial bytes) — draining whatever the
    // client still has queued keeps the connection reusable for its next request instead of the
    // socket having to be torn down mid-body.
    input.source.resume();
    throw err;
  }

  try {
    return await withTransaction(pool, async (client) => {
      const blob = await findOrCreateBlob(client, {
        mimeType: input.contentType,
        byteSize,
        storageKey,
        contentHash,
      });
      // A content-hash dedup hit means `blob` already existed under a different storageKey — the
      // bytes just streamed above are an unneeded duplicate on disk, not the ones kept. Deleted
      // only once this transaction commits: a delete that ran here and then failed would abort a
      // transaction whose database work was otherwise fine.
      if (blob.storageKey !== storageKey) {
        runAfterCommit(client, () => {
          void input.storage.delete(storageKey).catch((err) => {
            console.error(`Failed to delete duplicate upload bytes ${storageKey}`, err);
          });
        });
      }

      const existing = await findFileItemByBlobId(client, input.filesDatabaseId, blob.id);
      if (existing) return { item: existing, blob, created: false };

      const item = await createItemWithClient(client, {
        databaseId: input.filesDatabaseId,
        properties: { name: input.filename, file: { blobId: blob.id } },
      });
      return { item, blob, created: true };
    });
  } catch (err) {
    // A rolled-back transaction kept nothing, so the bytes streamed above are always garbage on
    // this path.
    try {
      await input.storage.delete(storageKey);
    } catch (deleteErr) {
      console.error(`Failed to delete upload bytes ${storageKey} after a failed transaction`, deleteErr);
    }
    throw err;
  }
}
