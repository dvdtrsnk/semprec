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
  removeTempFile,
} from "./mediaNormalization.js";
import {
  FIXTURE_CREATION_TIME,
  generateMp3Fixture,
  generateMp4Fixture,
  generateWebmFixture,
  probeNormalizedAudio,
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
