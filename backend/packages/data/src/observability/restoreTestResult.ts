import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getEarliestUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import { transitionObservabilityCheck } from "./observabilityChecksStore.js";
import type { RestoreTestResult } from "./restoreTestResultArgs.js";

export const RESTORE_TEST_CHECK_KEY = "backup:restoreTest";

export interface RecordRestoreTestResultOutcome {
  /** Id of the `backup_restore_failed` notification, or `null` for a passed run or when no user exists yet to receive one. */
  notificationId: string | null;
}

/**
 * Records one monthly restore-test run (issue #178) as the `backup:restoreTest`
 * `observability_checks` row, so a failed restore stays visible in the system health report until
 * a later run passes, and on failure writes `backup_restore_failed` through the canonical
 * `writeNotification`.
 *
 * Unlike `observabilityCheckSystem.ts`'s every-minute checks, a failed run notifies even when the
 * row was already `alerting`: runs are a month apart, so each failure is news rather than a
 * repeat of one sustained fault. `transitionInstance` is the run id, so a retried invocation of
 * the same run is deduplicated by `writeNotification` instead of notifying twice.
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
    if (result.status === "passed") return { notificationId: null };

    const userId = await getEarliestUserId(client);
    if (!userId) return { notificationId: null };
    const notificationId = await writeNotification(client, {
      userId,
      kind: "backup_restore_failed",
      linkHref: null,
      sourceTable: "observability_checks",
      sourceId: transition.id,
      transitionInstance: `${result.runId}:${RESTORE_TEST_CHECK_KEY}`,
      payload: { runId: result.runId, failedCheck: result.failedCheck },
    });
    return { notificationId };
  });
}
