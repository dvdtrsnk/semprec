import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { BlobStorageWriter } from "@semprec/data";

/**
 * The one and only place in the codebase that shells out to `ffmpeg`/`ffprobe` (issue #246's
 * acceptance criterion: "Only `semprec-transcribe` invokes `ffmpeg`/`ffprobe`; no other package
 * or process references them").
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
  durationSeconds: number;
  /** `null` when the source carries no `creation_time` container tag — the caller falls back to another timestamp. */
  creationTime: string | null;
}

function describeExit(command: string, code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  return new Error(`${command} exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}: ${stderr}`);
}

/**
 * Downloads the source blob to a local temp file so both `ffprobe` (which needs to seek for an
 * accurate duration on formats like mp4, whose moov atom is often at the end) and `ffmpeg`'s own
 * input read from a real seekable file rather than a one-shot pipe.
 */
export async function downloadToTempFile(blobStorage: BlobStorageWriter, storageKey: string): Promise<string> {
  const path = join(tmpdir(), `semprec-transcribe-${randomUUID()}`);
  await pipeline(blobStorage.readStream(storageKey), createWriteStream(path));
  return path;
}

export async function removeTempFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

const ffprobeOutputSchema = z.object({
  format: z.object({
    duration: z.string(),
    tags: z.object({ creation_time: z.string().optional() }).partial().optional(),
  }),
});

/** Runs `ffprobe` on a local file and reads back its duration and (if present) `creation_time` tag. */
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
          const durationSeconds = Number.parseFloat(parsed.format.duration);
          if (!Number.isFinite(durationSeconds)) {
            reject(new Error(`ffprobe reported a non-numeric duration: '${parsed.format.duration}'`));
            return;
          }
          resolve({ durationSeconds, creationTime: parsed.format.tags?.creation_time ?? null });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });
}

/**
 * Normalizes a local input file to 16 kHz mono Opus (audio/ogg) and streams the result straight
 * into `blobStorage` under `storageKey` — no intermediate output file. For a video input, `-vn`
 * drops the video stream and keeps only its audio, so a single command covers both the audio and
 * video acceptance criteria.
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
    if (exitResult.status === "rejected") {
      await blobStorage.delete(storageKey).catch(() => {});
      throw exitResult.reason;
    }
    if (writeResult.status === "rejected") throw writeResult.reason;
    return { storageKey, byteSize: writeResult.value.byteSize, contentHash: writeResult.value.contentHash };
  } finally {
    clearTimeout(timer);
  }
}
