import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
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
/** Above any real-world provider attachment limit (Gmail 25MB, Outlook ~20-25MB, iCloud 20MB) with generous headroom — a ceiling against a malicious/misbehaving server, not a normal-case limit. */
export const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;

export interface BlobStorageWriter {
  writeStream(storageKey: string, source: Readable, maxBytes?: number): Promise<{ byteSize: number; contentHash: string }>;
  /** Removes bytes written under a key that turned out to be an unneeded duplicate — see `mail/attachments.ts`'s content-hash dedup, which writes before it can know whether `findOrCreateBlob` will keep or discard that write. */
  delete(storageKey: string): Promise<void>;
}

/**
 * Local-filesystem default, adequate for a single self-hosted server before object storage
 * (issue #40) is provisioned — the same "adequate for one deployment, not over-engineered"
 * judgment call the credentials master key makes.
 */
export class LocalFsBlobStorageWriter implements BlobStorageWriter {
  constructor(private readonly baseDir: string) {}

  async writeStream(storageKey: string, source: Readable, maxBytes: number = MAX_ATTACHMENT_BYTES): Promise<{ byteSize: number; contentHash: string }> {
    const path = join(this.baseDir, storageKey);
    await mkdir(dirname(path), { recursive: true });

    const hash = createHash("sha256");
    let byteSize = 0;
    // A Transform in the pipeline itself (not a bare 'data' listener racing pipeline's own
    // consumption of `source`) ties hash/size accounting to exactly the bytes `pipeline`
    // actually forwarded — if the write side fails partway, `pipeline` rejects before this
    // function returns byteSize/contentHash at all, instead of the two ever silently
    // disagreeing about how much was written. Exceeding `maxBytes` throws (aborting the
    // pipeline) rather than silently truncating — imapflow's own `maxBytes` option on
    // `download()` truncates without error, which for a real attachment (unlike a body-text
    // preview) would mean handing the user a silently corrupted file instead of a clear
    // failure.
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > maxBytes) return callback(new Error(`Attachment exceeded ${maxBytes} bytes`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, hasher, createWriteStream(path));
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    await rm(join(this.baseDir, storageKey), { force: true });
  }
}
