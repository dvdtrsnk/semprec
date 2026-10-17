import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeIdentifier, type Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createUser } from "../auth/usersStore.js";
import { createBlob } from "../blobs/blobsStore.js";
import { ingestUploadedFile } from "../blobs/fileUploadStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { getOrCreateTenantDataKey } from "../credentials/tenantKeysStore.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter, MaxBytesExceededError, type BlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { seedSystem } from "../seed/seedSystem.js";
import { logger } from "../tenancy/logger.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  EXPORT_EXCLUDED_TABLES,
  handleTenantExportExpirySweepTask,
  handleTenantExportTask,
  type TenantExportStorages,
} from "../tenancy/tenantExportJob.js";
import { requestTenantExport } from "../tenancy/tenantExportsStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let storages: TenantExportStorages;
let filesStorage: LocalFsBlobStorageWriter;
let mailStorage: LocalFsBlobStorageWriter;
let filesDir: string;
let mailDir: string;

/** What one tenant's seeded data left behind, for the archive assertions. */
interface SeededTenant {
  email: string;
  itemIds: string[];
  blobIds: string[];
  mailBlobId: string;
  /** Unique bytes written into this tenant's blobs, one string per blob. */
  blobContents: string[];
}

/**
 * Reads every entry of a ZIP archive into memory. Uses the central directory, which carries each
 * entry's sizes even when the local header defers them to a data descriptor (as yazl writes them).
 */
function readZip(archive: Buffer): Map<string, Buffer> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const manifestSchema = z.object({
  formatVersion: z.literal(1),
  exportId: z.string(),
  generatedAt: z.string(),
  tables: z.array(z.object({ name: z.string(), file: z.string(), rowCount: z.number() })),
  blobCount: z.number(),
  missingBlobIds: z.array(z.string()),
});

const exportRowSchema = z.object({
  status: z.string(),
  storage_key: z.string().nullable(),
  byte_size: z.string().nullable(),
  completed_at: z.date().nullable(),
  expires_at: z.date().nullable(),
});

async function exportRow(id: string): Promise<z.infer<typeof exportRowSchema> | undefined> {
  const { rows } = await adminPool.query<Record<string, unknown>>(
    "SELECT status, storage_key, byte_size, completed_at, expires_at FROM tenant_exports WHERE id = $1",
    [id],
  );
  return rows[0] === undefined ? undefined : exportRowSchema.parse(rows[0]);
}

async function databaseIdIn(tenantId: string, moduleId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    if (!rows[0]) throw new Error(`no '${moduleId}' database in tenant ${tenantId}`);
    return rows[0].id;
  });
}

/** Writes items, relations, a doc, mail, blobs in both roots, a credential and a tenant key into `tenantId`. */
async function seedTenant(tenantId: string): Promise<SeededTenant> {
  const email = `${randomUUID()}@example.com`;
  await createUser(adminPool, { email, passwordHash: `hash-${randomUUID()}`, tenantId });
  const filesDatabaseId = await databaseIdIn(tenantId, "files");
  const emailsDatabaseId = await databaseIdIn(tenantId, "emails");
  const foldersDatabaseId = await databaseIdIn(tenantId, "folders");
  const fileContent = `files-root-bytes-${randomUUID()}`;
  const mailContent = `mail-root-bytes-${randomUUID()}`;

  return runInTenant(tenantId, async () => {
    const { blob: fileBlob, item: fileItem } = await ingestUploadedFile(pool, {
      filesDatabaseId,
      filename: "note.txt",
      contentType: "text/plain",
      source: Readable.from([fileContent]),
      storageKeyPrefix: "files",
      maxBytes: 1024,
      storage: filesStorage,
    });
    const properties = await createChokePoint(pool).listProperties(emailsDatabaseId);
    const relationId = (key: string): string => {
      const property = properties.find((p) => p.key === key);
      if (!property) throw new Error(`no '${key}' property on Emails`);
      return property.id;
    };
    const { itemId: mailItemId, folderItemId } = await withTransaction(pool, async (client) => {
      const folder = await createItemWithClient(
        client,
        { databaseId: foldersDatabaseId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      );
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId,
        filesDatabaseId,
        folderRelationPropertyId: relationId("folder"),
        attachmentsRelationPropertyId: relationId("attachments"),
        folderItemId: folder.id,
        mailboxItemId: randomUUID(),
        messageId: `<${randomUUID()}@example.com>`,
        subject: "Export me",
        envelope: {},
        attachments: [
          {
            filename: "attached.bin",
            contentType: "application/octet-stream",
            contentId: null,
            disposition: "attachment",
            openStream: () => Readable.from([mailContent]),
          },
        ],
        storage: mailStorage,
        storageKeyPrefix: "mail",
      });
      return { itemId: ingested.itemId, folderItemId: folder.id };
    });
    const { rows: mailBlobs } = await pool.query<{ blob_id: string }>("SELECT blob_id FROM mail_attachments");
    const mailBlobId = mailBlobs[0]?.blob_id;
    if (!mailBlobId) throw new Error("the mail ingest stored no attachment");

    // No production writer creates a doc without the realtime server; the doc sweeps' tests seed docs the same way.
    await pool.query("INSERT INTO docs (item_id) VALUES ($1)", [fileItem.id]);
    await withTransaction(pool, async (client) => {
      await storeCredential(client, {
        itemId: mailItemId,
        credentialType: "api_key",
        plaintext: `secret-${randomUUID()}`,
      });
      await getOrCreateTenantDataKey(client);
    });

    return {
      email,
      itemIds: [fileItem.id, mailItemId, folderItemId],
      blobIds: [fileBlob.id, mailBlobId],
      mailBlobId,
      blobContents: [fileContent, mailContent],
    };
  });
}

