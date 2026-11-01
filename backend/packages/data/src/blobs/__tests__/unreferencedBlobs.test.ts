import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import "../../domainWriteHooks.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  withTenantTransaction,
} from "../../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { MaxBytesExceededError } from "../../mail/blobStorage.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createBlob, deleteBlobIfUnreferenced } from "../blobsStore.js";
import { ingestUploadedBlob } from "../fileUploadStore.js";
import { handleBlobsUnreferencedSweepTask, sweepUnreferencedBlobs } from "../unreferencedBlobSweep.js";
import { insertInboxAttachments } from "../../inbox/inboxAttachmentsStore.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { registerItemPreWriteTransform } from "../../chokePoint/hooks.js";

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

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
      expect(blob.mimeType).toBe("application/octet-stream");
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

    it("removes uploaded bytes if reading the detection head fails", async () => {
      class FailingReadStorage extends FakeStorage {
        override readStream(): Readable {
          throw new Error("head read failed");
        }
      }
      const storage = new FailingReadStorage();
      await expect(upload(storage, "stored bytes")).rejects.toThrow("head read failed");
      expect(storage.bytesByKey.size).toBe(0);
      expect(storage.deleteCalls).toHaveLength(1);
      expect((await pool.query("SELECT id FROM blobs")).rows).toHaveLength(0);
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

    it("keeps a mixed-case blob reference in a schema-declared file property", async () => {
      const database = await chokePoint.createDatabase({ name: "Files" });
      await chokePoint.createProperty({ databaseId: database.id, key: "document", name: "Document", type: "file" });
      const blob = await createBlob(pool, { mimeType: "application/pdf", byteSize: 1, storageKey: "t/blobs/file" });
      await chokePoint.createItem({
        databaseId: database.id,
        properties: { document: { blobId: blob.id.toUpperCase() } },
      });
      expect(await withTransaction(pool, (client) => deleteBlobIfUnreferenced(client, blob.id))).toBeNull();
      expect(await countBlobs(blob.id)).toBe(1);
    });

    it("does not count a non-image property that happens to hold the blob id", async () => {
      const database = await chokePoint.createDatabase({ name: "Notes" });
      await chokePoint.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
      const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "t/blobs/text" });
      await chokePoint.createItem({ databaseId: database.id, properties: { note: { blobId: blob.id } } });

      expect(await withTransaction(pool, (client) => deleteBlobIfUnreferenced(client, blob.id))).toBe("t/blobs/text");
    });
  });

  describe("reference writes racing collection", () => {
    it("checks blob references supplied by defaults and pre-write transforms", async () => {
      const missing = randomUUID();
      const database = await chokePoint.createDatabase({ name: "Default image" });
      const property = await chokePoint.createProperty({
        databaseId: database.id,
        key: "photo",
        name: "Photo",
        type: "image",
      });
      // A legacy configuration fixture: current schema validation does not allow image defaults.
      await pool.query(
        "UPDATE properties SET config = jsonb_build_object('default', jsonb_build_object('blobId', $2::text)) WHERE id = $1",
        [property.id, missing],
      );
      await expect(chokePoint.createItem({ databaseId: database.id, properties: {} })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "photo" },
      });
      const moduleId = `blobProbe${randomUUID()}`;
      const transformed = await chokePoint.createDatabase({ name: "Transform image", ownerModuleId: moduleId });
      await chokePoint.createProperty({ databaseId: transformed.id, key: "photo", name: "Photo", type: "image" });
      await chokePoint.createProperty({ databaseId: transformed.id, key: "note", name: "Note", type: "text" });
      const existing = await chokePoint.createItem({ databaseId: transformed.id, properties: { note: "before" } });
      registerItemPreWriteTransform(moduleId, async ({ patch }) => ({ ...patch, photo: { blobId: missing } }));
      await expect(chokePoint.createItem({ databaseId: transformed.id, properties: {} })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "photo" },
      });
      await expect(
        chokePoint.updateItem({ databaseId: transformed.id, itemId: existing.id, propertiesPatch: { note: "after" } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "photo" } });
      expect((await chokePoint.getItem(transformed.id, existing.id))?.properties).toEqual({ note: "before" });
      const count = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = ANY($1::uuid[])",
        [[database.id, transformed.id]],
      );
      expect(count.rows[0]?.n).toBe(1);
    });

    it("rejects malformed, missing and foreign references and preserves unrelated legacy fields", async () => {
      const database = await recipesDatabaseWithImageProperty();
      await chokePoint.createProperty({ databaseId: database.id, key: "note", name: "Note", type: "text" });
      const foreignTenant = await createTestTenant(pool);
      const foreign = await withTenantTransaction(pool, foreignTenant, (client) =>
        createBlob(client, { mimeType: "image/png", byteSize: 1, storageKey: `${foreignTenant}/blobs/foreign` }),
      );
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const cp = createChokePoint(runtime);
        const invalid = ["not-a-uuid", randomUUID(), foreign.id];
        for (const id of invalid) {
          await expect(
            runInTenant(getTenantZeroId(), () =>
              cp.createItem({ databaseId: database.id, properties: { photo: { blobId: id } } }),
            ),
          ).rejects.toMatchObject({ code: "validation_failed", details: { field: "photo" } });
        }
        const item = await runInTenant(getTenantZeroId(), () =>
          cp.createItem({ databaseId: database.id, properties: { photo: { url: "https://example.com/image" } } }),
        );
        await pool.query("UPDATE items SET properties = jsonb_set(properties, '{photo}', $2::jsonb) WHERE id = $1", [
          item.id,
          JSON.stringify({ blobId: randomUUID() }),
        ]);
        await runInTenant(getTenantZeroId(), () =>
          cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { note: "safe" } }),
        );
        await expect(
          runInTenant(getTenantZeroId(), () =>
            cp.updateItem({
              databaseId: database.id,
              itemId: item.id,
              propertiesPatch: { photo: { blobId: foreign.id } },
            }),
          ),
        ).rejects.toMatchObject({ code: "validation_failed", details: { field: "photo" } });
        const saved = await runInTenant(getTenantZeroId(), () => cp.getItem(database.id, item.id));
        expect(saved?.properties.note).toBe("safe");
        expect(saved?.properties.photo).not.toEqual({ blobId: foreign.id });
        const own = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "tenant/blobs/own" });
        const updated = await runInTenant(getTenantZeroId(), () =>
          cp.updateItem({
            databaseId: database.id,
            itemId: item.id,
            propertiesPatch: { photo: { blobId: own.id.toUpperCase() } },
          }),
        );
        expect(updated.properties.photo).toEqual({ blobId: own.id.toUpperCase() });
        expect(
          await runInTenant(getTenantZeroId(), () =>
            withTransaction(runtime, (client) => deleteBlobIfUnreferenced(client, own.id)),
          ),
        ).toBeNull();
        await runInTenant(getTenantZeroId(), () =>
          cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { photo: null } }),
        );
        const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
          database.id,
        ]);
        expect(count.rows[0]?.n).toBe(1);
      } finally {
        await runtime.end();
      }
    });

    it("waits for a committed image reference before rechecking and keeps its bytes", async () => {
      const database = await recipesDatabaseWithImageProperty();
      const storage = new FakeStorage();
      const blob = (await upload(storage, "concurrent image")).blob;
      await ageBlob(blob.id, 25);
      const writerPool = await createRuntimeRolePool(pool, "semprec_data");
      const sweepPool = await createRuntimeRolePool(pool, "semprec_data");
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const writer = runInTenant(getTenantZeroId(), () =>
        withTransaction(writerPool, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("missing writer pid");
          await createItemWithClient(client, {
            databaseId: database.id,
            properties: { photo: { blobId: blob.id.toUpperCase() } },
          });
          ready(pid);
          await gate;
        }),
      );
      const writerOutcome = Promise.allSettled([writer]);
      let sweep: Promise<number> | undefined;
      try {
        const pid = await bounded(
          Promise.race([
            started,
            writer.then(() => {
              throw new Error("writer exited before barrier");
            }),
          ]),
        );
        sweep = runInTenant(getTenantZeroId(), () => sweepUnreferencedBlobs(sweepPool, storage));
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
      } finally {
        release();
        await writerOutcome;
        if (sweep) await Promise.allSettled([sweep]);
        await writerPool.end();
        await sweepPool.end();
      }
      await writer;
      expect(await sweep).toBe(0);
      expect(await countBlobs(blob.id)).toBe(1);
      expect(storage.bytesByKey.has(blob.storageKey)).toBe(true);
    });

    it("rolls back an image write that waits for a deletion to commit", async () => {
      const database = await recipesDatabaseWithImageProperty();
      const storage = new FakeStorage();
      const blob = (await upload(storage, "deleted image")).blob;
      const deletePool = await createRuntimeRolePool(pool, "semprec_data");
      const writerPool = await createRuntimeRolePool(pool, "semprec_data");
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const deleting = runInTenant(getTenantZeroId(), () =>
        withTransaction(deletePool, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("missing deletion pid");
          expect(await deleteBlobIfUnreferenced(client, blob.id)).toBe(blob.storageKey);
          ready(pid);
          await gate;
        }),
      );
      const deletionOutcome = Promise.allSettled([deleting]);
      let writing: Promise<unknown> | undefined;
      try {
        const pid = await bounded(
          Promise.race([
            started,
            deleting.then(() => {
              throw new Error("delete exited before barrier");
            }),
          ]),
        );
        writing = runInTenant(getTenantZeroId(), () =>
          createChokePoint(writerPool).createItem({
            databaseId: database.id,
            properties: { photo: { blobId: blob.id } },
          }),
        );
        void writing.catch(() => {});
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
      } finally {
        release();
        await deletionOutcome;
        if (writing) await Promise.allSettled([writing]);
        await deletePool.end();
        await writerPool.end();
      }
      await deleting;
      await expect(writing).rejects.toMatchObject({ code: "validation_failed", details: { field: "photo" } });
      const rows = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        database.id,
      ]);
      expect(rows.rows[0]?.n).toBe(0);
      expect(await countBlobs(blob.id)).toBe(0);
      expect(storage.deleteCalls).toEqual([]);
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

    it("keeps a stale standalone blob an Inbox attachment names, bytes included", async () => {
      const storage = new FakeStorage();
      const attached = (await upload(storage, "attached")).blob;
      const stale = (await upload(storage, "stale again")).blob;
      // The attachment table has no foreign key to items, so an id naming no row is enough here.
      await insertInboxAttachments(pool, randomUUID(), [{ blobId: attached.id, source: "camera" }]);
      await ageBlob(attached.id, 25);
      await ageBlob(stale.id, 25);

      expect(await sweepUnreferencedBlobs(pool, storage)).toBe(1);

      expect(await countBlobs(attached.id)).toBe(1);
      expect(storage.bytesByKey.has(attached.storageKey)).toBe(true);
      expect(await countBlobs(stale.id)).toBe(0);
      expect(storage.deleteCalls).toEqual([stale.storageKey]);
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
