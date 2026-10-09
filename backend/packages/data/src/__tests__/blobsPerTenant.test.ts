import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../domainWriteHooks.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { ingestUploadedFile } from "../blobs/fileUploadStore.js";
import {
  createBlob,
  findOrCreateBlob,
  getBlob,
  getBlobByContentHash,
  tenantBlobStorageKey,
} from "../blobs/blobsStore.js";

let pool: Pool;

/** Records every `writeStream` key and keeps the bytes in memory. */
class RecordingBlobStorage implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();
  readonly writtenKeys: string[] = [];

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    this.writtenKeys.push(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.bytesByKey.delete(storageKey);
  }

  readStream(): Readable {
    throw new Error("not used by these tests");
  }
}

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let primary: unknown;
  let failed = false;
  try {
    await client.query("BEGIN");
    await fn(client);
  } catch (err) {
    failed = true;
    primary = err;
  }
  let rollbackError: unknown;
  let rollbackFailed = false;
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    rollbackFailed = true;
    rollbackError = err;
  } finally {
    client.release();
  }
  // The test's own failure is the real one; a rollback failure only surfaces when nothing else failed.
  if (failed) throw primary;
  if (rollbackFailed) throw rollbackError;
}

async function useTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Drops the legacy index, adds tenant B beside tenant zero (A), and runs as `semprec_data`. */
async function twoTenants(client: PoolClient): Promise<{ tenantA: string; tenantB: string }> {
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  await client.query("DROP INDEX blobs_content_hash_uq");
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
  const tenantB = rows[0]?.id;
  if (!tenantB) throw new Error("second tenant was not inserted");
  await client.query("SET LOCAL ROLE semprec_data");
  return { tenantA: getTenantZeroId(), tenantB };
}

function blobInput(storageKey: string, contentHash: string) {
  return { mimeType: "application/pdf", byteSize: 3, storageKey, contentHash };
}

