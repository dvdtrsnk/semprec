import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createBlob } from "../blobs/blobsStore.js";
import {
  deleteInboxAttachment,
  getInboxAttachment,
  insertInboxAttachments,
  listInboxAttachments,
} from "../inbox/inboxAttachmentsStore.js";

// Issue #1564: `inbox_attachments` rows are tenant-owned, and a row cannot name another tenant's blob.
let adminPool: Pool;
let runtimePool: Pool;

beforeAll(async () => {
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
});

describe("inbox_attachments tenant isolation", () => {
  it("shows tenant A's attachments to tenant A only, and refuses to attach a blob of another tenant", async () => {
    const tenantA = await createTestTenant(adminPool);
    const tenantB = await createTestTenant(adminPool);
    const itemId = randomUUID();
    const blobA = await withTenantTransaction(runtimePool, tenantA, (client) =>
      createBlob(client, { mimeType: "image/png", byteSize: 1, storageKey: `${tenantA}/blobs/isolation` }),
    );
    await withTenantTransaction(runtimePool, tenantA, (client) =>
      insertInboxAttachments(client, itemId, [{ blobId: blobA.id, source: "camera" }]),
    );

    const own = await withTenantTransaction(runtimePool, tenantA, (client) => listInboxAttachments(client, [itemId]));
    expect(own.map((row) => row.blobId)).toEqual([blobA.id]);

    const foreign = await withTenantTransaction(runtimePool, tenantB, (client) =>
      listInboxAttachments(client, [itemId]),
    );
    expect(foreign).toEqual([]);
    expect(
      await withTenantTransaction(runtimePool, tenantB, (client) => getInboxAttachment(client, own[0]!.attachmentId)),
    ).toBeNull();
    expect(
      await withTenantTransaction(runtimePool, tenantB, (client) =>
        deleteInboxAttachment(client, own[0]!.attachmentId),
      ),
    ).toBe(false);

    await expect(
      withTenantTransaction(runtimePool, tenantB, (client) =>
        insertInboxAttachments(client, randomUUID(), [{ blobId: blobA.id, source: "files" }]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
