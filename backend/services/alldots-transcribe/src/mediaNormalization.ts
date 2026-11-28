import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { BlobStorageWriter } from "@alldots/data";
import { logger } from "./logger.js";

/** The only production code in the monorepo that shells out to `ffmpeg`/`ffprobe`. */

// A corrupt or adversarial input must not wedge the worker forever.
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const FFPROBE_TIMEOUT_MS = 30_000;

/**
 * Pixel cap enforced in the decoder (`-max_pixels`), so a tiny PNG declaring a huge canvas is refused
 * before any frame buffer is allocated. Far above any phone photo.
 */
export const MAX_IMAGE_PIXELS = 100_000_000;

export interface StoredMediaResult {
  storageKey: string;
  byteSize: number;
  contentHash: string;
}

export type NormalizedAudioResult = StoredMediaResult;

export interface MediaProbeResult {
  /** `null` when absent, e.g. a streamed WebM/Matroska recording. */
  durationSeconds: number | null;
  /** `null` when the source has no usable `creation_time` tag. */
  creationTime: string | null;
}

/** Stored as `mediaUnreadable`. */
export class MediaToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaToolError";
  }
}

function describeExit(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): MediaToolError {
  return new MediaToolError(
    `${command} exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}: ${stderr}`,
  );
}

/** Cleanup that must never replace the error or result it follows; a failure is only logged. */
async function cleanUpLeftover(
  cleanup: () => Promise<void>,
  fields: Record<string, string>,
  message: string,
): Promise<void> {
  try {
    await cleanup();
  } catch {
    logger.warn(fields, message);
  }
}

export function removeTempFile(path: string): Promise<void> {
  return cleanUpLeftover(() => rm(path, { force: true }), { path }, "Failed to remove a transcription temp file");
}

export function discardStoredAudio(blobStorage: BlobStorageWriter, storageKey: string): Promise<void> {
  return cleanUpLeftover(
    () => blobStorage.delete(storageKey),
    { storageKey },
    "Failed to delete normalized audio that no blob references",
  );
}

export function discardStoredImage(blobStorage: BlobStorageWriter, storageKey: string): Promise<void> {
  return cleanUpLeftover(
    () => blobStorage.delete(storageKey),
    { storageKey },
    "Failed to delete a rendered image that no blob references",
  );
}

/** A seekable local file, since ffprobe must seek (mp4's moov atom is often at the end). */
export async function downloadToTempFile(blobStorage: BlobStorageWriter, storageKey: string): Promise<string> {
  const path = join(tmpdir(), `alldots-transcribe-${randomUUID()}`);
  try {
    await pipeline(blobStorage.readStream(storageKey), createWriteStream(path));
  } catch (err) {
    // The write stream has usually created the file by the time the read side fails.
    await removeTempFile(path);
    throw err;
  }
  return path;
}

const ffprobeOutputSchema = z.object({
  format: z.object({
    // Absent when the header has no duration, e.g. browser `MediaRecorder` WebM.
    duration: z.string().optional(),
    tags: z.object({ creation_time: z.string().optional() }).partial().optional(),
  }),
});

const creationTimeTagSchema = z.iso.datetime({ offset: true });

/**
 * `creation_time` is untrusted text bound for a `timestamptz`-cast `date`. Only a zoned ISO 8601
 * instant in years 1-9999 is kept (Postgres has no year 0 and cannot parse `+010000`), re-serialized
 * via `toISOString()`.
 */
export function parseCreationTime(tag: string | undefined): string | null {
  if (tag === undefined || !creationTimeTagSchema.safeParse(tag).success) return null;
  const instant = new Date(tag);
  const year = instant.getUTCFullYear();
  return year >= 1 && year <= 9999 ? instant.toISOString() : null;
}

/** A non-zero exit, including the timeout kill, is a `MediaToolError`; a spawn failure is rethrown as is. */
function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => child.kill("SIGKILL"), FFPROBE_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };

    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(() =>
          reject(describeExit("ffprobe", code, signal, Buffer.concat(stderrChunks).toString("utf8").trim())),
        );
        return;
      }
      finish(() => resolve(Buffer.concat(stdoutChunks).toString("utf8")));
    });
  });
}

