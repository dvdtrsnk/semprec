import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { createBlob } from "../blobs/blobsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { AttachmentExtraction } from "../inbox/attachmentExtraction.js";
import {
  getInboxAttachment,
  hasAttachmentAwaitingMetadata,
  insertInboxAttachments,
  recordInboxAttachmentExtraction,
  recordInboxAttachmentMetadata,
  type InboxAttachmentSource,
} from "../inbox/inboxAttachmentsStore.js";

// Issue gh-1970: the `extraction` column of `inbox_attachments`, written once through its store function, and the
// question the Inbox tick asks before it starts. Run on the runtime role pool, where row-level security applies.

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

function extraction(overrides: Partial<AttachmentExtraction>): AttachmentExtraction {
  return {
    documentType: null,
    supplier: null,
    ico: null,
    amount: null,
    currency: null,
    issueDate: null,
    dueDate: null,
    suggestedFileName: null,
    suggestedFileType: null,
    ...overrides,
  };
}

interface Seeded {
  tenantId: string;
  itemId: string;
  attachmentIds: string[];
}

/** A fresh tenant with an Inbox item that carries one attachment per entry of `mimeTypes`. */
async function seedTenant(mimeTypes: string[] = ["image/jpeg"]): Promise<Seeded> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(runtimePool));
  return withTenantTransaction(runtimePool, tenantId, async (client) => {
    const inbox = await getDatabaseByModuleId(client, "inbox");
    if (!inbox) throw new Error("Missing Inbox database");
    const item = await createInboxItemWithClient(client, {
      inboxDatabaseId: inbox.id,
      date: "2026-10-16",
      time: "08:12",
      text: "Faktura za obklady",
    });
    const attachments: Array<{ blobId: string; source: InboxAttachmentSource }> = [];
    for (const mimeType of mimeTypes) {
      const blob = await createBlob(client, { mimeType, byteSize: 1, storageKey: `${tenantId}/blobs/${randomUUID()}` });
      attachments.push({ blobId: blob.id, source: "camera" });
    }
    return { tenantId, itemId: item.id, attachmentIds: await insertInboxAttachments(client, item.id, attachments) };
  });
}

function read(tenantId: string, attachmentId: string) {
  return withTenantTransaction(runtimePool, tenantId, (client) => getInboxAttachment(client, attachmentId));
}

function record(tenantId: string, input: Parameters<typeof recordInboxAttachmentExtraction>[1]) {
  return withTenantTransaction(runtimePool, tenantId, (client) => recordInboxAttachmentExtraction(client, input));
}

