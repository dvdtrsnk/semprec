import type { Readable } from "node:stream";
import { BlobReadCleanupError, settleBlobReadStream, type BlobReadCleanupBudget } from "@semprec/shared";
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

function isMissingFileError(err: unknown): err is Error {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

interface CleanupBudget extends BlobReadCleanupBudget {
  lastMissing?: Error;
}

interface OpenedStream {
  stream: Readable;
  openingErrors: unknown[];
  detachOpeningObserver: () => void;
}

async function waitForReadable(stream: Readable, signal: AbortSignal | undefined): Promise<void> {
  const outcome = await new Promise<{ ok: true } | { ok: false; error: unknown }>((resolve) => {
    const remove = () => {
      stream.off("readable", readable);
      stream.off("error", error);
      stream.off("close", closed);
      signal?.removeEventListener("abort", aborted);
    };
    const readable = () => {
      remove();
      resolve({ ok: true });
    };
    const error = (value: unknown) => {
      remove();
      resolve({ ok: false, error: value });
    };
    const closed = () => error(stream.errored ?? new Error("Blob stream closed before becoming readable"));
    const aborted = () => {
      const value = Object.assign(new Error("The operation was aborted", { cause: signal?.reason }), {
        name: "AbortError",
        code: "ABORT_ERR",
      });
      error(value);
    };
    stream.once("readable", readable);
    stream.once("error", error);
    stream.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else if (stream.closed) closed();
  });
  if (!outcome.ok) throw outcome.error;
}

/** Opens `storageKey` in one root, or `null` when its file does not exist. Waits for the first `readable` event so a missing file is known before any header is written; any other read error propagates. */
async function openIn(
  storage: BlobStorageWriter,
  storageKey: string,
  range: OpenBlobFromRootsInput["range"],
  signal: AbortSignal | undefined,
  budget: CleanupBudget,
): Promise<OpenedStream | null> {
  signal?.throwIfAborted();
  const stream = storage.readStream(storageKey, range);
  const openingErrors: unknown[] = [];
  const openingError = (error: unknown) => {
    if (openingErrors.length < 2 && !openingErrors.some((entry) => entry === error)) openingErrors.push(error);
  };
  const detachOpeningObserver = () => stream.off("error", openingError);
  stream.on("error", openingError);
  try {
    await waitForReadable(stream, signal);
    if (openingErrors.length) throw openingErrors[0];
    signal?.throwIfAborted();
    if (stream.closed || stream.destroyed)
      throw stream.errored ?? new Error("Blob stream closed before ownership transfer");
  } catch (err) {
    await settleBlobReadStream(stream, budget, { error: err }, openingErrors, detachOpeningObserver);
    if (isMissingFileError(err)) {
      signal?.throwIfAborted();
      budget.lastMissing = err;
      return null;
    }
    throw err;
  }
  return { stream, openingErrors, detachOpeningObserver };
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
  const budget: CleanupBudget = {};
  let opened = await openIn(input.primary, input.storageKey, input.range, input.signal, budget);
  if (!opened) {
    input.signal?.throwIfAborted();
    if (budget.deadline !== undefined && performance.now() >= budget.deadline)
      throw new BlobReadCleanupError(
        [budget.lastMissing, new Error("Blob stream cleanup deadline expired before fallback")],
        { cause: budget.lastMissing },
      );
    opened = await openIn(input.alternate, input.storageKey, input.range, input.signal, budget);
  }
  if (!opened) {
    input.signal?.throwIfAborted();
    return null;
  }
  const { stream, openingErrors, detachOpeningObserver } = opened;
  try {
    input.signal?.throwIfAborted();
    if (openingErrors.length) throw openingErrors[0];
    if (stream.closed || stream.destroyed)
      throw stream.errored ?? new Error("Blob stream closed before ownership transfer");
    detachOpeningObserver();
    return stream;
  } catch (err) {
    await settleBlobReadStream(stream, budget, { error: err }, openingErrors, detachOpeningObserver);
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
