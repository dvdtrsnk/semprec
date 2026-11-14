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
  readInboxAttachmentForMetadata,
  recordInboxAttachmentMetadata,
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
    ).toEqual({ deleted: false, releasedStorageKeys: [] });

    await expect(
      withTenantTransaction(runtimePool, tenantB, (client) =>
        insertInboxAttachments(client, otherItemId, [{ blobId: blobA.id, source: "files" }]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  describe("the facts of an attachment (issue gh-1965)", () => {
    async function twoTenantsWithOneAttachmentEach() {
      const tenantA = await createTestTenant(adminPool);
      const tenantB = await createTestTenant(adminPool);
      const attach = async (tenant: string) => {
        await runInTenant(tenant, () => seedSystem(runtimePool));
        return withTenantTransaction(runtimePool, tenant, async (client) => {
          const inbox = await getDatabaseByModuleId(client, "inbox");
          if (!inbox) throw new Error("Missing Inbox database");
          const item = await createInboxItemWithClient(client, {
            inboxDatabaseId: inbox.id,
            date: "2026-08-28",
            time: "09:00",
            text: "Tenant fixture",
          });
          const blob = await createBlob(client, {
            mimeType: "image/jpeg",
            byteSize: 1,
            storageKey: `${tenant}/blobs/${randomUUID()}`,
          });
          const [attachmentId] = await insertInboxAttachments(client, item.id, [{ blobId: blob.id, source: "camera" }]);
          if (attachmentId === undefined) throw new Error("No attachment was inserted");
          return { attachmentId, blobId: blob.id };
        });
      };
      return { tenantA, tenantB, a: await attach(tenantA), b: await attach(tenantB) };
    }

    it("shows the job's source row to the attachment's own tenant only", async () => {
      const { tenantA, tenantB, a } = await twoTenantsWithOneAttachmentEach();

      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          readInboxAttachmentForMetadata(client, a.attachmentId),
        ),
      ).toMatchObject({ attachmentId: a.attachmentId, mimeType: "image/jpeg", metadataRecorded: false });
      expect(
        await withTenantTransaction(runtimePool, tenantB, (client) =>
          readInboxAttachmentForMetadata(client, a.attachmentId),
        ),
      ).toBeNull();
    });

    it("records nothing for another tenant's attachment, and leaves the row and the blobs of both tenants as they were", async () => {
      const { tenantA, tenantB, a } = await twoTenantsWithOneAttachmentEach();
      const blobCount = (tenant: string) =>
        withTenantTransaction(runtimePool, tenant, async (client) => {
          const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs");
          return rows[0]?.n;
        });
      const [blobsOfA, blobsOfB] = [await blobCount(tenantA), await blobCount(tenantB)];

      const recorded = await withTenantTransaction(runtimePool, tenantB, (client) =>
        recordInboxAttachmentMetadata(client, {
          attachmentId: a.attachmentId,
          metadata: { width: 1, height: 1, pages: null },
          thumbnail: {
            mimeType: "image/jpeg",
            byteSize: 1,
            storageKey: `${tenantB}/inbox-attachments/foreign.jpg`,
            contentHash: "ef".repeat(32),
          },
          reduced: null,
        }),
      );

      expect(recorded).toEqual({ recorded: false, unusedStorageKeys: [`${tenantB}/inbox-attachments/foreign.jpg`] });
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) => getInboxAttachment(client, a.attachmentId)),
      ).toMatchObject({ metadata: null, thumbnailBlobId: null, reducedBlobId: null });
      expect([await blobCount(tenantA), await blobCount(tenantB)]).toEqual([blobsOfA, blobsOfB]);
    });

    it("records for the attachment's own tenant", async () => {
      const { tenantA, a } = await twoTenantsWithOneAttachmentEach();

      const recorded = await withTenantTransaction(runtimePool, tenantA, (client) =>
        recordInboxAttachmentMetadata(client, {
          attachmentId: a.attachmentId,
          metadata: { width: 2, height: 2, pages: null },
          thumbnail: null,
          reduced: null,
        }),
      );

      expect(recorded).toEqual({ recorded: true, unusedStorageKeys: [] });
    });

    it.each(["thumbnail_blob_id", "reduced_blob_id"])(
      "refuses a %s that names another tenant's blob",
      async (column) => {
        const { tenantB, a, b } = await twoTenantsWithOneAttachmentEach();

        await expect(
          withTenantTransaction(runtimePool, tenantB, (client) =>
            // The column name is one of the two literals of `it.each`, never input; a column cannot be a bind parameter.
            client.query(`UPDATE inbox_attachments SET ${column} = $2 WHERE attachment_id = $1`, [
              b.attachmentId,
              a.blobId,
            ]),
          ),
        ).rejects.toMatchObject({ code: "23503" });
      },
    );
  });
});
