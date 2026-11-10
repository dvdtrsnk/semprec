import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsBlobStorageWriter, type BlobStorageWriter } from "@semprec/data";
import {
  downloadToTempFile,
  normalizeAudio,
  probeMedia,
  probeNormalizedDuration,
  MediaToolError,
  removeTempFile,
  renderPlaybackAudio,
} from "./mediaNormalization.js";
import {
  FIXTURE_CREATION_TIME,
  decodeSpeech,
  generateLateAudioVideoFixture,
  generateMp3Fixture,
  generateMp4Fixture,
  generateOggFixture,
  generateSeekFixture,
  generateSpokenMedia,
  generateWebmFixture,
  probeAudioStream,
  probeAacProfile,
  probeNormalizedAudio,
  seekToneFrequency,
  speechSimilarity,
  speechWindow,
} from "./__tests__/fixtures/mediaFixtures.js";

// Integration tier although no test here touches the database: every one of them runs the real
// ffmpeg/ffprobe, which CI installs only after the unit tier (`.github/workflows/ci.yml`).

/** Fails the way a storage backend failing mid-flush would, but only once it has drained ffmpeg's whole output — so ffmpeg itself exits cleanly and the write is the only thing that rejects. */
function storageFailingAfterDrain(
  storageError: Error,
  deleteBytes: (storageKey: string) => Promise<void>,
): BlobStorageWriter {
  return {
    writeStream: async (_storageKey, source) => {
      for await (const _chunk of source) {
        // Dropped: this writer stores nothing.
      }
      throw storageError;
    },
    delete: deleteBytes,
    readStream: () => {
      throw new Error("normalizeAudio never reads from storage");
    },
  };
}

/** Length of the audio a file decodes to; the container duration of an Ogg file with an offset start is not that. */
async function decodedDurationSeconds(path: string): Promise<number> {
  const decoded = `${path}.wav`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", path, decoded]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg decode exited ${code}`))));
  });
  const { durationSeconds } = await probeMedia(decoded);
  return durationSeconds!;
}

