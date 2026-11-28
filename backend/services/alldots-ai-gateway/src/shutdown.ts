import type { Server } from "node:http";
import type { Pool } from "pg";
import type { ProcessHeartbeatHandle } from "@alldots/data";
import type { Logger } from "@alldots/shared";
import { logger } from "./logger.js";

/** Mirrors `REQUEST_TIMEOUT_MS` in `backend/packages/ai-gateway-client/src/httpAiGatewayClient.ts`, the caller of `POST /internal/complete`. */
export const COMPLETE_ROUTE_TIMEOUT_MS = 60_000;

/** Mirrors `REQUEST_TIMEOUT_MS` in `backend/services/alldots-transcribe/src/audioGatewayClient.ts`, the caller of `POST /internal/diarize` and `POST /internal/transcribe`. */
export const AUDIO_ROUTE_TIMEOUT_MS = 600_000;

/**
 * The longest any caller still waits, so a drain never cuts off a paid call its caller awaits.
 * Exceeds systemd's default 90 s, so the unit sets `TimeoutStopSec` above this plus `POOL_END_TIMEOUT_MS`.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = Math.max(COMPLETE_ROUTE_TIMEOUT_MS, AUDIO_ROUTE_TIMEOUT_MS);

const DRAIN_POLL_INTERVAL_MS = 50;

export const POOL_END_TIMEOUT_MS = 5_000;

export interface CreateGracefulShutdownOptions {
  server: Server;
  pool: Pool;
  heartbeat: ProcessHeartbeatHandle;
  logger: Logger;
  /** Ends WebSocket streams (which `server.close()` would wait on) before the pool ends. */
  closeStreams?: () => Promise<void>;
  /** Test seam; defaults to `SHUTDOWN_DRAIN_TIMEOUT_MS`. */
  drainTimeoutMs?: number;
}

/** After `drainTimeoutMs`, `closeAllConnections()` forces the close. */
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

/** Bounded so a hung database cannot stall shutdown. */
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
          // The bound already won; observe the rejection so it never goes unhandled.
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
 * Stop accepting, drain in-flight requests, stop the heartbeat only once serving is done (so the
 * process is not reported dead while it still serves), then end the pool.
 */
export function createGracefulShutdown(options: CreateGracefulShutdownOptions): (signal: string) => Promise<void> {
  const { server, pool, heartbeat, logger } = options;
  const drainTimeoutMs = options.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;

  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    logger.info({ signal }, "alldots-ai-gateway shutting down");

    if (options.closeStreams !== undefined) {
      await options.closeStreams().catch((err: unknown) => {
        logger.error({ err, signal }, "Closing the speech-to-text streams failed");
      });
    }
    const timedOut = await drainServer(server, drainTimeoutMs, logger, signal);

    heartbeat.stop();
    await endPool(pool, logger, signal);

    logger.info({ signal, timedOut }, "alldots-ai-gateway shutdown complete");
  }

  return function shutdown(signal: string): Promise<void> {
    shutdownPromise ??= runShutdown(signal);
    return shutdownPromise;
  };
}

/** `on`, not `once`: a second signal during the drain must not fall through to Node's default kill. */
export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shutdown(signal)
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          // An injected `shutdown` may reject; never leave that unhandled.
          logger.fatal({ err, signal }, "shutdown() rejected unexpectedly");
          process.exit(1);
        });
    });
  }
}
