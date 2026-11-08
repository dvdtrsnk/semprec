import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createBlob } from "../blobs/blobsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
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
    const createItem = async (tenant: string) => {
      await runInTenant(tenant, () => seedSystem(runtimePool));
      return withTenantTransaction(runtimePool, tenant, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox) throw new Error("Missing Inbox database");
        return createInboxItemWithClient(client, {
          inboxDatabaseId: inbox.id,
          date: "2026-08-28",
          time: "09:00",
          text: "Tenant fixture",
        });
      });
    };
    const itemId = (await createItem(tenantA)).id;
    const otherItemId = (await createItem(tenantB)).id;
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
    await expect(
      withTenantTransaction(runtimePool, tenantB, (client) =>
        insertInboxAttachments(client, itemId, [{ blobId: blobA.id, source: "files" }]),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const missing = randomUUID();
    await expect(
      withTenantTransaction(runtimePool, tenantA, (client) =>
        insertInboxAttachments(client, missing, [{ blobId: blobA.id, source: "files" }]),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await withTenantTransaction(runtimePool, tenantA, (client) => listInboxAttachments(client, [missing])),
    ).toEqual([]);
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
        insertInboxAttachments(client, otherItemId, [{ blobId: blobA.id, source: "files" }]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
