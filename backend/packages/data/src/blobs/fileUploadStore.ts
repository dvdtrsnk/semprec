import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { markManagedTransactionRollbackOnly, runAfterCommit, withTransaction } from "../db/pool.js";
import { safeStorageFilename } from "../mail/attachments.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { findFileItemByBlobId } from "../chokePoint/itemsStore.js";
import { findOrCreateBlob, lockBlobById, recordDetectedBlobMimeType, tenantBlobStorageKey } from "./blobsStore.js";
import { UnsupportedMediaTypeError, ValidationError } from "../errors.js";
import type { BlobRow, ItemRow } from "../types.js";
import { logger } from "./logger.js";
import { detectFileType, FILE_TYPE_DETECTION_HEAD_BYTES } from "./fileTypeDetection.js";
import { detectAudioMimeType } from "./audioTypeDetection.js";
import { INBOX_ATTACHMENT_MIME_TYPES } from "../inbox/attachmentTypes.js";

const UNKNOWN_CONTENT_MIME = "application/octet-stream";

async function readHead(storage: BlobStorageWriter, storageKey: string, byteSize: number): Promise<Buffer> {
  if (byteSize === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  const stream = storage.readStream(storageKey, {
    start: 0,
    end: Math.min(byteSize, FILE_TYPE_DETECTION_HEAD_BYTES) - 1,
  });
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export interface IngestUploadedFileInput {
  /** The seeded system Files database's id (`getDatabaseByModuleId(client, FILES_MODULE_ID)`). */
  filesDatabaseId: string;
  /** From the upload's `X-Filename` header — becomes the Files item's `name` (title) property. */
  filename: string;
  /** From the upload's `Content-Type` header — accepted but ignored: the stored mime and Files `type` come from the bytes. */
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
 * Filing a deduplicated blob locks that blob before checking for an existing Files item, so a
 * concurrent filing waits and then reads the committed item in a fresh statement.
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
  const { result } = await ingestUploadedFileWithTransaction(pool, input, () => Promise.resolve(undefined));
  return result;
}

export async function ingestUploadedFileWithTransaction<T>(
  pool: Pool,
  input: IngestUploadedFileInput,
  afterFile: (client: PoolClient, result: IngestUploadedFileResult) => Promise<T>,
): Promise<{ result: IngestUploadedFileResult; value: T }> {
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
    // Type and mime come from the stored bytes, never from the client's `Content-Type` or the filename.
    const detected = detectFileType(await readHead(input.storage, storageKey, byteSize));
    return await withTransaction(pool, async (client) => {
      const blob = await findOrCreateBlob(client, {
        mimeType: detected?.mimeType ?? UNKNOWN_CONTENT_MIME,
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
            logger.error(
              { errCode: err instanceof Error && "code" in err ? String(err.code) : undefined, blobId: blob.id },
              "Failed to delete duplicate upload bytes",
            );
          });
        });
      }

      if (!(await lockBlobById(client, blob.id))) {
        throw new ValidationError("Invalid blob reference", { field: "file" });
      }
      await recordDetectedBlobMimeType(client, blob.id, detected?.mimeType ?? UNKNOWN_CONTENT_MIME);
      const existing = await findFileItemByBlobId(client, input.filesDatabaseId, blob.id);
      const item =
        existing ??
        (await createItemWithClient(client, {
          databaseId: input.filesDatabaseId,
          properties: {
            name: input.filename,
            file: { blobId: blob.id },
            ...(detected ? { type: detected.type } : {}),
          },
        }));
      const result = { item, blob, created: existing === null };
      try {
        return { result, value: await afterFile(client, result) };
      } catch (error) {
        markManagedTransactionRollbackOnly(client, error);
        throw error;
      }
    });
  } catch (err) {
    // A rolled-back transaction kept nothing, so the bytes streamed above are always garbage on
    // this path.
    try {
      await input.storage.delete(storageKey);
    } catch (deleteErr) {
      logger.error(
        { errCode: deleteErr instanceof Error && "code" in deleteErr ? String(deleteErr.code) : undefined },
        "Failed to delete upload bytes after a failed transaction",
      );
    }
    throw err;
  }
}

