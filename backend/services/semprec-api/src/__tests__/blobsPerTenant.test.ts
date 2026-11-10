import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  reconcileGmailAccount,
  resetDatabase,
  type GmailMailClient,
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
  resolveMailModuleIds,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createBlobsRequestListener } from "../blobsHandler.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-per-tenant-${randomUUID()}`);
const tmpMailDir = join(tmpdir(), `semprec-test-blobs-per-tenant-mail-${randomUUID()}`);

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let server: Server;
let baseUrl: string;
let storage: LocalFsBlobStorageWriter;
let mailStorage: LocalFsBlobStorageWriter;

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
    mailStorage = new LocalFsBlobStorageWriter(tmpMailDir);
    server = createServer(createBlobsRequestListener(pool, { files: storage, mailAttachments: mailStorage }));
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
    const mailReadStream = vi.spyOn(mailStorage, "readStream");

    const foreign = await download(bHeaders, aUpload.blobId);
    const random = await download(bHeaders, randomUUID());

    expect(foreign).toEqual(random);
    expect(foreign.status).toBe(404);
    expect(readStream).not.toHaveBeenCalled();
    expect(mailReadStream).not.toHaveBeenCalled();
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
    // Historical invalid JSONB may name a foreign blob even though new writes are rejected.
    await runInTenant(tenantB, () =>
      withTransaction(pool, async (client) => {
        const item = await createItemWithClient(client, {
          databaseId: bFilesDatabaseId,
          properties: { name: "b-leaked.txt" },
        });
        const updated = await client.query<{ id: string }>(
          `UPDATE items SET properties = jsonb_set(properties, '{file}', jsonb_build_object('blobId', $3::text), true)
           WHERE tenant_id = app_tenant_default() AND database_id = $1 AND id = $2 RETURNING id`,
          [bFilesDatabaseId, item.id, orphan.id],
        );
        expect(updated.rowCount).toBe(1);
        expect(updated.rows).toEqual([{ id: item.id }]);
      }),
    );

    const aHeaders = await createUserIn(tenantA);
    const res = await download(aHeaders, orphan.id);

    expect(res.status).toBe(200);
    expect(res.disposition).toContain(`filename="${orphan.id}"`);
    expect(res.disposition).not.toContain("b-leaked.txt");
  });

  describe("bytes in either storage root", () => {
    it("downloads a Sent attachment after real reconciliation and upload deduplication", async () => {
      const content = "sent attachment bytes";
      const uploadedFirstContent = "upload-first attachment bytes";
      const uploadedFirst = await uploadIn(tenantA, "first.txt", uploadedFirstContent);
      const gmail: GmailMailClient = {
        getCurrentHistoryId: async () => "100",
        listHistorySince: async () => ({
          invalidated: false,
          newHistoryId: "101",
          changedMessageIds: [],
          removedMessageIds: [],
        }),
        listAllMessageIds: async () => ["sent-message", "uploaded-first"],
        listLabels: async () => [{ id: "SENT", name: "Sent", type: "system" }],
        fetchMessage: async (id) => ({
          id,
          threadId: "thread",
          labelIds: ["SENT"],
          message: {
            messageId: `<${id}@example.test>`,
            subject: "Sent",
            envelope: { from: { address: "sender@example.test" }, to: [{ address: "recipient@example.test" }] },
            attachments: [
              {
                filename: "sent.txt",
                contentType: "text/plain",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from([id === "sent-message" ? content : uploadedFirstContent]),
              },
            ],
          },
        }),
        modifyMessageLabels: async () => undefined,
      };
      await runInTenant(tenantA, () =>
        withTransaction(pool, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const chokePoint = createChokePoint(pool);
          const emailProperties = await chokePoint.listProperties(ids.emailsDatabaseId);
          const folderProperties = await chokePoint.listProperties(ids.foldersDatabaseId);
          const propertyId = (properties: typeof emailProperties, key: string): string => {
            const property = properties.find((entry) => entry.key === key);
            if (!property) throw new Error(`Missing ${key} property`);
            return property.id;
          };
          const mailbox = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Gmail", provider: "gmail" },
          });
          await reconcileGmailAccount(client, gmail, {
            mailboxItemId: mailbox.id,
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            foldersDatabaseId: ids.foldersDatabaseId,
            folderRelationPropertyId: propertyId(emailProperties, "folder"),
            attachmentsRelationPropertyId: propertyId(emailProperties, "attachments"),
            mailboxFolderRelationPropertyId: propertyId(folderProperties, "mailbox"),
            storage: mailStorage,
            storageKeyPrefix: "sent-test",
          });
        }),
      );
      const { rows } = await runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          client.query<{ blob_id: string; provider_message_id: string }>(
            `SELECT attachment.blob_id, meta.provider_message_id FROM mail_attachments attachment
             JOIN mail_message_meta meta ON meta.item_id = attachment.message_item_id`,
          ),
        ),
      );
      expect(rows).toHaveLength(2);
      const blobId = rows.find((row) => row.provider_message_id === "sent-message")?.blob_id;
      if (!blobId) throw new Error("Missing Sent attachment blob");
      expect(rows.find((row) => row.provider_message_id === "uploaded-first")?.blob_id).toBe(uploadedFirst.blobId);
      const sentEdges = await runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          client.query<{ provider_id: string }>(
            `SELECT folder.properties ->> 'providerId' AS provider_id
               FROM mail_attachments attachment
               JOIN item_relations edge ON edge.item_a = attachment.message_item_id OR edge.item_b = attachment.message_item_id
               JOIN items folder ON folder.id = CASE WHEN edge.item_a = attachment.message_item_id THEN edge.item_b ELSE edge.item_a END
              WHERE attachment.blob_id = $1 AND folder.properties ->> 'providerId' = 'SENT'`,
            [blobId],
          ),
        ),
      );
      expect(sentEdges.rows).toEqual([{ provider_id: "SENT" }]);
      const uploaded = await uploadIn(tenantA, "upload.txt", content);
      expect(uploaded.blobId).toBe(blobId);
      const stored = await runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          client.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [blobId]),
        ),
      );
      const key = stored.rows[0]?.storage_key;
      if (!key) throw new Error("Missing blob storage key");
      expect(existsSync(join(tmpMailDir, key))).toBe(true);
      expect(existsSync(join(tmpBlobDir, key))).toBe(false);
      const headers = await createUserIn(tenantA);
      const firstKeyRows = await runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          client.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [uploadedFirst.blobId]),
        ),
      );
      const firstKey = firstKeyRows.rows[0]?.storage_key;
      if (!firstKey) throw new Error("Missing uploaded blob storage key");
      expect(existsSync(join(tmpBlobDir, firstKey))).toBe(true);
      expect(existsSync(join(tmpMailDir, firstKey))).toBe(false);
      const mailReads = vi.spyOn(mailStorage, "readStream");
      const fileReads = vi.spyOn(storage, "readStream");
      const fallback = await download(headers, uploadedFirst.blobId);
      expect(fallback.status).toBe(200);
      expect(fallback.text).toBe(uploadedFirstContent);
      expect(mailReads).toHaveBeenCalledWith(firstKey, undefined);
      expect(fileReads).toHaveBeenCalledWith(firstKey, undefined);
      const full = await download(headers, blobId);
      expect(full.status).toBe(200);
      expect(full.text).toBe(content);
      const partial = await download({ ...headers, Range: "bytes=0-3" }, blobId);
      expect(partial.status).toBe(206);
      expect(partial.text).toBe("sent");
      const foreignHeaders = await createUserIn(tenantB);
      const foreign = await download(foreignHeaders, blobId);
      const unknown = await download(foreignHeaders, randomUUID());
      expect(foreign.status).toBe(404);
      expect(foreign).toEqual(unknown);
    });

    /** Writes `content` under a fresh key in `target` and records the blob (and, for an attachment, its `mail_attachments` row) in tenant zero. */
    async function seedBlob(opts: {
      target: LocalFsBlobStorageWriter | null;
      attachment: boolean;
      content: string;
    }): Promise<string> {
      return runInTenant(tenantA, () =>
        withTransaction(pool, async (client) => {
          const key = `${tenantA}/roots/${randomUUID()}.txt`;
          const written = opts.target
            ? await opts.target.writeStream(key, Readable.from([opts.content]), { maxBytes: 1024 })
            : { byteSize: opts.content.length, contentHash: randomUUID() };
          const blob = await createBlob(client, {
            mimeType: "text/plain",
            byteSize: written.byteSize,
            storageKey: key,
            contentHash: written.contentHash,
          });
          if (opts.attachment) {
            await client.query(
              `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, disposition, byte_size)
               VALUES ($1, $2, 'a.txt', 'text/plain', 'attachment', $3)`,
              [randomUUID(), blob.id, written.byteSize],
            );
          }
          return blob.id;
        }),
      );
    }

    // A mail_attachments row carries no folder, so an attachment synced into Sent has the same shape as one synced into the inbox.
    it("serves an attachment whose bytes are only in the mail attachments root, whole and ranged", async () => {
      const blobId = await seedBlob({ target: mailStorage, attachment: true, content: "attachment bytes" });
      const headers = await createUserIn(tenantA);

      const full = await download(headers, blobId);
      expect(full.status).toBe(200);
      expect(full.text).toBe("attachment bytes");

      const partial = await download({ ...headers, Range: "bytes=0-9" }, blobId);
      expect(partial.status).toBe(206);
      expect(partial.text).toBe("attachment");
    });

    it("serves a deduplicated attachment blob whose bytes are only in the files root", async () => {
      const blobId = await seedBlob({ target: storage, attachment: true, content: "uploaded first" });
      const headers = await createUserIn(tenantA);

      const res = await download(headers, blobId);
      expect(res.status).toBe(200);
      expect(res.text).toBe("uploaded first");
    });

    it("serves an uploaded blob whose bytes are only in the mail attachments root", async () => {
      const blobId = await seedBlob({ target: mailStorage, attachment: false, content: "synced first" });
      const headers = await createUserIn(tenantA);

      const res = await download(headers, blobId);
      expect(res.status).toBe(200);
      expect(res.text).toBe("synced first");
    });

    it("answers 404 not_found when neither root has the file", async () => {
      const blobId = await seedBlob({ target: null, attachment: true, content: "gone" });
      const headers = await createUserIn(tenantA);

      const res = await download(headers, blobId);
      expect(res.status).toBe(404);
      expect(res.text).toBe('{"error":{"code":"not_found"}}');
    });

    it("answers 500 on a non-ENOENT read error and never opens the other root", async () => {
      const blobId = await seedBlob({ target: mailStorage, attachment: true, content: "attachment bytes" });
      const headers = await createUserIn(tenantA);
      vi.spyOn(mailStorage, "readStream").mockImplementation(
        () =>
          new Readable({
            read() {
              this.destroy(Object.assign(new Error("permission denied"), { code: "EACCES" }));
            },
          }),
      );
      const otherRoot = vi.spyOn(storage, "readStream");

      const res = await download(headers, blobId);
      expect(res.status).toBe(500);
      expect(res.text).toBe('{"error":{"code":"internal_error"}}');
      expect(otherRoot).not.toHaveBeenCalled();
    });
  });
});
