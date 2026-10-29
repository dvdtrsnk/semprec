import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTenantZeroId } from "../../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { MaxBytesExceededError } from "../../mail/blobStorage.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createBlob, deleteBlobIfUnreferenced } from "../blobsStore.js";
import { ingestUploadedBlob } from "../fileUploadStore.js";
import { handleBlobsUnreferencedSweepTask, sweepUnreferencedBlobs } from "../unreferencedBlobSweep.js";
import { withTransaction } from "../../db/pool.js";

/** In-memory storage that enforces `maxBytes` like the real writer and records deletes. */
class FakeStorage implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();
  readonly deleteCalls: string[] = [];

  async writeStream(
    storageKey: string,
    source: Readable,
    options?: { maxBytes?: number },
  ): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (options?.maxBytes !== undefined && total > options.maxBytes)
        throw new MaxBytesExceededError(options.maxBytes);
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.deleteCalls.push(storageKey);
    this.bytesByKey.delete(storageKey);
  }

  readStream(storageKey: string): Readable {
    const bytes = this.bytesByKey.get(storageKey);
    if (!bytes) throw new Error(`no bytes stored for ${storageKey}`);
    return Readable.from([bytes]);
  }
}

let pool: Pool;
let chokePoint: ChokePoint;

async function countBlobs(blobId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs WHERE id = $1", [
    blobId,
  ]);
  return Number(rows[0]?.count);
}

async function countFilesItems(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM items WHERE properties ? 'file'",
  );
  return Number(rows[0]?.count);
}

function ageBlob(blobId: string, hours: number): Promise<unknown> {
  return pool.query("UPDATE blobs SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1", [
    blobId,
    String(hours),
  ]);
}

function upload(storage: FakeStorage, bytes: string, maxBytes = 1024) {
  return ingestUploadedBlob(pool, {
    mimeType: "image/png",
    source: Readable.from([Buffer.from(bytes)]),
    maxBytes,
    storage,
  });
}

