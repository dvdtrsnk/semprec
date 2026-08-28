import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

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
export interface BlobStorageWriter {
  writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }>;
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

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const path = join(this.baseDir, storageKey);
    await mkdir(dirname(path), { recursive: true });

    const hash = createHash("sha256");
    let byteSize = 0;
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      byteSize += chunk.length;
    });

    await pipeline(source, createWriteStream(path));
    return { byteSize, contentHash: hash.digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    await rm(join(this.baseDir, storageKey), { force: true });
  }
}
