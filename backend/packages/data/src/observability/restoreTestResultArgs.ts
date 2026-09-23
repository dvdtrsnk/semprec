/**
 * The steps `deploy/systemd/scripts/semprec-restore-test.sh` (issue #178) can fail at, in the
 * order it runs them. The script passes one of these as its failed step; anything else is a
 * mismatch between the script and this list and is rejected rather than stored.
 */
export const RESTORE_TEST_FAILED_CHECKS = [
  "configuration",
  "snapshotRestore",
  "postgresStart",
  "pgRestore",
  "itemsCount",
  "itemsFreshness",
  "docSnapshotsCount",
  "docSnapshotsState",
  "minioStart",
  "blobObjects",
  "cleanup",
] as const;

export type RestoreTestFailedCheck = (typeof RESTORE_TEST_FAILED_CHECKS)[number];

export type RestoreTestResult =
  { status: "passed"; runId: string } | { status: "failed"; runId: string; failedCheck: RestoreTestFailedCheck };

const RUN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function isFailedCheck(value: string): value is RestoreTestFailedCheck {
  return (RESTORE_TEST_FAILED_CHECKS as readonly string[]).includes(value);
}

/** Parses `passed <runId>` or `failed <runId> <failedCheck>` — the restore-test script's whole CLI contract. */
export function parseRestoreTestResultArgs(args: readonly string[]): RestoreTestResult {
  const [status, runId, failedCheck, ...rest] = args;
  if (runId === undefined || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("expected a run id of 1-64 letters, digits or hyphens");
  }
  if (status === "passed" && failedCheck === undefined) {
    return { status, runId };
  }
  if (status === "failed" && failedCheck !== undefined && rest.length === 0) {
    if (!isFailedCheck(failedCheck)) {
      throw new Error(`unknown restore-test check "${failedCheck}"`);
    }
    return { status, runId, failedCheck };
  }
  throw new Error("usage: passed <runId> | failed <runId> <failedCheck>");
}
