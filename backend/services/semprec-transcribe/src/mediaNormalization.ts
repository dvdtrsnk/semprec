import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { BlobStorageWriter } from "@semprec/data";
import { logger } from "./logger.js";

/**
 * The only production code in the monorepo that shells out to `ffmpeg`/`ffprobe` — see
 * `docs/adr/2026-09-22-ffmpeg-confined-to-semprec-transcribe.md`.
 */

// A hung ffmpeg/ffprobe process (a corrupt or adversarial input) must not wedge the worker
// forever (io-hardening: always a timeout on an external call).
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const FFPROBE_TIMEOUT_MS = 30_000;

/**
 * The most pixels (width times height) of a picture `ffprobe` or `ffmpeg` decodes from an upload, 100 million: far
 * above a phone photo (a phone sensor is at most about 200 MP), far below the decoded frame of a small, highly
 * compressed PNG that declares a huge canvas (a 15,000 x 15,000 RGBA canvas decodes to about 900 MB and fits in under
 * 1 MB). `ffprobe` decodes the first frame to learn a picture's size, so the cap is enforced where the decoder is
 * (`-max_pixels`): a larger picture is refused before any frame buffer is allocated, by every call that reads one,
 * and is a `MediaToolError` like any other file the tools cannot read.
 */
export const MAX_IMAGE_PIXELS = 100_000_000;

/** Bytes `ffmpeg` produced and streamed into blob storage: where they are, how many, and their SHA-256. */
export interface StoredMediaResult {
  storageKey: string;
  byteSize: number;
  contentHash: string;
}

export type NormalizedAudioResult = StoredMediaResult;

export interface MediaProbeResult {
  /** `null` when the container's `format.duration` is absent, e.g. a streamed WebM/Matroska recording — see `probeNormalizedDuration`. */
  durationSeconds: number | null;
  /** `null` when the source carries no usable `creation_time` container tag (see `parseCreationTime`) — the caller falls back to another timestamp. */
  creationTime: string | null;
}

/** `ffmpeg` or `ffprobe` could not read or convert the media; `recordTranscriptionFailure` stores this class as `mediaUnreadable`. */
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

/**
 * Runs cleanup that must never replace the error — or the result — of the work it follows. A
 * failure only leaves an unreferenced file behind, so it is logged for manual removal instead.
 */
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

/** Deletes normalized audio that no `blobs` row references, e.g. a failed or superseded normalization's output. */
export function discardStoredAudio(blobStorage: BlobStorageWriter, storageKey: string): Promise<void> {
  return cleanUpLeftover(
    () => blobStorage.delete(storageKey),
    { storageKey },
    "Failed to delete normalized audio that no blob references",
  );
}

/** Deletes a rendered image that no `blobs` row references, e.g. one the job produced and then did not record. */
export function discardStoredImage(blobStorage: BlobStorageWriter, storageKey: string): Promise<void> {
  return cleanUpLeftover(
    () => blobStorage.delete(storageKey),
    { storageKey },
    "Failed to delete a rendered image that no blob references",
  );
}

/**
 * Downloads the source blob to a local temp file so both `ffprobe` (which needs to seek for an
 * accurate duration on formats like mp4, whose moov atom is often at the end) and `ffmpeg`'s own
 * input read from a real seekable file rather than a one-shot pipe.
 */
export async function downloadToTempFile(blobStorage: BlobStorageWriter, storageKey: string): Promise<string> {
  const path = join(tmpdir(), `semprec-transcribe-${randomUUID()}`);
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
    // Absent, not "0" or "N/A", when the container's header carries no duration — most commonly a
    // streamed WebM/Matroska recording such as browser `MediaRecorder` output.
    duration: z.string().optional(),
    tags: z.object({ creation_time: z.string().optional() }).partial().optional(),
  }),
});

const creationTimeTagSchema = z.iso.datetime({ offset: true });

/**
 * `creation_time` is free text from an uploaded file, bound for a `date` property that views cast
 * to `timestamptz`. Only an ISO 8601 timestamp with an explicit zone whose UTC instant falls in
 * years 1–9999 is kept — outside that range lies either year 0, which Postgres does not have, or
 * a year `toISOString()` writes in an expanded `+010000` form Postgres cannot parse. The value is
 * re-serialized in the canonical `toISOString()` form every other stored `date` uses; anything
 * else counts as no tag at all.
 */
