import type { Readable } from "node:stream";

const CLEANUP_LIMIT_MS = 5_000;
const CLOSED_POLL_MS = 10;

export interface BlobReadCleanupBudget {
  deadline?: number;
}

export class BlobReadCleanupError extends AggregateError {
  constructor(errors: unknown[], options: ErrorOptions) {
    super(errors, "Blob stream cleanup failed", options);
    this.name = "BlobReadCleanupError";
  }
}

/** Observe closure of an owned blob-read stream within its cleanup budget. */
export async function settleBlobReadStream(
  stream: Readable,
  budget: BlobReadCleanupBudget,
  primary?: { error: unknown },
  openingErrors: readonly unknown[] = [],
  detachOpeningObserver: () => void = () => {},
): Promise<void> {
  const deadline = (budget.deadline ??= performance.now() + CLEANUP_LIMIT_MS);
  const failures: unknown[] = openingErrors.filter((error) => primary === undefined || error !== primary.error);
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
      if (!lateObservation.hasFirst && (primary === undefined || error !== primary.error)) {
        lateObservation.hasFirst = true;
        lateObservation.first = error;
        lateObservation.category = error instanceof Error ? "error" : "other";
      }
      return;
    }
    if ((primary === undefined || error !== primary.error) && !hasAsyncError) {
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
      if (primary === undefined || error !== primary.error) failures.push(error);
    }
  }
  if (!settled) check();
  const closed = await observed;
  if (hasAsyncError && !failures.some((error) => error === firstAsyncError)) failures.push(firstAsyncError);
  if (!closed) failures.push(new Error("Blob stream cleanup closure was not observed within its deadline"));
  if (failures.length)
    throw new BlobReadCleanupError([...(primary === undefined ? [] : [primary.error]), ...failures], {
      cause: primary === undefined ? failures[0] : primary.error,
    });
}
