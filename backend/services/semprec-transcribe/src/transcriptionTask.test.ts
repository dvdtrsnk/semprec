import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createBlob,
  createChokePoint,
  createItemWithClient,
  createViewTypeRegistry,
  ForbiddenError,
  getDatabaseByModuleId,
  getItemById,
  LocalFsBlobStorageWriter,
  NotFoundError,
  seedSystem,
  TRANSCRIPTION_OWNER_PROCESS,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
  updateItemWithClient,
  withTransaction,
  writeComputed,
  type BlobStorageWriter,
  type ItemRow,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { wireRealtimeHooks } from "@semprec/realtime";
import type { AiGatewayClientPort, AiGatewayCompletionInput, AiGatewayCompletionResult } from "@semprec/shared";
import { createTranscriptionTask, TranscriptionSourceChangedError } from "./transcriptionTask.js";
import type {
  AudioGatewayClient,
  DiarizationTurn,
  DiarizeRequest,
  TranscribeRequest,
  TranscriptionResult,
} from "./audioGatewayClient.js";
import {
  FIXTURE_CREATION_TIME,
  generateMp4Fixture,
  generateWebmFixture,
  probeNormalizedAudio,
} from "./__tests__/fixtures/mediaFixtures.js";

let pool: Pool;

/** A fake `AudioGatewayClient` for steps 0/1's tests, which do not exercise diarization/ASR themselves but still run through them as later pipeline steps. Counts calls so resume tests can assert on them. */
class FakeAudioGatewayClient implements AudioGatewayClient {
  diarizeCalls: DiarizeRequest[] = [];
  transcribeCalls: TranscribeRequest[] = [];
  diarizeResult: DiarizationTurn[] = [];
  transcribeResult: (request: TranscribeRequest) => TranscriptionResult = () => ({
    text: "",
    language: "en",
    segments: [],
  });

  async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
    this.diarizeCalls.push(request);
    return this.diarizeResult;
  }

  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    this.transcribeCalls.push(request);
    return this.transcribeResult(request);
  }
}

/**
 * A fake `AiGatewayClientPort` for steps 5 and 7: answers every summary request with a text naming
 * its instruction, every speaker-suggestion request with `speakerMappings`, and counts calls.
 */
class FakeSummaryClient implements AiGatewayClientPort {
  calls: AiGatewayCompletionInput[] = [];
  failure: Error | null = null;
  speakerMappings: Array<{ speaker: string; personId: string }> = [];

  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    if (input.operation === "transcript_speaker_suggestion")
      return { content: { mappings: this.speakerMappings }, usage: { inputTokens: 10, outputTokens: 5 } };
    const instruction = input.messages[0]?.content.split("\n")[1] ?? "";
    return { content: { summary: `summary for: ${instruction}` }, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

let summaryClient: FakeSummaryClient;

/** `wireRealtimeHooks` installs every hook; undo all of them so no later test publishes through this file's pool. */
function resetRealtimeHooks(): void {
  setInvalidationHook(() => {});
  setDocUpdateHook(() => {});
  setNotificationCreatedHook(() => {});
  setNotificationReadStateHook(() => {});
  setSessionRevokedHook(() => {});
  setAgentRunEventHook(() => {});
}

afterAll(async () => {
  await pool?.end();
});

describe("transcription step 0", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
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
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
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
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
    // Stops each run at step 5, before `done`, so the row still shows step 0's initial values.
    summaryClient.failure = new Error("stop before finalize");
    gatewayClient.transcribeResult = () => ({
      text: "Hello.",
      language: "en",
      segments: [{ start: 0, end: 0.5, text: "Hello." }],
    });

    await expect(task({ fileItemId: file.id })).rejects.toBe(summaryClient.failure);
    await pool.query("UPDATE items SET properties = '{}'::jsonb WHERE id = $1", [file.id]);
    await expect(task({ fileItemId: file.id })).rejects.toBe(summaryClient.failure);

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
  let gatewayClient: FakeAudioGatewayClient;
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
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
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

      await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

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

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const source = await readSource(files.id, file.id);
    const prepare = prepareCheckpointSchema.parse(source?.computed.prepare);
    expect(prepare.durationSeconds).toBeGreaterThan(2.9);
    expect(prepare.durationSeconds).toBeLessThan(3.5);
  });

