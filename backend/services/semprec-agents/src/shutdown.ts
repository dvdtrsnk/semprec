import type { Pool } from "pg";
import type { Logger } from "@semprec/shared";
import { logger } from "./logger.js";

export const POOL_END_TIMEOUT_MS = 5_000;
export const LISTENER_CLOSE_TIMEOUT_MS = 5_000;
export const AGENTS_STOP_WINDOW_MS = 120_000;
export const SEMP_CLEANUP_MARGIN_MS = 30_000;
export const SEMP_TURN_GRACE_MS = AGENTS_STOP_WINDOW_MS - SEMP_CLEANUP_MARGIN_MS;

function errorCategory(error: unknown): string {
  if (error instanceof AggregateError) return "aggregate_error";
  if (error instanceof Error) return "error";
  return typeof error;
}

export interface QueueRuntimeHandle {
  stop(): Promise<void>;
}

export interface TenantDeactivationListenerHandle {
  close(): Promise<void>;
}

export interface CreateGracefulShutdownOptions {
  queueRuntime: QueueRuntimeHandle;
  tenantDeactivationListener: TenantDeactivationListenerHandle;
  pool: Pool;
  logger: Logger;
  /** Closes every idle thread session as `done`; runs after the queue stopped, while the pool is open. */
  closeIdleThreadSessions: (pool: Pool) => Promise<{ closedRunIds: string[] }>;
  abortSempTurns: () => void;
  observeSempSettlement: () => () => Promise<unknown[]>;
}

/** Ends `pool`, bounded by `POOL_END_TIMEOUT_MS` so a hung or unreachable database can never stall shutdown indefinitely. */
function endPool(pool: Pool, logger: Logger, signal: string): Promise<{ failed: false } | { failed: true; error: unknown }> {
  return new Promise((resolve) => {
    let settled = false;

    const boundTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error({ signal }, "pool.end() did not settle within POOL_END_TIMEOUT_MS");
      resolve({ failed: true, error: new Error("pool.end() did not settle within POOL_END_TIMEOUT_MS") });
    }, POOL_END_TIMEOUT_MS);

    pool.end().then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(boundTimer);
        resolve({ failed: false });
      },
      (err: unknown) => {
        if (settled) {
          logger.error(
            { errorCategory: errorCategory(err), signal },
            "pool.end() rejected after POOL_END_TIMEOUT_MS had already elapsed",
          );
          return;
        }
        settled = true;
        clearTimeout(boundTimer);
        logger.error({ errorCategory: errorCategory(err), signal }, "pool.end() failed");
        resolve({ failed: true, error: err });
      },
    );
  });
}

/** Bounds listener teardown so a stalled database reconnect cannot prevent queue and pool shutdown. */
async function closeListener(
  listener: TenantDeactivationListenerHandle,
  logger: Logger,
  signal: string,
): Promise<void> {
  let timedOut = false;
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    boundTimer = setTimeout(() => {
      timedOut = true;
      logger.error({ signal }, "tenantDeactivationListener.close() did not settle within LISTENER_CLOSE_TIMEOUT_MS");
      resolve();
    }, LISTENER_CLOSE_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.resolve()
        .then(() => listener.close())
        .catch((err: unknown) => {
          // Keep observing close after the deadline: a late rejection must still be reported.
          logger.error(
            { errorCategory: errorCategory(err), signal },
            timedOut
              ? "tenantDeactivationListener.close() rejected after LISTENER_CLOSE_TIMEOUT_MS had already elapsed"
              : "tenantDeactivationListener.close() failed",
          );
        }),
      timeout,
    ]);
  } finally {
    clearTimeout(boundTimer);
  }
}

/**
 * Builds `semprec-agents`' shutdown sequence: this process has no HTTP intake to drain (it is a
 * pure queue consumer), so it closes the tenant deactivation listener (waiting at most
 * `LISTENER_CLOSE_TIMEOUT_MS`), stops the queue runtime
 * issue #91 hosts (`queueRuntime.stop()` awaits its `Runner.stop()`), closes the idle thread
 * sessions as `done` (so a deploy raises no `agent_run_error` for them) and then ends the pool. Per
 * `docs/adr/2026-09-17-shutdown-ordering-with-late-heartbeat-stop.md`'s rejected-alternative
 * note, this ordering is specific to this service — it names no heartbeat step.
 */
export function createGracefulShutdown(options: CreateGracefulShutdownOptions): (signal: string) => Promise<void> {
  const { queueRuntime, tenantDeactivationListener, pool, logger, closeIdleThreadSessions, abortSempTurns, observeSempSettlement } = options;

  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    const settleSemp = observeSempSettlement();
    const deadline = setTimeout(abortSempTurns, SEMP_TURN_GRACE_MS);
    let bound: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      bound = setTimeout(() => reject(new Error("Semp shutdown did not settle within the stop window")), AGENTS_STOP_WINDOW_MS);
    });
    let failures: unknown[];
    try {
      logger.info({ signal }, "semprec-agents shutting down");
      failures = await Promise.race([(async () => {
        await closeListener(tenantDeactivationListener, logger, signal);
        try {
          await queueRuntime.stop();
        } catch (err) {
          logger.error({ errorCategory: errorCategory(err), signal }, "queueRuntime.stop() failed");
        }
        return settleSemp();
      })(), timeout]);
    } finally {
      clearTimeout(deadline);
      clearTimeout(bound);
    }

    // After the queue stopped, so no turn is still being written; before the pool ends. A failure
    // is logged and the next startup repair closes the same sessions, so it never blocks the pool end.
    try {
      const { closedRunIds } = await closeIdleThreadSessions(pool);
      logger.info({ signal, closedIdleSessionCount: closedRunIds.length }, "Closed idle thread sessions");
    } catch (err) {
      logger.error({ errorCategory: errorCategory(err), signal }, "closeIdleThreadSessions() failed");
      if (failures.length) failures.push(err);
    }

    const poolResult = await endPool(pool, logger, signal);
    if (poolResult.failed && failures.length) failures.push(poolResult.error);

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Semp settlement and cleanup failed", { cause: failures[0] });

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
          logger.fatal({ errorCategory: errorCategory(err), signal }, "shutdown() rejected unexpectedly");
          process.exit(1);
        });
    });
  }
}
