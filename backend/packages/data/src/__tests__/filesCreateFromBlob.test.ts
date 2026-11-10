import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getSystemSettingsDatabaseId, getSystemSettingsItemId, getSystemTimezone } from "../systemSettings.js";
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
      const earlierBefore = await api.getItem(files.id, earlier.id);
      const earlierRelations = await api.listItemRelations(earlier.id, property.id);
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
      expect(await api.getItem(files.id, earlier.id)).toEqual(earlierBefore);
      expect(await api.listItemRelations(earlier.id, property.id)).toEqual(earlierRelations);
      expect(await api.listItemRelations(created.id, property.id)).toMatchObject([{ targetItemId: project.id }]);
    });
  });
  it("uses the tenant timezone when the local day differs from UTC", async () => {
    const uploaded = await upload(owner, "%PDF-1.4\ntimezone");
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const settings = await withTransaction(runtime, async (client) => ({
        databaseId: await getSystemSettingsDatabaseId(client),
        itemId: await getSystemSettingsItemId(client),
      }));
      await api.updateItem({ ...settings, propertiesPatch: { timezone: "Pacific/Kiritimati" } });
      const files = await db("files");
      const clockTime = DateTime.fromISO("2026-01-01T12:30:00.000Z");
      if (!clockTime.isValid) throw new Error("Invalid test time");
      const clock = vi.spyOn(DateTime, "now").mockReturnValue(clockTime);
      try {
        const item = await api.createItem({
          databaseId: files.id,
          properties: { name: "Timezone", file: { blobId: uploaded.blob.id } },
        });
        expect(item.properties.date).toBe("2026-01-02");
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("classifies fresh duplicate bytes without changing historical metadata or the earlier file", async () => {
    const bytes = "%PDF-1.4\nhistorical";
    const uploaded = await upload(owner, bytes);
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const files = await db("files");
      const projects = await db("projects");
      const project = await api.createItem({ databaseId: projects.id, properties: { name: "Existing project" } });
      const property = (await api.listProperties(files.id)).find((entry) => entry.key === "projects");
      if (!property) throw new Error("Files project relation missing");
      const earlier = await api.createItemWithRelations({
        databaseId: files.id,
        properties: { name: "Existing", file: { blobId: uploaded.blob.id }, type: "jpg" },
        relations: [{ kind: "resolved", relationPropertyId: property.id, targetItemIds: [project.id] }],
      });
      // Historical fixture: legacy MIME could have come from the upload header, before verified detection existed.
      const changed = await runtime.query(
        "UPDATE blobs SET mime_type = $1, detected_mime_type = NULL WHERE tenant_id = $2 AND id = $3",
        ["image/png", owner, uploaded.blob.id],
      );
      expect(changed.rowCount).toBe(1);
      const beforeBlob = await runtime.query<{ row: unknown }>(
        "SELECT to_jsonb(b) - 'detected_mime_type' AS row FROM blobs b WHERE tenant_id = $1 AND id = $2",
        [owner, uploaded.blob.id],
      );
      const beforeItem = await api.getItem(files.id, earlier.id);
      const beforeEdges = await api.listItemRelations(earlier.id, property.id);
      const unverified = await api.createItem({
        databaseId: files.id,
        properties: { name: "Unverified", file: { blobId: uploaded.blob.id } },
      });
      expect(unverified.properties.type).toBeUndefined();
      const duplicate = await upload(owner, bytes);
      expect(duplicate.blob.id).toBe(uploaded.blob.id);
      const afterBlob = await runtime.query<{ row: unknown; detected_mime_type: string | null }>(
        "SELECT to_jsonb(b) - 'detected_mime_type' AS row, detected_mime_type FROM blobs b WHERE tenant_id = $1 AND id = $2",
        [owner, uploaded.blob.id],
      );
      expect(afterBlob.rows).toEqual([{ row: beforeBlob.rows[0]?.row, detected_mime_type: "application/pdf" }]);
      const fresh = await api.createItem({
        databaseId: files.id,
        properties: { name: "Fresh", file: { blobId: uploaded.blob.id } },
      });
      expect(fresh.properties.type).toBe("pdf");
      expect(await api.getItem(files.id, earlier.id)).toEqual(beforeItem);
      expect(await api.listItemRelations(earlier.id, property.id)).toEqual(beforeEdges);
    });
  });

  it("leaves an unknown detected type unset and preserves an explicit type", async () => {
    const uploaded = await upload(owner, "unknown bytes");
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const files = await db("files");
      const unknown = await api.createItem({
        databaseId: files.id,
        properties: { name: "Unknown", file: { blobId: uploaded.blob.id } },
      });
      const explicit = await api.createItem({
        databaseId: files.id,
        properties: { name: "Explicit", file: { blobId: uploaded.blob.id }, type: "jpg" },
      });
      expect(unknown.properties.type).toBeUndefined();
      expect(explicit.properties.type).toBe("jpg");
    });
  });

  it("does not infer a file type absent from the tenant's current select options", async () => {
    const uploaded = await upload(owner, "%PDF-1.4\nunsupported-option");
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const files = await db("files");
      const property = (await api.listProperties(files.id)).find((entry) => entry.key === "type");
      if (!property) throw new Error("Files type property missing");
      // Model a historical schema whose locked select did not yet contain the PDF option.
      const changed = await withTransaction(runtime, (client) =>
        client.query(
          "UPDATE properties SET config = jsonb_set(config, '{options}', $1::jsonb) WHERE tenant_id = $2 AND id = $3",
          [JSON.stringify([{ key: "jpg" }]), owner, property.id],
        ),
      );
      expect(changed.rowCount).toBe(1);
      const item = await api.createItem({
        databaseId: files.id,
        properties: { name: "Unmatched", file: { blobId: uploaded.blob.id } },
      });
      expect(item.properties.type).toBeUndefined();
      expect(item.properties.file).toEqual({ blobId: uploaded.blob.id });
    });
  });

  it("reserves the type property and re-reads committed options in either order", async () => {
    const uploaded = await upload(owner, "%PDF-1.4\noverlap");
    await runInTenant(owner, async () => {
      const api = createChokePoint(runtime);
      const files = await db("files");
      const property = (await api.listProperties(files.id)).find((entry) => entry.key === "type");
      if (!property) throw new Error("Files type property missing");
      const withoutPdf = JSON.stringify([{ key: "jpg" }]);
      const withPdf = JSON.stringify([{ key: "pdf" }, { key: "jpg" }]);
      const sql =
        "UPDATE properties SET config = jsonb_set(config, '{options}', $1::jsonb) WHERE tenant_id = $2 AND id = $3";
      async function updateOptions(client: import("pg").PoolClient, options: string) {
        const result = await client.query(sql, [options, owner, property!.id]);
        expect(result.rowCount).toBe(1);
      }
      async function blockedBy(contender: () => number, holder: () => number) {
        await vi.waitFor(async () => {
          expect(contender()).toBeGreaterThan(0);
          expect(holder()).toBeGreaterThan(0);
          const result = await admin.query<{ blocked: number[] }>("SELECT pg_blocking_pids($1) AS blocked", [
            contender(),
          ]);
          expect(result.rows[0]?.blocked).toContain(holder());
        });
      }
      async function joined(body: () => Promise<void>, release: () => void, actors: Promise<unknown>[]) {
        const errors: unknown[] = [];
        try {
          await body();
        } catch (error) {
          errors.push(error);
        } finally {
          release();
          for (const result of await Promise.allSettled(actors))
            if (result.status === "rejected") errors.push(result.reason);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Files overlap and settlement failed");
      }
      let releaseFirst!: () => void;
      let readyFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      const firstReady = new Promise<void>((resolve) => (readyFirst = resolve));
      let configPid = 0;
      let createPid = 0;
      const configFirst = withTransaction(runtime, async (client) => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        configPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        // Fixture only: the public API correctly refuses changes to this locked schema.
        await updateOptions(client, withoutPdf);
        readyFirst();
        await firstGate;
      });
      const observePool = (onPid: (pid: number) => void, beforeCommit?: () => Promise<void>) =>
        new Proxy(runtime, {
          get(target, key, receiver) {
            if (key !== "connect") {
              const value: unknown = Reflect.get(target, key, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async () => {
              const client = await target.connect();
              onPid((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
              return new Proxy(client, {
                get(clientTarget, field, clientReceiver) {
                  if (field !== "query") {
                    const value: unknown = Reflect.get(clientTarget, field, clientReceiver);
                    return typeof value === "function" ? value.bind(clientTarget) : value;
                  }
                  return async (...args: unknown[]) => {
                    if (args[0] === "COMMIT" && beforeCommit) await beforeCommit();
                    const result: unknown = await Reflect.apply(
                      clientTarget.query.bind(clientTarget),
                      clientTarget,
                      args,
                    );
                    if (args[0] === "BEGIN") await clientTarget.query("SET LOCAL statement_timeout = '5s'");
                    return result;
                  };
                },
              });
            };
          },
        });
      void configFirst.catch(() => {});
      const actors: Promise<unknown>[] = [configFirst];
      await joined(
        async () => {
          await Promise.race([
            firstReady,
            configFirst.then(() => {
              throw new Error("Config holder ended before barrier");
            }),
          ]);
          const create = createChokePoint(observePool((pid) => (createPid = pid))).createItem({
            databaseId: files.id,
            properties: { name: "After config", file: { blobId: uploaded.blob.id } },
          });
          actors.push(create);
          void create.catch(() => {});
          await blockedBy(
            () => createPid,
            () => configPid,
          );
          process.stdout.write(`Files option config-first: holder=${configPid} contender=${createPid}\n`);
          releaseFirst();
          expect((await create).properties.type).toBeUndefined();
        },
        releaseFirst,
        actors,
      );

      await withTransaction(runtime, (client) => updateOptions(client, withPdf));
      let releaseSecond!: () => void;
      let readySecond!: () => void;
      const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
      const secondReady = new Promise<void>((resolve) => (readySecond = resolve));
      let updatePid = 0;
      createPid = 0;
      const createFirst = createChokePoint(
        observePool(
          (pid) => (createPid = pid),
          async () => {
            readySecond();
            await secondGate;
          },
        ),
      ).createItem({ databaseId: files.id, properties: { name: "Before config", file: { blobId: uploaded.blob.id } } });
      void createFirst.catch(() => {});
      const secondActors: Promise<unknown>[] = [createFirst];
      await joined(
        async () => {
          await Promise.race([
            secondReady,
            createFirst.then(() => {
              throw new Error("Create holder ended before barrier");
            }),
          ]);
          const update = withTransaction(runtime, async (client) => {
            await client.query("SET LOCAL statement_timeout = '5s'");
            updatePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
            await updateOptions(client, withoutPdf);
          });
          secondActors.push(update);
          void update.catch(() => {});
          await blockedBy(
            () => updatePid,
            () => createPid,
          );
          process.stdout.write(`Files option create-first: holder=${createPid} contender=${updatePid}\n`);
          releaseSecond();
          expect((await createFirst).properties.type).toBe("pdf");
          await update;
          const latest = await api.createItem({
            databaseId: files.id,
            properties: { name: "After update", file: { blobId: uploaded.blob.id } },
          });
          expect(latest.properties.type).toBeUndefined();
        },
        releaseSecond,
        secondActors,
      );
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