  it("falls back to the upload time for date when the recording has no creation_time", async () => {
    const { files, file, blob } = await createSourceFile("audio/mp4", untaggedAudioFixture);

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const source = await readSource(files.id, file.id);
    expect(prepareCheckpointSchema.parse(source?.computed.prepare).creationTime).toBeNull();
    expect(await readTranscriptDate(source)).toBe(blob.createdAt);
  });

  it("skips step 1 on a replay without invoking ffmpeg/ffprobe again", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

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

    await createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id });

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

    await expect(
      createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }),
    ).rejects.toBeInstanceOf(TranscriptionSourceChangedError);

    const source = await readSource(files.id, file.id);
    expect(source?.computed).not.toHaveProperty("prepare");
    expect(await readTranscriptDate(source)).toBeUndefined();
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });

  it("keeps the checkpoint of a concurrent run that finished step 1 first and discards its own audio", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    // A real blob, so the later diarize/ASR steps (which now run unconditionally after step 1) have
    // something to download — simulating the concurrent run's own normalized output, not this run's.
    const concurrentStorageKey = `transcriptions/${randomUUID()}`;
    await blobStorage.writeStream(concurrentStorageKey, Readable.from(audioFixture));
    const concurrentBlob = await withTransaction(pool, (client) =>
      createBlob(client, {
        mimeType: "audio/mp4",
        byteSize: audioFixture.byteLength,
        storageKey: concurrentStorageKey,
      }),
    );
    const concurrentCheckpoint = { normalizedBlobId: concurrentBlob.id, durationSeconds: 1, creationTime: null };
    // The concurrent run's own `date`, which it writes in the same transaction as its checkpoint.
    const concurrentDate = "2020-01-01T00:00:00.000Z";
    const storage = storageWithMidNormalizationHook(async () => {
      await withTransaction(pool, async (client) => {
        const source = await getItemById(client, files.id, file.id);
        const transcripts = await getDatabaseByModuleId(client, "transcripts");
        if (!transcripts) throw new Error("Transcripts database was not seeded");
        await updateItemWithClient(
          client,
          {
            databaseId: transcripts.id,
            itemId: z.string().parse(source?.computed.create),
            propertiesPatch: { date: concurrentDate },
          },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await writeComputed(client, files.id, file.id, "prepare", concurrentCheckpoint);
      });
    });

    await createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const source = await readSource(files.id, file.id);
    expect(source?.computed.prepare).toEqual(concurrentCheckpoint);
    expect(await readTranscriptDate(source)).toBe(concurrentDate);
    expect(await readNormalizedLeftovers()).toEqual({
      blobRows: 1,
      storedFiles: [concurrentStorageKey.slice("transcriptions/".length)],
    });
  });

  it("rolls back and discards its audio when the write transaction fails", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const storage = storageWithMidNormalizationHook(async () => {
      // A transcript deleted mid-normalization makes the write transaction's `date` patch fail.
      await pool.query(
        "UPDATE items SET deleted_at = now() WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')",
      );
    });

    await expect(
      createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect((await readSource(files.id, file.id))?.computed).not.toHaveProperty("prepare");
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });
});

const asrCheckpointSchema = z.object({
  language: z.string().nullable(),
  chunks: z.record(z.string(), z.object({ text: z.string(), segments: z.array(z.any()) })),
});

