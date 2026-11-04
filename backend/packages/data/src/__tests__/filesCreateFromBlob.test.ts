import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DateTime } from "luxon";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { ingestUploadedBlob } from "../blobs/fileUploadStore.js";
import { sweepUnreferencedBlobs } from "../blobs/unreferencedBlobSweep.js";
import { getSystemTimezone } from "../systemSettings.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";

class MemoryStorage implements BlobStorageWriter {
  readonly bytes = new Map<string, Buffer>();
  async writeStream(key: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    this.bytes.set(key, bytes);
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }
  async delete(key: string): Promise<void> {
    this.bytes.delete(key);
  }
  readStream(key: string): Readable {
    const bytes = this.bytes.get(key);
    if (!bytes) throw new Error("Missing stored bytes");
    return Readable.from([bytes]);
  }
}
let admin: Pool;
let runtime: Pool;
let owner: string;
let foreign: string;
let storage: MemoryStorage;

describe("Files creation from standalone blobs", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    owner = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    storage = new MemoryStorage();
    await runInTenant(owner, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });
  const upload = (tenantId: string, bytes: string) =>
    runInTenant(tenantId, () =>
      ingestUploadedBlob(runtime, {
        mimeType: "application/pdf",
        source: Readable.from([Buffer.from(bytes)]),
        maxBytes: 1024,
        storage,
      }),
    );
  async function db(moduleId: string) {
    const row = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId));
    if (!row) throw new Error(`Missing ${moduleId} database`);
    return row;
  }
  it("uploads, creates with a project, derives defaults and preserves an earlier item when bytes deduplicate", async () => {
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const files = await db("files");
      const projects = await db("projects");
      const project = await api.createItem({ databaseId: projects.id, properties: { name: "Project" } });
      const property = (await api.listProperties(files.id)).find((entry) => entry.key === "projects");
      if (!property) throw new Error("Files project relation missing");
      const firstUpload = await upload(owner, "%PDF-1.4\nshared");
      const earlier = await api.createItem({
        databaseId: files.id,
        properties: { name: "Earlier", file: { blobId: firstUpload.blob.id }, date: "2001-01-01", type: "jpg" },
      });
      const duplicate = await upload(owner, "%PDF-1.4\nshared");
      expect(duplicate.blob.id).toBe(firstUpload.blob.id);
      const zone = await withTransaction(runtime, (client) => getSystemTimezone(client));
      const before = DateTime.now().setZone(zone).toISODate();
      const created = await api.createItemWithRelations({
        databaseId: files.id,
        properties: { name: "New", file: { blobId: duplicate.blob.id } },
        relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds: [project.id] }],
      });
      const after = DateTime.now().setZone(zone).toISODate();
      expect(created.id).not.toBe(earlier.id);
      expect(created.properties.type).toBe("pdf");
      expect([before, after]).toContain(created.properties.date);
      expect((await api.getItem(files.id, earlier.id))?.properties).toMatchObject({
        name: "Earlier",
        date: "2001-01-01",
        type: "jpg",
      });
      expect(await api.listItemRelations(created.id, property.id)).toMatchObject([{ targetItemId: project.id }]);
    });
  });
  it("collects an unfiled upload after the grace period without creating a Files item", async () => {
    const uploaded = await upload(owner, "%PDF-1.4\ncancel");
    await runInTenant(owner, async () => {
      const files = await db("files");
      expect((await createChokePoint(runtime).listItems(files.id)).items).toEqual([]);
      expect(
        await sweepUnreferencedBlobs(
          runtime,
          storage,
          new Date(Date.parse(uploaded.blob.createdAt) + 25 * 60 * 60 * 1000),
        ),
      ).toBe(1);
      expect(storage.bytes.has(uploaded.blob.storageKey)).toBe(false);
      expect((await createChokePoint(runtime).listItems(files.id)).items).toEqual([]);
    });
  });
  it("refuses foreign and random blob IDs identically without creating an item", async () => {
    const foreignBlob = await upload(foreign, "%PDF-1.4\nforeign");
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const files = await db("files");
      const failures: Array<{ name: string; message: string; details: unknown }> = [];
      for (const blobId of [foreignBlob.blob.id, randomUUID()]) {
        try {
          await api.createItem({ databaseId: files.id, properties: { name: "Invalid", file: { blobId } } });
          throw new Error("Expected refusal");
        } catch (err) {
          if (!(err instanceof Error) || !("details" in err)) throw err;
          failures.push({ name: err.name, message: err.message, details: err.details });
        }
      }
      expect(failures).toHaveLength(2);
      expect(failures[0]).toEqual(failures[1]);
      expect((await api.listItems(files.id)).items).toEqual([]);
    });
  });

  it("installs the Files date default through the registered populated-tenant runner", async () => {
    const files = await runInTenant(owner, () => db("files"));
    await runInTenant(owner, () =>
      withTransaction(runtime, async (client) => {
        // Recreate the older Files schema without the default.
        await client.query(
          "UPDATE properties SET config = config - 'default' WHERE database_id = $1 AND key = 'date'",
          [files.id],
        );
      }),
    );
    const run = () => runAsSystem("test Files default cutover", () => runTenantCutoverMigrations(runtime));
    await run();
    const read = () =>
      runInTenant(owner, () =>
        runtime.query<{ config: unknown; xmin: string }>(
          "SELECT config, xmin::text FROM properties WHERE database_id = $1 AND key = 'date'",
          [files.id],
        ),
      );
    const first = await read();
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.config).toMatchObject({ default: "today" });
    await run();
    expect((await read()).rows).toEqual(first.rows);
  });
});
