import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFsBlobStorageWriter } from "@semprec/data";
import { downloadToTempFile, parseCreationTime } from "./mediaNormalization.js";

// Only what runs without the ffmpeg/ffprobe binaries belongs in this tier; everything that spawns
// them is in `mediaNormalization.test.ts`.

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

describe("downloadToTempFile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes its temp file when the download fails", async () => {
    // Never created: the download reads a key that was never written.
    const blobStorage = new LocalFsBlobStorageWriter(
      join(tmpdir(), `semprec-media-normalization-test-${randomUUID()}`),
    );
    const isolatedTmp = await mkdtemp(join(tmpdir(), "semprec-media-normalization-tmpdir-"));
    vi.stubEnv("TMPDIR", isolatedTmp);
    try {
      await expect(downloadToTempFile(blobStorage, `source/${randomUUID()}`)).rejects.toThrow(/ENOENT/);
      expect(await readdir(isolatedTmp)).toEqual([]);
    } finally {
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });
});
