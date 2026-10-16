import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { transitionObservabilityCheck } from "./observabilityChecksStore.js";
import { writeOperatorAlert } from "./operatorAlerts.js";
import type { RestoreTestResult } from "./restoreTestResultArgs.js";

export const RESTORE_TEST_CHECK_KEY = "backup:restoreTest";

export interface RecordRestoreTestResultOutcome {
  /** Ids of the `backup_restore_failed` notifications, one per admin; empty for a passed run or when no admin exists. */
  notificationIds: string[];
}

/**
 * Records one monthly restore-test run (issue #178) as the `backup:restoreTest`
 * `observability_checks` row, so a failed restore stays visible in the system health report until
 * a later run passes, and on failure writes one content-free `backup_restore_failed` to every admin
 * through `writeOperatorAlert`. Must run in a system scope.
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
  return withTransaction(pool, async (client) => {
    const transition = await transitionObservabilityCheck(client, RESTORE_TEST_CHECK_KEY, () =>
      result.status === "passed"
        ? { status: "ok", detail: { runId: result.runId } }
        : { status: "alerting", detail: { runId: result.runId, failedCheck: result.failedCheck } },
    );
    if (result.status === "passed") return { notificationIds: [] };

    const notificationIds = await writeOperatorAlert(pool, client, {
      kind: "backup_restore_failed",
      checkId: transition.id,
      transitionInstance: `${result.runId}:${RESTORE_TEST_CHECK_KEY}`,
      payload: { runId: result.runId, failedCheck: result.failedCheck },
    });
    return { notificationIds };
  });
}
