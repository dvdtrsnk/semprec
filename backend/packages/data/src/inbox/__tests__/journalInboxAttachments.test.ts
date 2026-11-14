import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier, readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../../testSupport/tenantFixtures.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { ingestUploadedBlob } from "../../blobs/fileUploadStore.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getItemById } from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { createCoreTaskList } from "../../worker.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import {
  deleteInboxAttachment,
  insertInboxAttachments,
  recordInboxAttachmentMetadata,
  type InboxAttachmentSource,
} from "../inboxAttachmentsStore.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../journalInboxCompute.js";

// Issue gh-1969: the cached day summary lists each Inbox item's attachments, and the day is recomputed where the
// attachments change. Everything runs through the runtime role `semprec_data` inside a tenant, with two tenants.
let adminPool: Pool;
let runtimePool: Pool;

interface Tenant {
  id: string;
  inboxId: string;
  journalId: string;
}

const attachmentSummarySchema = z.object({
  attachmentId: z.string(),
  blobId: z.string(),
  name: z.string().nullable(),
  mimeType: z.string(),
  byteSize: z.number(),
  pageCount: z.number().nullable(),
  thumbnailBlobId: z.string().nullable(),
  source: z.string(),
});
const daySummarySchema = z.array(z.object({ id: z.string(), attachments: z.array(attachmentSummarySchema) }));
const recomputeJobSchema = z.object({ payload: z.object({ journalDayItemId: z.string() }) });

beforeAll(async () => {
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
});

afterEach(() => {
  setInvalidationHook(() => undefined);
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
});

/** Runs `fn` as the runtime role inside the tenant, with the tenant scope that producers of queue jobs read. */
function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTenantTransaction(runtimePool, tenantId, fn));
}

async function seedTenant(): Promise<Tenant> {
  const id = await createTestTenant(adminPool);
  await runInTenant(id, () => seedSystem(runtimePool));
  return inTenant(id, async (client) => {
    const inbox = await getDatabaseByModuleId(client, "inbox");
    const journal = await getDatabaseByModuleId(client, "journal");
    if (!inbox || !journal) throw new Error("The seeded tenant has no Inbox or Journal database");
    return { id, inboxId: inbox.id, journalId: journal.id };
  });
}

async function capture(tenant: Tenant, text: string): Promise<string> {
  const item = await inTenant(tenant.id, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: tenant.inboxId,
      date: "2026-08-28",
      time: "09:00",
      text,
    }),
  );
  return item.id;
}

async function journalDayIdOf(tenant: Tenant, inboxItemId: string): Promise<string> {
  return inTenant(tenant.id, async (client) => {
    const property = await propertiesStore.getPropertyByKey(client, tenant.inboxId, "journalDay");
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property?.id ?? "");
    const [edge] = await relationsStore.listRelationsForItem(client, definition?.id ?? "", inboxItemId);
    if (!edge) throw new Error("The Inbox item has no Journal day");
    return relationsStore.otherSide(edge, inboxItemId);
  });
}

interface AttachmentFixture {
  mimeType: string;
  byteSize: number;
  /** The last segment of the blob's storage key; an upload's key is `<uuid>-<file name>`. */
  keyName: string;
  source?: InboxAttachmentSource;
}

/** Stores a blob and attaches it, as an upload followed by a capture does. */
async function attach(
  tenant: Tenant,
  inboxItemId: string,
  fixture: AttachmentFixture,
): Promise<{ attachmentId: string; blobId: string }> {
  return inTenant(tenant.id, async (client) => {
    const blob = await createBlob(client, {
      mimeType: fixture.mimeType,
      byteSize: fixture.byteSize,
      storageKey: `${tenant.id}/inbox/${fixture.keyName}`,
    });
    const [attachmentId] = await insertInboxAttachments(client, inboxItemId, [
      { blobId: blob.id, source: fixture.source ?? "files" },
    ]);
    if (attachmentId === undefined) throw new Error("No attachment was inserted");
    return { attachmentId, blobId: blob.id };
  });
}

/** In-memory bytes for `ingestUploadedBlob`, the function `POST /api/blobs` stores an upload with. */
class MemoryStorage implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.bytesByKey.delete(storageKey);
  }

  readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    const bytes = this.bytesByKey.get(storageKey);
    if (!bytes) throw new Error(`no bytes stored for ${storageKey}`);
    return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
  }
}

