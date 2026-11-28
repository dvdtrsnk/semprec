import type { Server } from "node:http";
import type { Pool } from "pg";
import type { Logger } from "@alldots/shared";
import { logger } from "./logger.js";

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 60_000;
export const DRAIN_POLL_INTERVAL_MS = 50;
export const POOL_END_TIMEOUT_MS = 5_000;
/** How long shutdown waits for the deactivation listener's in-flight handlers. */
export const LISTENER_CLOSE_TIMEOUT_MS = 5_000;

export interface QueueRuntimeHandle {
  stop(): Promise<void>;
}

export interface CreateGracefulShutdownOptions {
  server: Server;
  /** Closed first, so no deactivation handler runs against a closing sync server or mail root. */
  tenantDeactivationListener: { close(): Promise<void> };
  syncServer: { close(): Promise<void> };
  voiceServer: { close(): Promise<void> };
  queueRuntime: QueueRuntimeHandle;
  /**
   * Absent when this process hosts no Gmail watch; stopped after the HTTP drain and before
   * `mailLiveSync`.
   */
  gmailPubSubDispatcher?: { stop(): Promise<void> };
  mailLiveSync: { stop(): Promise<void> };
  /** The kept IMAP sync sessions; closed after the queue runtime, whose sync passes check them out. */
  imapSessions: { close(): Promise<void> };
  pool: Pool;
  logger: Logger;
  /** Lets a test shrink the drain bound below the integration `testTimeout`. */
  drainTimeoutMs?: number;
}

/**
 * Resolves once `server.close()` calls back, or once `drainTimeoutMs` elapses and
 * `closeAllConnections()` forces it.
 */
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

/** Bounded by `POOL_END_TIMEOUT_MS` so a hung database cannot stall shutdown. */
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
 * Its `close()` waits for in-flight handlers, and a handler stopping a mailbox lifecycle can take
 * as long as that lifecycle's `start()` or `stop()`. Past the bound shutdown moves on, and a
 * still-running handler races the sync server's and mail root's own close.
 */
function closeListener(listener: { close(): Promise<void> }, logger: Logger, signal: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const boundTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error({ signal }, "tenantDeactivationListener.close() did not settle within LISTENER_CLOSE_TIMEOUT_MS");
      resolve();
    }, LISTENER_CLOSE_TIMEOUT_MS);

    listener.close().then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(boundTimer);
        resolve();
      },
      (err: unknown) => {
        if (settled) {
          logger.error(
            { err, signal },
            "tenantDeactivationListener.close() rejected after LISTENER_CLOSE_TIMEOUT_MS had already elapsed",
          );
          return;
        }
        settled = true;
        clearTimeout(boundTimer);
        logger.error({ err, signal }, "tenantDeactivationListener.close() failed");
        resolve();
      },
    );
  });
}

/**
 * Order:
 * 1. Tenant deactivation listener (its handler calls into the sync server and the mail root, so it
 * stops before either).
 * 2. Sync server: clients get close code 1012 and its `LISTEN` client is released; otherwise
 * upgraded sockets keep `server.close()` from settling.
 * 3. HTTP intake and drain.
 * 4. Gmail Pub/Sub dispatcher, if any: an in-flight pull returns within the transport timeout, and
 * anything pulled but not handed off stays unacknowledged for redelivery.
 * 5. Mail live-sync root, before the queue runtime, because a lifecycle's `start()` enqueues a
 * `mailAccountSync` job that must not race the runner's stop.
 * 6. Queue runtime.
 * 7. Kept IMAP sync sessions: no pass runs any more to check one out, and each closes with a bounded
 * LOGOUT.
 * 8. Pool.
 * This ordering is specific to this service and has no heartbeat step
 * (docs/architecture/agents-approvals-and-ai.md#process-lifecycle).
 */
export function createGracefulShutdown(options: CreateGracefulShutdownOptions): (signal: string) => Promise<void> {
  const {
    server,
    tenantDeactivationListener,
    syncServer,
    voiceServer,
    queueRuntime,
    gmailPubSubDispatcher,
    mailLiveSync,
    imapSessions,
    pool,
    logger,
  } = options;
  const drainTimeoutMs = options.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;

  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    logger.info({ signal }, "alldots-api shutting down");

    await closeListener(tenantDeactivationListener, logger, signal);

    try {
      await syncServer.close();
    } catch (err) {
      logger.error({ err, signal }, "syncServer.close() failed");
    }

    try {
      await voiceServer.close();
    } catch (err) {
      logger.error({ err, signal }, "voiceServer.close() failed");
    }

    const timedOut = await drainServer(server, drainTimeoutMs, logger, signal);

    if (gmailPubSubDispatcher) {
      try {
        await gmailPubSubDispatcher.stop();
      } catch (err) {
        // Its name only: a transport failure must not put a request's token into the log.
        logger.error(
          { errorName: err instanceof Error ? err.name : typeof err, signal },
          "gmailPubSubDispatcher.stop() failed",
        );
      }
    }

    try {
      await mailLiveSync.stop();
    } catch (err) {
      logger.error({ err, signal }, "mailLiveSync.stop() failed");
    }

    try {
      await queueRuntime.stop();
    } catch (err) {
      logger.error({ err, signal }, "queueRuntime.stop() failed");
    }

    try {
      await imapSessions.close();
    } catch (err) {
      logger.error({ errorName: err instanceof Error ? err.name : typeof err, signal }, "imapSessions.close() failed");
    }

    await endPool(pool, logger, signal);

    logger.info({ signal, timedOut }, "alldots-api shutdown complete");
  }

  return function shutdown(signal: string): Promise<void> {
    shutdownPromise ??= runShutdown(signal);
    return shutdownPromise;
  };
}

/**
 * `on`, not `once`: with `once` a second SIGTERM during the drain would fall through to Node's
 * default action and kill the process mid-teardown. `shutdown()` is idempotent.
 */
export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shutdown(signal)
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.fatal({ err, signal }, "shutdown() rejected unexpectedly");
          process.exit(1);
        });
    });
  }
}
