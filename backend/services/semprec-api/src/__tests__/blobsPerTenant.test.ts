import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createBlob,
  createChokePoint,
  createItemWithClient,
  createUser,
  FILES_MODULE_ID,
  getDatabaseByModuleId,
  hashPassword,
  ingestUploadedFile,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createBlobsRequestListener } from "../blobsHandler.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-per-tenant-${randomUUID()}`);

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let server: Server;
let baseUrl: string;
let storage: LocalFsBlobStorageWriter;

interface Upload {
  blobId: string;
  etag: string;
}

async function createUserIn(tenantId: string): Promise<{ Authorization: string }> {
  const email = `${randomUUID()}@example.com`;
  await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
  const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/** The tenant's Files database id, read in its own scope. */
async function filesDatabaseIdIn(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, FILES_MODULE_ID));
    if (!database) throw new Error(`no Files database in tenant ${tenantId}`);
    return database.id;
  });
}

/** Uploads `content` as a Files item in `tenantId`, the way `POST /api/files` does. */
async function uploadIn(tenantId: string, filename: string, content: string): Promise<Upload> {
  const filesDatabaseId = await filesDatabaseIdIn(tenantId);
  const { blob } = await runInTenant(tenantId, () =>
    ingestUploadedFile(pool, {
      filesDatabaseId,
      filename,
      contentType: "text/plain",
      source: Readable.from([content]),
      storageKeyPrefix: "files",
      maxBytes: 1024,
      storage,
    }),
  );
  if (!blob.contentHash) throw new Error("expected a content hash on the uploaded blob");
  return { blobId: blob.id, etag: `"${blob.contentHash}"` };
}

async function download(
  headers: Record<string, string>,
  blobId: string,
): Promise<{
  status: number;
  text: string;
  contentType: string | null;
  etag: string | null;
  disposition: string | null;
}> {
  const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers });
  return {
    status: res.status,
    text: await res.text(),
    contentType: res.headers.get("content-type"),
    etag: res.headers.get("etag"),
    disposition: res.headers.get("content-disposition"),
  };
}

describe("GET /api/blobs/:id resolves the blob in the caller's tenant (issue #1009)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    // Seeded while tenant zero is the only tenant: `seedSystem` cannot resolve a tenant for its module data migrations once a second one exists.
    await seedSystem(adminPool);
    tenantB = await createTestTenant(adminPool);
    // Tenant B's Files database, with the two properties `POST /api/files` writes (the seeded one has more).
    const chokePoint = createChokePoint(adminPool);
    await runInTenant(tenantB, async () => {
      const database = await chokePoint.createDatabase({ name: "Files", system: true, ownerModuleId: FILES_MODULE_ID });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
      await chokePoint.createProperty({ databaseId: database.id, key: "file", name: "File", type: "file" });
    });

    storage = new LocalFsBlobStorageWriter(tmpBlobDir);
    server = createServer(createBlobsRequestListener(pool, { storage }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers a foreign blob id with If-None-Match exactly like a random id", async () => {
    const aUpload = await uploadIn(tenantA, "a.txt", "tenant A bytes");
    const bHeaders = await createUserIn(tenantB);

    const foreign = await download({ ...bHeaders, "If-None-Match": aUpload.etag }, aUpload.blobId);
    const random = await download({ ...bHeaders, "If-None-Match": aUpload.etag }, randomUUID());

    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe('{"error":{"code":"not_found"}}');
    expect(foreign.etag).toBeNull();
    expect(foreign).toEqual(random);
  });

  it("answers a foreign blob id with Range exactly like a random id", async () => {
    const aUpload = await uploadIn(tenantA, "a.txt", "tenant A bytes");
    const bHeaders = await createUserIn(tenantB);

    const foreign = await download({ ...bHeaders, Range: "bytes=0-0" }, aUpload.blobId);
    const random = await download({ ...bHeaders, Range: "bytes=0-0" }, randomUUID());

    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(random);
  });

  it("answers a plain foreign request with the same 404 and never opens the read stream", async () => {
    const aUpload = await uploadIn(tenantA, "a.txt", "tenant A bytes");
    const bHeaders = await createUserIn(tenantB);
    const readStream = vi.spyOn(storage, "readStream");

    const foreign = await download(bHeaders, aUpload.blobId);
    const random = await download(bHeaders, randomUUID());

    expect(foreign).toEqual(random);
    expect(foreign.status).toBe(404);
    expect(readStream).not.toHaveBeenCalled();
  });

  it("keeps serving the caller's own blob: 200, 304, 206 and 416", async () => {
    const aUpload = await uploadIn(tenantA, "report.txt", "0123456789");
    const aHeaders = await createUserIn(tenantA);

    const full = await download(aHeaders, aUpload.blobId);
    expect(full.status).toBe(200);
    expect(full.text).toBe("0123456789");
    expect(full.disposition).toContain('filename="report.txt"');

    const notModified = await download({ ...aHeaders, "If-None-Match": aUpload.etag }, aUpload.blobId);
    expect(notModified.status).toBe(304);
    expect(notModified.etag).toBe(aUpload.etag);

    const partial = await download({ ...aHeaders, Range: "bytes=0-3" }, aUpload.blobId);
    expect(partial.status).toBe(206);
    expect(partial.text).toBe("0123");

    const unsatisfiable = await download({ ...aHeaders, Range: "bytes=500-600" }, aUpload.blobId);
    expect(unsatisfiable.status).toBe(416);
  });

  it("names a blob's download with its own tenant's Files item, not another tenant's", async () => {
    const bUpload = await uploadIn(tenantB, "b-secret.txt", "tenant B bytes");
    const aUpload = await uploadIn(tenantA, "a-visible.txt", "tenant A bytes");
    const aHeaders = await createUserIn(tenantA);

    const res = await download(aHeaders, aUpload.blobId);
    expect(res.disposition).toContain('filename="a-visible.txt"');
    expect(res.disposition).not.toContain("b-secret.txt");
    expect(bUpload.blobId).not.toBe(aUpload.blobId);
  });

  it("falls back to the blob id as filename when the caller's tenant has no Files item for it", async () => {
    const bFilesDatabaseId = await filesDatabaseIdIn(tenantB);
    const orphan = await runInTenant(tenantA, () =>
      withTransaction(pool, async (client) => {
        const key = `${tenantA}/orphan/${randomUUID()}.txt`;
        const written = await storage.writeStream(key, Readable.from(["orphan bytes"]), { maxBytes: 1024 });
        return createBlob(client, {
          mimeType: "text/plain",
          byteSize: written.byteSize,
          storageKey: key,
          contentHash: written.contentHash,
        });
      }),
    );
    // Tenant B has a Files item naming A's blob id. A must not see it.
    await runInTenant(tenantB, () =>
      withTransaction(pool, (client) =>
        createItemWithClient(client, {
          databaseId: bFilesDatabaseId,
          properties: { name: "b-leaked.txt", file: { blobId: orphan.id } },
        }),
      ),
    );

    const aHeaders = await createUserIn(tenantA);
    const res = await download(aHeaders, orphan.id);

    expect(res.status).toBe(200);
    expect(res.disposition).toContain(`filename="${orphan.id}"`);
    expect(res.disposition).not.toContain("b-leaked.txt");
  });
});