describe("mediaNormalization", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let fixtureBytes: Buffer;
  const tempPaths: string[] = [];

  beforeAll(async () => {
    fixtureBytes = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(() => {
    tmpBlobDir = join(tmpdir(), `semprec-media-normalization-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
  });

  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((path) => removeTempFile(path)));
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function writeToTempFile(bytes: Buffer = fixtureBytes): Promise<string> {
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(bytes));
    const path = await downloadToTempFile(blobStorage, storageKey);
    tempPaths.push(path);
    return path;
  }

  it("probes duration and the creation_time tag off a real media file", async () => {
    const probe = await probeMedia(await writeToTempFile());

    expect(probe.durationSeconds).toBeGreaterThan(0.9);
    expect(probe.durationSeconds).toBeLessThan(1.5);
    expect(probe.creationTime).toBe("2024-03-01T12:00:00.000Z");
  });

  it("treats a creation_time tag that is not a timestamp as no tag at all", async () => {
    const probe = await probeMedia(await writeToTempFile(await generateMp3Fixture("not-a-date")));

    expect(probe.durationSeconds).toBeGreaterThan(0.9);
    expect(probe.creationTime).toBeNull();
  });

  it("normalizes to 16 kHz mono Opus at about 16 kb/s and streams the result into blob storage", async () => {
    const fixturePath = await writeToTempFile();

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    const result = await normalizeAudio(fixturePath, blobStorage, outputStorageKey);

    expect(result.storageKey).toBe(outputStorageKey);
    const outputBytes = await readFile(join(tmpBlobDir, outputStorageKey));
    expect(outputBytes.byteLength).toBe(result.byteSize);
    expect(await probeNormalizedAudio(join(tmpBlobDir, outputStorageKey))).toEqual({
      codecName: "opus",
      channels: 1,
      inputSampleRate: 16_000,
    });
    // 16 kb/s is about 7 MB per hour; libopus's own mono default of 64 kb/s is four times that. The
    // bound leaves room for the Ogg headers a one-second clip cannot amortize.
    const { durationSeconds } = await probeMedia(fixturePath);
    expect(durationSeconds).not.toBeNull();
    expect((result.byteSize * 8) / durationSeconds!).toBeLessThan(32_000);
  });

  it("renders AAC mono at about 64 kb/s in an MP4 whose length matches the original", async () => {
    const fixturePath = await writeToTempFile();

    const outputStorageKey = `transcriptions/${randomUUID()}.m4a`;
    const result = await renderPlaybackAudio(fixturePath, blobStorage, outputStorageKey);

    const outputPath = join(tmpBlobDir, outputStorageKey);
    expect((await readFile(outputPath)).byteLength).toBe(result.byteSize);
    const stream = await probeAudioStream(outputPath);
    expect(stream).toMatchObject({ codecName: "aac", channels: 1 });
    expect(stream.bitRate).toBeLessThan(80_000);
    const original = await probeMedia(fixturePath);
    const rendition = await probeMedia(outputPath);
    expect(Math.abs(rendition.durationSeconds! - original.durationSeconds!)).toBeLessThan(0.1);
  });

  it("puts the rendition and the Opus copy of a video whose audio starts late on one timeline", async () => {
    const fixturePath = await writeToTempFile(await generateLateAudioVideoFixture());
    const opusKey = `transcriptions/${randomUUID()}.opus`;
    const m4aKey = `transcriptions/${randomUUID()}.m4a`;

    await normalizeAudio(fixturePath, blobStorage, opusKey);
    await renderPlaybackAudio(fixturePath, blobStorage, m4aKey);

    // The audio lasts two seconds. Both files drop the late start instead of padding it, so each
    // plays those two seconds from 0 and a segment time means the same word in either.
    const opusDecoded = await decodedDurationSeconds(join(tmpBlobDir, opusKey));
    const m4aDecoded = await decodedDurationSeconds(join(tmpBlobDir, m4aKey));
    expect(Math.abs(m4aDecoded - 2)).toBeLessThan(0.1);
    expect(Math.abs(m4aDecoded - opusDecoded)).toBeLessThan(0.1);
    const m4a = await probeMedia(join(tmpBlobDir, m4aKey));
    expect(Math.abs(m4a.durationSeconds! - opusDecoded)).toBeLessThan(0.1);
  });

  it.each([false, true])(
    "seeks matching distinct content in normalized and playback audio (late video: %s)",
    async (lateVideo) => {
      const source = await writeToTempFile(await generateSeekFixture(lateVideo));
      const opusKey = `transcriptions/${randomUUID()}.opus`;
      const playbackKey = `transcriptions/${randomUUID()}.m4a`;
      await normalizeAudio(source, blobStorage, opusKey);
      if (lateVideo) await renderPlaybackAudio(source, blobStorage, playbackKey);
      const playback = lateVideo ? join(tmpBlobDir, playbackKey) : source;
      for (const [offset, expected] of [
        [0.4, 440],
        [1.4, 880],
      ] as const) {
        expect(Math.abs((await seekToneFrequency(join(tmpBlobDir, opusKey), offset)) - expected)).toBeLessThan(12);
        expect(Math.abs((await seekToneFrequency(playback, offset)) - expected)).toBeLessThan(12);
      }
    },
  );

  it.each([false, true])(
    "seeks the matching spoken marker in AAC-LC and normalized audio (late video: %s)",
    async (lateVideo) => {
      const source = await writeToTempFile(await generateSpokenMedia(lateVideo));
      const opusKey = `transcriptions/${randomUUID()}.opus`;
      const playbackKey = `transcriptions/${randomUUID()}.m4a`;
      await normalizeAudio(source, blobStorage, opusKey);
      if (lateVideo) await renderPlaybackAudio(source, blobStorage, playbackKey);
      const playback = lateVideo ? join(tmpBlobDir, playbackKey) : source;
      expect(await probeAacProfile(playback)).toBe("LC");
      const normalized = join(tmpBlobDir, opusKey);
      const alpha = await speechWindow(normalized, 0);
      const bravo = await speechWindow(normalized, 1.35);
      const playedAlpha = await speechWindow(playback, 0);
      const playedBravo = await speechWindow(playback, 1.35);
      const alphaMatch = speechSimilarity(alpha, playedAlpha);
      const bravoMatch = speechSimilarity(bravo, playedBravo);
      const normalFull = await decodeSpeech(normalized);
      const playbackFull = await decodeSpeech(playback);
      const sampleWindow = (bytes: Buffer, seconds: number) =>
        bytes.subarray(seconds * 16000 * 2, (seconds + 0.4) * 16000 * 2);
      const comparisons = {
        alphaMatch,
        bravoMatch,
        normalizedAlphaSeek: speechSimilarity(sampleWindow(normalFull, 0), alpha),
        normalizedBravoSeek: speechSimilarity(sampleWindow(normalFull, 1.35), bravo),
        playbackAlphaSeek: speechSimilarity(sampleWindow(playbackFull, 0), playedAlpha),
        playbackBravoSeek: speechSimilarity(sampleWindow(playbackFull, 1.35), playedBravo),
      };
      for (const [label, match] of Object.entries(comparisons)) {
        expect.soft(match.score, `${label}: ${JSON.stringify(match)}`).toBeGreaterThan(0.5);
        expect.soft(Math.abs(match.lagSamples), `${label}: ${JSON.stringify(match)}`).toBeLessThanOrEqual(400);
      }
      expect(alphaMatch.score).toBeGreaterThan(speechSimilarity(alpha, playedBravo).score + 0.2);
      expect(bravoMatch.score).toBeGreaterThan(speechSimilarity(bravo, playedAlpha).score + 0.2);
      const shifted = Buffer.concat([Buffer.alloc(1600), alpha]).subarray(0, alpha.length);
      const shiftedMatch = speechSimilarity(alpha, shifted);
      expect(shiftedMatch.score).toBeGreaterThan(0.9);
      expect(Math.abs(shiftedMatch.lagSamples)).toBeGreaterThan(400);
    },
  );

  it("renders an Ogg input", async () => {
    const fixturePath = await writeToTempFile(await generateOggFixture());
    const outputStorageKey = `transcriptions/${randomUUID()}.m4a`;

    await renderPlaybackAudio(fixturePath, blobStorage, outputStorageKey);

    const outputPath = join(tmpBlobDir, outputStorageKey);
    expect(await probeAudioStream(outputPath)).toMatchObject({ codecName: "aac", channels: 1 });
    const { durationSeconds } = await probeMedia(outputPath);
    expect(Math.abs(durationSeconds! - 1)).toBeLessThan(0.1);
  });

  it("deletes the rendition and reports the storage error when only the blob write fails", async () => {
    const fixturePath = await writeToTempFile();
    const storageError = new Error("disk full");
    const deleteBytes = vi.fn().mockResolvedValue(undefined);
    const outputStorageKey = `transcriptions/${randomUUID()}.m4a`;

    await expect(
      renderPlaybackAudio(fixturePath, storageFailingAfterDrain(storageError, deleteBytes), outputStorageKey),
    ).rejects.toBe(storageError);
    expect(deleteBytes).toHaveBeenCalledWith(outputStorageKey);
  });

  it("rejects and removes any partial rendition when ffmpeg fails on an invalid input", async () => {
    const invalidPath = join(tmpdir(), `semprec-media-normalization-invalid-${randomUUID()}`);
    await writeFile(invalidPath, "not media");
    tempPaths.push(invalidPath);
    const outputStorageKey = `transcriptions/${randomUUID()}.m4a`;

    await expect(renderPlaybackAudio(invalidPath, blobStorage, outputStorageKey)).rejects.toBeInstanceOf(
      MediaToolError,
    );
    await expect(readFile(join(tmpBlobDir, outputStorageKey))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and removes any partial output when ffmpeg fails on an invalid input", async () => {
    const invalidPath = join(tmpdir(), `semprec-media-normalization-invalid-${randomUUID()}`);
    await writeFile(invalidPath, "not a media file");
    tempPaths.push(invalidPath);

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    await expect(normalizeAudio(invalidPath, blobStorage, outputStorageKey)).rejects.toThrow(/ffmpeg exited with code/);
    await expect(readFile(join(tmpBlobDir, outputStorageKey))).rejects.toThrow();
  });

  it("deletes the output and reports the storage error when only the blob write fails", async () => {
    const fixturePath = await writeToTempFile();
    const storageError = new Error("storage flush failed");
    const deleteBytes = vi.fn(async (_storageKey: string) => {});

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    await expect(
      normalizeAudio(fixturePath, storageFailingAfterDrain(storageError, deleteBytes), outputStorageKey),
    ).rejects.toBe(storageError);
    expect(deleteBytes).toHaveBeenCalledWith(outputStorageKey);
  });

  it("still reports the storage error when deleting the output fails as well", async () => {
    const fixturePath = await writeToTempFile();
    const storageError = new Error("storage flush failed");
    const deleteBytes = vi.fn(async (_storageKey: string) => {
      throw new Error("delete failed");
    });

    await expect(
      normalizeAudio(
        fixturePath,
        storageFailingAfterDrain(storageError, deleteBytes),
        `transcriptions/${randomUUID()}.opus`,
      ),
    ).rejects.toBe(storageError);
    expect(deleteBytes).toHaveBeenCalledOnce();
  });

  it("rejects with a descriptive error when ffprobe cannot read the input", async () => {
    const missingPath = join(tmpdir(), `semprec-media-normalization-missing-${randomUUID()}`);
    await expect(probeMedia(missingPath)).rejects.toThrow(/ffprobe exited with code/);
  });

  it("reports no duration for a streamed WebM/Matroska source whose header carries none", async () => {
    const probe = await probeMedia(await writeToTempFile(await generateWebmFixture()));

    expect(probe.durationSeconds).toBeNull();
  });

  it("still normalizes a source with no duration, and probeNormalizedDuration reads the output's own", async () => {
    const fixturePath = await writeToTempFile(await generateWebmFixture());
    expect((await probeMedia(fixturePath)).durationSeconds).toBeNull();

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    await normalizeAudio(fixturePath, blobStorage, outputStorageKey);

    const durationSeconds = await probeNormalizedDuration(blobStorage, outputStorageKey);
    expect(durationSeconds).toBeGreaterThan(2.9);
    expect(durationSeconds).toBeLessThan(3.5);
  });
});