describe("standalone blobs (issue #1401)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function recipesDatabaseWithImageProperty(key = "photo") {
    const database = await chokePoint.createDatabase({ name: `Recipes ${key}` });
    await chokePoint.createProperty({ databaseId: database.id, key, name: key, type: "image" });
    return database;
  }

  describe("ingestUploadedBlob", () => {
    it("creates a blob under the blobs/ prefix and no Files item", async () => {
      const storage = new FakeStorage();
      const { blob, created } = await upload(storage, "png bytes");

      expect(created).toBe(true);
      expect(blob.mimeType).toBe("image/png");
      expect(blob.byteSize).toBe(String("png bytes".length));
      expect(blob.storageKey.split("/")[1]).toBe("blobs");
      expect(storage.bytesByKey.get(blob.storageKey)).toEqual(Buffer.from("png bytes"));
      expect(await countFilesItems()).toBe(0);
    });

    it("returns the existing blob for identical bytes and drops the duplicate bytes", async () => {
      const storage = new FakeStorage();
      const first = await upload(storage, "same bytes");
      const second = await upload(storage, "same bytes");

      expect(second.created).toBe(false);
      expect(second.blob.id).toBe(first.blob.id);
      expect(storage.bytesByKey.size).toBe(1);
      expect(storage.bytesByKey.has(first.blob.storageKey)).toBe(true);
    });

    it("rejects a body over the cap and leaves no blob row", async () => {
      const storage = new FakeStorage();
      await expect(upload(storage, "x".repeat(50), 10)).rejects.toBeInstanceOf(MaxBytesExceededError);
      const { rows } = await pool.query("SELECT id FROM blobs");
      expect(rows).toHaveLength(0);
    });
  });

  describe("deleteBlobIfUnreferenced with image properties", () => {
    it("keeps a blob an item's image property names, whatever the property key", async () => {
      for (const key of ["photo", "cover", "coverOverride"]) {
        const database = await recipesDatabaseWithImageProperty(key);
        const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: `t/blobs/${key}` });
        await chokePoint.createItem({ databaseId: database.id, properties: { [key]: { blobId: blob.id } } });

        expect(await withTransaction(pool, (client) => deleteBlobIfUnreferenced(client, blob.id))).toBeNull();
        expect(await countBlobs(blob.id)).toBe(1);
      }
    });

    it("does not count a non-image property that happens to hold the blob id", async () => {
      const database = await chokePoint.createDatabase({ name: "Notes" });
      await chokePoint.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
      const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "t/blobs/text" });
      await chokePoint.createItem({ databaseId: database.id, properties: { note: { blobId: blob.id } } });

      expect(await withTransaction(pool, (client) => deleteBlobIfUnreferenced(client, blob.id))).toBe("t/blobs/text");
    });
  });

  describe("sweepUnreferencedBlobs", () => {
    it("removes a stale unreferenced standalone blob and its bytes, keeping referenced and fresh ones", async () => {
      const storage = new FakeStorage();
      const database = await recipesDatabaseWithImageProperty();

      const stale = (await upload(storage, "stale")).blob;
      const referenced = (await upload(storage, "referenced")).blob;
      const fresh = (await upload(storage, "fresh")).blob;
      await chokePoint.createItem({ databaseId: database.id, properties: { photo: { blobId: referenced.id } } });
      await ageBlob(stale.id, 25);
      await ageBlob(referenced.id, 25);

      expect(await sweepUnreferencedBlobs(pool, storage)).toBe(1);

      expect(await countBlobs(stale.id)).toBe(0);
      expect(storage.bytesByKey.has(stale.storageKey)).toBe(false);
      expect(storage.deleteCalls).toEqual([stale.storageKey]);
      expect(await countBlobs(referenced.id)).toBe(1);
      expect(storage.bytesByKey.has(referenced.storageKey)).toBe(true);
      expect(await countBlobs(fresh.id)).toBe(1);
    });

    it("leaves a stale blob outside the blobs/ prefix alone", async () => {
      const storage = new FakeStorage();
      const owned = await createBlob(pool, { mimeType: "audio/mp4", byteSize: 1, storageKey: "t/files/derived" });
      await ageBlob(owned.id, 48);

      expect(await sweepUnreferencedBlobs(pool, storage)).toBe(0);
      expect(await countBlobs(owned.id)).toBe(1);
    });

    it("does not touch another tenant's stale blob when run in this tenant's scope", async () => {
      const storage = new FakeStorage();
      const tenantB = await createTestTenant(pool);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO blobs (tenant_id, mime_type, byte_size, storage_key, content_hash)
         VALUES ($1, 'image/png', 1, $2, 'b-hash') RETURNING id`,
        [tenantB, `${tenantB}/blobs/foreign`],
      );
      const foreignId = rows[0]?.id ?? "";
      await ageBlob(foreignId, 48);
      const own = (await upload(storage, "own stale")).blob;
      await ageBlob(own.id, 48);

      // The admin pool bypasses row-level security, so the sweep runs on the runtime role.
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        expect(await runInTenant(getTenantZeroId(), () => sweepUnreferencedBlobs(runtimePool, storage))).toBe(1);
      } finally {
        await runtimePool.end();
      }

      expect(await countBlobs(own.id)).toBe(0);
      expect(await countBlobs(foreignId)).toBe(1);
    });

    it("the task handler sweeps every active tenant", async () => {
      const storage = new FakeStorage();
      const tenantB = await createTestTenant(pool);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO blobs (tenant_id, mime_type, byte_size, storage_key, content_hash)
         VALUES ($1, 'image/png', 1, $2, 'b-hash') RETURNING id`,
        [tenantB, `${tenantB}/blobs/foreign`],
      );
      const foreignId = rows[0]?.id ?? "";
      await ageBlob(foreignId, 48);

      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        await handleBlobsUnreferencedSweepTask(runtimePool, storage);
      } finally {
        await runtimePool.end();
      }

      expect(await countBlobs(foreignId)).toBe(0);
      expect(storage.deleteCalls).toEqual([`${tenantB}/blobs/foreign`]);
    });
  });
});
