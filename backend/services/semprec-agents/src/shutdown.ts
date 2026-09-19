import type { Pool } from "pg";
import type { Logger } from "@semprec/shared";

export const POOL_END_TIMEOUT_MS = 5_000;

export interface QueueRuntimeHandle {
  stop(): Promise<void>;
}

export interface CreateGracefulShutdownOptions {
  queueRuntime: QueueRuntimeHandle;
  pool: Pool;
  logger: Logger;
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
 * Builds `semprec-agents`' shutdown sequence: this process has no HTTP intake to drain (it is a
 * pure queue consumer), so it stops the queue runtime issue #91 hosts (`queueRuntime.stop()`
 * awaits its `Runner.stop()`) and then ends the pool. Per
 * `docs/adr/2026-09-17-shutdown-ordering-with-late-heartbeat-stop.md`'s rejected-alternative
 * note, this ordering is specific to this service — it names no heartbeat step.
 */
export function createGracefulShutdown(options: CreateGracefulShutdownOptions): (signal: string) => Promise<void> {
  const { queueRuntime, pool, logger } = options;

  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    logger.info({ signal }, "semprec-agents shutting down");

    try {
      await queueRuntime.stop();
    } catch (err) {
      logger.error({ err, signal }, "queueRuntime.stop() failed");
    }

    await endPool(pool, logger, signal);

    logger.info({ signal }, "semprec-agents shutdown complete");
  }

  return function shutdown(signal: string): Promise<void> {
    shutdownPromise ??= runShutdown(signal);
    return shutdownPromise;
  };
}

/**
 * Wires both `SIGTERM` and `SIGINT` to the injected `shutdown`. Uses `on`, not `once`, so a
 * repeated signal during shutdown does not fall through to Node's default (immediately fatal)
 * action — `shutdown()`'s own idempotency makes a repeat signal harmless.
 */
export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shutdown(signal)
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          console.error("shutdown() rejected unexpectedly during", signal, err);
          process.exit(1);
        });
    });
  }
}