export function parseCreationTime(tag: string | undefined): string | null {
  if (tag === undefined || !creationTimeTagSchema.safeParse(tag).success) return null;
  const instant = new Date(tag);
  const year = instant.getUTCFullYear();
  return year >= 1 && year <= 9999 ? instant.toISOString() : null;
}

/**
 * Runs `ffprobe` with `args` and resolves to what it printed on stdout. Rejects with a `MediaToolError` when it exits
 * unsuccessfully, which a kill at `FFPROBE_TIMEOUT_MS` is too, and with the spawn error when it cannot start.
 */
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

/** Runs `ffprobe` on a local file and reads back its duration and (if present and valid) `creation_time` tag. */
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
  /** The picture's width as it is shown, that is after the orientation its file records is applied. */
  width: number;
  /** The picture's height as it is shown. */
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
 * Runs `ffprobe` on a local image file (JPEG or PNG) and reads back its size as the picture is shown: the stored size,
 * swapped when the file's orientation turns it a quarter turn, which is how `renderImageJpeg` renders it as well. A file
 * `ffprobe` cannot read, one with no picture stream, one of more than `MAX_IMAGE_PIXELS` pixels (`ffprobe` reports it
 * with no size) and output it did not write in the expected shape are all a `MediaToolError`.
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

/**
 * Falls back to the normalized Ogg Opus output's own duration when the source container had none
 * (see `MediaProbeResult.durationSeconds`) — normalization always produces a format that carries
 * one, unlike some streamed source containers (e.g. WebM/Matroska from a browser `MediaRecorder`).
 * Downloads the already-uploaded output back to a temp file to probe it, since `probeMedia` needs
 * a seekable local file.
 */
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

/**
 * Extracts `[startSeconds, startSeconds + durationSeconds)` of a local (already-normalized) audio
 * file as its own standalone Ogg Opus byte buffer, for step 3's per-chunk ASR calls. `-ss` before
 * `-i` seeks the input directly rather than decoding and discarding every sample before the chunk,
 * which matters once `startSeconds` is deep into a multi-hour recording.
 */
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

/**
 * Normalizes a local input file to 16 kHz mono Opus (audio/ogg) at 16 kb/s — about 7 MB per hour
 * of audio — and streams the result into `blobStorage` under `storageKey`.
 */
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
 * Renders a player-friendly copy of a local input file — AAC in an MP4 container (audio/mp4),
 * mono, 64 kb/s — from the same decoded input as `normalizeAudio` and with the same `start_time`
 * handling, so both share one timeline and a segment's `startsAt` seeks to the same word in either.
 * The MP4 is fragmented because it is streamed to storage, where a plain MP4 would need a seekable
 * output to place its index.
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

/**
 * Runs `ffmpeg -i inputPath -vn <outputArgs>` and streams its stdout straight into `blobStorage`
 * under `storageKey`, with no intermediate output file. `-vn` drops any video stream and keeps only
 * its audio. The audio timestamps are rebased to the first decoded sample for both outputs.
 * On failure, whatever already reached `storageKey`
 * is deleted before the error propagates.
 */
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
 * Renders a local image file (JPEG or PNG) as a JPEG whose long side is at most `longSidePixels` and streams it into
 * `blobStorage` under `storageKey`. A picture already within that size keeps its size, it is never enlarged, and the
 * aspect ratio is kept. The orientation the file records is applied, so the result is upright, as `probeImage` reports its
 * size. A picture of more than `MAX_IMAGE_PIXELS` pixels is not decoded: `ffmpeg` fails and that is a `MediaToolError`.
 * The output is checked before it is returned: it must be non-empty and begin with the JPEG signature, otherwise
 * it is deleted and a `MediaToolError` is thrown, as on any failure of `ffmpeg` or of the storage write.
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

/**
 * Runs `ffmpeg` with `args`, which must end in `pipe:1`, and streams its stdout into `blobStorage` under `storageKey`.
 * `ffmpeg` is killed after `FFMPEG_TIMEOUT_MS`. On any failure, whatever already reached `storageKey` is deleted
 * with `discard` before the error propagates.
 */
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
