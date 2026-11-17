import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import type { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsBlobStorageWriter } from "@semprec/data";
import {
  downloadToTempFile,
  normalizeAudio,
  probeMedia,
  probeNormalizedDuration,
  removeTempFile,
} from "./mediaNormalization.js";
import { generateOggFixture } from "./__tests__/fixtures/mediaFixtures.js";

// Integration tier without a database: it runs the real ffmpeg/ffprobe.

/** How long the writer's directory creation is held back: far longer than ffmpeg needs to encode the fixture. */
const MKDIR_DELAY_MS = 1500;

// The real writer's `mkdir` waits for `mkdirGate.current` when a test has set it. Every other function of
// `node:fs/promises` is the real one.
const mkdirGate = vi.hoisted(() => ({ current: undefined as Promise<void> | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof mkdir>) => {
      await mkdirGate.current;
      return actual.mkdir(...args);
    },
  };
});

describe("normalizeAudio through a writer whose directory creation is slow", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  const tempPaths: string[] = [];

  beforeEach(() => {
    tmpBlobDir = join(tmpdir(), `semprec-media-slow-storage-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
  });

  afterEach(async () => {
    mkdirGate.current = undefined;
    await Promise.all(tempPaths.splice(0).map((path) => removeTempFile(path)));
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  it("stores the whole audio ffmpeg wrote, although ffmpeg exits before the directory exists", async () => {
    const sourceKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(sourceKey, Readable.from(await generateOggFixture()));
    const inputPath = await downloadToTempFile(blobStorage, sourceKey);
    tempPaths.push(inputPath);
    const inputSeconds = (await probeMedia(inputPath)).durationSeconds;
    expect(inputSeconds).not.toBeNull();

    const outputKey = `transcriptions/${randomUUID()}.opus`;
    mkdirGate.current = new Promise<void>((resolve) => setTimeout(resolve, MKDIR_DELAY_MS));
    const result = await normalizeAudio(inputPath, blobStorage, outputKey);
    mkdirGate.current = undefined;

    expect(result.byteSize).toBeGreaterThan(0);
    expect((await stat(join(tmpBlobDir, outputKey))).size).toBe(result.byteSize);
    // `probeNormalizedDuration` throws a `MediaToolError` on an empty or unreadable file.
    const outputSeconds = await probeNormalizedDuration(blobStorage, outputKey);
    expect(Math.abs(outputSeconds - inputSeconds!)).toBeLessThan(0.1);
  });
});
