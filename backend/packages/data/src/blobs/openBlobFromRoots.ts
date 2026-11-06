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

function isMissingFileError(err: unknown): err is Error {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

const CLEANUP_LIMIT_MS = 5_000;
const CLOSED_POLL_MS = 10;

interface CleanupBudget {
  deadline?: number;
  lastMissing?: Error;
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
    const closed = () => error(new Error("Blob stream closed before becoming readable"));
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

/** Observe closure of a stream retained by this helper before allowing fallback or failure. */
async function closeOwnedStream(
  stream: Readable,
  primary: unknown,
  budget: CleanupBudget,
  openingErrors: readonly unknown[] = [],
  detachOpeningObserver: () => void = () => {},
): Promise<void> {
  const deadline = (budget.deadline ??= performance.now() + CLEANUP_LIMIT_MS);
  const failures: unknown[] = openingErrors.filter((error) => error !== primary);
  let firstAsyncError: unknown;
  let hasAsyncError = false;
  let settled = false;
  const lateObservation: { count: number; hasFirst: boolean; first: unknown; category: "error" | "other" } = {
    count: 0,
    hasFirst: false,
    first: undefined,
    category: "other",
  };
  let closureObserved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let continuation: ReturnType<typeof setImmediate> | undefined;
  let finish!: (closed: boolean) => void;
  const observed = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const remove = () => {
    stream.off("close", onClose);
    stream.off("error", onError);
  };
  const complete = (closed: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (continuation) clearImmediate(continuation);
    if (closed) remove();
    finish(closed);
  };
  const onClose = () => {
    if (settled) {
      remove();
      return;
    }
    complete(closureObserved || performance.now() < deadline);
    remove();
  };
  const onError = (error: unknown) => {
    if (settled) {
      lateObservation.count = Math.min(lateObservation.count + 1, 1_000_000);
      if (!lateObservation.hasFirst && error !== primary) {
        lateObservation.hasFirst = true;
        lateObservation.first = error;
        lateObservation.category = error instanceof Error ? "error" : "other";
      }
      return;
    }
    if (error !== primary && !hasAsyncError) {
      hasAsyncError = true;
      firstAsyncError = error;
    }
  };
  const check = () => {
    const now = performance.now();
    if (now >= deadline) {
      complete(false);
      return;
    }
    if (stream.closed) {
      closureObserved = true;
      // Node may publish an already-recorded destroy error before its close notification.
      // Keep the error observer through that event-loop turn, including emitClose:false.
      continuation = setImmediate(() => complete(true));
      return;
    }
    timer = setTimeout(check, Math.min(CLOSED_POLL_MS, Math.max(0, deadline - now)));
  };
  stream.on("close", onClose);
  stream.on("error", onError);
  detachOpeningObserver();
  if (!stream.closed && !stream.destroyed) {
    try {
      stream.destroy();
    } catch (error) {
      if (error !== primary) failures.push(error);
    }
  }
  if (!settled) check();
  const closed = await observed;
  if (hasAsyncError && !failures.some((error) => error === firstAsyncError)) failures.push(firstAsyncError);
  if (!closed) failures.push(new Error("Blob stream cleanup closure was not observed within its deadline"));
  if (failures.length)
    throw new AggregateError([primary, ...failures], "Blob stream cleanup failed", { cause: primary });
}

/** Opens `storageKey` in one root, or `null` when its file does not exist. Waits for the first `readable` event so a missing file is known before any header is written; any other read error propagates. */
async function openIn(
  storage: BlobStorageWriter,
  storageKey: string,
  range: OpenBlobFromRootsInput["range"],
  signal: AbortSignal | undefined,
  budget: CleanupBudget,
): Promise<Readable | null> {
  signal?.throwIfAborted();
  const stream = storage.readStream(storageKey, range);
  const openingErrors: unknown[] = [];
  const openingError = (error: unknown) => {
    if (openingErrors.length < 2 && !openingErrors.some((entry) => entry === error)) openingErrors.push(error);
  };
  stream.on("error", openingError);
  try {
    await waitForReadable(stream, signal);
    if (openingErrors.length) throw openingErrors[0];
    signal?.throwIfAborted();
  } catch (err) {
    await closeOwnedStream(stream, err, budget, openingErrors, () => stream.off("error", openingError));
    if (isMissingFileError(err)) {
      signal?.throwIfAborted();
      budget.lastMissing = err;
      if (budget.deadline !== undefined && performance.now() >= budget.deadline)
        throw new AggregateError(
          [err, new Error("Blob stream cleanup deadline expired before fallback")],
          "Blob cleanup deadline expired before fallback",
          { cause: err },
        );
      return null;
    }
    throw err;
  } finally {
    stream.off("error", openingError);
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
  const budget: CleanupBudget = {};
  let stream = await openIn(input.primary, input.storageKey, input.range, input.signal, budget);
  if (!stream) {
    input.signal?.throwIfAborted();
    if (budget.deadline !== undefined && performance.now() >= budget.deadline)
      throw new AggregateError(
        [budget.lastMissing, new Error("Blob stream cleanup deadline expired before fallback")],
        "Blob cleanup deadline expired before fallback",
        { cause: budget.lastMissing },
      );
    stream = await openIn(input.alternate, input.storageKey, input.range, input.signal, budget);
  }
  if (!stream) {
    input.signal?.throwIfAborted();
    return null;
  }
  try {
    input.signal?.throwIfAborted();
    return stream;
  } catch (err) {
    await closeOwnedStream(stream, err, budget);
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
