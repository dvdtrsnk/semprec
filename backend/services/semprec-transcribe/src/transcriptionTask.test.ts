import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createBlob,
  createItemWithClient,
  createViewTypeRegistry,
  ForbiddenError,
  getDatabaseByModuleId,
  getItemById,
  LocalFsBlobStorageWriter,
  NotFoundError,
  seedSystem,
  updateItemWithClient,
  withTransaction,
  writeComputed,
  type BlobStorageWriter,
  type ItemRow,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createTranscriptionTask, TranscriptionSourceChangedError } from "./transcriptionTask.js";
import {
  FIXTURE_CREATION_TIME,
  generateMp4Fixture,
  generateWebmFixture,
  probeNormalizedAudio,
} from "./__tests__/fixtures/mediaFixtures.js";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

describe("transcription step 0", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let audioFixture: Buffer;

  beforeAll(async () => {
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  it("creates one pending transcript with the source values and skips its checkpoint on replay", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}.m4a`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording.mp3", file: { blobId: blob.id } },
      }),
    );
    const task = createTranscriptionTask(pool, blobStorage);

    await task({ fileItemId: file.id });
    await pool.query("UPDATE items SET properties = '{}'::jsonb WHERE id = $1", [file.id]);
    await task({ fileItemId: file.id });

    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!transcripts) throw new Error("Transcripts database was not seeded");
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1",
      [transcripts.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toMatchObject({
      name: "recording.mp3",
      status: "processing",
      link: `semprec://items/${file.id}`,
    });
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    expect(source?.computed.create).toBe(rows[0]?.id);
    const { rows: automationRows } = await pool.query<{ status: string }>(
      "SELECT status FROM item_automation WHERE item_id = $1",
      [rows[0]?.id],
    );
    expect(automationRows).toEqual([{ status: "pending" }]);
  });

  it("rejects writing the transcripts 'status'/'link' system properties under the wrong systemOwnerProcess", async () => {
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!transcripts) throw new Error("Transcripts database was not seeded");

    const promise = withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: transcripts.id,
          properties: { name: "recording.mp3", status: "processing", link: "semprec://items/does-not-matter" },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: "wrong-process" },
      ),
    );

    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    try {
      await promise;
      expect.unreachable("expected an owner_violation ForbiddenError");
    } catch (err) {
      expect((err as ForbiddenError).code).toBe("owner_violation");
    }
  });
});

const prepareCheckpointSchema = z.object({
  normalizedBlobId: z.string(),
  durationSeconds: z.number(),
  creationTime: z.string().nullable(),
});

