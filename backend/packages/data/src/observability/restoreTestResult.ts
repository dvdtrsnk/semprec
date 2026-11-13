import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { transitionObservabilityCheck } from "./observabilityChecksStore.js";
import { BACKUP_RESTORE_PROBLEM_KEY } from "../semp/sourceProblemKeys.js";
import { resolveOperatorAlertProblems, writeOperatorAlert } from "./operatorAlerts.js";
import type { RestoreTestResult } from "./restoreTestResultArgs.js";

export const RESTORE_TEST_CHECK_KEY = "backup:restoreTest";

const RUN_ID_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

/** The UTC start time encoded in a run id (`YYYYMMDDTHHMMSSZ-<pid>`) as ISO 8601, or `null` when it does not parse. */
function parseRunIdTime(runId: string): string | null {
  const match = RUN_ID_TIME_PATTERN.exec(runId);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? date.toISOString() : null;
}

export interface RestoreTestOutcome {
  /** ISO 8601 UTC time the last restore test started, or `null` when the row carries neither `ranAt` nor a parsable `runId`. */
  lastTestAt: string | null;
  ok: boolean;
}

/**
 * Reads the tenant-safe outcome of the `backup:restoreTest` check: when the last test ran and whether
 * it passed. Rows written before `ranAt` existed are read through the run id. `failedCheck` is
 * operator detail and is never returned.
 */
export function readRestoreTestOutcome(detail: Record<string, unknown>, status: "ok" | "alerting"): RestoreTestOutcome {
  const { ranAt, runId } = detail;
  let lastTestAt: string | null = null;
  if (typeof ranAt === "string") lastTestAt = ranAt;
  else if (typeof runId === "string") lastTestAt = parseRunIdTime(runId);
  return { lastTestAt, ok: status === "ok" };
}

export interface RecordRestoreTestResultOutcome {
  /** Ids of the `backup_restore_failed` notifications, one per admin; empty for a passed run or when no admin exists. */
  notificationIds: string[];
}

/**
 * Records one monthly restore-test run (issue #178) as the `backup:restoreTest`
 * `observability_checks` row, so a failed restore stays visible in the system health report until
 * a later run passes, and on failure writes one content-free `backup_restore_failed` to every admin
 * through `writeOperatorAlert`, which also raises each admin's `backup:restoreTest` problem. A passed run
 * resolves those problems as recovered (`resolveOperatorAlertProblems`). Must run in a system scope.
 *
 * Unlike `observabilityCheckSystem.ts`'s every-minute checks, a failed run notifies even when the
 * row was already `alerting`: runs are a month apart, so each failure is news rather than a
 * repeat of one sustained fault. `transitionInstance` starts with the run id, so a retried invocation of
 * the same run is deduplicated per admin by `writeNotification` instead of notifying twice.
 */
export async function recordRestoreTestResult(
  pool: Pool,
  result: RestoreTestResult,
): Promise<RecordRestoreTestResultOutcome> {
  // The run id carries the run's start time; a run id that does not parse falls back to the recording time.
  const ranAt = parseRunIdTime(result.runId) ?? new Date().toISOString();
  return withTransaction(pool, async (client) => {
    const transition = await transitionObservabilityCheck(client, RESTORE_TEST_CHECK_KEY, () =>
      result.status === "passed"
        ? { status: "ok", detail: { runId: result.runId, ranAt } }
        : { status: "alerting", detail: { runId: result.runId, ranAt, failedCheck: result.failedCheck } },
    );
    if (result.status === "passed") {
      // A passed run closes the failure's problem of every admin (issue #1915); an admin without one changes nothing.
      await resolveOperatorAlertProblems(pool, client, BACKUP_RESTORE_PROBLEM_KEY);
      return { notificationIds: [] };
    }

    const notificationIds = await writeOperatorAlert(pool, client, {
      kind: "backup_restore_failed",
      checkId: transition.id,
      transitionInstance: `${result.runId}:${RESTORE_TEST_CHECK_KEY}`,
      payload: { runId: result.runId, failedCheck: result.failedCheck },
      problem: {
        category: "backup",
        kind: "backupRestore",
        severity: "critical",
        dedupeKey: BACKUP_RESTORE_PROBLEM_KEY,
        occurrenceKey: result.runId,
      },
    });
    return { notificationIds };
  });
}
