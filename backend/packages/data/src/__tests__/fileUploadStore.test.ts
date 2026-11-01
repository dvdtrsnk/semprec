import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { ForbiddenError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { ingestUploadedBlob, ingestUploadedFile } from "../blobs/fileUploadStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { logger } from "../blobs/logger.js";
import { deleteBlobIfUnreferenced } from "../blobs/blobsStore.js";

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

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("filing barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

  async function uploadBytes(
    storage: FakeBlobStorageWriter,
    filesDatabaseId: string,
    bytes: Buffer,
    contentType: string,
    filename = "upload.bin",
  ) {
    return ingestUploadedFile(pool, {
      filesDatabaseId,
      filename,
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

  it("reuses a standalone blob and its original storage root when filing identical bytes", async () => {
    const storage = new FakeBlobStorageWriter();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const standalone = await ingestUploadedBlob(pool, {
      mimeType: "image/png",
      source: Readable.from([bytes]),
      maxBytes: 1024,
      storage,
    });
    const filed = await uploadBytes(storage, await filesDatabaseId(), bytes, "image/png");
    expect(filed.created).toBe(true);
    expect(filed.blob.id).toBe(standalone.blob.id);
    expect(filed.blob.storageKey).toBe(standalone.blob.storageKey);
    expect(filed.item.properties.file).toEqual({ blobId: standalone.blob.id });
    expect(storage.bytesByKey.has(standalone.blob.storageKey)).toBe(true);
  });

  it.each([
    ["first.bin", "second.bin", "commit"],
    ["second.bin", "first.bin", "commit"],
    ["first.bin", "second.bin", "rollback"],
  ] as const)(
    "serializes %s before %s when the first outcome is %s",
    async (firstName, secondName, outcome) => {
      const filesId = await filesDatabaseId();
      const storage = new FakeBlobStorageWriter();
      const bytes = Buffer.from("standalone race bytes");
      const standalone = await ingestUploadedBlob(pool, {
        mimeType: "image/png",
        source: Readable.from([bytes]),
        maxBytes: 1024,
        storage,
      });
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const wrapped = new Map<PoolClient, PoolClient["query"]>();
      let held = false;
      const instrument = (client: PoolClient) => {
        if (wrapped.has(client)) return;
        // The proxy forwards each call with its original receiver.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        wrapped.set(client, client.query);
        // eslint-disable-next-line @typescript-eslint/unbound-method
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (held || typeof args[0] !== "string" || !args[0].includes("properties -> 'file' ->> 'blobId'"))
              return result;
            held = true;
            return Promise.resolve(result).then(async (value: unknown) => {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (pid === undefined) throw new Error("missing filing pid");
              ready(pid);
              await gate;
              if (outcome === "rollback") throw new Error("forced first filing rollback");
              return value;
            });
          },
        });
      };
      pool.on("acquire", instrument);
      const first = uploadBytes(storage, filesId, bytes, "image/png", firstName);
      const firstSettled = Promise.allSettled([first]);
      let second: ReturnType<typeof uploadBytes> | undefined;
      try {
        const pid = await bounded(
          Promise.race([
            started,
            first.then(() => {
              throw new Error("first filing exited before barrier");
            }),
          ]),
        );
        second = uploadBytes(storage, filesId, bytes, "image/png", secondName);
        const secondSettled = Promise.allSettled([second]);
        await expect
          .poll(
            async () => {
              const result = await pool.query<{ blocked: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
                [pid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
        release();
        const [firstResult] = await firstSettled;
        const [secondResult] = await secondSettled;
        if (outcome === "commit") {
          expect(firstResult?.status).toBe("fulfilled");
          expect(secondResult?.status).toBe("fulfilled");
          if (firstResult?.status === "fulfilled" && secondResult?.status === "fulfilled") {
            expect(firstResult.value.created).toBe(true);
            expect(firstResult.value.item.properties.name).toBe(firstName);
            expect(secondResult.value.created).toBe(false);
            expect(secondResult.value.item.id).toBe(firstResult.value.item.id);
            expect(secondResult.value.blob.id).toBe(standalone.blob.id);
          }
        } else {
          expect(firstResult?.status).toBe("rejected");
          if (firstResult?.status === "rejected")
            expect(firstResult.reason).toMatchObject({ message: "forced first filing rollback" });
          expect(secondResult?.status).toBe("fulfilled");
          if (secondResult?.status === "fulfilled")
            expect(secondResult.value).toMatchObject({
              created: true,
              blob: { id: standalone.blob.id },
              item: { properties: { name: secondName } },
            });
        }
        const rows = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties ? 'file'",
          [filesId],
        );
        expect(rows.rows[0]?.n).toBe(1);
        expect(storage.bytesByKey.has(standalone.blob.storageKey)).toBe(true);
        await vi.waitFor(() => expect(storage.bytesByKey.size).toBe(1));
        expect(storage.deleteCalls).toHaveLength(2);
      } finally {
        release();
        await firstSettled;
        if (second) await Promise.allSettled([second]);
        pool.off("acquire", instrument);
        for (const [client, query] of wrapped) client.query = query;
      }
    },
    15000,
  );

  it("fails closed and cleans its bytes if the reused blob disappears before the filing lock", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();
    const bytes = Buffer.from("blob deleted before filing lock");
    const standalone = await ingestUploadedBlob(pool, {
      mimeType: "image/png",
      source: Readable.from([bytes]),
      maxBytes: 1024,
      storage,
    });
    const wrapped = new Map<PoolClient, PoolClient["query"]>();
    let intercepted = false;
    let deletion: Promise<void> | undefined;
    const instrument = (client: PoolClient) => {
      if (wrapped.has(client)) return;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      wrapped.set(client, client.query);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          if (intercepted || typeof args[0] !== "string" || !args[0].includes("AND id = $1 FOR UPDATE")) {
            return Reflect.apply(target, receiver, args);
          }
          intercepted = true;
          deletion = withTransaction(pool, async (other) => {
            const key = await deleteBlobIfUnreferenced(other, standalone.blob.id);
            expect(key).toBe(standalone.blob.storageKey);
          }).then(async () => storage.delete(standalone.blob.storageKey));
          return bounded(deletion).then(() => Reflect.apply(target, receiver, args));
        },
      });
    };
    pool.on("acquire", instrument);
    try {
      await expect(uploadBytes(storage, filesId, bytes, "image/png")).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "file" },
      });
      expect(intercepted).toBe(true);
      expect(storage.bytesByKey.size).toBe(0);
      expect(storage.deleteCalls).toHaveLength(2);
      const rows = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties ? 'file'",
        [filesId],
      );
      expect(rows.rows[0]?.n).toBe(0);
    } finally {
      if (deletion) await Promise.allSettled([deletion]);
      pool.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    }
  }, 15000);

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
