import type { Server } from "node:http";
import type { Pool } from "pg";
import type { ProcessHeartbeatHandle } from "@semprec/data";
import type { Logger } from "@semprec/shared";

/**
 * Derived, not chosen: the only caller of this service,
 * `backend/packages/ai-gateway-client/src/httpAiGatewayClient.ts`, sets `REQUEST_TIMEOUT_MS` to
 * this same value. A shorter drain would cut off exactly the paid-for provider call this issue
 * exists to protect, while the caller is still waiting for it. systemd's `DefaultTimeoutStopSec`
 * of 90 s already exceeds this, so no unit-file change is needed for this to work.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 60_000;

export const DRAIN_POLL_INTERVAL_MS = 50;

export const POOL_END_TIMEOUT_MS = 5_000;

export interface CreateGracefulShutdownOptions {
  server: Server;
  pool: Pool;
  heartbeat: ProcessHeartbeatHandle;
  logger: Logger;
  /** Defaults to `SHUTDOWN_DRAIN_TIMEOUT_MS`; exists only so a test can shrink the drain bound below `vitest.integration.config.ts`'s 30 s `testTimeout`. */
  drainTimeoutMs?: number;
}

/** Drains in-flight connections: resolves once `server.close()`'s callback fires, or once `drainTimeoutMs` elapses and `closeAllConnections()` forces it. */
function drainServer(server: Server, drainTimeoutMs: number, logger: Logger, signal: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const pollTimer = setInterval(() => {
      server.closeIdleConnections();
    }, DRAIN_POLL_INTERVAL_MS);

    const drainTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      server.closeAllConnections();
      resolve(true);
    }, drainTimeoutMs);

    server.close((err) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(drainTimer);
      if (err) logger.error({ err, signal }, "server.close() failed");
      resolve(false);
    });
  });
}

/** Ends `pool`, bounded by `POOL_END_TIMEOUT_MS` so a hung or unreachable database can never stall shutdown indefinitely. */
function endPool(pool: Pool, logger: Logger, signal: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const boundTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error({ signal }, "pool.end() did not settle within POOL_END_TIMEOUT_MS");
      resolve();
    }, POOL_END_TIMEOUT_MS);

    pool.end().then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(boundTimer);
        resolve();
      },
      (err: unknown) => {
        if (settled) {
          // The bound already won the race; this rejection must still be observed so it can
          // never become an unhandled rejection later.
          logger.error({ err, signal }, "pool.end() rejected after POOL_END_TIMEOUT_MS had already elapsed");
          return;
        }
        settled = true;
        clearTimeout(boundTimer);
        logger.error({ err, signal }, "pool.end() failed");
        resolve();
      },
    );
  });
}

/**
 * Builds this service's shutdown sequence: stop accepting new connections, drain in-flight
 * `/internal/complete` requests, stop the heartbeat only once the server is done serving, then
 * end the pool. See `docs/adr/2026-09-17-shutdown-ordering-with-late-heartbeat-stop.md` for why
 * the steps run in this order and why the heartbeat stops last rather than first.
 */
export function createGracefulShutdown(options: CreateGracefulShutdownOptions): (signal: string) => Promise<void> {
  const { server, pool, heartbeat, logger } = options;
  const drainTimeoutMs = options.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;

  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    logger.info({ signal }, "semprec-ai-gateway shutting down");

    const timedOut = await drainServer(server, drainTimeoutMs, logger, signal);

    heartbeat.stop();
    await endPool(pool, logger, signal);

    logger.info({ signal, timedOut }, "semprec-ai-gateway shutdown complete");
  }

  return function shutdown(signal: string): Promise<void> {
    shutdownPromise ??= runShutdown(signal);
    return shutdownPromise;
  };
}

/**
 * Wires both `SIGTERM` and `SIGINT` to the injected `shutdown`. Uses `on`, not `once`: `once`
 * removes the listener after the first signal, so a second SIGTERM during a drain of up to
 * `SHUTDOWN_DRAIN_TIMEOUT_MS` would fall through to Node's default action and kill the process
 * mid-teardown. `shutdown()`'s own idempotency makes a repeat signal harmless.
 */
export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal).then(() => {
        process.exit(0);
      });
    });
  }
}
