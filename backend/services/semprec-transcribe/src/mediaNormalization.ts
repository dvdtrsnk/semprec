import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

export interface NormalizedAudioResult {
  storageKey: string;
  byteSize: number;
  contentHash: string;
}

export interface MediaProbeResult {
  /** `null` when the container's `format.duration` is absent, e.g. a streamed WebM/Matroska recording — see `probeNormalizedDuration`. */
  durationSeconds: number | null;
  /** `null` when the source carries no usable `creation_time` container tag (see `parseCreationTime`) — the caller falls back to another timestamp. */
  creationTime: string | null;
}

function describeExit(command: string, code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  return new Error(`${command} exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}: ${stderr}`);
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
  } catch (err) {
    logger.warn({ ...fields, err }, message);
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

/** Runs `ffprobe` on a local file and reads back its duration and (if present and valid) `creation_time` tag. */
export function probeMedia(inputPath: string): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_entries", "format=duration:format_tags=creation_time", inputPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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
      finish(() => {
        try {
          const parsed = ffprobeOutputSchema.parse(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")));
          let durationSeconds: number | null = null;
          if (parsed.format.duration !== undefined) {
            durationSeconds = Number.parseFloat(parsed.format.duration);
            if (!Number.isFinite(durationSeconds)) {
              reject(new Error(`ffprobe reported a non-numeric duration: '${parsed.format.duration}'`));
              return;
            }
          }
          const tag = parsed.format.tags?.creation_time;
          const creationTime = parseCreationTime(tag);
          if (tag !== undefined && creationTime === null) {
            // The tag's own text is file content, not an identifier, so it stays out of the log.
            logger.warn({}, "Ignoring a creation_time tag that is not a usable timestamp");
          }
          resolve({ durationSeconds, creationTime });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });
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
    if (durationSeconds === null) throw new Error(`ffprobe reported no duration for normalized output '${storageKey}'`);
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
 * of audio — and streams the result straight into `blobStorage` under `storageKey`, with no
 * intermediate output file. For a video input, `-vn` drops the video stream and keeps only its
 * audio, so a single command covers both the audio and video acceptance criteria. On failure,
 * whatever already reached `storageKey` is deleted before the error propagates.
 */
export async function normalizeAudio(
  inputPath: string,
  blobStorage: BlobStorageWriter,
  storageKey: string,
): Promise<NormalizedAudioResult> {
  const child = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libopus",
      "-b:a",
      "16k",
      "-f",
      "ogg",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
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
      await discardStoredAudio(blobStorage, storageKey);
      throw writeResult.reason;
    }
    if (exitResult.status === "rejected") {
      await discardStoredAudio(blobStorage, storageKey);
      throw exitResult.reason;
    }
    return { storageKey, byteSize: writeResult.value.byteSize, contentHash: writeResult.value.contentHash };
  } finally {
    clearTimeout(timer);
  }
}
