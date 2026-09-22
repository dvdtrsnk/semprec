import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsBlobStorageWriter, type BlobStorageWriter } from "@semprec/data";
import {
  downloadToTempFile,
  normalizeAudio,
  parseCreationTime,
  probeMedia,
  removeTempFile,
} from "./mediaNormalization.js";
import {
  FIXTURE_CREATION_TIME,
  generateMp3Fixture,
  generateMp4Fixture,
  probeNormalizedAudio,
} from "./__tests__/fixtures/mediaFixtures.js";

describe("parseCreationTime", () => {
  it.each([
    ["ffmpeg's own mp4 form", "2024-03-01T12:00:00.000000Z", "2024-03-01T12:00:00.000Z"],
    ["an explicit offset, normalized to UTC", "2024-03-01T13:00:00+01:00", "2024-03-01T12:00:00.000Z"],
    ["the earliest year Postgres has", "0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
    ["no tag at all", undefined, null],
    ["free text", "not-a-date", null],
    ["a timestamp with no zone", "2024-03-01T12:00:00", null],
    ["a calendar date that does not exist", "2024-02-30T12:00:00Z", null],
    ["year 0, which Postgres does not have", "0000-06-01T00:00:00Z", null],
    ["an offset that pushes the instant past year 9999", "9999-12-31T23:59:59-23:59", null],
  ])("handles %s", (_label, tag, expected) => {
    expect(parseCreationTime(tag)).toBe(expected);
  });
});

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
    vi.unstubAllEnvs();
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
    expect((result.byteSize * 8) / durationSeconds).toBeLessThan(32_000);
  });

  it("rejects and removes any partial output when ffmpeg fails on an invalid input", async () => {
    const invalidPath = join(tmpdir(), `semprec-media-normalization-invalid-${randomUUID()}`);
    await writeFile(invalidPath, "not a media file");
    tempPaths.push(invalidPath);

    const outputStorageKey = `transcriptions/${randomUUID()}.opus`;
    await expect(normalizeAudio(invalidPath, blobStorage, outputStorageKey)).rejects.toThrow(/ffmpeg/);
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

  it("removes its temp file when the download fails", async () => {
    const isolatedTmp = await mkdtemp(join(tmpdir(), "semprec-media-normalization-tmpdir-"));
    vi.stubEnv("TMPDIR", isolatedTmp);
    try {
      await expect(downloadToTempFile(blobStorage, `source/${randomUUID()}`)).rejects.toThrow(/ENOENT/);
      expect(await readdir(isolatedTmp)).toEqual([]);
    } finally {
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("rejects with a descriptive error when ffprobe cannot read the input", async () => {
    const missingPath = join(tmpdir(), `semprec-media-normalization-missing-${randomUUID()}`);
    await expect(probeMedia(missingPath)).rejects.toThrow(/ffprobe/);
  });
});
