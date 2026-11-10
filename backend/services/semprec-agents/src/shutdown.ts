import type { Pool } from "pg";
import type { Logger } from "@semprec/shared";
import { logger } from "./logger.js";
import type { AgentRunnerStopAttempt } from "./queueRuntime.js";
import type { SempSettlementObservation } from "./inFlightAgentRuns.js";

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
  stopForShutdown(): AgentRunnerStopAttempt;
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
  observeSempSettlement: () => SempSettlementObservation;
}

/** Ends `pool`, bounded by `POOL_END_TIMEOUT_MS` so a hung or unreachable database can never stall shutdown indefinitely. */
function endPool(
  pool: Pool,
  logger: Logger,
  signal: string,
  stopAt: number,
): Promise<{ failed: false } | { failed: true; errors: unknown[]; unsettled: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const poolDeadline = Math.min(stopAt, performance.now() + POOL_END_TIMEOUT_MS);
    const timeoutError = () => new Error("pool.end() did not settle within its shutdown bound");

    const boundTimer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        logger.error({ signal }, "pool.end() did not settle within its shutdown bound");
        resolve({
          failed: true,
          errors: [timeoutError()],
          unsettled: true,
        });
      },
      Math.max(0, poolDeadline - performance.now()),
    );

    const expiredBeforeStart = new Error("Shutdown stop window elapsed before pool.end()");
    Promise.resolve()
      .then(() => {
        if (performance.now() >= poolDeadline) throw expiredBeforeStart;
        return pool.end();
      })
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(boundTimer);
          if (performance.now() >= poolDeadline) resolve({ failed: true, errors: [timeoutError()], unsettled: true });
          else resolve({ failed: false });
        },
        (err: unknown) => {
          if (settled) {
            logger.error(
              { errorCategory: errorCategory(err), signal },
              "pool.end() rejected after its shutdown bound had elapsed",
            );
            return;
          }
          settled = true;
          clearTimeout(boundTimer);
          logger.error({ errorCategory: errorCategory(err), signal }, "pool.end() failed");
          const late = performance.now() >= poolDeadline;
          resolve({
            failed: true,
            errors: err === expiredBeforeStart ? [timeoutError()] : late ? [err, timeoutError()] : [err],
            unsettled: late,
          });
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
  const {
    queueRuntime,
    tenantDeactivationListener,
    pool,
    logger,
    closeIdleThreadSessions,
    abortSempTurns,
    observeSempSettlement,
  } = options;

  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    const stopAt = performance.now() + AGENTS_STOP_WINDOW_MS;
    const observation = observeSempSettlement();
    const abortErrors: unknown[] = [];
    const abort = () => {
      try {
        abortSempTurns();
      } catch (error) {
        abortErrors.push(error);
      }
    };
    const deadline = setTimeout(abort, SEMP_TURN_GRACE_MS);
    let bound: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      bound = setTimeout(() => resolve({ kind: "timeout" }), AGENTS_STOP_WINDOW_MS);
    });
    let abandoned = false;
    let general: PromiseSettledResult<void> | undefined;
    let chat: PromiseSettledResult<void> | undefined;
    let stopFailure: { reason: unknown } | undefined;
    let outcome:
      { kind: "timeout" } | { kind: "unquiesced" } | { kind: "settled"; failures: unknown[] } | { kind: "abandoned" };
    try {
      logger.info({ signal }, "semprec-agents shutting down");
      outcome = await Promise.race([
        (async () => {
          await closeListener(tenantDeactivationListener, logger, signal);
          if (abandoned || performance.now() >= stopAt) return { kind: "timeout" as const };
          let attempt: AgentRunnerStopAttempt;
          try {
            attempt = queueRuntime.stopForShutdown();
          } catch (reason) {
            stopFailure = { reason };
            abort();
            return { kind: "unquiesced" as const };
          }
          const generalResult = attempt.general.then(
            (result) => {
              general = result;
            },
            (reason: unknown) => {
              general = { status: "rejected", reason };
            },
          );
          const chatResult = attempt.chat.then(
            (result) => {
              chat = result;
              if (result.status === "rejected") abort();
            },
            (reason: unknown) => {
              chat = { status: "rejected", reason };
              abort();
            },
          );
          await Promise.all([generalResult, chatResult]);
          if (abandoned) return { kind: "abandoned" as const };
          if (chat?.status !== "fulfilled") return { kind: "unquiesced" as const };
          return { kind: "settled" as const, failures: await observation.wait() };
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(deadline);
      clearTimeout(bound);
    }

    if (outcome.kind !== "settled") {
      abandoned = true;
      abort();
      const observed = observation.snapshotAndDispose();
      const reasons: unknown[] = [];
      if (chat?.status === "rejected") reasons.push(chat.reason);
      else if (stopFailure) reasons.push(stopFailure.reason);
      else
        reasons.push(
          new Error(
            chat?.status === "fulfilled"
              ? "Semp shutdown did not settle within the stop window"
              : "Semp shutdown did not establish chat-runner quiescence within the stop window",
          ),
        );
      if (general?.status === "rejected") reasons.push(general.reason);
      if (outcome.kind === "timeout" && (chat?.status === "rejected" || stopFailure)) {
        reasons.push(new Error("Semp shutdown did not settle within the stop window"));
      }
      reasons.push(...observed, ...abortErrors);
      if (reasons.length === 1) throw reasons[0];
      throw new AggregateError(reasons, "Semp shutdown could not establish quiescence", { cause: reasons[0] });
    }
    if (general?.status === "rejected")
      logger.error({ errorCategory: errorCategory(general.reason), signal }, "queueRuntime.stop() failed");
    const failures = [...outcome.failures, ...abortErrors];
    if (failures.length && general?.status === "rejected") failures.push(general.reason);

    const deadlineFailure = () => new Error("Shutdown cleanup did not settle within the stop window");
    const rejectFailures = (): never => {
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Semp settlement and cleanup failed", { cause: failures[0] });
    };
    const remaining = () => stopAt - performance.now();
    if (remaining() <= 0) {
      failures.push(deadlineFailure());
      rejectFailures();
    }
    let sweepTimedOut = false;
    let sweepTimer: ReturnType<typeof setTimeout> | undefined;
    const sweep = Promise.resolve()
      .then(() => {
        if (remaining() <= 0) return null;
        return closeIdleThreadSessions(pool);
      })
      .then(
        (result) => {
          if (result === null) return { kind: "timeout" as const };
          const { closedRunIds } = result;
          if (!sweepTimedOut)
            logger.info({ signal, closedIdleSessionCount: closedRunIds.length }, "Closed idle thread sessions");
          return { kind: "settled" as const };
        },
        (error: unknown) => {
          logger.error(
            { errorCategory: errorCategory(error), signal },
            sweepTimedOut
              ? "closeIdleThreadSessions() rejected after the stop window"
              : "closeIdleThreadSessions() failed",
          );
          return { kind: "failed" as const, error };
        },
      );
    const sweepResult = await Promise.race([
      sweep,
      new Promise<{ kind: "timeout" }>((resolve) => {
        sweepTimer = setTimeout(() => {
          sweepTimedOut = true;
          resolve({ kind: "timeout" });
        }, remaining());
      }),
    ]);
    clearTimeout(sweepTimer);
    if (sweepResult.kind === "timeout") {
      failures.push(deadlineFailure());
      rejectFailures();
    }
    const sweepError = sweepResult.kind === "failed" ? { error: sweepResult.error } : undefined;
    if (sweepError && failures.length) failures.push(sweepError.error);

    const poolTime = remaining();
    if (poolTime <= 0) {
      if (sweepError && !failures.length) failures.push(sweepError.error);
      failures.push(deadlineFailure());
      rejectFailures();
    }
    const poolResult = await endPool(pool, logger, signal, stopAt);
    if (poolResult.failed && !poolResult.unsettled && remaining() <= 0) {
      if (sweepError && !failures.length) failures.push(sweepError.error);
      failures.push(...poolResult.errors, deadlineFailure());
      rejectFailures();
    }
    if (poolResult.failed && poolResult.unsettled && sweepError && !failures.length) failures.push(sweepError.error);
    if (poolResult.failed && (failures.length || poolResult.unsettled)) failures.push(...poolResult.errors);

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Semp settlement and cleanup failed", { cause: failures[0] });

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
