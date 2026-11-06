import { once } from "node:events";
import type { Readable } from "node:stream";
import type { BlobStorageWriter } from "../mail/blobStorage.js";

export type BlobRootName = "files" | "mailAttachments";

export interface OpenBlobFromRootsInput {
  primary: BlobStorageWriter;
  alternate: BlobStorageWriter;
  storageKey: string;
  signal?: AbortSignal;
  /** Inclusive byte range, forwarded to whichever root serves the file. */
  range?: { start: number; end: number };
}

interface BlobRootQueryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/** Opens `storageKey` in one root, or `null` when its file does not exist. Waits for the first `readable` event so a missing file is known before any header is written; any other read error propagates. */
async function openIn(
  storage: BlobStorageWriter,
  storageKey: string,
  range: OpenBlobFromRootsInput["range"],
  signal: AbortSignal | undefined,
): Promise<Readable | null> {
  signal?.throwIfAborted();
  const stream = storage.readStream(storageKey, range);
  try {
    await once(stream, "readable", { signal });
    signal?.throwIfAborted();
  } catch (err) {
    try {
      stream.destroy();
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], "Blob open and stream cleanup failed", { cause: err });
    }
    if (isMissingFileError(err)) {
      signal?.throwIfAborted();
      return null;
    }
    throw err;
  }
  return stream;
}

/**
 * Opens a blob's bytes from whichever storage root holds them. Content-hash deduplication lets an
 * upload and a mail attachment share one blob, so the bytes can lie in either root (see ADR
 * 2026-10-18-tenant-export-cross-root-blob-lookup). Tries `primary`, and only on `ENOENT` the same
 * key in `alternate`; any other read error is thrown without a second attempt. `null` when neither
 * root has the file.
 */
export async function openBlobFromRoots(input: OpenBlobFromRootsInput): Promise<Readable | null> {
  input.signal?.throwIfAborted();
  let stream = await openIn(input.primary, input.storageKey, input.range, input.signal);
  if (!stream) {
    input.signal?.throwIfAborted();
    stream = await openIn(input.alternate, input.storageKey, input.range, input.signal);
  }
  if (!stream) {
    input.signal?.throwIfAborted();
    return null;
  }
  try {
    input.signal?.throwIfAborted();
    return stream;
  } catch (err) {
    try {
      stream.destroy();
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], "Blob transfer and stream cleanup failed", { cause: err });
    }
    throw err;
  }
}

/**
 * The root to try first for a blob: the mail attachments root when the blob has a `mail_attachments`
 * row for the tenant in scope, otherwise the files root.
 */
export async function primaryRootForBlob(client: BlobRootQueryable, blobId: string): Promise<BlobRootName> {
  const { rows } = await client.query<{ in_mail: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM mail_attachments m
                     WHERE m.blob_id = $1 AND m.tenant_id = app_current_tenant()) AS in_mail`,
    [blobId],
  );
  return rows[0]?.in_mail ? "mailAttachments" : "files";
}