describe("blobs are stored and deduplicated per tenant", () => {
  let tmpBlobDir: string | undefined;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    if (tmpBlobDir) await rm(tmpBlobDir, { recursive: true, force: true });
    tmpBlobDir = undefined;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores an uploaded file under the tenant prefix and writes its bytes under exactly that key", async () => {
    await seedSystem(pool);
    const { filesDatabaseId } = await withTransaction(pool, (client) => resolveMailModuleIds(client));
    const storage = new RecordingBlobStorage();

    const { blob } = await ingestUploadedFile(pool, {
      filesDatabaseId,
      filename: "report.pdf",
      contentType: "application/pdf",
      source: Readable.from(Buffer.from("report-bytes")),
      storageKeyPrefix: "files",
      maxBytes: 1024,
      storage,
    });

    expect(blob.storageKey.startsWith(`${getTenantZeroId()}/files/`)).toBe(true);
    expect(storage.writtenKeys).toEqual([blob.storageKey]);
    expect(storage.bytesByKey.get(blob.storageKey)).toEqual(Buffer.from("report-bytes"));
  });

  it("rejects an upload before writing any bytes when no tenant resolves", async () => {
    const nullTenantPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return async () => ({ rows: [{ tenant_id: null }] });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const storage = new RecordingBlobStorage();

    await expect(
      ingestUploadedFile(nullTenantPool, {
        filesDatabaseId: randomUUID(),
        filename: "report.pdf",
        contentType: "application/pdf",
        source: Readable.from(Buffer.from("report-bytes")),
        storageKeyPrefix: "files",
        maxBytes: 1024,
        storage,
      }),
    ).rejects.toThrow("No tenant is in scope for a blob storage key");
    expect(storage.writtenKeys).toEqual([]);
  });

  it("stores a mail attachment under the tenant and mailbox prefix", async () => {
    await seedSystem(pool);
    const chokePoint = createChokePoint(pool);
    const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));
    const { rows: dbRows } = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id IN ('emails', 'folders')",
    );
    const emailsId = dbRows.find((r) => r.owner_module_id === "emails")?.id;
    const foldersId = dbRows.find((r) => r.owner_module_id === "folders")?.id;
    if (!emailsId || !foldersId) throw new Error("emails/folders databases were not seeded");
    const emailProperties = await chokePoint.listProperties(emailsId);
    const folderProperty = emailProperties.find((p) => p.key === "folder");
    const attachmentsProperty = emailProperties.find((p) => p.key === "attachments");
    if (!folderProperty || !attachmentsProperty) throw new Error("emails properties were not seeded");
    const folder = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: foldersId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      ),
    );
    const mailboxItemId = randomUUID();
    const storage = new RecordingBlobStorage();

    const result = await withTransaction(pool, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: emailsId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        mailboxItemId,
        messageId: "<tenant-prefixed-attachment@x>",
        envelope: {},
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            contentId: null,
            disposition: "attachment",
            openStream: () => Readable.from(Buffer.from("invoice-bytes")),
          },
        ],
        storage,
        storageKeyPrefix: mailboxItemId,
      }),
    );

    const { rows } = await pool.query<{ storage_key: string }>(
      `SELECT b.storage_key FROM mail_attachments a JOIN blobs b ON b.id = a.blob_id WHERE a.message_item_id = $1`,
      [result.itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.storage_key.startsWith(`${getTenantZeroId()}/${mailboxItemId}/`)).toBe(true);
    expect(storage.writtenKeys).toEqual([rows[0]?.storage_key]);
  });

  it("prefixes a storage key with the tenant in scope and rejects when none is", async () => {
    await inRolledBackTransaction(async (client) => {
      const { tenantB } = await twoTenants(client);

      await useTenant(client, tenantB);
      expect(await tenantBlobStorageKey(client, "files/x")).toBe(`${tenantB}/files/x`);

      await useTenant(client, "");
      await expect(tenantBlobStorageKey(client, "files/x")).rejects.toThrow(
        "No tenant is in scope for a blob storage key",
      );
    });
  });

  it("dedupes one hash within a tenant without the legacy global index", async () => {
    await inRolledBackTransaction(async (client) => {
      await client.query("DROP INDEX blobs_content_hash_uq");
      const hash = createHash("sha256").update("same").digest("hex");

      const first = await findOrCreateBlob(client, blobInput(`${getTenantZeroId()}/files/a`, hash));
      const second = await findOrCreateBlob(client, blobInput(`${getTenantZeroId()}/files/b`, hash));

      expect(second).toEqual(first);
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM blobs WHERE content_hash = $1",
        [hash],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  it("keeps one row per tenant for the same hash and reads back only the tenant's own", async () => {
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB } = await twoTenants(client);
      const hash = createHash("sha256").update("shared-bytes").digest("hex");

      await useTenant(client, tenantA);
      const blobA = await findOrCreateBlob(
        client,
        blobInput(await tenantBlobStorageKey(client, `files/${randomUUID()}-a.pdf`), hash),
      );
      await useTenant(client, tenantB);
      const blobB = await findOrCreateBlob(
        client,
        blobInput(await tenantBlobStorageKey(client, `files/${randomUUID()}-b.pdf`), hash),
      );

      expect(blobB.id).not.toBe(blobA.id);
      expect(blobA.storageKey.startsWith(`${tenantA}/files/`)).toBe(true);
      expect(blobB.storageKey.startsWith(`${tenantB}/files/`)).toBe(true);

      await client.query("RESET ROLE");
      const { rows } = await client.query<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id::text AS tenant_id FROM blobs WHERE content_hash = $1 ORDER BY tenant_id = $2 DESC",
        [hash, tenantA],
      );
      expect(rows).toEqual([
        { id: blobA.id, tenant_id: tenantA },
        { id: blobB.id, tenant_id: tenantB },
      ]);
      await client.query("SET LOCAL ROLE semprec_data");

      await useTenant(client, tenantA);
      expect(await getBlobByContentHash(client, hash)).toEqual(blobA);
      await useTenant(client, tenantB);
      expect(await getBlobByContentHash(client, hash)).toEqual(blobB);
    });
  });

  it("still serves a legacy blob whose storage key has no tenant prefix", async () => {
    tmpBlobDir = await mkdtemp(join(tmpdir(), "semprec-blobs-per-tenant-"));
    const storage = new LocalFsBlobStorageWriter(tmpBlobDir);
    const legacyKey = `files/${randomUUID()}-legacy.pdf`;
    await storage.writeStream(legacyKey, Readable.from(Buffer.from("legacy-bytes")));
    const created = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "application/pdf", byteSize: 12, storageKey: legacyKey }),
    );

    const fetched = await withTransaction(pool, (client) => getBlob(client, created.id));
    expect(fetched?.storageKey).toBe(legacyKey);

    const chunks: Buffer[] = [];
    for await (const chunk of storage.readStream(fetched?.storageKey ?? ""))
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from("legacy-bytes"));
  });
});
