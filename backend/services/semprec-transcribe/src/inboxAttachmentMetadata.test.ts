import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob, registerTask, runOnce, type TaskList } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import {
  createBlob,
  createItemWithClient,
  deleteInboxAttachment,
  enqueueInboxAttachmentMetadata,
  getDatabaseByModuleId,
  getInboxAttachment,
  ingestUploadedBlob,
  insertInboxAttachments,
  INBOX_RECORDING_MIN_SECONDS,
  LocalFsBlobStorageWriter,
  seedSystem,
  tenantBlobStorageKey,
  withTransaction,
  type InboxAttachmentRow,
  installQueueSchema,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { createInboxAttachmentMetadataTask } from "./inboxAttachmentMetadata.js";
import { MAX_IMAGE_PIXELS, probeImage } from "./mediaNormalization.js";
import {
  FIXTURE_CREATION_TIME,
  generateHugeCanvasPng,
  generateImageFixture,
  generateM4aFixture,
  generateMp3Fixture,
  generateWebmFixture,
} from "./__tests__/fixtures/mediaFixtures.js";

// Runs through the queue with the real ffprobe/ffmpeg on the runtime role pool, with a second tenant
// for the cross-tenant case. Attachments are created as a capture creates them.

/** A local-filesystem storage that remembers which keys were read and can hold every write until a gate opens. */
class ObservedStorage extends LocalFsBlobStorageWriter {
  reads: string[] = [];
  beforeWrite: (() => Promise<void>) | null = null;

  override readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    this.reads.push(storageKey);
    return super.readStream(storageKey, range);
  }

  override async writeStream(
    storageKey: string,
    source: Readable,
    options?: Parameters<LocalFsBlobStorageWriter["writeStream"]>[2],
  ): ReturnType<LocalFsBlobStorageWriter["writeStream"]> {
    await this.beforeWrite?.();
    return super.writeStream(storageKey, source, options);
  }
}

const tickPayloadSchema = z.object({ heartbeatId: z.string(), itemId: z.string() });
const jobEnvelopeSchema = z.object({ tenantId: z.string().nullable(), payload: z.unknown() });

let adminPool: Pool;
let runtimePool: Pool;
let blobDir: string;
let storage: ObservedStorage;
let tenantA: string;
let tenantB: string;
let taskList: TaskList;
let ticks: Array<z.infer<typeof tickPayloadSchema>>;
let previousScope: string | undefined;

