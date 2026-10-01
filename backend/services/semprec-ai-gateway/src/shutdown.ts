import type { Server } from "node:http";
import type { Pool } from "pg";
import type { ProcessHeartbeatHandle } from "@semprec/data";
import type { Logger } from "@semprec/shared";

/** Mirrors `REQUEST_TIMEOUT_MS` in `backend/packages/ai-gateway-client/src/httpAiGatewayClient.ts`, the caller of `POST /internal/complete`. */
export const COMPLETE_ROUTE_TIMEOUT_MS = 60_000;

/** Mirrors `REQUEST_TIMEOUT_MS` in `backend/services/semprec-transcribe/src/audioGatewayClient.ts`, the caller of `POST /internal/diarize` and `POST /internal/transcribe`. */
export const AUDIO_ROUTE_TIMEOUT_MS = 600_000;

/**
 * Derived, not chosen: the longest time any caller of this service still waits for a response.
 * A shorter drain would cut off a paid-for provider call while its caller is still waiting for it
 * (a pyannoteAI diarization routinely runs for minutes). This exceeds systemd's 90 s
 * `DefaultTimeoutStopSec`, so `deploy/systemd/semprec-ai-gateway.service` sets its own
 * `TimeoutStopSec` above this drain plus `POOL_END_TIMEOUT_MS`.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = Math.max(COMPLETE_ROUTE_TIMEOUT_MS, AUDIO_ROUTE_TIMEOUT_MS);

const DRAIN_POLL_INTERVAL_MS = 50;

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
      shutdown(signal)
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          // `shutdown` is caller-injected and typed only as `Promise<void>`; this repository's
          // own `createGracefulShutdown` never rejects, but this function makes no such
          // guarantee about its argument, so a rejection here must not become unhandled.
          console.error("shutdown() rejected unexpectedly during", signal, err);
          process.exit(1);
        });
    });
  }
}