export async function probeMedia(inputPath: string): Promise<MediaProbeResult> {
  const stdout = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "format=duration:format_tags=creation_time",
    inputPath,
  ]);
  const parsed = ffprobeOutputSchema.parse(JSON.parse(stdout));
  let durationSeconds: number | null = null;
  if (parsed.format.duration !== undefined) {
    durationSeconds = Number.parseFloat(parsed.format.duration);
    if (!Number.isFinite(durationSeconds)) {
      throw new MediaToolError(`ffprobe reported a non-numeric duration: '${parsed.format.duration}'`);
    }
  }
  const tag = parsed.format.tags?.creation_time;
  const creationTime = parseCreationTime(tag);
  if (tag !== undefined && creationTime === null) {
    // The tag's own text is file content, not an identifier, so it stays out of the log.
    logger.warn({}, "Ignoring a creation_time tag that is not a usable timestamp");
  }
  return { durationSeconds, creationTime };
}

export interface ImageProbeResult {
  /** After the file's orientation is applied. */
  width: number;
  height: number;
}

const ffprobeImageSchema = z.object({
  streams: z.array(z.object({ width: z.number().int().positive(), height: z.number().int().positive() })),
  // The first frame's side data holds the rotation an EXIF orientation tag asks for; the stream itself does not.
  packets_and_frames: z
    .array(z.object({ side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional() }))
    .optional(),
});

/**
 * The size as shown (swapped for a quarter-turn orientation, as `renderImageJpeg` renders it). An
 * unreadable, pictureless or over-cap file is a `MediaToolError`.
 */
export async function probeImage(inputPath: string): Promise<ImageProbeResult> {
  const stdout = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-max_pixels",
    MAX_IMAGE_PIXELS.toString(),
    "-select_streams",
    "v:0",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    "stream=width,height:side_data=rotation",
    inputPath,
  ]);
  let parsed: z.infer<typeof ffprobeImageSchema>;
  try {
    parsed = ffprobeImageSchema.parse(JSON.parse(stdout));
  } catch {
    throw new MediaToolError("ffprobe returned output of an unexpected shape for an image");
  }
  const stream = parsed.streams[0];
  if (!stream) throw new MediaToolError("ffprobe found no picture stream in the image");
  const rotations = (parsed.packets_and_frames ?? []).flatMap((frame) =>
    (frame.side_data_list ?? []).flatMap((data) => (data.rotation === undefined ? [] : [data.rotation])),
  );
  const quarterTurn = rotations.some((rotation) => Math.abs(rotation) % 180 === 90);
  return quarterTurn ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
}

/** The normalized Ogg Opus output always carries a duration, unlike some streamed sources. */
export async function probeNormalizedDuration(blobStorage: BlobStorageWriter, storageKey: string): Promise<number> {
  const path = await downloadToTempFile(blobStorage, storageKey);
  try {
    const { durationSeconds } = await probeMedia(path);
    if (durationSeconds === null)
      throw new MediaToolError(`ffprobe reported no duration for normalized output '${storageKey}'`);
    return durationSeconds;
  } finally {
    await removeTempFile(path);
  }
}

/** `-ss` before `-i` seeks instead of decoding everything before the chunk. */
export async function extractAudioChunkBytes(
  inputPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<Buffer> {
  const child = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      startSeconds.toString(),
      "-t",
      durationSeconds.toString(),
      "-i",
      inputPath,
      "-c:a",
      "libopus",
      "-f",
      "ogg",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(describeExit("ffmpeg", code, signal, Buffer.concat(stderrChunks).toString("utf8").trim()));
      });
    });
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(stdoutChunks);
}

/** 16 kHz mono Opus at 16 kb/s, about 7 MB per hour. */
export function normalizeAudio(
  inputPath: string,
  blobStorage: BlobStorageWriter,
  storageKey: string,
): Promise<NormalizedAudioResult> {
  return encodeAudioToStorage(
    inputPath,
    ["-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k", "-f", "ogg"],
    blobStorage,
    storageKey,
  );
}