/** A PDF upload: its storage key ends in `<uuid>-<file name>`. */
function pdf(fileName = "invoice.pdf", source?: InboxAttachmentSource): AttachmentFixture {
  return { mimeType: "application/pdf", byteSize: 48213, keyName: `${randomUUID()}-${fileName}`, source };
}

/** The summary the day caches for its Inbox items, parsed from the day item's `computed` value. */
async function cachedSummary(tenant: Tenant, dayId: string) {
  const day = await inTenant(tenant.id, (client) => getItemById(client, tenant.journalId, dayId));
  return daySummarySchema.parse(day?.computed[JOURNAL_INBOX_COMPUTED_KEY]);
}

async function cachedAttachments(tenant: Tenant, dayId: string, inboxItemId: string) {
  const entry = (await cachedSummary(tenant, dayId)).find((candidate) => candidate.id === inboxItemId);
  if (!entry) throw new Error("The day does not list the Inbox item");
  return entry.attachments;
}

/** Runs the pending recompute jobs through the production task list on the runtime role. */
async function drainRecomputes(): Promise<void> {
  await runOnce({ pgPool: runtimePool, taskList: createCoreTaskList(runtimePool, createActionRegistry()) });
  expect(await countJobsByIdentifier(adminPool, CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE)).toBe(0);
}

/** The Journal days with a pending recompute job. */
async function pendingRecomputeDays(): Promise<string[]> {
  const payloads = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE);
  return payloads.map((raw) => recomputeJobSchema.parse(raw).payload.journalDayItemId).sort();
}

/** Removes the pending recompute jobs, so only an enqueue made after this call is observed (as inboxTickRecompute.test.ts does). */
async function clearRecomputeJobs(): Promise<void> {
  await adminPool.query(
    `DELETE FROM graphile_worker._private_jobs
     WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = $1)`,
    [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE],
  );
}