async function requestExportIn(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1", [tenantId]);
  const userId = rows[0]?.id;
  if (!userId) throw new Error(`no user in tenant ${tenantId}`);
  return runInTenant(tenantId, async () => {
    const requested = await withTransaction(pool, (client) => requestTenantExport(client, userId));
    return requested.export.id;
  });
}

async function runExport(tenantId: string, exportId: string, helpers = {}, using = storages): Promise<void> {
  await runInTenant(tenantId, () => handleTenantExportTask(pool, using, { exportId }, helpers));
}

function archivePath(tenantId: string, exportId: string): string {
  return join(filesDir, `${tenantId}/exports/${exportId}.zip`);
}

/** The tenant-classified tables the archive must contain, read from the catalog independently of the job. */
async function expectedTableNames(): Promise<string[]> {
  const { rows } = await adminPool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY 1`,
  );
  const excluded: readonly string[] = EXPORT_EXCLUDED_TABLES;
  return rows.map((row) => row.relname).filter((name) => !excluded.includes(name));
}

describe("tenant data export (issue #1043)", () => {
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
    // Seeded while tenant zero is the only tenant; tenant B is provisioned the production way.
    await seedSystem(adminPool);
    tenantB = await createTestTenant(adminPool, { status: "provisioning" });
    await provisionTenant(pool, tenantB);

    const root = join(tmpdir(), `semprec-test-export-${randomUUID()}`);
    filesDir = join(root, "files");
    mailDir = join(root, "mail");
    filesStorage = new LocalFsBlobStorageWriter(filesDir);
    mailStorage = new LocalFsBlobStorageWriter(mailDir);
    storages = { files: filesStorage, mailAttachments: mailStorage };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("archives exactly tenant A's data, with every table counted and every blob byte-identical", async () => {
    const seededA = await seedTenant(tenantA);
    const seededB = await seedTenant(tenantB);
    const exportId = await requestExportIn(tenantA);

    await runExport(tenantA, exportId);

    const row = await exportRow(exportId);
    expect(row?.status).toBe("ready");
    const archiveBytes = readFileSync(archivePath(tenantA, exportId));
    expect(row?.storage_key).toBe(`${tenantA}/exports/${exportId}.zip`);
    expect(Number(row?.byte_size)).toBe(archiveBytes.length);
    expect(row?.completed_at).not.toBeNull();
    expect(row!.expires_at!.getTime() - row!.completed_at!.getTime()).toBe(7 * 24 * 60 * 60 * 1000);

    const entries = readZip(archiveBytes);
    const tableNames = await expectedTableNames();
    expect(tableNames).toEqual(
      expect.arrayContaining(["items", "item_relations", "docs", "mail_attachments", "blobs"]),
    );
    expect([...entries.keys()].sort()).toEqual(
      [
        "account.json",
        "manifest.json",
        ...tableNames.map((name) => `tables/${name}.jsonl`),
        ...seededA.blobIds.map((id) => `blobs/${id}`),
      ].sort(),
    );

    const account: unknown = JSON.parse(entries.get("account.json")!.toString("utf8"));
    expect(account).toEqual({ email: seededA.email, locale: "cs", role: "member", createdAt: expect.any(String) });

    const manifest = manifestSchema.parse(JSON.parse(entries.get("manifest.json")!.toString("utf8")));
    expect(manifest.exportId).toBe(exportId);
    expect(manifest.blobCount).toBe(seededA.blobIds.length);
    expect(manifest.missingBlobIds).toEqual([]);
    expect(manifest.tables.map((table) => table.name)).toEqual(tableNames);
    for (const table of manifest.tables) {
      // The name comes from the catalog and is quoted by escapeIdentifier.
      const { rows } = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${escapeIdentifier(table.name)} WHERE tenant_id = $1`,
        [tenantA],
      );
      expect(table.rowCount, table.name).toBe(Number(rows[0]?.count));
      const text = entries.get(table.file)!.toString("utf8");
      const lines = text === "" ? [] : text.trimEnd().split("\n");
      expect(lines.length, table.name).toBe(table.rowCount);
    }
    expect(manifest.tables.find((table) => table.name === "items")?.rowCount).toBeGreaterThan(0);

    for (const blobId of seededA.blobIds) {
      const { rows } = await adminPool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
        blobId,
      ]);
      const dir = blobId === seededA.mailBlobId ? mailDir : filesDir;
      const stored = readFileSync(join(dir, rows[0]!.storage_key));
      const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
      expect(sha(entries.get(`blobs/${blobId}`)!)).toBe(sha(stored));
    }

    const everything = [...entries.values()].map((bytes) => bytes.toString("utf8")).join("\n");
    for (const foreign of [tenantB, seededB.email, ...seededB.itemIds, ...seededB.blobIds, ...seededB.blobContents]) {
      expect(everything).not.toContain(foreign);
    }
    for (const own of seededA.blobContents) expect(everything).toContain(own);

    const { rows: secrets } = await adminPool.query<{ ciphertext: string; nonce: string }>(
      "SELECT encode(ciphertext, 'hex') AS ciphertext, encode(nonce, 'hex') AS nonce FROM external_credentials WHERE tenant_id = $1",
      [tenantA],
    );
    const { rows: keys } = await adminPool.query<{ wrapped_key: string }>(
      "SELECT encode(wrapped_key, 'hex') AS wrapped_key FROM tenant_keys WHERE tenant_id = $1",
      [tenantA],
    );
    const { rows: users } = await adminPool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE tenant_id = $1",
      [tenantA],
    );
    expect(secrets).toHaveLength(1);
    expect(keys).toHaveLength(1);
    for (const forbidden of [
      '"ciphertext"',
      '"nonce"',
      "password_hash",
      "tables/tenant_keys",
      "tables/external_credentials",
      secrets[0]!.ciphertext,
      secrets[0]!.nonce,
      keys[0]!.wrapped_key,
      users[0]!.password_hash,
    ]) {
      expect(everything).not.toContain(forbidden);
    }
    expect(
      [...entries.keys()].some((name) => name.includes("tenant_keys") || name.includes("external_credentials")),
    ).toBe(false);
  });

  it("completes and lists a blob whose file is missing in missingBlobIds", async () => {
    await seedTenant(tenantA);
    const missing = await runInTenant(tenantA, () =>
      createBlob(pool, { mimeType: "text/plain", byteSize: 4, storageKey: `${tenantA}/files/gone-${randomUUID()}` }),
    );
    const exportId = await requestExportIn(tenantA);

    await runExport(tenantA, exportId);

    expect((await exportRow(exportId))?.status).toBe("ready");
    const entries = readZip(readFileSync(archivePath(tenantA, exportId)));
    const manifest = manifestSchema.parse(JSON.parse(entries.get("manifest.json")!.toString("utf8")));
    expect(manifest.missingBlobIds).toEqual([missing.id]);
    expect(entries.has(`blobs/${missing.id}`)).toBe(false);
  });

  it("marks the export failed, leaves no file and rethrows when the storage write fails mid-archive", async () => {
    await seedTenant(tenantA);
    const exportId = await requestExportIn(tenantA);
    // The write is cut off after 256 bytes, well inside the archive.
    const failingFiles: BlobStorageWriter = {
      writeStream: (key, source) => filesStorage.writeStream(key, source, { maxBytes: 256 }),
      delete: (key) => filesStorage.delete(key),
      readStream: (key, range) => filesStorage.readStream(key, range),
    };

    await expect(
      runExport(tenantA, exportId, {}, { files: failingFiles, mailAttachments: mailStorage }),
    ).rejects.toBeInstanceOf(MaxBytesExceededError);

    expect((await exportRow(exportId))?.status).toBe("failed");
    expect(existsSync(archivePath(tenantA, exportId))).toBe(false);
  });

  it("removes the partial file, puts the export back to pending and queues it again when the worker shuts down", async () => {
    await seedTenant(tenantA);
    const exportId = await requestExportIn(tenantA);
    // The request's own job stands for the running one: graphile-worker holds it locked, not queued.
    await adminPool.query("SELECT graphile_worker.remove_job($1)", [`tenantExport:${exportId}`]);
    const controller = new AbortController();
    const readMailBlob = mailStorage.readStream.bind(mailStorage);
    // Shutdown arrives while the blob entries are being written, after every table entry.
    vi.spyOn(mailStorage, "readStream").mockImplementation((key, range) => {
      controller.abort();
      return readMailBlob(key, range);
    });

    await expect(runExport(tenantA, exportId, { abortSignal: controller.signal })).resolves.toBeUndefined();

    expect((await exportRow(exportId))?.status).toBe("pending");
    expect(existsSync(archivePath(tenantA, exportId))).toBe(false);
    const { rows } = await adminPool.query<{ key: string | null }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1",
      [CORE_TASK_NAMES.TENANT_EXPORT],
    );
    expect(rows).toEqual([{ key: `tenantExport:${exportId}` }]);
    const payloads = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.TENANT_EXPORT);
    expect(payloads).toEqual([expect.objectContaining({ tenantId: tenantA, payload: { exportId } })]);
  });

  it("leaves an export that is not pending, and an unknown id, untouched", async () => {
    await seedTenant(tenantA);
    const exportId = await requestExportIn(tenantA);
    await runExport(tenantA, exportId);
    const before = await exportRow(exportId);

    await runExport(tenantA, exportId);
    await expect(runExport(tenantA, randomUUID())).resolves.toBeUndefined();

    expect(await exportRow(exportId)).toEqual(before);
  });

  describe("expiry sweep", () => {
    async function readyExportIn(tenantId: string): Promise<string> {
      await seedTenant(tenantId);
      const exportId = await requestExportIn(tenantId);
      await runExport(tenantId, exportId);
      return exportId;
    }

    /** Moves an export's timestamps back by `days`; no production writer changes them after the fact. */
    async function backdate(exportId: string, days: number): Promise<void> {
      await adminPool.query(
        `UPDATE tenant_exports
            SET created_at = created_at - make_interval(days => $2),
                completed_at = completed_at - make_interval(days => $2),
                expires_at = expires_at - make_interval(days => $2)
          WHERE id = $1`,
        [exportId, days],
      );
    }

    it("removes tenant A's expired export and its file and keeps tenant B's unexpired one", async () => {
      const expiredA = await readyExportIn(tenantA);
      const liveB = await readyExportIn(tenantB);
      await backdate(expiredA, 8);

      await handleTenantExportExpirySweepTask(pool, filesStorage);

      expect(await exportRow(expiredA)).toBeUndefined();
      expect(existsSync(archivePath(tenantA, expiredA))).toBe(false);
      expect((await exportRow(liveB))?.status).toBe("ready");
      expect(existsSync(archivePath(tenantB, liveB))).toBe(true);
    });

    it("logs a failed file delete and still removes the row", async () => {
      const expiredA = await readyExportIn(tenantA);
      await backdate(expiredA, 8);
      vi.spyOn(filesStorage, "delete").mockRejectedValue(new Error("storage unavailable"));
      const logError = vi.spyOn(logger, "error").mockImplementation(() => {});

      await expect(handleTenantExportExpirySweepTask(pool, filesStorage)).resolves.toBeUndefined();

      expect(await exportRow(expiredA)).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        { errorName: "Error", tenantId: tenantA },
        "Deleting an expired tenant export archive failed",
      );
    });

    it("removes a failed export older than seven days and keeps a recent failed one", async () => {
      await seedTenant(tenantA);
      const failingFiles: BlobStorageWriter = {
        writeStream: (key, source) => filesStorage.writeStream(key, source, { maxBytes: 64 }),
        delete: (key) => filesStorage.delete(key),
        readStream: (key, range) => filesStorage.readStream(key, range),
      };
      const fail = async (): Promise<string> => {
        const exportId = await requestExportIn(tenantA);
        await expect(
          runExport(tenantA, exportId, {}, { files: failingFiles, mailAttachments: mailStorage }),
        ).rejects.toThrow();
        return exportId;
      };
      const oldFailed = await fail();
      const recentFailed = await fail();
      await backdate(oldFailed, 8);

      await handleTenantExportExpirySweepTask(pool, filesStorage);

      expect(await exportRow(oldFailed)).toBeUndefined();
      expect((await exportRow(recentFailed))?.status).toBe("failed");
    });
  });
});