/**
 * Mono AAC/MP4 on the same timeline as `normalizeAudio`, so a segment's `startsAt` seeks to the
 * same word in either. Fragmented because a plain MP4 needs a seekable output for its index.
 */
export function renderPlaybackAudio(
  inputPath: string,
  blobStorage: BlobStorageWriter,
  storageKey: string,
): Promise<NormalizedAudioResult> {
  return encodeAudioToStorage(
    inputPath,
    ["-ac", "1", "-c:a", "aac", "-b:a", "64k", "-f", "mp4", "-movflags", "frag_keyframe+delay_moov+default_base_moof"],
    blobStorage,
    storageKey,
  );
}

/** Timestamps are rebased to the first decoded sample, so every audio output shares one timeline. */
function encodeAudioToStorage(
  inputPath: string,
  outputArgs: string[],
  blobStorage: BlobStorageWriter,
  storageKey: string,
): Promise<NormalizedAudioResult> {
  return streamFfmpegToStorage(
    ["-y", "-loglevel", "error", "-i", inputPath, "-vn", "-af", "asetpts=PTS-STARTPTS", ...outputArgs, "pipe:1"],
    blobStorage,
    storageKey,
    discardStoredAudio,
  );
}

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Downscales (never enlarges) to `longSidePixels`, upright as `probeImage` reports it. Output that
 * is empty or lacks the JPEG signature is deleted and thrown as a `MediaToolError`.
 */
export async function renderImageJpeg(
  inputPath: string,
  longSidePixels: number,
  blobStorage: BlobStorageWriter,
  storageKey: string,
): Promise<StoredMediaResult> {
  // `longSidePixels` is a number typed by the caller, never file content, so it cannot inject filter syntax.
  const fit = `scale=w='min(${longSidePixels},iw)':h='min(${longSidePixels},ih)':force_original_aspect_ratio=decrease`;
  const rendered = await streamFfmpegToStorage(
    [
      "-y",
      "-loglevel",
      "error",
      "-max_pixels",
      MAX_IMAGE_PIXELS.toString(),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      fit,
      "-c:v",
      "mjpeg",
      "-f",
      "mjpeg",
      "pipe:1",
    ],
    blobStorage,
    storageKey,
    discardStoredImage,
  );
  try {
    if (rendered.byteSize === 0) throw new MediaToolError("ffmpeg produced an empty image");
    const head = await buffer(blobStorage.readStream(storageKey, { start: 0, end: JPEG_SIGNATURE.length - 1 }));
    if (!head.equals(JPEG_SIGNATURE)) throw new MediaToolError("ffmpeg produced an image that is not a JPEG");
  } catch (err) {
    await discardStoredImage(blobStorage, storageKey);
    throw err;
  }
  return rendered;
}

/** `args` must end in `pipe:1`. On any failure, partial output is discarded before the error propagates. */
async function streamFfmpegToStorage(
  args: string[],
  blobStorage: BlobStorageWriter,
  storageKey: string,
  discard: (blobStorage: BlobStorageWriter, storageKey: string) => Promise<void>,
): Promise<StoredMediaResult> {
  const child = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
  const exit = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(describeExit("ffmpeg", code, signal, Buffer.concat(stderrChunks).toString("utf8").trim()));
    });
  });

  try {
    // `child.stdout` is handed over unread: `BlobStorageWriter.writeStream` consumes its source from the
    // tick it is called, so ffmpeg cannot finish and lose its output while the writer prepares.
    const [exitResult, writeResult] = await Promise.allSettled([
      exit,
      blobStorage.writeStream(storageKey, child.stdout),
    ]);
    // Checked first: once storage stops reading ffmpeg's stdout, ffmpeg dies of a broken pipe,
    // and that exit is only the symptom of the storage failure.
    if (writeResult.status === "rejected") {
      await discard(blobStorage, storageKey);
      throw writeResult.reason;
    }
    if (exitResult.status === "rejected") {
      await discard(blobStorage, storageKey);
      throw exitResult.reason;
    }
    return { storageKey, byteSize: writeResult.value.byteSize, contentHash: writeResult.value.contentHash };
  } finally {
    clearTimeout(timer);
  }
}
