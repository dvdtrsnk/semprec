import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../../domainWriteHooks.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../../testSupport/tenantFixtures.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import type { ItemRow } from "../../types.js";
import { withTransaction } from "../../db/pool.js";
import { createBlob } from "../blobsStore.js";
import { filenameFromStorageKey, loadBlobMetadataForItems } from "../blobMetadata.js";

let pool: Pool;
let runtimePool: Pool | undefined;

/** Counts the queries a callee sends that read the `blobs` table. */
function countBlobQueries(client: PoolClient): { client: PoolClient; count: () => number } {
  let blobQueries = 0;
  const counted = new Proxy(client, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop !== "query" || typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const [text] = args;
        if (typeof text === "string" && /FROM blobs\b/i.test(text)) blobQueries += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { client: counted, count: () => blobQueries };
}

async function seedBlob(storageKey: string, mimeType = "application/pdf", byteSize = 2400) {
  return withTransaction(pool, (client) => createBlob(client, { mimeType, byteSize, storageKey }));
}

describe("loadBlobMetadataForItems", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  async function seedDatabaseWithBlobProperties() {
    const chokePoint = createChokePoint(pool);
    const database = await chokePoint.createDatabase({ name: "Blob metadata" });
    await chokePoint.createProperty({ databaseId: database.id, key: "file", name: "File", type: "file" });
    await chokePoint.createProperty({ databaseId: database.id, key: "cover", name: "Cover", type: "image" });
    await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
    return { chokePoint, databaseId: database.id };
  }

  it("returns size, type and filename for a file property and the type of an image property", async () => {
    const { chokePoint, databaseId } = await seedDatabaseWithBlobProperties();
    const tenantId = getTenantZeroId();
    const fileBlob = await seedBlob(`${tenantId}/files/${randomUUID()}-report.pdf`, "application/pdf", 2400);
    const coverBlob = await seedBlob(`${tenantId}/covers/${randomUUID()}-cover.png`, "image/png", 99);
    const item = await chokePoint.createItem({
      databaseId,
      properties: {
        title: "x",
        file: { blobId: fileBlob.id.toUpperCase() },
        cover: { blobId: coverBlob.id.toUpperCase() },
      },
    });

    const map = await withTransaction(pool, (client) => loadBlobMetadataForItems(client, [item]));

    expect(map.get(item.id)).toEqual({
      file: { blobId: fileBlob.id, byteSize: 2400, mimeType: "application/pdf", filename: "report.pdf" },
      cover: { blobId: coverBlob.id, byteSize: 99, mimeType: "image/png", filename: "cover.png" },
    });
    expect(item.properties.file).toEqual({ blobId: fileBlob.id.toUpperCase() });
    expect(item.properties.cover).toEqual({ blobId: coverBlob.id.toUpperCase() });
  });

  it("reports a null filename when the storage key does not follow the upload shape", async () => {
    const { chokePoint, databaseId } = await seedDatabaseWithBlobProperties();
    const blob = await seedBlob(`${getTenantZeroId()}/mail/attachment-without-uuid.pdf`);
    const item = await chokePoint.createItem({ databaseId, properties: { file: { blobId: blob.id } } });

    const map = await withTransaction(pool, (client) => loadBlobMetadataForItems(client, [item]));

    expect(map.get(item.id)?.file?.filename).toBeNull();
  });

  it("omits an item without a blob property value, a non-blob property, and a blob that no longer exists", async () => {
    const { chokePoint, databaseId } = await seedDatabaseWithBlobProperties();
    const plain = await chokePoint.createItem({ databaseId, properties: { title: "plain" } });
    // Historical dangling references can predate the write hook; the read must still omit them.
    const dangling = { ...plain, id: randomUUID(), properties: { file: { blobId: randomUUID() } } };

    const map = await withTransaction(pool, (client) => loadBlobMetadataForItems(client, [plain, dangling]));

    expect(map.size).toBe(0);
  });

  it("ignores a blobId that is not a UUID instead of failing the query", async () => {
    const { databaseId } = await seedDatabaseWithBlobProperties();
    const item = { id: randomUUID(), databaseId, properties: { file: { blobId: "not-a-uuid" } } };

    const map = await withTransaction(pool, (client) => loadBlobMetadataForItems(client, [item]));

    expect(map.size).toBe(0);
  });

  it("reads the blobs of 50 items in one blobs query", async () => {
    const { chokePoint, databaseId } = await seedDatabaseWithBlobProperties();
    const tenantId = getTenantZeroId();
    const items: ItemRow[] = [];
    for (let index = 0; index < 50; index += 1) {
      const blob = await seedBlob(`${tenantId}/files/${randomUUID()}-file-${index}.txt`, "text/plain", index);
      items.push(await chokePoint.createItem({ databaseId, properties: { file: { blobId: blob.id } } }));
    }

    const counted = await withTransaction(pool, async (client) => {
      const probe = countBlobQueries(client);
      const map = await loadBlobMetadataForItems(probe.client, items);
      return { map, queries: probe.count() };
    });

    expect(counted.queries).toBe(1);
    expect(counted.map.size).toBe(50);
    expect(counted.map.get(items[7]!.id)?.file).toMatchObject({ byteSize: 7, filename: "file-7.txt" });
  });

  it("never returns a blob of another tenant", async () => {
    const { chokePoint, databaseId } = await seedDatabaseWithBlobProperties();
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const foreignBlob = await withTenantTransaction(pool, tenantB, (client) =>
      createBlob(client, {
        mimeType: "application/pdf",
        byteSize: 5,
        storageKey: `${tenantB}/files/${randomUUID()}-secret.pdf`,
      }),
    );
    const ownBlob = await seedBlob(`${tenantA}/files/${randomUUID()}-own.pdf`);
    const item = await chokePoint.createItem({ databaseId, properties: { file: { blobId: ownBlob.id } } });
    // Raw object: production writes never store another tenant's blob id, so this state is built by hand.
    const foreignItem = { ...item, id: randomUUID(), properties: { file: { blobId: foreignBlob.id.toUpperCase() } } };
    runtimePool ??= await createRuntimeRolePool(pool, "semprec_data");

    const map = await withTenantTransaction(runtimePool, tenantA, (client) =>
      loadBlobMetadataForItems(client, [item, foreignItem]),
    );

    expect(map.get(item.id)?.file?.filename).toBe("own.pdf");
    expect(map.has(foreignItem.id)).toBe(false);
  });
});

describe("filenameFromStorageKey", () => {
  it("takes the part after the uuid prefix of the last segment", () => {
    const uuid = randomUUID();
    expect(filenameFromStorageKey(`t/files/${uuid}-my-report-v2.pdf`)).toBe("my-report-v2.pdf");
  });

  it("returns null for a segment without the uuid prefix", () => {
    expect(filenameFromStorageKey("t/files/plain.pdf")).toBeNull();
  });
});