describe("transcription steps 2 and 3 (diarize, ASR)", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
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
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function createSourceFile(bytes: Buffer) {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(bytes));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: bytes.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return { files, file };
  }

  function readSource(filesId: string, fileId: string): Promise<ItemRow | null> {
    return withTransaction(pool, (client) => getItemById(client, filesId, fileId));
  }

  /**
   * Inflates step 1's checkpointed duration and clears steps 2/3's checkpoints, so a replay
   * exercises multiple ASR chunk boundaries against the fixture's real (sub-second) audio without
   * generating a 20+ minute fixture file: `ffmpeg -t` past the real file's end simply stops at EOF.
   */
  async function inflateDurationAndResetLaterSteps(fileId: string, durationSeconds: number): Promise<void> {
    await pool.query(
      `UPDATE items
       SET computed = jsonb_set(computed, '{prepare,durationSeconds}', to_jsonb($2::float8)) - 'diarize' - 'asr'
       WHERE id = $1`,
      [fileId, durationSeconds],
    );
  }

  it("diarizes the whole recording exactly once, checkpoints its turns, and also runs ASR", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    gatewayClient.diarizeResult = [{ speaker: "SPEAKER_00", start: 0, end: 1 }];

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.diarizeCalls[0]?.audioSeconds).toBeGreaterThan(0);
    expect(gatewayClient.transcribeCalls.length).toBeGreaterThan(0);
    const source = await readSource(files.id, file.id);
    expect(source?.computed.diarize).toEqual(gatewayClient.diarizeResult);
  });

  it("skips diarization on replay without calling the gateway again", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id });
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    const beforeReplay = await readSource(files.id, file.id);

    await task({ fileItemId: file.id });

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    const afterReplay = await readSource(files.id, file.id);
    expect(afterReplay?.computed.diarize).toEqual(beforeReplay?.computed.diarize);
  });

  it("splits ASR into one chunk per 20-minute boundary, checkpoints each immediately, and passes chunk 0's detected language to later chunks", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });
    await inflateDurationAndResetLaterSteps(file.id, 25 * 60);
    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    gatewayClient.transcribeResult = (request) => ({
      text: `chunk-${gatewayClient.transcribeCalls.length - 1}`,
      language: request.language ?? "cs",
      segments: [],
    });

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(2);
    expect(gatewayClient.transcribeCalls[0]?.language).toBeUndefined();
    expect(gatewayClient.transcribeCalls[1]?.language).toBe("cs");
    const source = await readSource(files.id, file.id);
    const asr = asrCheckpointSchema.parse(source?.computed.asr);
    expect(asr.language).toBe("cs");
    expect(Object.keys(asr.chunks)).toEqual(["0", "1"]);
    expect(asr.chunks["0"]?.text).toBe("chunk-0");
    expect(asr.chunks["1"]?.text).toBe("chunk-1");
  });

  it("resumes after a crash mid-ASR: the retried run repeats no already-checkpointed chunk and no diarize call", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });
    await inflateDurationAndResetLaterSteps(file.id, 25 * 60);
    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    let callCount = 0;
    gatewayClient.transcribeResult = () => {
      callCount += 1;
      if (callCount === 2) throw new Error("simulated crash");
      return { text: "chunk-0", language: "cs", segments: [] };
    };

    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id }),
    ).rejects.toThrow("simulated crash");

    const midSource = await readSource(files.id, file.id);
    expect(Object.keys(asrCheckpointSchema.parse(midSource?.computed.asr).chunks)).toEqual(["0"]);

    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    gatewayClient.transcribeResult = (request) => ({
      text: "chunk-1",
      language: request.language ?? "cs",
      segments: [],
    });

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    expect(gatewayClient.diarizeCalls).toHaveLength(0);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls[0]?.language).toBe("cs");
    const finalSource = await readSource(files.id, file.id);
    const asr = asrCheckpointSchema.parse(finalSource?.computed.asr);
    expect(Object.keys(asr.chunks)).toEqual(["0", "1"]);
  });
});

const transcriptOutputSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()),
});

