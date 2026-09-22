import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createBlob,
  createItemWithClient,
  createViewTypeRegistry,
  ForbiddenError,
  getDatabaseByModuleId,
  getItemById,
  LocalFsBlobStorageWriter,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createTranscriptionTask } from "./transcriptionTask.js";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

const FIXTURE_CREATION_TIME = "2024-03-01T12:00:00Z";

/** Generates a short fragmented-mp4 fixture with ffmpeg's `lavfi` test sources, streamed straight to a buffer — no binary fixture checked into git. `withVideo` covers the "video input with an audio track" acceptance criterion, exercised through the same command as a real upload. */
function generateFixture(withVideo: boolean): Promise<Buffer> {
  const inputs = withVideo
    ? [
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=5:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
      ]
    : ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
  const codecArgs = withVideo
    ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
    : ["-c:a", "aac"];
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        ...inputs,
        "-metadata",
        `creation_time=${FIXTURE_CREATION_TIME}`,
        ...codecArgs,
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg fixture generation failed: ${Buffer.concat(stderrChunks).toString("utf8")}`));
    });
  });
}

function probeAudioStream(path: string): Promise<{ codecName: string; channels: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "stream=codec_name,channels",
        "-select_streams",
        "a",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${Buffer.concat(stderrChunks).toString("utf8")}`));
        return;
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        streams: Array<{ codec_name: string; channels: number }>;
      };
      const stream = parsed.streams[0];
      if (!stream) {
        reject(new Error("ffprobe found no audio stream"));
        return;
      }
      resolve({ codecName: stream.codec_name, channels: stream.channels });
    });
  });
}

describe("transcription step 0", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let audioFixture: Buffer;

  beforeAll(async () => {
    audioFixture = await generateFixture(false);
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

describe("transcription step 1 (prepare)", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let audioFixture: Buffer;
  let videoFixture: Buffer;

  beforeAll(async () => {
    [audioFixture, videoFixture] = await Promise.all([generateFixture(false), generateFixture(true)]);
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

  async function createSourceFile(name: string, mimeType: string, bytes: Buffer) {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(bytes));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType, byteSize: bytes.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: files.id, properties: { name, file: { blobId: blob.id } } }),
    );
    return { files, file };
  }

  it.each([
    ["audio", "audio/mp4", () => audioFixture],
    ["video with an audio track", "video/mp4", () => videoFixture],
  ])(
    "normalizes a %s input to 16 kHz mono Opus and checkpoints duration and creation_time",
    async (_label, mimeType, getBytes) => {
      const bytes = getBytes();
      const { files, file } = await createSourceFile("recording", mimeType, bytes);

      const task = createTranscriptionTask(pool, blobStorage);
      await task({ fileItemId: file.id });

      const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
      const prepare = source?.computed.prepare as { normalizedBlobId?: string; durationSeconds?: number } | undefined;
      expect(prepare?.normalizedBlobId).toEqual(expect.any(String));
      expect(prepare?.durationSeconds).toBeGreaterThan(0.5);
      expect(prepare?.durationSeconds).toBeLessThan(2);

      const { rows: blobRows } = await pool.query<{ mime_type: string; storage_key: string }>(
        "SELECT mime_type, storage_key FROM blobs WHERE id = $1",
        [prepare?.normalizedBlobId],
      );
      expect(blobRows).toHaveLength(1);
      const normalizedPath = join(tmpBlobDir, blobRows[0]!.storage_key);
      const streamInfo = await probeAudioStream(normalizedPath);
      expect(streamInfo.codecName).toBe("opus");
      expect(streamInfo.channels).toBe(1);

      const transcriptId = (source?.computed.create as string | undefined) ?? "";
      const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
      const { rows: transcriptRows } = await pool.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
        [transcripts?.id, transcriptId],
      );
      expect(transcriptRows[0]?.properties.date).toBe("2024-03-01T12:00:00.000000Z");
    },
  );

  it("skips step 1 on a replay without invoking ffmpeg/ffprobe again", async () => {
    const { files, file } = await createSourceFile("recording", "audio/mp4", audioFixture);
    const task = createTranscriptionTask(pool, blobStorage);

    await task({ fileItemId: file.id });
    const beforeReplay = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    expect(beforeReplay?.computed.prepare).toBeDefined();

    // Every blob byte on disk is gone: if step 1 ran ffmpeg/ffprobe again it would fail to read
    // the (now-missing) source file, so a clean replay proves the checkpoint skip actually fired.
    await rm(tmpBlobDir, { recursive: true, force: true });

    await expect(task({ fileItemId: file.id })).resolves.toBeUndefined();
    const afterReplay = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    expect(afterReplay?.computed.prepare).toEqual(beforeReplay?.computed.prepare);
  });
});
