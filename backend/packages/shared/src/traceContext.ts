import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Cross-process correlation context. `traceId` is minted at whichever entry point starts a flow (HTTP/WS request,
 * scheduler tick, agent run, mail-sync cycle) and carried via `AsyncLocalStorage` in-process, the `@semprec/queue`
 * envelope across the queue, and the `x-trace-id` header to the AI gateway. Other fields are bound as they become
 * known.
 */
export interface TraceContext {
  traceId: string;
  agentRunId?: string;
  jobName?: string;
  jobId?: string;
  mailboxId?: string;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

export function mintTraceId(): string {
  return randomUUID();
}

export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

export function getTraceId(): string | undefined {
  return traceContextStorage.getStore()?.traceId;
}

/**
 * Runs `fn` with `bindings` merged onto the active context (concurrent branches never see each other's bindings).
 * `traceId` is an explicit `bindings.traceId`, else the active trace, else a fresh one: an entry point with no trace
 * starts one, while a nested call extends the same trace, so one cross-process flow keeps one traceId.
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
