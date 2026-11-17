import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { transitionObservabilityCheck } from "./observabilityChecksStore.js";
import { BACKUP_RESTORE_PROBLEM_KEY } from "../semp/sourceProblemKeys.js";
import { resolveOperatorAlertProblems, writeOperatorAlert } from "./operatorAlerts.js";
import type { RestoreTestResult } from "./restoreTestResultArgs.js";

export const RESTORE_TEST_CHECK_KEY = "backup:restoreTest";

const RUN_ID_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

/** Run ids are `YYYYMMDDTHHMMSSZ-<pid>`; `null` when it does not parse. */
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
  /** `null` when the row carries neither `ranAt` nor a parsable `runId`. */
  lastTestAt: string | null;
  ok: boolean;
}

/** Tenant-safe: `failedCheck` is operator detail and is never returned. */
export function readRestoreTestOutcome(detail: Record<string, unknown>, status: "ok" | "alerting"): RestoreTestOutcome {
  const { ranAt, runId } = detail;
  let lastTestAt: string | null = null;
  if (typeof ranAt === "string") lastTestAt = ranAt;
  else if (typeof runId === "string") lastTestAt = parseRunIdTime(runId);
  return { lastTestAt, ok: status === "ok" };
}

export interface RecordRestoreTestResultOutcome {
  /** One per admin; empty for a passed run. */
  notificationIds: string[];
}

/**
 * Must run in a system scope. Unlike the every-minute checks, every failed run notifies even if
 * already `alerting`: runs are a month apart, so each failure is news. `transitionInstance` starts
 * with the run id, so a retried record of the same run dedupes per admin.
 */
export async function recordRestoreTestResult(
  pool: Pool,
  result: RestoreTestResult,
): Promise<RecordRestoreTestResultOutcome> {
  // An unparsable run id falls back to the recording time.
  const ranAt = parseRunIdTime(result.runId) ?? new Date().toISOString();
  return withTransaction(pool, async (client) => {
    const transition = await transitionObservabilityCheck(client, RESTORE_TEST_CHECK_KEY, () =>
      result.status === "passed"
        ? { status: "ok", detail: { runId: result.runId, ranAt } }
        : { status: "alerting", detail: { runId: result.runId, ranAt, failedCheck: result.failedCheck } },
    );
    if (result.status === "passed") {
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
