import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
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
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { registerItemPreWriteTransform } from "../../chokePoint/hooks.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { storeMessageSpeech } from "../../semp/messageSpeechStore.js";

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

/** Captures the backend on the very client that issues the matched production statement. */
function observeStatementPid(runtime: Pool, statement: RegExp) {
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  const wrapped = new Map<PoolClient, PoolClient["query"]>();
  let captured = false;
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    wrapped.set(client, client.query);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        if (captured || typeof args[0] !== "string" || !statement.test(args[0])) {
          return Reflect.apply(target, receiver, args);
        }
        captured = true;
        return (async () => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const actual = result.rows[0]?.pid;
          if (actual === undefined) throw new Error("missing competing backend pid");
          resolvePid(actual);
          return Reflect.apply(target, receiver, args);
        })();
      },
    });
  };
  runtime.on("acquire", instrument);
  return {
    pid,
    restore() {
      runtime.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    },
  };
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
      const competing = observeStatementPid(sweepPool, /FROM blobs\b[\s\S]*FOR UPDATE/i);
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
      let sweepOutcome: Promise<PromiseSettledResult<number>[]> | undefined;
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
        sweepOutcome = Promise.allSettled([sweep]);
        const competitorPid = await bounded(competing.pid);
        await expect
          .poll(
            async () => {
              const result = await pool.query<{ blocked: boolean }>(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [pid, competitorPid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
      } finally {
        release();
        await writerOutcome;
        if (sweepOutcome) await sweepOutcome;
        competing.restore();
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
      const competing = observeStatementPid(writerPool, /FROM blobs\b[\s\S]*FOR KEY SHARE/i);
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
      let writingOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
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
        writingOutcome = Promise.allSettled([writing]);
        const competitorPid = await bounded(competing.pid);
        await expect
          .poll(
            async () => {
              const result = await pool.query<{ blocked: boolean }>(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [pid, competitorPid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
      } finally {
        release();
        await deletionOutcome;
        if (writingOutcome) await writingOutcome;
        competing.restore();
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
    it("waits for a committed image UPDATE before rechecking and keeps its bytes", async () => {
      const database = await recipesDatabaseWithImageProperty();
      const storage = new FakeStorage();
      const prior = (await upload(storage, "prior image bytes")).blob;
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { photo: { blobId: prior.id } },
      });
      const blob = (await upload(storage, "concurrent image")).blob;
      await ageBlob(blob.id, 25);
      const writerPool = await createRuntimeRolePool(pool, "semprec_data");
      const sweepPool = await createRuntimeRolePool(pool, "semprec_data");
      const competing = observeStatementPid(sweepPool, /FROM blobs\b[\s\S]*FOR UPDATE/i);
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
          await updateItemWithClient(client, {
            databaseId: database.id,
            itemId: item.id,
            propertiesPatch: { photo: { blobId: blob.id.toUpperCase() } },
          });
          ready(pid);
          await gate;
        }),
      );
      const writerOutcome = Promise.allSettled([writer]);
      let sweep: Promise<number> | undefined;
      let sweepOutcome: Promise<PromiseSettledResult<number>[]> | undefined;
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
        sweepOutcome = Promise.allSettled([sweep]);
        const competitorPid = await bounded(competing.pid);
        await expect
          .poll(
            async () => {
              const result = await pool.query<{ blocked: boolean }>(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [pid, competitorPid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
      } finally {
        release();
        await writerOutcome;
        if (sweepOutcome) await sweepOutcome;
        competing.restore();
        await writerPool.end();
        await sweepPool.end();
      }
      await writer;
      expect(await sweep).toBe(0);
      expect(await countBlobs(blob.id)).toBe(1);
      expect(storage.bytesByKey.has(blob.storageKey)).toBe(true);
      expect((await chokePoint.getItem(database.id, item.id))?.properties.photo).toEqual({
        blobId: blob.id.toUpperCase(),
      });
    });

    it("rejects an image UPDATE that waits for a deletion to commit", async () => {
      const database = await recipesDatabaseWithImageProperty();
      const storage = new FakeStorage();
      const prior = (await upload(storage, "prior image bytes")).blob;
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { photo: { blobId: prior.id } },
      });
      const blob = (await upload(storage, "deleted image")).blob;
      const deletePool = await createRuntimeRolePool(pool, "semprec_data");
      const writerPool = await createRuntimeRolePool(pool, "semprec_data");
      const competing = observeStatementPid(writerPool, /FROM blobs\b[\s\S]*FOR KEY SHARE/i);
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
      let writingOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
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
          createChokePoint(writerPool).updateItem({
            databaseId: database.id,
            itemId: item.id,
            propertiesPatch: { photo: { blobId: blob.id } },
          }),
        );
        writingOutcome = Promise.allSettled([writing]);
        const competitorPid = await bounded(competing.pid);
        await expect
          .poll(
            async () => {
              const result = await pool.query<{ blocked: boolean }>(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [pid, competitorPid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
      } finally {
        release();
        await deletionOutcome;
        if (writingOutcome) await writingOutcome;
        competing.restore();
        await deletePool.end();
        await writerPool.end();
      }
      await deleting;
      await expect(writing).rejects.toMatchObject({ code: "validation_failed", details: { field: "photo" } });
      const rows = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
        database.id,
      ]);
      expect(rows.rows[0]?.n).toBe(1);
      const persisted = await chokePoint.getItem(database.id, item.id);
      expect(persisted?.properties.photo).toEqual({ blobId: prior.id });
      expect(storage.bytesByKey.get(prior.storageKey)).toEqual(Buffer.from("prior image bytes"));
      expect(await countBlobs(blob.id)).toBe(0);
      expect(storage.deleteCalls).toEqual([]);
    });
  });

  describe("sweepUnreferencedBlobs", () => {
    it("cascades one deleted message's speech row while preserving shared and foreign bytes", async () => {
      const dir = await mkdtemp(join(tmpdir(), "semprec-speech-message-cascade-"));
      const storage = new LocalFsBlobStorageWriter(dir);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const tenant = getTenantZeroId();
      const foreign = await createTestTenant(pool);
      let failure: unknown;
      let failed = false;
      try {
        const role = await runInTenant(tenant, () =>
          runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          ),
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const makeSpeech = async (owner: string, text: string, bytes: Buffer) => {
          const key = `${owner}/blobs/${randomUUID()}`;
          await storage.writeStream(key, Readable.from([bytes]), { maxBytes: bytes.length });
          return runInTenant(owner, () =>
            withTransaction(runtime, async (client) => {
              const turn = await sendSempMessage(client, { text, context: [], hasContext: false });
              const speech = await storeMessageSpeech(client, {
                threadId: turn.threadId,
                messageId: turn.messageId,
                text,
                voice: "alloy",
                storageKey: key,
                byteSize: bytes.length,
              });
              return { ...turn, blobId: speech.blob.id, key };
            }),
          );
        };
        const target = await makeSpeech(tenant, "Target speech", Buffer.from("AB"));
        const control = await makeSpeech(tenant, "Control speech", Buffer.from("CD"));
        const foreignControl = await makeSpeech(foreign, "Foreign speech", Buffer.from("EF"));
        const cp = createChokePoint(runtime);
        const database = await runInTenant(tenant, () => cp.createDatabase({ name: "Message cascade references" }));
        await runInTenant(tenant, () =>
          cp.createProperty({ databaseId: database.id, key: "photo", name: "Photo", type: "image" }),
        );
        const item = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: database.id, properties: { photo: { blobId: target.blobId } } }),
        );
        // No production message-delete workflow exists; remove only the paired assistant to satisfy the reply FK.
        await runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            const removed = await client.query<{ id: string }>(
              "DELETE FROM semp_messages WHERE id = $1 AND thread_id = $2 AND role = 'assistant' RETURNING id",
              [target.assistantMessageId, target.threadId],
            );
            expect(removed.rowCount).toBe(1);
            expect(removed.rows).toEqual([{ id: target.assistantMessageId }]);
          }),
        );
        const ownSnapshot = () =>
          runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => ({
              threads: (
                await client.query<{ id: string }>(
                  "SELECT id FROM semp_threads WHERE id = ANY($1::uuid[]) ORDER BY id",
                  [[target.threadId, control.threadId]],
                )
              ).rows,
              messages: (
                await client.query<{ id: string; role: string; thread_id: string }>(
                  "SELECT id, role, thread_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY id",
                  [[target.messageId, control.messageId, control.assistantMessageId]],
                )
              ).rows,
              cache: (
                await client.query<{ message_id: string; blob_id: string }>(
                  "SELECT message_id, blob_id FROM semp_message_speech WHERE message_id = ANY($1::uuid[]) ORDER BY message_id",
                  [[target.messageId, control.messageId]],
                )
              ).rows,
              blobs: (
                await client.query<{ id: string }>("SELECT id FROM blobs WHERE id = ANY($1::uuid[]) ORDER BY id", [
                  [target.blobId, control.blobId],
                ])
              ).rows,
              item: (
                await client.query<{ row: unknown }>("SELECT to_jsonb(i) AS row FROM items i WHERE i.id = $1", [
                  item.id,
                ])
              ).rows,
              jobs: (
                await client.query<{ key: string }>(
                  "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
                  [[`sempMessage:${target.assistantMessageId}`, `sempMessage:${control.assistantMessageId}`]],
                )
              ).rows,
            })),
          );
        const foreignSnapshot = () =>
          runInTenant(foreign, () =>
            withTransaction(runtime, async (client) => ({
              message: (
                await client.query<{ id: string }>("SELECT id FROM semp_messages WHERE id = $1", [
                  foreignControl.messageId,
                ])
              ).rows,
              cache: (
                await client.query<{ message_id: string; blob_id: string }>(
                  "SELECT message_id, blob_id FROM semp_message_speech WHERE message_id = $1",
                  [foreignControl.messageId],
                )
              ).rows,
              blob: (await client.query<{ id: string }>("SELECT id FROM blobs WHERE id = $1", [foreignControl.blobId]))
                .rows,
            })),
          );
        const before = await ownSnapshot();
        const foreignBefore = await foreignSnapshot();
        expect(before.threads).toHaveLength(2);
        expect(before.messages).toHaveLength(3);
        expect(before.cache).toHaveLength(2);
        expect(before.blobs).toHaveLength(2);
        expect(before.item).toHaveLength(1);
        expect(before.jobs).toHaveLength(2);
        expect(foreignBefore).toEqual({
          message: [{ id: foreignControl.messageId }],
          cache: [{ message_id: foreignControl.messageId, blob_id: foreignControl.blobId }],
          blob: [{ id: foreignControl.blobId }],
        });
        const refusedForeign = await runInTenant(foreign, () =>
          withTransaction(runtime, (client) =>
            client.query<{ id: string }>("DELETE FROM semp_messages WHERE id = $1 RETURNING id", [target.messageId]),
          ),
        );
        const refusedRandom = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            client.query<{ id: string }>("DELETE FROM semp_messages WHERE id = $1 RETURNING id", [randomUUID()]),
          ),
        );
        expect(refusedForeign.rowCount).toBe(0);
        expect(refusedForeign.rows).toEqual([]);
        expect(refusedRandom.rowCount).toBe(0);
        expect(refusedRandom.rows).toEqual([]);
        expect(await ownSnapshot()).toEqual(before);
        expect(await foreignSnapshot()).toEqual(foreignBefore);
        // No production message-delete endpoint exists; exercise the registered message FK directly.
        const deleted = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            client.query<{ id: string }>(
              "DELETE FROM semp_messages WHERE id = $1 AND thread_id = $2 AND role = 'user' RETURNING id",
              [target.messageId, target.threadId],
            ),
          ),
        );
        expect(deleted.rowCount).toBe(1);
        expect(deleted.rows).toEqual([{ id: target.messageId }]);
        const after = await ownSnapshot();
        expect(after.threads).toEqual(before.threads);
        expect(after.messages.map((row) => row.id).sort()).toEqual(
          [control.messageId, control.assistantMessageId].sort(),
        );
        expect(after.cache).toEqual([{ message_id: control.messageId, blob_id: control.blobId }]);
        expect(after.blobs).toEqual(before.blobs);
        expect(after.item).toEqual(before.item);
        expect(after.jobs).toEqual(before.jobs);
        expect(await foreignSnapshot()).toEqual(foreignBefore);
        expect(await readFile(join(dir, target.key))).toEqual(Buffer.from("AB"));
        expect(await readFile(join(dir, control.key))).toEqual(Buffer.from("CD"));
        expect(await readFile(join(dir, foreignControl.key))).toEqual(Buffer.from("EF"));
        const future = new Date("9999-01-01T00:00:00Z");
        expect(await runInTenant(tenant, () => sweepUnreferencedBlobs(runtime, storage, future))).toBe(0);
        expect(await readFile(join(dir, target.key))).toEqual(Buffer.from("AB"));
        await runInTenant(tenant, () =>
          cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { photo: null } }),
        );
        expect(await runInTenant(tenant, () => sweepUnreferencedBlobs(runtime, storage, future))).toBe(1);
        await expect(readFile(join(dir, target.key))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(dir, control.key))).toEqual(Buffer.from("CD"));
        expect(await readFile(join(dir, foreignControl.key))).toEqual(Buffer.from("EF"));
        const final = await ownSnapshot();
        expect(final.cache).toEqual([{ message_id: control.messageId, blob_id: control.blobId }]);
        expect(final.blobs).toEqual([{ id: control.blobId }]);
        expect(await foreignSnapshot()).toEqual(foreignBefore);
      } catch (error) {
        failed = true;
        failure = error;
      }
      const cleanup = await Promise.allSettled([runtime.end(), rm(dir, { recursive: true, force: true })]);
      const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failed || errors.length)
        throw new AggregateError([...(failed ? [failure] : []), ...errors], "Message cascade or cleanup failed", {
          cause: failed ? failure : errors[0],
        });
    });

    it("keeps speech and shared item bytes until their last reference is removed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "semprec-speech-collection-"));
      const storage = new LocalFsBlobStorageWriter(dir);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      const tenant = getTenantZeroId();
      let failure: unknown;
      let failed = false;
      try {
        const role = await runInTenant(tenant, () =>
          runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          ),
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const key = `${tenant}/blobs/${randomUUID()}`;
        await storage.writeStream(key, Readable.from([Buffer.from("AB")]), { maxBytes: 2 });
        const fixture = await runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            const turn = await sendSempMessage(client, { text: "speech", context: [], hasContext: false });
            const speech = await storeMessageSpeech(client, {
              threadId: turn.threadId,
              messageId: turn.messageId,
              text: "speech",
              voice: "alloy",
              storageKey: key,
              byteSize: 2,
            });
            return { ...turn, blobId: speech.blob.id };
          }),
        );
        const cp = createChokePoint(runtime);
        const database = await runInTenant(tenant, () => cp.createDatabase({ name: "Speech references" }));
        await runInTenant(tenant, () =>
          cp.createProperty({ databaseId: database.id, key: "photo", name: "Photo", type: "image" }),
        );
        const item = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: database.id, properties: { photo: { blobId: fixture.blobId } } }),
        );
        const future = new Date("9999-01-01T00:00:00Z");
        expect(await runInTenant(tenant, () => sweepUnreferencedBlobs(runtime, storage, future))).toBe(0);
        expect(await readFile(join(dir, key))).toEqual(Buffer.from("AB"));
        // No production thread-deletion entry point exists yet; exercise the registered cascade directly.
        await runInTenant(tenant, () =>
          withTransaction(runtime, async (client) => {
            const deleted = await client.query<Record<string, never>>("DELETE FROM semp_threads WHERE id = $1", [
              fixture.threadId,
            ]);
            expect(deleted.rowCount).toBe(1);
          }),
        );
        const cache = await runInTenant(tenant, () =>
          runtime.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1",
            [fixture.messageId],
          ),
        );
        expect(cache.rows).toEqual([{ count: 0 }]);
        expect(await runInTenant(tenant, () => sweepUnreferencedBlobs(runtime, storage, future))).toBe(0);
        expect(await readFile(join(dir, key))).toEqual(Buffer.from("AB"));
        await runInTenant(tenant, () =>
          cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { photo: null } }),
        );
        expect(await runInTenant(tenant, () => sweepUnreferencedBlobs(runtime, storage, future))).toBe(1);
        await expect(readFile(join(dir, key))).rejects.toMatchObject({ code: "ENOENT" });
      } catch (error) {
        failed = true;
        failure = error;
      }
      const cleanup = await Promise.allSettled([runtime.end(), rm(dir, { recursive: true, force: true })]);
      const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failed || errors.length)
        throw new AggregateError([...(failed ? [failure] : []), ...errors], "Speech collection or cleanup failed");
    });

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
      await withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox) throw new Error("Missing Inbox database");
        const item = await createInboxItemWithClient(client, {
          inboxDatabaseId: inbox.id,
          date: "2026-08-28",
          time: "09:00",
          text: "Attached blob",
        });
        await insertInboxAttachments(client, item.id, [{ blobId: attached.id, source: "camera" }]);
      });
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
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  }
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "semprec-standalone-race-"));
    const storage = new LocalFsBlobStorageWriter(dir);
    const one = await createRuntimeRolePool(pool, "semprec_data");
    const two = await createRuntimeRolePool(pool, "semprec_data");
    const tenant = getTenantZeroId();
    const upload = (pool: Pool) =>
      runInTenant(tenant, () =>
        ingestUploadedBlob(pool, { mimeType: "image/png", source: Readable.from([bytes]), maxBytes: 1024, storage }),
      );
    const old = await upload(one);
    await pool.query("UPDATE blobs SET created_at=now()-interval '25 hours' WHERE id=$1", [old.blob.id]);
    return { dir, storage, one, two, tenant, upload, old };
  }
  async function files(dir: string) {
    return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((x) => x.isFile()).length;
  }
  it("fails closed and cleans uploaded bytes when collection wins after dedup read", async () => {
    const f = await setup();
    const ready = gate(),
      release = gate();
    let intercepted = false;
    const wrapped = new Map<PoolClient, PoolClient["query"]>();
    const instrument = (client: PoolClient) => {
      if (wrapped.has(client)) return;
      // The proxy forwards the original receiver and the method is restored before releasing the pool.
      /* eslint-disable @typescript-eslint/unbound-method */
      wrapped.set(client, client.query);
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (intercepted || typeof args[0] !== "string" || !args[0].includes("FROM blobs WHERE content_hash = $1"))
            return result;
          intercepted = true;
          return Promise.resolve(result).then(async (value: unknown) => {
            ready.release();
            await release.promise;
            return value;
          });
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
    };
    f.one.on("acquire", instrument);
    const upload = f.upload(f.one);
    const settled = Promise.allSettled([upload]);
    let sweep: Promise<number> | undefined;
    try {
      await bounded(
        Promise.race([
          ready.promise,
          upload.then(() => {
            throw new Error("upload ended before barrier");
          }),
        ]),
      );
      sweep = runInTenant(f.tenant, () => sweepUnreferencedBlobs(f.two, f.storage));
      expect(await bounded(sweep)).toBe(1);
      expect(await files(f.dir)).toBe(1);
      release.release();
      await expect(upload).rejects.toMatchObject({ name: "ValidationError", details: { field: "blobId" } });
      expect(
        (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs WHERE id=$1", [f.old.blob.id])).rows[0]
          ?.n,
      ).toBe(0);
      await viWaitFiles(f.dir, 0);
    } finally {
      release.release();
      await settled;
      if (sweep) await Promise.allSettled([sweep]);
      f.one.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
      await f.one.end();
      await f.two.end();
      await rm(f.dir, { recursive: true, force: true });
    }
  }, 15000);
  async function viWaitFiles(dir: string, count: number) {
    for (let i = 0; i < 100; i++) {
      if ((await files(dir)) === count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await files(dir)).toBe(count);
  }
  it("committed old dedup stays eligible for subsequent sweep", async () => {
    const f = await setup();
    try {
      const before = (
        await pool.query<{ created_at: Date }>("SELECT created_at FROM blobs WHERE id=$1", [f.old.blob.id])
      ).rows[0]?.created_at;
      const repeat = await f.upload(f.one);
      expect(repeat.created).toBe(false);
      expect(repeat.blob.id).toBe(f.old.blob.id);
      expect(
        (await pool.query<{ created_at: Date }>("SELECT created_at FROM blobs WHERE id=$1", [repeat.blob.id])).rows[0]
          ?.created_at,
      ).toEqual(before);
      expect(await runInTenant(f.tenant, () => sweepUnreferencedBlobs(f.two, f.storage))).toBe(1);
      await viWaitFiles(f.dir, 0);
    } finally {
      await f.one.end();
      await f.two.end();
      await rm(f.dir, { recursive: true, force: true });
    }
  }, 15000);
  it("collector holds deletion before a concurrent repeated upload", async () => {
    const f = await setup();
    const competing = observeStatementPid(f.one, /INSERT INTO blobs\b/i);
    const ready = gate(),
      release = gate();
    let pid = 0;
    const deleting = runInTenant(f.tenant, () =>
      withTransaction(f.two, async (client) => {
        pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
        expect(await deleteBlobIfUnreferenced(client, f.old.blob.id)).toBe(f.old.blob.storageKey);
        ready.release();
        await release.promise;
      }),
    );
    const settled = Promise.allSettled([deleting]);
    let upload: ReturnType<typeof f.upload> | undefined;
    try {
      await bounded(
        Promise.race([
          ready.promise,
          deleting.then(() => {
            throw new Error("deletion ended before barrier");
          }),
        ]),
      );
      upload = f.upload(f.one);
      const uploadSettled = Promise.allSettled([upload]);
      const competitorPid = await bounded(competing.pid);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked =
          (
            await pool.query<{ b: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS b", [
              pid,
              competitorPid,
            ])
          ).rows[0]?.b === true;
        if (!blocked) await new Promise((r) => setTimeout(r, 20));
      }
      expect(blocked).toBe(true);
      release.release();
      await deleting;
      const [result] = await uploadSettled;
      expect(result?.status).toBe("fulfilled");
      if (result?.status === "fulfilled") {
        expect(result.value.created).toBe(true);
        expect(result.value.blob.id).not.toBe(f.old.blob.id);
      }
    } finally {
      release.release();
      await settled;
      if (upload) await Promise.allSettled([upload]);
      competing.restore();
      await f.one.end();
      await f.two.end();
      await rm(f.dir, { recursive: true, force: true });
    }
  }, 15000);
});
