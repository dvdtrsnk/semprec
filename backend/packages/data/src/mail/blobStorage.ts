import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough, Transform, type Readable } from "node:stream";
import { logger } from "./logger.js";

/**
 * Where an attachment's bytes actually land — swappable so a later ops issue can supply a
 * MinIO/S3-backed writer without touching any caller (`mail/attachments.ts`, the IMAP
 * adapter's large-attachment path). `writeStream` is the one and only write path: every
 * caller (buffered content from `mailparser`, or a live IMAP download stream) goes through
 * `Readable.from(...)`/the stream itself into this same function, so "memory-safe" is a
 * structural property of the writer, not something each call site has to get right
 * separately. Streamed via `pipeline()` (not bare `.pipe()` — a documented imapflow bug,
 * #65, truncates the write under backpressure), computing size/content hash incrementally
 * as bytes flow rather than after buffering the whole attachment.
 *
 * The contract every `writeStream` implementation must follow is on `BlobStorageWriter.writeStream`.
 */
export interface WriteStreamOptions {
  /**
   * Issue #158's streamed-upload cap: the write aborts (and any bytes already flushed for this
   * key are removed) the moment the byte count exceeds this, so an unknown/chunked-length request
   * body — or a `Content-Length` header that lied — can't bypass the limit by simply omitting or
   * understating it.
   */
  maxBytes?: number;
}

/** Raised by `writeStream` when `options.maxBytes` is exceeded — distinct from a plain I/O error so a caller can map it to a 413 without inspecting the message. */
export class MaxBytesExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Stream exceeded the ${maxBytes}-byte limit`);
    this.name = "MaxBytesExceededError";
  }
}

export interface BlobStorageWriter {
  /**
   * Contract for every implementation
   * (`docs/adr/2026-11-15-a-blob-writer-consumes-its-source-from-the-tick-it-is-called.md`): it consumes
   * `source` and observes its errors from the tick it is called, before its first `await`, so a caller may
   * hand over a producer that blocks on a full pipe or can fail (a child process's stdout, a request body
   * that gets aborted) without having read it first. Asynchronous preparation (a directory, credentials, a
   * multipart upload) runs while the source is consumed into a bounded buffer, or after the pipeline is
   * attached. When the preparation or the write fails, the implementation destroys `source`, removes the
   * partial bytes and rejects with the first error.
   */
  writeStream(
    storageKey: string,
    source: Readable,
    options?: WriteStreamOptions,
  ): Promise<{ byteSize: number; contentHash: string }>;
  /** Removes bytes written under a key that turned out to be an unneeded duplicate — see `mail/attachments.ts`'s content-hash dedup, which writes before it can know whether `findOrCreateBlob` will keep or discard that write. */
  delete(storageKey: string): Promise<void>;
  /** Opens a read stream for a previously written key — the whole object, or (issue #158) a single inclusive byte range for `GET /api/blobs/:id`'s Range support. */
  readStream(storageKey: string, range?: { start: number; end: number }): Readable;
}

const TEST_BLOB_STORAGE_DIRS = {
  FILES_STORAGE_DIR: "/tmp/semprec-files",
  MAIL_ATTACHMENTS_DIR: "/tmp/semprec-mail-attachments",
} as const;

/**
 * Issue #645: the base directory a `LocalFsBlobStorageWriter` default writes under. The variable's
 * value when set and non-empty; under `NODE_ENV=test` (vitest) the old `/tmp` path, so the test
 * suites need no configuration; anywhere else it throws naming the variable — `/tmp` is cleaned on
 * reboot while the `blobs` rows referencing the bytes survive, so a deployment must not fall back
 * to it silently. `deploy/provision.sh` creates the `/opt/semprec/data/...` directories the
 * `.env.example` values point at.
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

/** The upload limit in megabytes when `MAX_FILE_SIZE_MB` is not set. */
export const DEFAULT_MAX_FILE_SIZE_MB = 100;

/**
 * The upload limit of the deployment, `MAX_FILE_SIZE_MB` of `env`, in bytes (a megabyte is 1024 * 1024 bytes), or
 * `DEFAULT_MAX_FILE_SIZE_MB` when it is absent. It is read here, in one place, for every entry point that enforces it:
 * `POST /api/files` and the mail draft routes through the composition root of `semprec-api` (`serve.ts`) and the agent
 * forward of `mailAgentTools.ts`, so that one operation has one limit whoever starts it. A value that is not a positive
 * finite number is a deployment error and throws, so a process never runs with an unreadable limit.
 */
export function readMaxFileSizeBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const megabytes = Number(env.MAX_FILE_SIZE_MB ?? String(DEFAULT_MAX_FILE_SIZE_MB));
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`MAX_FILE_SIZE_MB is not a valid positive number: ${env.MAX_FILE_SIZE_MB}`);
  }
  return megabytes * 1024 * 1024;
}

/**
 * Local-filesystem default, adequate for a single self-hosted server before object storage
 * (issue #40) is provisioned — the same "adequate for one deployment, not over-engineered"
 * judgment call the credentials master key makes.
 *
 * `writeStream` attaches to its source before it creates the key's directory: the source is piped
 * through the hashing and size-counting `Transform` into a `PassThrough`, and that intake chain holds
 * at most its default high-water marks while the directory is created, so a producer that is faster
 * than the disk is paused instead of being read late. Only then is the staged stream piped into the
 * file. A failure at either step destroys the staging stream with the failure, which destroys the
 * source with that same error, and removes whatever was written.
 */
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
    // A separate `source.on('data', ...)` listener would race `pipeline()`'s own consumption:
    // adding a 'data' listener puts a Readable into flowing mode immediately, which can start
    // emitting chunks before `pipeline()` itself attaches downstream — chunks emitted in that
    // gap would reach this listener but the file write could still miss bytes depending on the
    // stream's exact scheduling. A Transform spliced directly into the pipeline is driven by
    // `pipeline()` itself, so hashing/size accounting can never see a different set of bytes
    // than what actually gets written.
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

    // The source is attached here, before the first `await`: a producer that is not read yet (a
    // child's stdout, a stream that can fail) must not sit unobserved while the directory is created.
    // `staged` holds what has been read until the file is open; the default high-water marks of the
    // chain are what bounds it.
    const staged = new PassThrough();
    const intake = pipeline(source, hasher, staged);
    // The outcome of `intake` reaches the caller through `staged`, which the file pipeline reads, and
    // through the `await intake` below; this handler only marks a rejection that happens before either
    // of them is waiting as observed.
    intake.catch(() => undefined);

    try {
      await mkdir(dirname(path), { recursive: true });
      await pipeline(staged, createWriteStream(path));
      await intake;
    } catch (err) {
      // Destroying `staged` with the failure makes `intake` destroy the source and the hasher with that
      // same error. A bare `destroy()` would destroy the source with ERR_STREAM_PREMATURE_CLOSE, and a
      // caller that observes its own source would report that instead of the storage error.
      staged.destroy(err instanceof Error ? err : new Error("Blob write failed", { cause: err }));
      // `intake` settles once the source is destroyed; its rejection repeats `err` and must not replace it.
      await intake.catch(() => undefined);
      // The file pipeline has already destroyed the write stream by now, but whatever it had already
      // flushed to disk is still there — issue #158's "abort and clean partial state on overflow"
      // requires a failed/aborted write to leave nothing behind, not just stop growing.
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