beforeAll(async () => {
  previousScope = process.env.SEMPREC_TENANT_SCOPE;
  process.env.SEMPREC_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  await installQueueSchema(adminPool);
  blobDir = await mkdtemp(join(tmpdir(), "semprec-inbox-attachment-metadata-"));
  storage = new ObservedStorage(blobDir);
  tenantA = await createTestTenant(adminPool);
  tenantB = await createTestTenant(adminPool);
  await runInTenant(tenantA, () => seedSystem(runtimePool));
  await runInTenant(tenantB, () => seedSystem(runtimePool));
  ticks = [];
  taskList = {
    [CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA]: registerTask(
      CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA,
      createInboxAttachmentMetadataTask(runtimePool, storage),
    ),
    // The heartbeat the job announces its update to: its payload is what the test reads.
    [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: registerTask(CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE, async (payload) => {
      ticks.push(tickPayloadSchema.parse(payload));
    }),
  };
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
  if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = previousScope;
});

function inTenantTransaction<T>(tenant: string, fn: Parameters<typeof withTenantTransaction<T>>[2]): Promise<T> {
  return runInTenant(tenant, () => withTenantTransaction(runtimePool, tenant, fn));
}

/** Uploads `bytes` the way `POST /api/blobs` does, and attaches the blob to a new Inbox item, as a capture does. */
async function attach(
  tenant: string,
  bytes: Buffer,
  options: { itemId?: string } = {},
): Promise<{ attachmentId: string; inboxItemId: string; blobId: string }> {
  return runInTenant(tenant, async () => {
    const { blob } = await ingestUploadedBlob(runtimePool, {
      mimeType: "application/octet-stream",
      source: Readable.from([bytes]),
      maxBytes: 64 * 1024 * 1024,
      storage,
    });
    return withTransaction(runtimePool, async (client) => {
      const inboxItemId =
        options.itemId ??
        (
          await createItemWithClient(client, {
            databaseId: await inboxDatabaseId(client),
            properties: { date: "2026-11-02", time: "10:15", text: "" },
          })
        ).id;
      const [attachmentId] = await insertInboxAttachments(client, inboxItemId, [{ blobId: blob.id, source: "camera" }]);
      if (attachmentId === undefined) throw new Error("No attachment was inserted");
      await enqueueInboxAttachmentMetadata(client, attachmentId);
      return { attachmentId, inboxItemId, blobId: blob.id };
    });
  });
}

/** Attaches a blob that holds `bytes` under the type `mimeType` says, as a mail attachment's declared type can differ from its bytes. */
async function attachDeclared(
  tenant: string,
  mimeType: string,
  bytes: Buffer,
): Promise<{ attachmentId: string; inboxItemId: string; blobId: string }> {
  return runInTenant(tenant, async () => {
    const storageKey = await withTransaction(runtimePool, (client) =>
      tenantBlobStorageKey(client, `mail/${randomUUID()}`),
    );
    await storage.writeStream(storageKey, Readable.from([bytes]));
    return withTransaction(runtimePool, async (client) => {
      const blob = await createBlob(client, { mimeType, byteSize: bytes.length, storageKey });
      const item = await createItemWithClient(client, {
        databaseId: await inboxDatabaseId(client),
        properties: { date: "2026-11-02", time: "10:15", text: "" },
      });
      const [attachmentId] = await insertInboxAttachments(client, item.id, [{ blobId: blob.id, source: "files" }]);
      if (attachmentId === undefined) throw new Error("No attachment was inserted");
      await enqueueInboxAttachmentMetadata(client, attachmentId);
      return { attachmentId, inboxItemId: item.id, blobId: blob.id };
    });
  });
}

async function inboxDatabaseId(client: Parameters<typeof getDatabaseByModuleId>[0]): Promise<string> {
  const database = await getDatabaseByModuleId(client, "inbox");
  if (!database) throw new Error("The Inbox database was not seeded");
  return database.id;
}

/** Runs the queue until no job of the two tasks is left waiting; jobs of one tenant's lane run one after the other. */
async function runQueue(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await runOnce({ pgPool: runtimePool, taskList });
    const { rows } = await adminPool.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM graphile_worker.jobs WHERE task_identifier = ANY($1::text[]) AND attempts = 0",
      [Object.keys(taskList)],
    );
    if (rows[0]?.waiting === 0) return;
  }
  throw new Error("The queue still holds jobs after ten rounds");
}

async function readAttachment(tenant: string, attachmentId: string): Promise<InboxAttachmentRow> {
  const row = await inTenantTransaction(tenant, (client) => getInboxAttachment(client, attachmentId));
  if (!row) throw new Error(`Attachment ${attachmentId} is gone`);
  return row;
}

const blobRowSchema = z.object({ mime_type: z.string(), byte_size: z.string(), storage_key: z.string() });

async function readBlob(tenant: string, blobId: string) {
  return inTenantTransaction(tenant, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT mime_type, byte_size, storage_key FROM blobs WHERE id = $1",
      [blobId],
    );
    return rows[0] ? blobRowSchema.parse(rows[0]) : null;
  });
}

async function blobCount(tenant: string): Promise<number> {
  return inTenantTransaction(tenant, async (client) => {
    const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs");
    return rows[0]?.n ?? -1;
  });
}

