import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Issue #167's cross-process correlation context. `traceId` is minted once at whichever entry
 * point starts a flow (HTTP/WS request, scheduler tick, new agent run, mail-sync cycle) and
 * carried through every downstream call within that process via `AsyncLocalStorage`, across the
 * queue via the envelope in `@semprec/queue`, and to the AI gateway via the `x-trace-id` header.
 * The other fields are optional enrichment, bound as they become known.
 */
export interface TraceContext {
  traceId: string;
  agentRunId?: string;
  jobName?: string;
  jobId?: string;
  mailboxId?: string;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

/** Mints a fresh trace id. Every entry point that starts a new flow uses this. */
export function mintTraceId(): string {
  return randomUUID();
}

/** The active trace context, or `undefined` outside any `withTraceContext` call. */
export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

/** The active trace id, or `undefined` outside any `withTraceContext` call. */
export function getTraceId(): string | undefined {
  return traceContextStorage.getStore()?.traceId;
}

/**
 * Runs `fn` with a trace context in scope: `bindings` are merged onto whatever context is
 * already active (concurrent `AsyncLocalStorage` branches never see each other's bindings), and
 * `traceId` resolves to, in order, an explicit `bindings.traceId`, the already-active trace, or a
 * freshly minted one. That single rule makes this the one function every entry point and every
 * enrichment point (binding `agentRunId`, `mailboxId`, ...) calls: a request/tick/job with no
 * active trace starts one, while a nested call (an agent run started from within a heartbeat job)
 * extends the same trace instead of starting a new one — issue #167's "one cross-process flow
 * retains one traceId".
 */
export function withTraceContext<T>(bindings: Partial<TraceContext>, fn: () => T): T {
  const current = traceContextStorage.getStore();
  const next: TraceContext = {
    ...current,
    ...bindings,
    traceId: bindings.traceId ?? current?.traceId ?? mintTraceId(),
  };
  return traceContextStorage.run(next, fn);
}