describe("transcription steps 4-8 (merge, summarize, match, suggest speakers, finalize)", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
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
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
    gatewayClient.diarizeResult = [
      { speaker: "SPEAKER_00", start: 0, end: 0.5 },
      { speaker: "SPEAKER_01", start: 0.5, end: 1 },
    ];
    gatewayClient.transcribeResult = () => ({
      text: "Hello. Hi there.",
      language: "en",
      segments: [
        { start: 0, end: 0.4, text: " Hello." },
        { start: 0.6, end: 0.9, text: " Hi there." },
      ],
    });
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function createSourceFile() {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return { files, file };
  }

  async function readTranscript(fileId: string) {
    const { rows } = await pool.query<{ id: string; properties: unknown; computed: unknown }>(
      `SELECT t.id, t.properties, t.computed FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
       WHERE f.id = $1`,
      [fileId],
    );
    const row = rows[0];
    if (!row) throw new Error("expected a transcript for the file");
    return { id: row.id, ...transcriptOutputSchema.parse(row) };
  }

  async function readAutomationStatus(transcriptId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM item_automation WHERE item_id = $1", [
      transcriptId,
    ]);
    return rows[0]?.status;
  }

  it("merges into speaker segments with the language, summarizes, and finalizes done with item_automation done", async () => {
    const { file } = await createSourceFile();

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([
      { speaker: "SPEAKER_00", text: "Hello.", startsAt: 0, endsAt: 0.4 },
      { speaker: "SPEAKER_01", text: "Hi there.", startsAt: 0.6, endsAt: 0.9 },
    ]);
    expect(transcript.computed.language).toBe("en");
    expect(transcript.computed.summaryByInstruction).toEqual({
      meetingSummary: expect.stringMatching(/^summary for: Summarize this meeting/),
    });
    expect(transcript.properties.status).toBe("done");
    expect(await readAutomationStatus(transcript.id)).toBe("done");

    expect(summaryClient.calls).toHaveLength(1);
    expect(summaryClient.calls[0]).toMatchObject({ operation: "transcript_summary", projectItemId: null });
    expect(summaryClient.calls[0]?.system).toContain("(en)");
    expect(summaryClient.calls[0]?.messages[0]?.content).toContain("SPEAKER_00: Hello.\nSPEAKER_01: Hi there.");
  });

  it("merges overlapping ASR chunks without duplicating the overlap band", async () => {
    const { file } = await createSourceFile();
    gatewayClient.diarizeResult = [{ speaker: "SPEAKER_00", start: 0, end: 1500 }];
    // Steps 0 and 1 land, then diarization fails before any later checkpoint exists.
    const diarizeFailure = new Error("simulated diarize failure");
    const failingGateway = new FakeAudioGatewayClient();
    failingGateway.diarize = async () => {
      throw diarizeFailure;
    };
    await expect(
      createTranscriptionTask(pool, blobStorage, failingGateway, summaryClient)({ fileItemId: file.id }),
    ).rejects.toBe(diarizeFailure);
    // 25 minutes: chunk 0 = [0, 1200], chunk 1 = [1170, 1500], cut at 1185.
    await pool.query(
      `UPDATE items SET computed = jsonb_set(computed, '{prepare,durationSeconds}', to_jsonb(1500::float8)) WHERE id = $1`,
      [file.id],
    );
    gatewayClient.transcribeResult = (request) =>
      request.filename === "chunk-0.opus"
        ? {
            text: "",
            language: "cs",
            segments: [
              { start: 1175, end: 1180, text: "early in band" },
              { start: 1188, end: 1196, text: "late in band (chunk 0 copy)" },
            ],
          }
        : {
            text: "",
            language: "cs",
            segments: [
              { start: 5, end: 10, text: "early in band (chunk 1 copy)" },
              { start: 18, end: 26, text: "late in band" },
            ],
          };

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([
      { speaker: "SPEAKER_00", text: "early in band", startsAt: 1175, endsAt: 1180 },
      { speaker: "SPEAKER_00", text: "late in band", startsAt: 1188, endsAt: 1196 },
    ]);
    expect(transcript.computed.language).toBe("cs");
  });

  it("caches a distinct summary per instruction and never repeats a cached one", async () => {
    const { file } = await createSourceFile();
    const actionItems = { key: "actionItems", prompt: "List only the action items." };

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
      actionItems,
    )({ fileItemId: file.id });
    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
      actionItems,
    )({ fileItemId: file.id });

    const transcript = await readTranscript(file.id);
    const summaries = z.record(z.string(), z.string()).parse(transcript.computed.summaryByInstruction);
    expect(Object.keys(summaries).sort()).toEqual(["actionItems", "meetingSummary"]);
    expect(summaries.actionItems).toBe("summary for: List only the action items.");
    expect(summaries.meetingSummary).not.toBe(summaries.actionItems);
    expect(summaryClient.calls).toHaveLength(2);
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
  });

  it("leaves the row processing when the summary fails, then finalizes on retry without repeating a paid call", async () => {
    const { file } = await createSourceFile();
    const summaryFailure = new Error("simulated gateway failure");
    summaryClient.failure = summaryFailure;

    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id }),
    ).rejects.toBe(summaryFailure);

    const failed = await readTranscript(file.id);
    expect(failed.computed.segments).toHaveLength(2);
    expect(failed.computed).not.toHaveProperty("summaryByInstruction");
    expect(failed.properties.status).toBe("processing");
    expect(await readAutomationStatus(failed.id)).toBe("pending");

    summaryClient.failure = null;
    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const finalized = await readTranscript(file.id);
    expect(finalized.computed.segments).toEqual(failed.computed.segments);
    expect(finalized.properties.status).toBe("done");
    expect(await readAutomationStatus(finalized.id)).toBe("done");
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
    expect(summaryClient.calls).toHaveLength(2);
  });

  it("never rewrites merged segments or their speaker keys on a replay", async () => {
    const { file } = await createSourceFile();
    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });
    const before = await readTranscript(file.id);
    await pool.query(
      `UPDATE items SET computed = jsonb_set(computed, '{diarize}', '[{"speaker":"SPEAKER_09","start":0,"end":1}]')
       WHERE id = $1`,
      [file.id],
    );

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    expect((await readTranscript(file.id)).computed.segments).toEqual(before.computed.segments);
  });

  it("summarizes a transcript with no speech as empty without a gateway call", async () => {
    const { file } = await createSourceFile();
    gatewayClient.transcribeResult = () => ({ text: "", language: null, segments: [] });

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([]);
    expect(transcript.computed.language).toBeNull();
    expect(transcript.computed.summaryByInstruction).toEqual({ meetingSummary: "" });
    expect(transcript.properties.status).toBe("done");
    expect(summaryClient.calls).toHaveLength(0);
  });

  async function readMatch(transcriptId: string) {
    const { rows: edges } = await pool.query<{ other: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
       FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b)
       WHERE p.key = 'event' AND (r.item_a = $1 OR r.item_b = $1)`,
      [transcriptId],
    );
    const { rows: cards } = await pool.query<{ id: string; kind: string }>(
      `SELECT i.id, i.properties ->> 'kind' AS kind FROM items i JOIN databases d ON d.id = i.database_id
       WHERE d.owner_module_id = 'processingProposals'`,
    );
    return { eventIds: edges.map((edge) => edge.other), cards };
  }

  async function createEvent(date: string): Promise<string> {
    const events = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "events"));
    if (!events) throw new Error("Events database was not seeded");
    const event = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: events.id, properties: { name: "Sync", type: "meeting", date } }),
    );
    return event.id;
  }

  it("links the one Event in the recording's window before finalizing, and a rerun adds nothing", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id });
    await task({ fileItemId: file.id });

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    expect(await readMatch(transcript.id)).toEqual({ eventIds: [eventId], cards: [] });
  });

  it("creates one transcript card when no Event matches, and a rerun converges on it", async () => {
    const { file } = await createSourceFile();
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id });
    await task({ fileItemId: file.id });

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    const match = await readMatch(transcript.id);
    expect(match.eventIds).toEqual([]);
    expect(match.cards).toEqual([{ id: expect.any(String), kind: "transcript" }]);
    // No linked Event, so no participants to suggest speakers from: nothing is asked.
    expect(summaryClient.calls.map((call) => call.operation)).toEqual(["transcript_summary"]);
  });

  async function createParticipant(eventId: string, name: string): Promise<string> {
    const { person, peoplePropertyId } = await withTransaction(pool, async (client) => {
      const people = await getDatabaseByModuleId(client, "people");
      const events = await getDatabaseByModuleId(client, "events");
      if (!people || !events) throw new Error("People/Events databases were not seeded");
      const created = await createItemWithClient(client, { databaseId: people.id, properties: { name } });
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
        [events.id],
      );
      if (!rows[0]) throw new Error("Events 'people' property was not seeded");
      return { person: created, peoplePropertyId: rows[0].id };
    });
    await createChokePoint(pool).createRelation({
      relationPropertyId: peoplePropertyId,
      callerItemId: eventId,
      targetItemId: person.id,
    });
    return person.id;
  }

  async function readSpeakerCards() {
    const { rows } = await pool.query<{ proposal: unknown; status: string }>(
      `SELECT i.properties -> 'proposal' AS proposal, i.properties ->> 'status' AS status
       FROM items i JOIN databases d ON d.id = i.database_id
       WHERE d.owner_module_id = 'processingProposals' AND i.properties ->> 'kind' = 'transcript'`,
    );
    return rows;
  }

  async function countSpeakerEdges(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id = d.property_id_a WHERE p.key = 'speakers'`,
    );
    return rows[0]?.count ?? 0;
  }

  it("suggests speakers from the linked Event's participants as cards, writes no mapping, and a rerun pays once", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const aliceId = await createParticipant(eventId, "Alice");
    await createParticipant(eventId, "Bob");
    summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId }];
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id });
    await task({ fileItemId: file.id });

    const suggestionCalls = summaryClient.calls.filter((call) => call.operation === "transcript_speaker_suggestion");
    expect(suggestionCalls).toHaveLength(1);
    expect(suggestionCalls[0]).toMatchObject({ projectItemId: null });
    const content = suggestionCalls[0]?.messages[0]?.content ?? "";
    expect(content).toContain(`${aliceId}: Alice`);
    expect(content).toContain("SPEAKER_00\nSPEAKER_01");
    expect(await readSpeakerCards()).toEqual([
      {
        proposal: {
          entityKind: "relation",
          target: aliceId,
          properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } },
        },
        status: "proposed",
      },
    ]);
    expect(await countSpeakerEdges()).toBe(0);
    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
  });

  it("leaves the row processing when the speaker suggestion fails, then suggests on retry", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const aliceId = await createParticipant(eventId, "Alice");
    summaryClient.speakerMappings = [{ speaker: "SPEAKER_00", personId: aliceId }];
    const failing: AiGatewayClientPort = {
      complete: (input) =>
        input.operation === "transcript_speaker_suggestion"
          ? Promise.reject(new Error("gateway refused"))
          : summaryClient.complete(input),
    };

    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, failing)({ fileItemId: file.id }),
    ).rejects.toThrow("gateway refused");
    expect((await readTranscript(file.id)).properties.status).toBe("processing");
    expect(await readSpeakerCards()).toEqual([]);

    await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });

    expect((await readTranscript(file.id)).properties.status).toBe("done");
    expect(await readSpeakerCards()).toHaveLength(1);
  });

  it("publishes each output write and the done transition on the generic realtime channel", async () => {
    const { file } = await createSourceFile();
    wireRealtimeHooks(pool);
    const listenClient = await pool.connect();
    const received: unknown[] = [];
    try {
      await listenClient.query("LISTEN semprec_events");
      listenClient.on("notification", (message) => received.push(JSON.parse(message.payload ?? "null")));

      await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id });
      const transcript = await readTranscript(file.id);
      const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));

      // Step 1 (date), step 4 (segments, then language), step 5 (summary) and step 8 (status done).
      await vi.waitFor(() => {
        const updates = received.filter(
          (message) =>
            z
              .object({ type: z.literal("invalidation"), scope: z.literal("item"), op: z.literal("update") })
              .safeParse(message).success &&
            z.object({ itemId: z.literal(transcript.id), databaseId: z.literal(transcripts?.id) }).safeParse(message)
              .success,
        );
        expect(updates).toHaveLength(5);
      });
    } finally {
      listenClient.release(true);
      resetRealtimeHooks();
    }
  });
});