async function derivedFiles(tenant: string): Promise<string[]> {
  try {
    return (await readdir(join(blobDir, tenant, "inbox-attachments"))).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** The stored image behind a derived blob, probed from the file the storage holds. */
async function storedSize(tenant: string, blobId: string | null): Promise<{ width: number; height: number }> {
  if (blobId === null) throw new Error("No derived blob");
  const blob = await readBlob(tenant, blobId);
  if (!blob) throw new Error(`Blob ${blobId} is gone`);
  return probeImage(join(blobDir, blob.storage_key));
}

async function itemSnapshot(tenant: string, itemId: string): Promise<string> {
  return inTenantTransaction(tenant, async (client) => {
    const { rows } = await client.query<{ snapshot: string }>("SELECT i::text AS snapshot FROM items i WHERE id = $1", [
      itemId,
    ]);
    return rows[0]?.snapshot ?? "gone";
  });
}

describe("the inboxAttachmentMetadata job (issue gh-1965)", () => {
  describe("photos", () => {
    it("records the size, a preview of at most 128 px and a reduced copy of at most 1568 px, as JPEG blobs", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 3000, height: 2000, format: "jpeg" }));

      await runQueue();

      const row = await readAttachment(tenantA, photo.attachmentId);
      expect(row.metadata).toEqual({ width: 3000, height: 2000, pages: null });
      expect(row.thumbnailBlobId).not.toBeNull();
      expect(row.reducedBlobId).not.toBeNull();
      expect(row.thumbnailBlobId).not.toBe(row.reducedBlobId);
      expect(await storedSize(tenantA, row.thumbnailBlobId)).toEqual({ width: 128, height: 85 });
      expect(await storedSize(tenantA, row.reducedBlobId)).toEqual({ width: 1568, height: 1045 });
      for (const id of [row.thumbnailBlobId, row.reducedBlobId]) {
        const blob = await readBlob(tenantA, id ?? "");
        expect(blob).toMatchObject({ mime_type: "image/jpeg", storage_key: expect.stringContaining(`${tenantA}/`) });
      }
      // Its own blob is untouched, and the two images are all the job added.
      expect(row.blobId).toBe(photo.blobId);
      expect(await blobCount(tenantA)).toBe(3);
      expect(await derivedFiles(tenantA)).toHaveLength(2);
    });

    it("records the byte size and content hash of the bytes each derived image holds in storage", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 1000, height: 700, format: "png" }));

      await runQueue();

      const row = await readAttachment(tenantA, photo.attachmentId);
      for (const id of [row.thumbnailBlobId, row.reducedBlobId]) {
        const hash = await inTenantTransaction(tenantA, async (client) => {
          const { rows } = await client.query<{ content_hash: string | null }>(
            "SELECT content_hash FROM blobs WHERE id = $1",
            [id],
          );
          return rows[0]?.content_hash;
        });
        const blob = await readBlob(tenantA, id ?? "");
        const stored = await readFile(join(blobDir, blob?.storage_key ?? ""));
        expect(blob?.byte_size).toBe(String(stored.byteLength));
        expect(hash).toBe(createHash("sha256").update(stored).digest("hex"));
      }
    });

    it("does not enlarge a small image: preview and reduced copy keep its size, and share one blob", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 100, height: 60, format: "png" }));

      await runQueue();

      const row = await readAttachment(tenantA, photo.attachmentId);
      expect(row.metadata).toEqual({ width: 100, height: 60, pages: null });
      expect(await storedSize(tenantA, row.thumbnailBlobId)).toEqual({ width: 100, height: 60 });
      expect(await storedSize(tenantA, row.reducedBlobId)).toEqual({ width: 100, height: 60 });
      // The two renderings are identical bytes, so the tenant stores them once; the duplicate's file is removed.
      expect(row.thumbnailBlobId).toBe(row.reducedBlobId);
      expect(await blobCount(tenantA)).toBe(2);
      expect(await derivedFiles(tenantA)).toHaveLength(1);
    });

    it("records the size a photo is shown in, and renders it upright, when its orientation turns it a quarter", async () => {
      const photo = await attach(
        tenantA,
        await generateImageFixture({ width: 300, height: 200, format: "jpeg", exifOrientation: 6 }),
      );

      await runQueue();

      const row = await readAttachment(tenantA, photo.attachmentId);
      expect(row.metadata).toEqual({ width: 200, height: 300, pages: null });
      expect(await storedSize(tenantA, row.thumbnailBlobId)).toEqual({ width: 85, height: 128 });
      expect(await storedSize(tenantA, row.reducedBlobId)).toEqual({ width: 200, height: 300 });
    });

    it("shares a derived blob between two attachments of the same photo, and frees it with the last of them", async () => {
      const bytes = await generateImageFixture({ width: 1200, height: 800, format: "jpeg" });
      const first = await attach(tenantA, bytes);
      const second = await attach(tenantA, bytes);

      await runQueue();

      const firstRow = await readAttachment(tenantA, first.attachmentId);
      const secondRow = await readAttachment(tenantA, second.attachmentId);
      expect(firstRow.blobId).toBe(secondRow.blobId);
      expect(secondRow.thumbnailBlobId).toBe(firstRow.thumbnailBlobId);
      expect(secondRow.reducedBlobId).toBe(firstRow.reducedBlobId);
      expect(await derivedFiles(tenantA)).toHaveLength(2);

      const afterFirst = await runInTenant(tenantA, () =>
        withTransaction(runtimePool, (client) => deleteInboxAttachment(client, first.attachmentId)),
      );
      expect(afterFirst).toEqual({ deleted: true, releasedStorageKeys: [] });
      expect(await readBlob(tenantA, firstRow.thumbnailBlobId ?? "")).not.toBeNull();

      const afterSecond = await runInTenant(tenantA, () =>
        withTransaction(runtimePool, (client) => deleteInboxAttachment(client, second.attachmentId)),
      );
      expect(afterSecond.deleted).toBe(true);
      expect(afterSecond.releasedStorageKeys).toHaveLength(2);
      expect(await readBlob(tenantA, firstRow.thumbnailBlobId ?? "")).toBeNull();
      expect(await readBlob(tenantA, firstRow.reducedBlobId ?? "")).toBeNull();
    });

    it("frees the preview and the reduced copy when the attachment is deleted, and returns their keys", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 3000, height: 2000, format: "jpeg" }));
      await runQueue();
      const row = await readAttachment(tenantA, photo.attachmentId);
      const keys = [
        (await readBlob(tenantA, row.thumbnailBlobId ?? ""))?.storage_key,
        (await readBlob(tenantA, row.reducedBlobId ?? ""))?.storage_key,
      ];

      const deleted = await runInTenant(tenantA, () =>
        withTransaction(runtimePool, (client) => deleteInboxAttachment(client, photo.attachmentId)),
      );

      expect(deleted.deleted).toBe(true);
      expect([...deleted.releasedStorageKeys].sort()).toEqual([...keys].sort());
      expect(await readBlob(tenantA, row.thumbnailBlobId ?? "")).toBeNull();
      expect(await readBlob(tenantA, row.reducedBlobId ?? "")).toBeNull();
      // The attachment's own blob is left to its caller.
      expect(await readBlob(tenantA, photo.blobId)).not.toBeNull();
    });
  });

  describe("audio", () => {
    it("records the length of a 40-second voice note as a voiceNote, with the time it was recorded", async () => {
      const note = await attach(tenantA, await generateM4aFixture(40, { creationTime: FIXTURE_CREATION_TIME }));

      await runQueue();

      const row = await readAttachment(tenantA, note.attachmentId);
      expect(row.metadata).toEqual({
        durationSeconds: 40,
        recordedAt: "2024-03-01T12:00:00.000Z",
        audioKind: "voiceNote",
        pages: null,
      });
      expect(row.thumbnailBlobId).toBeNull();
      expect(row.reducedBlobId).toBeNull();
      expect(await blobCount(tenantA)).toBe(1);
    });

    it("records a 23-minute recording as a recording, and no recordedAt for a file without a creation time", async () => {
      const recording = await attach(tenantA, await generateM4aFixture(23 * 60));

      await runQueue();

      const row = await readAttachment(tenantA, recording.attachmentId);
      expect(row.metadata).toEqual({ durationSeconds: 1380, audioKind: "recording", pages: null });
      expect(Object.hasOwn(row.metadata ?? {}, "recordedAt")).toBe(false);
    });

    it.each([
      { seconds: INBOX_RECORDING_MIN_SECONDS - 1, audioKind: "voiceNote" },
      { seconds: INBOX_RECORDING_MIN_SECONDS, audioKind: "recording" },
      { seconds: INBOX_RECORDING_MIN_SECONDS + 1, audioKind: "recording" },
    ])("classifies a $seconds-second attachment as a $audioKind", async ({ seconds, audioKind }) => {
      const note = await attach(tenantA, await generateM4aFixture(seconds));

      await runQueue();

      expect((await readAttachment(tenantA, note.attachmentId)).metadata).toEqual({
        durationSeconds: seconds,
        audioKind,
        pages: null,
      });
    });

    it("reads an MP3 too", async () => {
      const note = await attach(tenantA, await generateMp3Fixture(FIXTURE_CREATION_TIME));

      await runQueue();

      const metadata = (await readAttachment(tenantA, note.attachmentId)).metadata;
      expect(metadata).toMatchObject({ audioKind: "voiceNote", pages: null });
      expect(metadata?.durationSeconds).toBeGreaterThan(0.9);
      expect(metadata?.durationSeconds).toBeLessThan(1.5);
    });
  });

  describe("the transcription of voice notes it queues (issue gh-1980)", () => {
    const failVoiceNoteJobInsert = `
      CREATE FUNCTION fail_voice_note_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure of the voice note job insert';
      END $$`;

    afterEach(async () => {
      await adminPool.query("DROP TRIGGER IF EXISTS fail_voice_note_job_insert ON graphile_worker._private_jobs");
      await adminPool.query("DROP FUNCTION IF EXISTS fail_voice_note_job_insert()");
    });

    it("queues one job for the Inbox item of a 40-second voice note, under the item's key", async () => {
      const note = await attach(tenantA, await generateM4aFixture(40));

      await runQueue();

      expect(await voiceNoteJobs()).toEqual({
        keys: [`inbox-voice-note:${note.inboxItemId}`],
        envelopes: [{ tenantId: tenantA, inboxItemId: note.inboxItemId }],
      });
    });

    it("queues one job for an item with two voice notes: the second replaces the first", async () => {
      const first = await attach(tenantA, await generateM4aFixture(30));
      await attach(tenantA, await generateM4aFixture(50), { itemId: first.inboxItemId });

      await runQueue();

      expect(await voiceNoteJobs()).toEqual({
        keys: [`inbox-voice-note:${first.inboxItemId}`],
        envelopes: [{ tenantId: tenantA, inboxItemId: first.inboxItemId }],
      });
    });

    it.each([
      { seconds: INBOX_RECORDING_MIN_SECONDS - 1, queued: true },
      { seconds: INBOX_RECORDING_MIN_SECONDS, queued: false },
      { seconds: INBOX_RECORDING_MIN_SECONDS + 1, queued: false },
    ])("queues a job for a $seconds-second attachment: $queued", async ({ seconds, queued }) => {
      const note = await attach(tenantA, await generateM4aFixture(seconds));

      await runQueue();

      expect((await voiceNoteJobs()).keys).toEqual(queued ? [`inbox-voice-note:${note.inboxItemId}`] : []);
    });

    it("queues nothing for a photo, a PDF and an audio file that cannot be read", async () => {
      await attach(tenantA, await generateImageFixture({ width: 300, height: 200, format: "jpeg" }));
      await attach(tenantA, Buffer.from("%PDF-1.7 a scanned receipt"));
      await attachDeclared(tenantA, "audio/mp4", Buffer.from("not an audio file at all"));

      await runQueue();

      expect(await voiceNoteJobs()).toEqual({ keys: [], envelopes: [] });
    });

    it("queues nothing again when the job runs again for an attachment that already has its metadata", async () => {
      const note = await attach(tenantA, await generateM4aFixture(40));
      await runQueue();
      await adminPool.query("SELECT graphile_worker.remove_job($1)", [`inbox-voice-note:${note.inboxItemId}`]);
      await runInTenant(tenantA, () =>
        withTransaction(runtimePool, (client) => enqueueForeignJob(client, note.attachmentId)),
      );

      await runQueue();

      expect(await voiceNoteJobs()).toEqual({ keys: [], envelopes: [] });
    });

    it("rolls the metadata back with the job that cannot be queued, and leaves the attachment for a retry", async () => {
      const note = await attach(tenantA, await generateM4aFixture(40));
      await adminPool.query(failVoiceNoteJobInsert);
      await adminPool.query(
        `CREATE TRIGGER fail_voice_note_job_insert BEFORE INSERT ON graphile_worker._private_jobs
           FOR EACH ROW WHEN (NEW.key LIKE 'inbox-voice-note:%') EXECUTE FUNCTION fail_voice_note_job_insert()`,
      );
      const task = createInboxAttachmentMetadataTask(runtimePool, storage);

      await expect(runInTenant(tenantA, () => task({ attachmentId: note.attachmentId }))).rejects.toThrow(
        /injected failure of the voice note job insert/,
      );

      expect((await readAttachment(tenantA, note.attachmentId)).metadata).toBeNull();
      expect(await voiceNoteJobs()).toEqual({ keys: [], envelopes: [] });
    });
  });

  describe("files with nothing to read", () => {
    it("records only a null page count for a PDF, without reading the file", async () => {
      const pdf = await attach(tenantA, Buffer.from("%PDF-1.7 a scanned receipt"));
      storage.reads = [];

      await runQueue();

      const row = await readAttachment(tenantA, pdf.attachmentId);
      expect(row.metadata).toEqual({ pages: null });
      expect(row.thumbnailBlobId).toBeNull();
      expect(row.reducedBlobId).toBeNull();
      expect(storage.reads).toEqual([]);
    });
  });

  describe("files that cannot be read", () => {
    const corruptFiles = [
      { label: "a JPEG that is cut off after its signature", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) },
      {
        label: "an M4A with a header and no content",
        bytes: Buffer.concat([
          Buffer.from([0, 0, 0, 24]),
          Buffer.from("ftypM4A ", "latin1"),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from("M4A isom", "latin1"),
        ]),
      },
    ];

    it.each(corruptFiles)(
      "records metadata.error and no image for $label, leaves the Inbox item as it was and fails nothing",
      async ({ bytes }) => {
        const corrupt = await attach(tenantA, bytes);
        const itemBefore = await itemSnapshot(tenantA, corrupt.inboxItemId);
        const blobsBefore = await blobCount(tenantA);

        await runQueue();

        const row = await readAttachment(tenantA, corrupt.attachmentId);
        expect(row.metadata).toEqual({ error: "mediaUnreadable", pages: null });
        expect(row.thumbnailBlobId).toBeNull();
        expect(row.reducedBlobId).toBeNull();
        expect(await blobCount(tenantA)).toBe(blobsBefore);
        expect(await derivedFiles(tenantA)).toEqual([]);
        expect(await itemSnapshot(tenantA, corrupt.inboxItemId)).toBe(itemBefore);
        await expectNoFailedJob();
      },
    );

    it("records metadata.error for an audio blob whose container carries no duration", async () => {
      // A mail attachment keeps the type its sender declared, so a blob of an audio type can hold bytes of another kind.
      const webm = await attachDeclared(tenantA, "audio/mp4", await generateWebmFixture());

      await runQueue();

      const row = await readAttachment(tenantA, webm.attachmentId);
      expect(row.metadata).toEqual({ error: "mediaUnreadable", pages: null });
      await expectNoFailedJob();
    });

    it("records metadata.error and no image for a small PNG that declares a canvas over the pixel cap", async () => {
      const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 100;
      const huge = await attach(tenantA, generateHugeCanvasPng(side, side));
      const itemBefore = await itemSnapshot(tenantA, huge.inboxItemId);
      const blobsBefore = await blobCount(tenantA);

      await runQueue();

      const row = await readAttachment(tenantA, huge.attachmentId);
      expect(row.metadata).toEqual({ error: "mediaUnreadable", pages: null });
      expect(row.thumbnailBlobId).toBeNull();
      expect(row.reducedBlobId).toBeNull();
      expect(await blobCount(tenantA)).toBe(blobsBefore);
      expect(await derivedFiles(tenantA)).toEqual([]);
      expect(await itemSnapshot(tenantA, huge.inboxItemId)).toBe(itemBefore);
      await expectNoFailedJob();
    });

    it("records metadata.error for an image blob whose bytes are audio", async () => {
      const audio = await attachDeclared(tenantA, "image/jpeg", await generateM4aFixture(2));

      await runQueue();

      const row = await readAttachment(tenantA, audio.attachmentId);
      expect(row.metadata).toEqual({ error: "mediaUnreadable", pages: null });
      expect(row.thumbnailBlobId).toBeNull();
      expect(await derivedFiles(tenantA)).toEqual([]);
    });

    it("fails the job, and records nothing, when the bytes are missing from storage", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 300, height: 200, format: "jpeg" }));
      const blob = await readBlob(tenantA, photo.blobId);
      await rm(join(blobDir, blob?.storage_key ?? ""));
      const task = createInboxAttachmentMetadataTask(runtimePool, storage);

      await expect(runInTenant(tenantA, () => task({ attachmentId: photo.attachmentId }))).rejects.toMatchObject({
        code: "ENOENT",
      });

      expect((await readAttachment(tenantA, photo.attachmentId)).metadata).toBeNull();
    });
  });

  describe("running again", () => {
    it("changes nothing and does not read the file when the job runs a second time", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 3000, height: 2000, format: "jpeg" }));
      await runQueue();
      const rowAfterFirst = await readAttachment(tenantA, photo.attachmentId);
      const blobsAfterFirst = await blobCount(tenantA);
      const filesAfterFirst = await derivedFiles(tenantA);
      const itemAfterFirst = await itemSnapshot(tenantA, photo.inboxItemId);
      ticks = [];
      storage.reads = [];

      await runInTenant(tenantA, () =>
        withTransaction(runtimePool, (client) => enqueueInboxAttachmentMetadata(client, photo.attachmentId)),
      );
      await runQueue();

      expect(await readAttachment(tenantA, photo.attachmentId)).toEqual(rowAfterFirst);
      expect(await blobCount(tenantA)).toBe(blobsAfterFirst);
      expect(await derivedFiles(tenantA)).toEqual(filesAfterFirst);
      expect(await itemSnapshot(tenantA, photo.inboxItemId)).toBe(itemAfterFirst);
      expect(storage.reads).toEqual([]);
      expect(ticks).toEqual([]);
      await expectNoFailedJob();
    });

    it("lets one of two runs that start together record, and removes the images the other wrote", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 3000, height: 2000, format: "jpeg" }));
      // Both runs pass the first read, which finds no metadata, before either writes a byte.
      let arrived = 0;
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      storage.beforeWrite = async () => {
        arrived += 1;
        if (arrived === 2) open();
        await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 20_000))]);
      };
      const task = createInboxAttachmentMetadataTask(runtimePool, storage);

      await runInTenant(tenantA, () =>
        Promise.all([task({ attachmentId: photo.attachmentId }), task({ attachmentId: photo.attachmentId })]),
      );

      expect(arrived).toBeGreaterThanOrEqual(2);
      const row = await readAttachment(tenantA, photo.attachmentId);
      expect(row.metadata).toEqual({ width: 3000, height: 2000, pages: null });
      expect(await blobCount(tenantA)).toBe(3);
      expect(await derivedFiles(tenantA)).toHaveLength(2);
      expect(ticks).toEqual([]);
    });
  });

  describe("the Inbox item's heartbeats", () => {
    it("announces one update of the source Inbox item when the facts are recorded", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 300, height: 200, format: "jpeg" }));
      const updateHeartbeatId = await updateHeartbeatOf(tenantA);
      await removeCaptureTicks();

      await runQueue();

      expect(ticks).toEqual([{ heartbeatId: updateHeartbeatId, itemId: photo.inboxItemId }]);
    });

    it("announces the update for a file that could not be read too", async () => {
      const corrupt = await attach(tenantA, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
      const updateHeartbeatId = await updateHeartbeatOf(tenantA);
      await removeCaptureTicks();

      await runQueue();

      expect(ticks).toEqual([{ heartbeatId: updateHeartbeatId, itemId: corrupt.inboxItemId }]);
    });
  });

  describe("another tenant's attachment", () => {
    it("is not processed: a job of tenant B naming tenant A's attachment ends and reads and writes nothing", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 3000, height: 2000, format: "jpeg" }));
      await removeJobsOf(tenantA);
      const rowBefore = await readAttachment(tenantA, photo.attachmentId);
      const blobsOfB = await blobCount(tenantB);
      storage.reads = [];

      await runInTenant(tenantB, () =>
        withTransaction(runtimePool, (client) => enqueueForeignJob(client, photo.attachmentId)),
      );
      await runQueue();

      expect(await readAttachment(tenantA, photo.attachmentId)).toEqual(rowBefore);
      expect(await blobCount(tenantA)).toBe(1);
      expect(await blobCount(tenantB)).toBe(blobsOfB);
      expect(await derivedFiles(tenantA)).toEqual([]);
      expect(await derivedFiles(tenantB)).toEqual([]);
      expect(storage.reads).toEqual([]);
      expect(ticks).toEqual([]);
      await expectNoFailedJob();
    });

    it("leaves tenant A's own job able to record afterwards", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 300, height: 200, format: "jpeg" }));
      await runInTenant(tenantB, () =>
        withTransaction(runtimePool, (client) => enqueueForeignJob(client, photo.attachmentId)),
      );

      await runQueue();

      expect((await readAttachment(tenantA, photo.attachmentId)).metadata).toEqual({
        width: 300,
        height: 200,
        pages: null,
      });
    });
  });

  describe("when the write fails", () => {
    const failBlobInsert = `
      CREATE FUNCTION fail_derived_blob_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure of the derived blob insert';
      END $$`;

    afterEach(async () => {
      await adminPool.query("DROP TRIGGER IF EXISTS fail_derived_blob_insert ON blobs");
      await adminPool.query("DROP FUNCTION IF EXISTS fail_derived_blob_insert()");
    });

    it("rolls back, removes both stored images and leaves the attachment for a retry", async () => {
      const photo = await attach(tenantA, await generateImageFixture({ width: 3000, height: 2000, format: "jpeg" }));
      await adminPool.query(failBlobInsert);
      // The upload's own blob is already stored; only derived images (key under `inbox-attachments`) are refused.
      await adminPool.query(
        `CREATE TRIGGER fail_derived_blob_insert BEFORE INSERT ON blobs
           FOR EACH ROW WHEN (NEW.storage_key LIKE '%/inbox-attachments/%') EXECUTE FUNCTION fail_derived_blob_insert()`,
      );
      const task = createInboxAttachmentMetadataTask(runtimePool, storage);

      await expect(runInTenant(tenantA, () => task({ attachmentId: photo.attachmentId }))).rejects.toThrow(
        /injected failure/,
      );

      const row = await readAttachment(tenantA, photo.attachmentId);
      expect(row.metadata).toBeNull();
      expect(row.thumbnailBlobId).toBeNull();
      expect(await blobCount(tenantA)).toBe(1);
      expect(await derivedFiles(tenantA)).toEqual([]);
      expect(ticks).toEqual([]);
    });
  });
});