describe("attachments in the day's Inbox summary (issue gh-1969)", () => {
  it("lists a PDF attachment with its name, type, size, source and a page count that is not computed", async () => {
    const tenant = await seedTenant();
    const itemId = await capture(tenant, "Invoice");
    const dayId = await journalDayIdOf(tenant, itemId);
    const { attachmentId, blobId } = await attach(tenant, itemId, pdf("invoice.pdf", "share"));

    await drainRecomputes();

    expect(await cachedAttachments(tenant, dayId, itemId)).toEqual([
      {
        attachmentId,
        blobId,
        name: "invoice.pdf",
        mimeType: "application/pdf",
        byteSize: 48213,
        pageCount: null,
        thumbnailBlobId: null,
        source: "share",
      },
    ]);
  });

  it("has a null name for a blob whose storage key records no file name", async () => {
    const tenant = await seedTenant();
    const itemId = await capture(tenant, "Anonymous upload");
    const dayId = await journalDayIdOf(tenant, itemId);
    await attach(tenant, itemId, { mimeType: "image/png", byteSize: 90, keyName: randomUUID() });

    await drainRecomputes();

    expect((await cachedAttachments(tenant, dayId, itemId)).map((entry) => entry.name)).toEqual([null]);
  });

  it("has a null name for a PDF captured through the blob upload, whose storage key is a bare uuid", async () => {
    const tenant = await seedTenant();
    const itemId = await capture(tenant, "Uploaded invoice");
    const dayId = await journalDayIdOf(tenant, itemId);
    // What a capture attaches: the blob `POST /api/blobs` stores, under `<tenant>/blobs/<uuid>` with no file name.
    const uploaded = await runInTenant(tenant.id, () =>
      ingestUploadedBlob(runtimePool, {
        mimeType: "application/pdf",
        source: Readable.from([Buffer.from("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n")]),
        maxBytes: 1024,
        storage: new MemoryStorage(),
      }),
    );
    expect(uploaded.blob.storageKey).toMatch(/\/blobs\/[0-9a-f-]{36}$/);
    const attachmentIds = await inTenant(tenant.id, (client) =>
      insertInboxAttachments(client, itemId, [{ blobId: uploaded.blob.id, source: "files" }]),
    );

    await drainRecomputes();

    expect(await cachedAttachments(tenant, dayId, itemId)).toEqual([
      {
        attachmentId: attachmentIds[0],
        blobId: uploaded.blob.id,
        name: null,
        mimeType: "application/pdf",
        byteSize: Number(uploaded.blob.byteSize),
        pageCount: null,
        thumbnailBlobId: null,
        source: "files",
      },
    ]);
  });

  it("previews a photo by its thumbnail blob once the metadata is computed, never by the original blob", async () => {
    const tenant = await seedTenant();
    const itemId = await capture(tenant, "Receipt photo");
    const dayId = await journalDayIdOf(tenant, itemId);
    const photo = await attach(tenant, itemId, {
      mimeType: "image/jpeg",
      byteSize: 2_400_000,
      keyName: `${randomUUID()}-receipt.jpg`,
      source: "camera",
    });
    await drainRecomputes();
    const [before] = await cachedAttachments(tenant, dayId, itemId);
    expect(before).toMatchObject({ blobId: photo.blobId, thumbnailBlobId: null });

    await inTenant(tenant.id, (client) =>
      recordInboxAttachmentMetadata(client, {
        attachmentId: photo.attachmentId,
        metadata: { width: 3000, height: 4000, pages: null },
        thumbnail: {
          mimeType: "image/jpeg",
          byteSize: 900,
          storageKey: `${tenant.id}/inbox-attachments/${randomUUID()}.jpg`,
          contentHash: randomUUID().replaceAll("-", "").repeat(2),
        },
        reduced: null,
      }),
    );
    await drainRecomputes();

    const [after] = await cachedAttachments(tenant, dayId, itemId);
    expect(after?.thumbnailBlobId).toEqual(expect.any(String));
    expect(after?.thumbnailBlobId).not.toBe(photo.blobId);
    expect(after).toMatchObject({
      blobId: photo.blobId,
      mimeType: "image/jpeg",
      byteSize: 2_400_000,
      source: "camera",
    });
  });

  it("lists an item's attachments in their order, each item with its own, and [] for an item without any", async () => {
    const tenant = await seedTenant();
    const withTwo = await capture(tenant, "Two files");
    const withOne = await capture(tenant, "One file");
    const withNone = await capture(tenant, "No file");
    const dayId = await journalDayIdOf(tenant, withTwo);
    const first = await attach(tenant, withTwo, pdf("first.pdf"));
    const second = await attach(tenant, withTwo, pdf("second.pdf"));
    const single = await attach(tenant, withOne, pdf("single.pdf"));

    await drainRecomputes();

    expect((await cachedAttachments(tenant, dayId, withTwo)).map((entry) => entry.attachmentId)).toEqual([
      first.attachmentId,
      second.attachmentId,
    ]);
    expect((await cachedAttachments(tenant, dayId, withOne)).map((entry) => entry.attachmentId)).toEqual([
      single.attachmentId,
    ]);
    expect(await cachedAttachments(tenant, dayId, withNone)).toEqual([]);
  });

  it("never lists another tenant's attachments in a day", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const itemA = await capture(tenantA, "Tenant A item");
    const itemB = await capture(tenantB, "Tenant B item");
    const dayA = await journalDayIdOf(tenantA, itemA);
    const dayB = await journalDayIdOf(tenantB, itemB);
    const attachmentA = await attach(tenantA, itemA, pdf("a.pdf"));
    const attachmentB = await attach(tenantB, itemB, pdf("b.pdf"));

    await drainRecomputes();

    const idsA = (await cachedSummary(tenantA, dayA)).flatMap((entry) => entry.attachments.map((a) => a.attachmentId));
    const idsB = (await cachedSummary(tenantB, dayB)).flatMap((entry) => entry.attachments.map((a) => a.attachmentId));
    expect(idsA).toContain(attachmentA.attachmentId);
    expect(idsA).not.toContain(attachmentB.attachmentId);
    expect(idsB).toContain(attachmentB.attachmentId);
    expect(idsB).not.toContain(attachmentA.attachmentId);
  });

  describe("recompute triggers", () => {
    it("enqueues the day's recompute when an attachment is added, and the day shows it announced", async () => {
      const tenant = await seedTenant();
      const itemId = await capture(tenant, "Add");
      const dayId = await journalDayIdOf(tenant, itemId);
      await drainRecomputes();
      await clearRecomputeJobs();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));

      const added = await attach(tenant, itemId, pdf());

      expect(await pendingRecomputeDays()).toEqual([dayId]);
      await drainRecomputes();
      expect((await cachedAttachments(tenant, dayId, itemId)).map((entry) => entry.attachmentId)).toEqual([
        added.attachmentId,
      ]);
      // The search job of the day (`itemSearchFanout`) recomputes the same cell and announces it too, so the
      // count depends on which jobs were due: the day is announced at least once, always as an update.
      const announced = events.filter((event) => event.scope === "item" && event.itemId === dayId);
      expect(announced.length).toBeGreaterThan(0);
      for (const event of announced) {
        expect(event).toMatchObject({ scope: "item", databaseId: tenant.journalId, itemId: dayId, op: "update" });
      }
    });

    it("enqueues nothing when no attachment is added", async () => {
      const tenant = await seedTenant();
      const itemId = await capture(tenant, "Nothing to add");
      await drainRecomputes();
      await clearRecomputeJobs();

      const ids = await inTenant(tenant.id, (client) => insertInboxAttachments(client, itemId, []));

      expect(ids).toEqual([]);
      expect(await pendingRecomputeDays()).toEqual([]);
    });

    it("enqueues the day's recompute when an attachment is removed, and the day drops it", async () => {
      const tenant = await seedTenant();
      const itemId = await capture(tenant, "Remove");
      const dayId = await journalDayIdOf(tenant, itemId);
      const kept = await attach(tenant, itemId, pdf("kept.pdf"));
      const removed = await attach(tenant, itemId, pdf("removed.pdf"));
      await drainRecomputes();
      expect((await cachedAttachments(tenant, dayId, itemId)).map((entry) => entry.attachmentId)).toEqual([
        kept.attachmentId,
        removed.attachmentId,
      ]);
      await clearRecomputeJobs();

      const outcome = await inTenant(tenant.id, (client) => deleteInboxAttachment(client, removed.attachmentId));

      expect(outcome.deleted).toBe(true);
      expect(await pendingRecomputeDays()).toEqual([dayId]);
      await drainRecomputes();
      expect((await cachedAttachments(tenant, dayId, itemId)).map((entry) => entry.attachmentId)).toEqual([
        kept.attachmentId,
      ]);
    });

    it("enqueues nothing when the attachment to remove does not exist", async () => {
      const tenant = await seedTenant();
      const itemId = await capture(tenant, "Remove nothing");
      await attach(tenant, itemId, pdf());
      await drainRecomputes();
      await clearRecomputeJobs();

      const outcome = await inTenant(tenant.id, (client) => deleteInboxAttachment(client, randomUUID()));

      expect(outcome).toEqual({ deleted: false, releasedStorageKeys: [] });
      expect(await pendingRecomputeDays()).toEqual([]);
    });

    it("enqueues the day's recompute when the metadata of an attachment is completed, and not when it was already recorded", async () => {
      const tenant = await seedTenant();
      const itemId = await capture(tenant, "Metadata");
      const dayId = await journalDayIdOf(tenant, itemId);
      const photo = await attach(tenant, itemId, {
        mimeType: "image/png",
        byteSize: 500,
        keyName: `${randomUUID()}-p.png`,
      });
      await drainRecomputes();
      await clearRecomputeJobs();
      const record = () =>
        inTenant(tenant.id, (client) =>
          recordInboxAttachmentMetadata(client, {
            attachmentId: photo.attachmentId,
            metadata: { width: 10, height: 10, pages: null },
            thumbnail: null,
            reduced: null,
          }),
        );

      expect((await record()).recorded).toBe(true);
      expect(await pendingRecomputeDays()).toEqual([dayId]);
      await drainRecomputes();
      await clearRecomputeJobs();

      expect((await record()).recorded).toBe(false);
      expect(await pendingRecomputeDays()).toEqual([]);
    });

    it("enqueues nothing when the attachment whose metadata is completed does not exist", async () => {
      const tenant = await seedTenant();
      await capture(tenant, "No such attachment");
      await drainRecomputes();
      await clearRecomputeJobs();

      const outcome = await inTenant(tenant.id, (client) =>
        recordInboxAttachmentMetadata(client, {
          attachmentId: randomUUID(),
          metadata: { pages: null },
          thumbnail: null,
          reduced: null,
        }),
      );

      expect(outcome.recorded).toBe(false);
      expect(await pendingRecomputeDays()).toEqual([]);
    });
  });
});