describe("recordInboxAttachmentExtraction (issue gh-1970)", () => {
  it("stores the extraction of an attachment and reads it back with the row", async () => {
    const { tenantId, itemId, attachmentIds } = await seedTenant();
    const attachmentId = attachmentIds[0]!;
    expect((await read(tenantId, attachmentId))?.extraction).toBeNull();

    const stored = await record(tenantId, {
      attachmentId,
      inboxItemId: itemId,
      extraction: extraction({ amount: 4820, currency: "CZK", dueDate: "2026-10-23" }),
    });

    expect(stored).toEqual(extraction({ amount: 4820, currency: "CZK", dueDate: "2026-10-23" }));
    expect((await read(tenantId, attachmentId))?.extraction).toEqual(stored);
  });

  it("writes once: a second call returns the stored value and leaves the row alone", async () => {
    const { tenantId, itemId, attachmentIds } = await seedTenant();
    const attachmentId = attachmentIds[0]!;
    await record(tenantId, { attachmentId, inboxItemId: itemId, extraction: extraction({ amount: 1 }) });

    const second = await record(tenantId, { attachmentId, inboxItemId: itemId, extraction: extraction({ amount: 2 }) });

    expect(second).toEqual(extraction({ amount: 1 }));
    expect((await read(tenantId, attachmentId))?.extraction).toEqual(extraction({ amount: 1 }));
  });

  it("keeps one value when two runs store at the same time, and both runs return it", async () => {
    const { tenantId, itemId, attachmentIds } = await seedTenant();
    const attachmentId = attachmentIds[0]!;

    const results = await Promise.all([
      record(tenantId, { attachmentId, inboxItemId: itemId, extraction: extraction({ amount: 1 }) }),
      record(tenantId, { attachmentId, inboxItemId: itemId, extraction: extraction({ amount: 2 }) }),
    ]);

    const kept = (await read(tenantId, attachmentId))?.extraction;
    expect([1, 2]).toContain(kept?.amount);
    expect(results).toEqual([kept, kept]);
  });

  it("writes nothing for an attachment that belongs to another Inbox item of the tenant", async () => {
    const { tenantId, attachmentIds } = await seedTenant();
    const attachmentId = attachmentIds[0]!;

    const stored = await record(tenantId, {
      attachmentId,
      inboxItemId: randomUUID(),
      extraction: extraction({ amount: 1 }),
    });

    expect(stored).toBeNull();
    expect((await read(tenantId, attachmentId))?.extraction).toBeNull();
  });

  it("returns null for an attachment that does not exist", async () => {
    const { tenantId, itemId } = await seedTenant();

    expect(
      await record(tenantId, { attachmentId: randomUUID(), inboxItemId: itemId, extraction: extraction({}) }),
    ).toBeNull();
  });

  it("does not write the attachment of another tenant, and leaves its extraction as it was", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const attachmentOfB = b.attachmentIds[0]!;

    const crossWrite = await record(a.tenantId, {
      attachmentId: attachmentOfB,
      inboxItemId: b.itemId,
      extraction: extraction({ amount: 666 }),
    });

    expect(crossWrite).toBeNull();
    expect((await read(b.tenantId, attachmentOfB))?.extraction).toBeNull();
    expect(await read(a.tenantId, attachmentOfB)).toBeNull();
    // Its own tenant can still write it, so the refusal above was the tenant and not a broken row.
    expect(
      await record(b.tenantId, { attachmentId: attachmentOfB, inboxItemId: b.itemId, extraction: extraction({}) }),
    ).toEqual(extraction({}));
  });

  it("refuses an extraction that does not match the schema before it reaches the database", async () => {
    const { tenantId, itemId, attachmentIds } = await seedTenant();
    const attachmentId = attachmentIds[0]!;
    const invalid = { ...extraction({}), currency: "czk" };

    await expect(record(tenantId, { attachmentId, inboxItemId: itemId, extraction: invalid })).rejects.toThrow();
    expect((await read(tenantId, attachmentId))?.extraction).toBeNull();
  });
});

describe("hasAttachmentAwaitingMetadata (issue gh-1970)", () => {
  const awaiting = (tenantId: string, itemId: string) =>
    withTenantTransaction(runtimePool, tenantId, (client) => hasAttachmentAwaitingMetadata(client, itemId));
  const recordMetadata = (
    tenantId: string,
    attachmentId: string,
    metadata: { pages: null; error?: "mediaUnreadable" },
  ) =>
    withTenantTransaction(runtimePool, tenantId, (client) =>
      recordInboxAttachmentMetadata(client, { attachmentId, metadata, thumbnail: null, reduced: null }),
    );

  it("is true for an image whose metadata job has not run, and false once it has written, readable or not", async () => {
    const readable = await seedTenant(["image/jpeg"]);
    expect(await awaiting(readable.tenantId, readable.itemId)).toBe(true);
    await recordMetadata(readable.tenantId, readable.attachmentIds[0]!, { pages: null });
    expect(await awaiting(readable.tenantId, readable.itemId)).toBe(false);

    const unreadable = await seedTenant(["image/png"]);
    expect(await awaiting(unreadable.tenantId, unreadable.itemId)).toBe(true);
    await recordMetadata(unreadable.tenantId, unreadable.attachmentIds[0]!, { pages: null, error: "mediaUnreadable" });
    expect(await awaiting(unreadable.tenantId, unreadable.itemId)).toBe(false);
  });

  it("stays true while any one of several images still waits", async () => {
    const { tenantId, itemId, attachmentIds } = await seedTenant(["image/jpeg", "image/jpeg"]);
    await recordMetadata(tenantId, attachmentIds[0]!, { pages: null });

    expect(await awaiting(tenantId, itemId)).toBe(true);
  });

  it("is false for a PDF and for audio whose metadata is not computed, and for an item without attachments", async () => {
    const documents = await seedTenant(["application/pdf", "audio/mpeg"]);
    expect(await awaiting(documents.tenantId, documents.itemId)).toBe(false);

    const empty = await seedTenant([]);
    expect(await awaiting(empty.tenantId, empty.itemId)).toBe(false);
  });

  it("does not see the images of another tenant's Inbox item", async () => {
    const a = await seedTenant(["image/jpeg"]);
    const b = await seedTenant([]);

    expect(await awaiting(b.tenantId, a.itemId)).toBe(false);
    expect(await awaiting(a.tenantId, a.itemId)).toBe(true);
  });
});
