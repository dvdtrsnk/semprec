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

/**
 * In-memory stand-in for `LocalFsBlobStorageWriter`: records every `writeStream`/`delete` call
 * and can be told to make a specific key's `delete` throw, so the tests can drive the "delete
 * inside vs. after commit" distinction the ADR requires without touching the filesystem.
 */
class FakeBlobStorageWriter implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();
  readonly deleteCalls: string[] = [];
  private deleteFailureKeys = new Set<string>();

  failDeleteFor(storageKey: string): void {
    this.deleteFailureKeys.add(storageKey);
  }

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.deleteCalls.push(storageKey);
    if (this.deleteFailureKeys.has(storageKey)) {
      throw new Error(`simulated delete failure for ${storageKey}`);
    }
    this.bytesByKey.delete(storageKey);
  }

  readStream(): Readable {
    throw new Error("not used by these tests");
  }
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
    const firstKey = [...storage.bytesByKey.keys()][0];

    const second = await upload(storage, filesId, "same content");
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);

    expect(storage.deleteCalls).toHaveLength(1);
    const secondKey = storage.deleteCalls[0];
    expect(secondKey).not.toBe(firstKey);
    expect(storage.bytesByKey.has(firstKey)).toBe(true);
    expect(storage.bytesByKey.has(secondKey)).toBe(false);
  });

  it("a failed after-commit delete of the duplicate does not fail the upload (delete happens after commit, not inside)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const first = await upload(storage, filesId, "same content again");

    const beforeSecondKeys = new Set(storage.bytesByKey.keys());
    // The second call's storage key doesn't exist yet, so fail every delete from here on —
    // whichever key the second upload streams to is the one that must be told to throw.
    const originalWriteStream = storage.writeStream.bind(storage);
    storage.writeStream = async (storageKey, source, options) => {
      storage.failDeleteFor(storageKey);
      return originalWriteStream(storageKey, source, options);
    };

    const second = await upload(storage, filesId, "same content again");

    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(storage.deleteCalls).toHaveLength(1);
    // The duplicate's bytes are still present because the fake's delete failed — the point
    // being verified is that the failure did not abort the transaction.
    const secondKey = storage.deleteCalls[0];
    expect(beforeSecondKeys.has(secondKey)).toBe(false);
    expect(storage.bytesByKey.has(secondKey)).toBe(true);

    // The delete runs from an `afterCommit` callback, whose rejection is handled asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to delete duplicate upload bytes ${secondKey}`),
      expect.anything(),
    );
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