const voiceNoteJobSchema = z.object({ inboxItemId: z.string() });

/** The jobs view has no payload, so envelopes come from the queue's test support. */
async function voiceNoteJobs(): Promise<{
  keys: string[];
  envelopes: Array<{ tenantId: string | null; inboxItemId: string }>;
}> {
  const { rows } = await adminPool.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE],
  );
  const raw = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE);
  const envelopes = raw
    .map((entry) => jobEnvelopeSchema.parse(entry))
    .map((envelope) => ({
      tenantId: envelope.tenantId,
      inboxItemId: voiceNoteJobSchema.parse(envelope.payload).inboxItemId,
    }))
    .sort((a, b) => a.inboxItemId.localeCompare(b.inboxItemId));
  return { keys: rows.map((row) => row.key), envelopes };
}

/** A job of the running tenant that names an attachment of another tenant, under a key of its own so it replaces no job. */
function enqueueForeignJob(client: Parameters<typeof enqueueJob>[0], attachmentId: string): Promise<void> {
  return enqueueJob(client, CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA, { attachmentId }, { jobKey: randomUUID() });
}

async function updateHeartbeatOf(tenant: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `SELECT h.id FROM project_heartbeats h JOIN databases d ON d.id::text = h.rule ->> 'databaseId'
      WHERE d.owner_module_id = 'inbox' AND d.tenant_id = $1 AND h.rule ->> 'kind' = 'onItemEvent'
        AND h.rule ->> 'event' = 'update'`,
    [tenant],
  );
  if (!rows[0]) throw new Error("The Inbox update heartbeat was not seeded");
  return rows[0].id;
}

/** Drops the tick jobs the creation of the Inbox item queued, so only the ones the job queues are seen. */
async function removeCaptureTicks(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.remove_job(key) FROM graphile_worker.jobs WHERE task_identifier = 'heartbeatFireCore' AND key IS NOT NULL",
  );
  ticks = [];
}

/** Drops every job that belongs to `tenant`, those of the attachment's creation included. */
async function removeJobsOf(tenant: string): Promise<void> {
  const raw = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA);
  expect(raw.map((payload) => jobEnvelopeSchema.parse(payload).tenantId)).toContain(tenant);
  await adminPool.query(
    "SELECT graphile_worker.remove_job(key) FROM graphile_worker.jobs WHERE key IS NOT NULL AND task_identifier = ANY($1::text[])",
    [[CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA, CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]],
  );
  ticks = [];
}

/** No job of the queue failed: a failed job stays in the queue with its attempt counted. */
async function expectNoFailedJob(): Promise<void> {
  const { rows } = await adminPool.query<{ task_identifier: string; last_error: string | null }>(
    "SELECT task_identifier, last_error FROM graphile_worker.jobs WHERE attempts > 0 OR last_error IS NOT NULL",
  );
  expect(rows).toEqual([]);
}