/**
 * The mime types a standalone blob may have (issue gh-1963): every Inbox attachment type, plus HEIC, which was
 * accepted before the allowlist existed and which a capture then refuses with its own error. An exception to the
 * unknown-bytes-accepted rule of [[2026-11-04-blob-content-classification-preserves-legacy-metadata]], recorded in
 * [[2026-11-14-a-standalone-blob-upload-accepts-only-the-inbox-attachment-types]].
 */
const BLOB_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([...INBOX_ATTACHMENT_MIME_TYPES, "image/heic"]);

/** The mime type of an uploaded blob, decided from its leading bytes: audio first, then documents and images. */
function detectBlobMimeType(head: Buffer): string | null {
  return detectAudioMimeType(head) ?? detectFileType(head)?.mimeType ?? null;
}

export interface IngestUploadedBlobInput {
  /** The caller's declared content type, already checked to be well formed; the stored mime comes from the bytes and ignores it. */
  mimeType: string;
  source: Readable;
  /** Hard cap enforced while streaming — see `BlobStorageWriter.writeStream`'s `maxBytes`. */
  maxBytes: number;
  storage: BlobStorageWriter;
}

export interface IngestUploadedBlobResult {
  blob: BlobRow;
  /** `false` when identical bytes (same content hash) already had a blob and this call reused it. */
  created: boolean;
}

/**
 * `POST /api/blobs`'s upload pipeline: the streaming, size cap, content-hash dedup and
 * duplicate-bytes cleanup of `ingestUploadedFile`, but no item is created. Bytes go under the
 * `blobs/` key prefix (`<tenantId>/blobs/<uuid>`), which is how `blobsUnreferencedSweep` tells a
 * standalone blob from one a Files item, a library cover or a recording owns.
 *
 * The stored mime type comes from the bytes, never from `input.mimeType`. A dedup hit keeps its first row's
 * `mime_type` and answers it unchanged ([[2026-11-04-blob-content-classification-preserves-legacy-metadata]]); the
 * verified type recorded beside it is what a capture then judges the blob by (`effectiveBlobMimeTypeSql`). Bytes
 * whose type is not one of `BLOB_UPLOAD_MIME_TYPES` (or is not recognised at all) are removed again and refused with
 * `UnsupportedMediaTypeError`, before any row is written.
 */
export async function ingestUploadedBlob(
  pool: Pool,
  input: IngestUploadedBlobInput,
): Promise<IngestUploadedBlobResult> {
  // Resolved before streaming, so a missing tenant fails before any byte is written.
  const storageKey = await tenantBlobStorageKey(pool, `blobs/${randomUUID()}`);

  let byteSize: number;
  let contentHash: string;
  try {
    ({ byteSize, contentHash } = await input.storage.writeStream(storageKey, input.source, {
      maxBytes: input.maxBytes,
    }));
  } catch (err) {
    input.source.resume();
    throw err;
  }

  try {
    const detectedMimeType = detectBlobMimeType(await readHead(input.storage, storageKey, byteSize));
    if (detectedMimeType === null || !BLOB_UPLOAD_MIME_TYPES.has(detectedMimeType)) {
      throw new UnsupportedMediaTypeError("The uploaded bytes are not a type a blob may have");
    }
    return await withTransaction(pool, async (client) => {
      const blob = await findOrCreateBlob(client, {
        mimeType: detectedMimeType,
        byteSize,
        storageKey,
        contentHash,
      });
      if (!(await lockBlobById(client, blob.id))) {
        throw new ValidationError("Invalid blob reference", { field: "blobId" });
      }
      await recordDetectedBlobMimeType(client, blob.id, detectedMimeType);
      if (blob.storageKey === storageKey) return { blob, created: true };
      // A dedup hit: the bytes just streamed duplicate the existing blob's; drop them once this commits.
      runAfterCommit(client, () => {
        void input.storage.delete(storageKey).catch((err) => {
          logger.error(
            { errCode: err instanceof Error && "code" in err ? String(err.code) : undefined, blobId: blob.id },
            "Failed to delete duplicate upload bytes",
          );
        });
      });
      return { blob, created: false };
    });
  } catch (err) {
    try {
      await input.storage.delete(storageKey);
    } catch (deleteErr) {
      logger.error(
        { errCode: deleteErr instanceof Error && "code" in deleteErr ? String(deleteErr.code) : undefined },
        "Failed to delete upload bytes after a failed transaction",
      );
    }
    throw err;
  }
}
