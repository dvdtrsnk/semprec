import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { ForbiddenError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { ingestUploadedFile } from "../blobs/fileUploadStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { logger } from "../blobs/logger.js";

/**
 * In-memory stand-in for `LocalFsBlobStorageWriter`: records every `writeStream`/`delete` call
 * and can be told to make the *next* written key's `delete` throw, so the tests can drive the
 * "delete inside vs. after commit" distinction the ADR requires without touching the filesystem.
 */
class FakeBlobStorageWriter implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();
  readonly deleteCalls: string[] = [];
  private readonly deleteFailureKeys = new Set<string>();
  private failNextWrittenKeysDelete = false;

  failDeleteForNextWrite(): void {
    this.failNextWrittenKeysDelete = true;
  }

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    if (this.failNextWrittenKeysDelete) {
      this.deleteFailureKeys.add(storageKey);
      this.failNextWrittenKeysDelete = false;
    }
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.deleteCalls.push(storageKey);
    if (this.deleteFailureKeys.has(storageKey)) {
      throw new Error(`simulated delete failure for ${storageKey}`);
    }
    this.bytesByKey.delete(storageKey);
  }

  readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    const bytes = this.bytesByKey.get(storageKey);
    if (!bytes) throw new Error(`no bytes stored for ${storageKey}`);
    return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
  }
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

let pool: Pool;

describe("ingestUploadedFile (issue #670)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function filesDatabaseId(): Promise<string> {
    const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));
    return ids.filesDatabaseId;
  }

  function upload(storage: FakeBlobStorageWriter, filesDatabaseId: string, bytes: string) {
    return ingestUploadedFile(pool, {
      filesDatabaseId,
      filename: "note.txt",
      contentType: "text/plain",
      source: Readable.from([Buffer.from(bytes)]),
      storageKeyPrefix: "files",
      maxBytes: 1024,
      storage,
    });
  }

  async function uploadBytes(
    storage: FakeBlobStorageWriter,
    filesDatabaseId: string,
    bytes: Buffer,
    contentType: string,
  ) {
    return ingestUploadedFile(pool, {
      filesDatabaseId,
      filename: "upload.bin",
      contentType,
      source: Readable.from([bytes]),
      storageKeyPrefix: "files",
      maxBytes: 1024 * 1024,
      storage,
    });
  }

  it("detects a PDF sent as image/jpeg from its bytes: type pdf and blob mime application/pdf", async () => {
    const result = await uploadBytes(
      new FakeBlobStorageWriter(),
      await filesDatabaseId(),
      Buffer.from("%PDF-1.7\n%body"),
      "image/jpeg",
    );
    expect(result.item.properties["type"]).toBe("pdf");
    expect(result.blob.mimeType).toBe("application/pdf");
  });

  it("stores no type and application/octet-stream for unrecognised content, whatever the client claimed", async () => {
    const result = await uploadBytes(
      new FakeBlobStorageWriter(),
      await filesDatabaseId(),
      Buffer.from("just some text"),
      "application/pdf",
    );
    expect(result.item.properties).not.toHaveProperty("type");
    expect(result.blob.mimeType).toBe("application/octet-stream");
  });

  it("stores an empty upload as unknown content", async () => {
    const result = await uploadBytes(
      new FakeBlobStorageWriter(),
      await filesDatabaseId(),
      Buffer.alloc(0),
      "image/png",
    );
    expect(result.item.properties).not.toHaveProperty("type");
    expect(result.blob.mimeType).toBe("application/octet-stream");
  });

  it("returns the existing item unchanged when identical bytes are uploaded again", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const first = await uploadBytes(storage, filesId, bytes, "application/octet-stream");
    const second = await uploadBytes(storage, filesId, bytes, "image/jpeg");
    expect(first.item.properties["type"]).toBe("png");
    expect(second.created).toBe(false);
    expect(second.item).toEqual(first.item);
  });

  it("deletes the streamed bytes and leaves no blobs row when the transaction fails", async () => {
    const filesId = await filesDatabaseId();
    // The Files database is seeded as a system database, which `chokePoint.archiveDatabase`
    // refuses to archive — archived directly here purely to make `createItemWithClient` throw
    // `database_archived`, the same guard a non-system database hits through the choke point.
    await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [filesId]);
    const storage = new FakeBlobStorageWriter();

    await expect(upload(storage, filesId, "hello world")).rejects.toBeInstanceOf(ForbiddenError);

    expect(storage.deleteCalls).toHaveLength(1);
    expect(storage.bytesByKey.size).toBe(0);

    const contentHash = createHash("sha256").update("hello world").digest("hex");
    const { rows } = await pool.query("SELECT id FROM blobs WHERE content_hash = $1", [contentHash]);
    expect(rows).toHaveLength(0);
  });

  it("deletes the duplicate's bytes after commit, exactly once, keeping the first key's bytes", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const first = await upload(storage, filesId, "same content");
    expect(first.created).toBe(true);
    const firstKey = first.blob.storageKey;

    const second = await upload(storage, filesId, "same content");
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);

    expect(storage.deleteCalls).toHaveLength(1);
    const secondKey = requireDefined(storage.deleteCalls[0], "expected one delete call");
    expect(secondKey).not.toBe(firstKey);
    expect(storage.bytesByKey.has(firstKey)).toBe(true);
    expect(storage.bytesByKey.has(secondKey)).toBe(false);
  });

  it("a failed after-commit delete of the duplicate does not fail the upload (delete happens after commit, not inside)", async () => {
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const first = await upload(storage, filesId, "same content again");
    storage.failDeleteForNextWrite();

    const second = await upload(storage, filesId, "same content again");

    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(storage.deleteCalls).toHaveLength(1);
    // The duplicate's bytes are still present because the fake's delete failed — the point
    // being verified is that the failure did not abort the transaction.
    const secondKey = requireDefined(storage.deleteCalls[0], "expected one delete call");
    expect(storage.bytesByKey.has(secondKey)).toBe(true);

    // The delete runs from an `afterCommit` callback, whose rejection is handled asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      { errCode: undefined, blobId: expect.any(String) },
      "Failed to delete duplicate upload bytes",
    );
    // The log names neither the storage key nor the fake's error text, which embeds the key.
    const logged = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(logged).not.toContain(secondKey);
    expect(logged).not.toContain("simulated delete failure");
  });

  it("keeps the bytes and the blobs row referencing them when the upload creates a new blob", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const result = await upload(storage, filesId, "brand new bytes");

    expect(result.created).toBe(true);
    expect(storage.deleteCalls).toHaveLength(0);
    expect(storage.bytesByKey.get(result.blob.storageKey)).toBeDefined();
  });
});
