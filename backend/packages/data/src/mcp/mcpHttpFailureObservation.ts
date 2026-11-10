import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type AuthStatus = 401 | 403;
type Operation = { active: boolean; failures: WeakMap<Error, AuthStatus> };
type Attempt = {
  operation: Operation;
  method: string;
  id: string | number | undefined;
  hasId: boolean;
  matched: number;
  status: AuthStatus | undefined;
  emitted: WeakRef<Error> | undefined;
  child: boolean;
};

export interface McpHttpObservation {
  run<T>(work: () => Promise<T>): Promise<T>;
  status(error: unknown): AuthStatus | undefined;
  close(): void;
}

/** A private observer for the pinned SDK's direct terminal SSE POST error branches. */
export function createMcpHttpFailureObserver(hasAuthProvider: boolean) {
  const operations = new AsyncLocalStorage<Operation>();
  const attempts = new AsyncLocalStorage<Attempt>();

  function matchesRequest(init: RequestInit | undefined, attempt: Attempt): boolean {
    if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return false;
    try {
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || Array.isArray(body) || !("method" in body)) return false;
      if (body.method !== attempt.method || "id" in body !== attempt.hasId) return false;
      return !attempt.hasId || ("id" in body && body.id === attempt.id);
    } catch {
      return false;
    }
  }

  function wrapFetch(fetch: FetchLike): FetchLike {
    return async (input, init) => {
      const attempt = attempts.getStore();
      const matched = attempt !== undefined && attempt.operation.active && matchesRequest(init, attempt);
      if (matched) {
        attempt.matched += 1;
        attempt.status = undefined;
      }
      try {
        const response = await fetch(input, init);
        if (
          matched &&
          attempt.operation.active &&
          (response.status === 403 || (response.status === 401 && !hasAuthProvider))
        ) {
          attempt.status = response.status;
        }
        return response;
      } catch (error) {
        if (matched) attempt.status = undefined;
        throw error;
      }
    };
  }

  function install(transport: Transport): void {
    const previousError = transport.onerror;
    transport.onerror = (error) => {
      const attempt = attempts.getStore();
      if (attempt?.operation.active && error instanceof Error) attempt.emitted = new WeakRef(error);
      previousError?.(error);
    };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      const operation = operations.getStore();
      if (!operation?.active || !("method" in message) || typeof message.method !== "string")
        return send(message, options);
      const method = message.method;
      if (method !== "initialize" && method !== "notifications/initialized" && method !== "tools/call")
        return send(message, options);
      const hasId = "id" in message;
      const id = hasId ? message.id : undefined;
      if (
        (hasId && typeof id !== "string" && typeof id !== "number") ||
        (!hasId && method !== "notifications/initialized") ||
        (hasId && method === "notifications/initialized")
      )
        return send(message, options);
      const parent = attempts.getStore();
      if (parent?.operation === operation) parent.child = true;
      const attempt: Attempt = {
        operation,
        method,
        id,
        hasId,
        matched: 0,
        status: undefined,
        emitted: undefined,
        child: false,
      };
      return attempts.run(attempt, async () => {
        try {
          await send(message, options);
        } catch (error) {
          if (
            operation.active &&
            !attempt.child &&
            attempt.matched === 1 &&
            attempt.status !== undefined &&
            error instanceof Error &&
            error === attempt.emitted?.deref()
          ) {
            operation.failures.set(error, attempt.status);
          }
          throw error;
        }
      });
    };
  }

  function begin(): McpHttpObservation {
    const operation: Operation = { active: true, failures: new WeakMap() };
    return {
      run: (work) => operations.run(operation, work),
      status: (error) => {
        if (!operation.active || !(error instanceof Error)) return undefined;
        const status = operation.failures.get(error);
        operation.failures.delete(error);
        return status;
      },
      close: () => {
        operation.active = false;
      },
    };
  }
  return { begin, install, wrapFetch };
}
