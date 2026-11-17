import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { tenantBlobStorageKey } from "../blobs/blobsStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

export interface DownloadedLibraryCover {
  bytes: Uint8Array;
  mimeType: string;
  sourceUrl?: string;
}

export const MAX_LIBRARY_COVER_BYTES = 10 * 1024 * 1024;

export async function prepareLibraryCover(pool: Pool, storage: BlobStorageWriter, cover: DownloadedLibraryCover) {
  const storageKey = await tenantBlobStorageKey(pool, `blobs/${randomUUID()}`);
  const written = await storage.writeStream(storageKey, Readable.from([cover.bytes]), {
    maxBytes: MAX_LIBRARY_COVER_BYTES,
  });
  return { storageKey, mimeType: cover.mimeType, sourceUrl: cover.sourceUrl, ...written };
}

export async function disposeLibraryCover(storage: BlobStorageWriter, storageKey: string): Promise<void> {
  await storage.delete(storageKey);
}