describe("transcription step 1 (prepare)", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let audioFixture: Buffer;
  let videoFixture: Buffer;
  let untaggedAudioFixture: Buffer;

  beforeAll(async () => {
    [audioFixture, videoFixture, untaggedAudioFixture] = await Promise.all([
      generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME }),
      generateMp4Fixture({ withVideo: true, creationTime: FIXTURE_CREATION_TIME }),
      generateMp4Fixture(),
    ]);
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function createSourceFile(mimeType: string, bytes: Buffer) {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(bytes));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType, byteSize: bytes.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return { files, file, blob };
  }

  function readSource(filesId: string, fileId: string): Promise<ItemRow | null> {
    return withTransaction(pool, (client) => getItemById(client, filesId, fileId));
  }

  async function readTranscriptDate(source: ItemRow | null): Promise<unknown> {
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE id = $1",
      [z.string().parse(source?.computed.create)],
    );
    return rows[0]?.properties.date;
  }

  /** The normalized audio left behind — neither a `blobs` row nor bytes in storage when step 1 discarded it. */
  async function readNormalizedLeftovers(): Promise<{ blobRows: number; storedFiles: string[] }> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM blobs WHERE storage_key LIKE 'transcriptions/%'",
    );
    return {
      blobRows: Number(rows[0]?.count),
      storedFiles: await readdir(join(tmpBlobDir, "transcriptions")),
    };
  }

  /** `blobStorage`, except that `hook` runs as step 1 starts storing ffmpeg's output: after its read transaction, before its write transaction. */
  function storageWithMidNormalizationHook(hook: () => Promise<void>): BlobStorageWriter {
    return {
      writeStream: async (storageKey, source, options) => {
        if (storageKey.startsWith("transcriptions/")) await hook();
        return blobStorage.writeStream(storageKey, source, options);
      },
      delete: (storageKey) => blobStorage.delete(storageKey),
      readStream: (storageKey, range) => blobStorage.readStream(storageKey, range),
    };
  }

  it.each([
    ["audio", "audio/mp4", () => audioFixture],
    ["video with an audio track", "video/mp4", () => videoFixture],
  ])(
    "normalizes a %s input to 16 kHz mono Opus and checkpoints duration and creation_time",
    async (_label, mimeType, getBytes) => {
      const { files, file } = await createSourceFile(mimeType, getBytes());

      await createTranscriptionTask(pool, blobStorage)({ fileItemId: file.id });

      const source = await readSource(files.id, file.id);
      const prepare = prepareCheckpointSchema.parse(source?.computed.prepare);
      expect(prepare.durationSeconds).toBeGreaterThan(0.5);
      expect(prepare.durationSeconds).toBeLessThan(2);
      expect(prepare.creationTime).toBe("2024-03-01T12:00:00.000Z");

      const { rows: blobRows } = await pool.query<{ mime_type: string; storage_key: string }>(
        "SELECT mime_type, storage_key FROM blobs WHERE id = $1",
        [prepare.normalizedBlobId],
      );
      expect(blobRows).toEqual([{ mime_type: "audio/ogg", storage_key: expect.stringMatching(/^transcriptions\//) }]);
      expect(await probeNormalizedAudio(join(tmpBlobDir, blobRows[0]!.storage_key))).toEqual({
        codecName: "opus",
        channels: 1,
        inputSampleRate: 16_000,
      });

      expect(await readTranscriptDate(source)).toBe("2024-03-01T12:00:00.000Z");
    },
  );

  it("checkpoints the normalized output's own duration when the source container has none", async () => {
    const { files, file } = await createSourceFile("audio/webm", await generateWebmFixture());

    await createTranscriptionTask(pool, blobStorage)({ fileItemId: file.id });

    const source = await readSource(files.id, file.id);
    const prepare = prepareCheckpointSchema.parse(source?.computed.prepare);
    expect(prepare.durationSeconds).toBeGreaterThan(2.9);
    expect(prepare.durationSeconds).toBeLessThan(3.5);
  });

  it("falls back to the upload time for date when the recording has no creation_time", async () => {
    const { files, file, blob } = await createSourceFile("audio/mp4", untaggedAudioFixture);

    await createTranscriptionTask(pool, blobStorage)({ fileItemId: file.id });

    const source = await readSource(files.id, file.id);
    expect(prepareCheckpointSchema.parse(source?.computed.prepare).creationTime).toBeNull();
    expect(await readTranscriptDate(source)).toBe(blob.createdAt);
  });

  it("skips step 1 on a replay without invoking ffmpeg/ffprobe again", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const task = createTranscriptionTask(pool, blobStorage);

    await task({ fileItemId: file.id });
    const beforeReplay = await readSource(files.id, file.id);
    expect(beforeReplay?.computed.prepare).toBeDefined();

    // Every blob byte on disk is gone: if step 1 ran ffmpeg/ffprobe again it would fail to read
    // the (now-missing) source file, so a clean replay proves the checkpoint skip actually fired.
    await rm(tmpBlobDir, { recursive: true, force: true });

    await expect(task({ fileItemId: file.id })).resolves.toBeUndefined();
    const afterReplay = await readSource(files.id, file.id);
    expect(afterReplay?.computed.prepare).toEqual(beforeReplay?.computed.prepare);
  });

  it("holds no pooled connection, and so no transaction, while ffmpeg runs", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    let checkedOutDuringFfmpeg: number | undefined;
    const storage = storageWithMidNormalizationHook(async () => {
      checkedOutDuringFfmpeg = pool.totalCount - pool.idleCount;
    });

    await createTranscriptionTask(pool, storage)({ fileItemId: file.id });

    expect(checkedOutDuringFfmpeg).toBe(0);
    expect((await readSource(files.id, file.id))?.computed.prepare).toBeDefined();
  });

  it("writes nothing and discards its audio when the source's file is replaced while ffmpeg runs", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const replacement = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: 1, storageKey: `source/${randomUUID()}` }),
    );
    const storage = storageWithMidNormalizationHook(async () => {
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: files.id,
          itemId: file.id,
          propertiesPatch: { file: { blobId: replacement.id } },
        }),
      );
    });

    await expect(createTranscriptionTask(pool, storage)({ fileItemId: file.id })).rejects.toBeInstanceOf(
      TranscriptionSourceChangedError,
    );

    const source = await readSource(files.id, file.id);
    expect(source?.computed).not.toHaveProperty("prepare");
    expect(await readTranscriptDate(source)).toBeUndefined();
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });

  it("keeps the checkpoint of a concurrent run that finished step 1 first and discards its own audio", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const concurrentCheckpoint = { normalizedBlobId: randomUUID(), durationSeconds: 1, creationTime: null };
    const storage = storageWithMidNormalizationHook(async () => {
      await withTransaction(pool, (client) =>
        writeComputed(client, files.id, file.id, "prepare", concurrentCheckpoint),
      );
    });

    await createTranscriptionTask(pool, storage)({ fileItemId: file.id });

    const source = await readSource(files.id, file.id);
    expect(source?.computed.prepare).toEqual(concurrentCheckpoint);
    expect(await readTranscriptDate(source)).toBeUndefined();
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });

  it("rolls back and discards its audio when the write transaction fails", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const storage = storageWithMidNormalizationHook(async () => {
      // A transcript deleted mid-normalization makes the write transaction's `date` patch fail.
      await pool.query(
        "UPDATE items SET deleted_at = now() WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')",
      );
    });

    await expect(createTranscriptionTask(pool, storage)({ fileItemId: file.id })).rejects.toBeInstanceOf(NotFoundError);

    expect((await readSource(files.id, file.id))?.computed).not.toHaveProperty("prepare");
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });
});
