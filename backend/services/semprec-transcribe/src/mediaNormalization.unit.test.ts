import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalFsBlobStorageWriter } from "@semprec/data";
import { downloadToTempFile, normalizeAudio, probeMedia, removeTempFile } from "./mediaNormalization.js";

/** Generates a short fragmented-mp4 audio fixture with ffmpeg's `lavfi` test source, streamed straight to a buffer — no binary fixture checked into git. */
function generateAudioFixture(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-metadata",
        "creation_time=2024-03-01T12:00:00Z",
        "-c:a",
        "aac",
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

describe("mediaNormalization", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let fixtureBytes: Buffer;
  const tempPaths: string[] = [];

  beforeAll(async () => {
    fixtureBytes = await generateAudioFixture();
  });

  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((path) => removeTempFile(path)));
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  function freshBlobStorage(): LocalFsBlobStorageWriter {
    tmpBlobDir = join(tmpdir(), `semprec-media-normalization-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    return blobStorage;
  }

  async function writeFixtureToTempFile(): Promise<string> {
    freshBlobStorage();
    const storageKey = `source/${randomUUID()}.m4a`;
    await blobStorage.writeStream(storageKey, Readable.from(fixtureBytes));
    const path = await downloadToTempFile(blobStorage, storageKey);
    tempPaths.push(path);
    return path;
  }

  it("probes duration and the creation_time tag off a real media file", async () => {
    const fixturePath = await writeFixtureToTempFile();

    const probe = await probeMedia(fixturePath);

    expect(probe.durationSeconds).toBeGreaterThan(0.9);
    expect(probe.durationSeconds).toBeLessThan(1.5);
    expect(probe.creationTime).toBe("2024-03-01T12:00:00.000000Z");
  });

  it("normalizes to mono Opus and streams the result into blob storage", async () => {
    const fixturePath = await writeFixtureToTempFile();

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    const result = await normalizeAudio(fixturePath, blobStorage, outputStorageKey);

    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.storageKey).toBe(outputStorageKey);

    const outputBytes = await readFile(join(tmpBlobDir, outputStorageKey));
    expect(outputBytes.byteLength).toBe(result.byteSize);
    const streamInfo = await probeAudioStream(join(tmpBlobDir, outputStorageKey));
    expect(streamInfo.codecName).toBe("opus");
    expect(streamInfo.channels).toBe(1);
  });

  it("rejects and removes any partial output when ffmpeg fails on an invalid input", async () => {
    freshBlobStorage();
    const invalidPath = join(tmpdir(), `semprec-media-normalization-invalid-${randomUUID()}`);
    await writeFile(invalidPath, "not a media file");
    tempPaths.push(invalidPath);

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    await expect(normalizeAudio(invalidPath, blobStorage, outputStorageKey)).rejects.toThrow(/ffmpeg/);
    await expect(readFile(join(tmpBlobDir, outputStorageKey))).rejects.toThrow();
  });

  it("rejects with a descriptive error when ffprobe cannot read the input", async () => {
    const missingPath = join(tmpdir(), `semprec-media-normalization-missing-${randomUUID()}`);
    await expect(probeMedia(missingPath)).rejects.toThrow(/ffprobe/);
  });
});
