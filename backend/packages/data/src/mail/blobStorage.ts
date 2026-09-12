import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";

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

/**
 * Local-filesystem default, adequate for a single self-hosted server before object storage
 * (issue #40) is provisioned — the same "adequate for one deployment, not over-engineered"
 * judgment call the credentials master key makes.
 */
export class LocalFsBlobStorageWriter implements BlobStorageWriter {
  constructor(private readonly baseDir: string) {}

  async writeStream(
    storageKey: string,
    source: Readable,
    options: WriteStreamOptions = {},
  ): Promise<{ byteSize: number; contentHash: string }> {
    const path = join(this.baseDir, storageKey);
    await mkdir(dirname(path), { recursive: true });

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

    try {
      await pipeline(source, hasher, createWriteStream(path));
    } catch (err) {
      // `pipeline()` has already destroyed the write stream by the time its promise rejects, but
      // whatever it had already flushed to disk is still there — issue #158's "abort and clean
      // partial state on overflow" requires a failed/aborted write to leave nothing behind, not
      // just stop growing.
      await this.delete(storageKey);
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
