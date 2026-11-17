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
  filesDatabaseId: string;
  filename: string;
  /** Ignored: the stored mime and Files `type` come from the bytes. */
  contentType: string;
  source: Readable;
  storageKeyPrefix: string;
  /** Enforced while streaming. */
  maxBytes: number;
  storage: BlobStorageWriter;
}

export interface IngestUploadedFileResult {
  item: ItemRow;
  blob: BlobRow;
  /** `false` when an identical upload already had a Files item and it was reused. */
  created: boolean;
}

/**
 * `POST /api/files`: streams bytes to storage, then dedupes by content hash and reuses or creates the Files item in
 * one transaction. The blob is locked before checking for an existing Files item, so a concurrent filing waits and
 * then sees the committed item.
 *
 * Bytes must be written before the transaction because the hash only exists afterwards. On rollback they are garbage
 * and deleted from the `catch`; on a dedup hit they are deleted after commit, because a failed delete inside the
 * transaction would abort otherwise-good database work.
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
  // Before streaming, so a missing tenant fails before any byte is written.
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
    // The write cleaned up its partial bytes; draining the rest keeps the connection reusable.
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
      // Dedup hit: the streamed bytes are a duplicate; delete them only after commit.
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
    // Nothing committed references these bytes.
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

/** Every Inbox attachment type plus HEIC, which a capture then refuses with its own error. */
const BLOB_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([...INBOX_ATTACHMENT_MIME_TYPES, "image/heic"]);

/** Audio first, then documents and images. */
function detectBlobMimeType(head: Buffer): string | null {
  return detectAudioMimeType(head) ?? detectFileType(head)?.mimeType ?? null;
}

export interface IngestUploadedBlobInput {
  /** Ignored for storage: the stored mime comes from the bytes. */
  mimeType: string;
  source: Readable;
  /** Enforced while streaming. */
  maxBytes: number;
  storage: BlobStorageWriter;
}

export interface IngestUploadedBlobResult {
  blob: BlobRow;
  /** `false` when identical bytes already had a blob and it was reused. */
  created: boolean;
}

/**
 * `POST /api/blobs`: like `ingestUploadedFile` but creates no item. The `blobs/` key prefix is how the unreferenced
 * sweep tells a standalone blob from an owned one. A dedup hit keeps its first row's `mime_type`; the detected type
 * recorded beside it is what captures judge by. Unrecognised or disallowed bytes are refused before any row is written.
 */
export async function ingestUploadedBlob(
  pool: Pool,
  input: IngestUploadedBlobInput,
): Promise<IngestUploadedBlobResult> {
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
      // Dedup hit: delete the duplicate bytes after commit.
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
