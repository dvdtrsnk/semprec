import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough, Transform, type Readable } from "node:stream";
import { logger } from "./logger.js";

export interface WriteStreamOptions {
  /**
   * Counted on the stream itself, so a missing or lying `Content-Length` cannot bypass it. On
   * overflow the write aborts and flushed bytes are removed.
   */
  maxBytes?: number;
}

/** Distinct from an I/O error so a caller can map it to a 413. */
export class MaxBytesExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Stream exceeded the ${maxBytes}-byte limit`);
    this.name = "MaxBytesExceededError";
  }
}

export interface BlobStorageWriter {
  /**
   * Contract for every implementation: consume `source` and observe its errors from the tick it
   * is called, before the first `await`, so a caller may hand over a producer that blocks on a full
   * pipe or can fail. Async preparation runs while the source drains into a bounded buffer. On
   * failure, destroy `source`, remove partial bytes and reject with the first error.
   */
  writeStream(
    storageKey: string,
    source: Readable,
    options?: WriteStreamOptions,
  ): Promise<{ byteSize: number; contentHash: string }>;
  delete(storageKey: string): Promise<void>;
  /** `range` is inclusive (HTTP Range). */
  readStream(storageKey: string, range?: { start: number; end: number }): Readable;
}

const TEST_BLOB_STORAGE_DIRS = {
  FILES_STORAGE_DIR: "/tmp/alldots-files",
  MAIL_ATTACHMENTS_DIR: "/tmp/alldots-mail-attachments",
} as const;

/**
 * Falls back to `/tmp` only under `NODE_ENV=test`; elsewhere an unset variable throws, because
 * `/tmp` is cleaned on reboot while the `blobs` rows survive.
 */
export function resolveBlobStorageDir(envVarName: "FILES_STORAGE_DIR" | "MAIL_ATTACHMENTS_DIR"): string {
  const configured = process.env[envVarName];
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  if (process.env.NODE_ENV === "test") {
    return TEST_BLOB_STORAGE_DIRS[envVarName];
  }
  throw new Error(`${envVarName} is not set`);
}

export const DEFAULT_MAX_FILE_SIZE_MB = 100;

/**
 * `MAX_FILE_SIZE_MB` in bytes, read in one place so file uploads, mail draft routes and agent
 * forwards share one limit. An invalid value throws rather than running with no usable limit.
 */
export function readMaxFileSizeBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const megabytes = Number(env.MAX_FILE_SIZE_MB ?? String(DEFAULT_MAX_FILE_SIZE_MB));
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`MAX_FILE_SIZE_MB is not a valid positive number: ${env.MAX_FILE_SIZE_MB}`);
  }
  return megabytes * 1024 * 1024;
}

/** Local-filesystem writer for a single self-hosted server. */
export class LocalFsBlobStorageWriter implements BlobStorageWriter {
  constructor(private readonly baseDir: string) {}

  async writeStream(
    storageKey: string,
    source: Readable,
    options: WriteStreamOptions = {},
  ): Promise<{ byteSize: number; contentHash: string }> {
    const path = join(this.baseDir, storageKey);

    const hash = createHash("sha256");
    let byteSize = 0;
    // A Transform inside the pipeline, not a 'data' listener, so the hash and size always cover
    // exactly the bytes written.
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (options.maxBytes !== undefined && byteSize > options.maxBytes) {
          callback(new MaxBytesExceededError(options.maxBytes));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    // Attached before the first `await` (see the interface contract); the chain's default
    // high-water marks bound what `staged` holds until the file is open.
    const staged = new PassThrough();
    const intake = pipeline(source, hasher, staged);
    // Only marks an early rejection as observed; the outcome is still awaited below.
    intake.catch(() => undefined);

    try {
      await mkdir(dirname(path), { recursive: true });
      await pipeline(staged, createWriteStream(path));
      await intake;
    } catch (err) {
      // Destroy with the real error: a bare destroy() would surface ERR_STREAM_PREMATURE_CLOSE on
      // the source instead of the storage error.
      staged.destroy(err instanceof Error ? err : new Error("Blob write failed", { cause: err }));
      // Its rejection repeats `err` and must not replace it.
      await intake.catch(() => undefined);
      // A failed write must leave no partial bytes on disk.
      try {
        await this.delete(storageKey);
      } catch (cleanupError) {
        logger.error(
          { errorCategory: cleanupError instanceof Error ? "error" : "non_error" },
          "Failed to remove partial blob bytes",
        );
      }
      throw err;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    await rm(join(this.baseDir, storageKey), { force: true });
  }

  readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    const path = join(this.baseDir, storageKey);
    return range ? createReadStream(path, { start: range.start, end: range.end }) : createReadStream(path);
  }
}
