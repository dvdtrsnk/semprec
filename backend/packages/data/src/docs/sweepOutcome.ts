import { logger } from "./logger.js";

export interface SweepOutcome {
  succeeded: number;
  failed: number;
}

/**
 * Throws when a sweep failed for every doc it attempted (so graphile-worker retries the
 * job and the queue checks see it); logs a warning when it failed for some; is silent when
 * nothing failed. A sweep that attempted zero docs (`{ succeeded: 0, failed: 0 }`) is not a
 * failure.
 */
export function assertSweepNotFailedEntirely(sweepName: string, outcome: SweepOutcome): void {
  const { succeeded, failed } = outcome;
  if (failed === 0) return;
  if (succeeded === 0) {
    throw new Error(`${sweepName}: all ${failed} attempted doc(s) failed`);
  }
  logger.warn({ sweepName, ...outcome }, "Sweep finished with per-doc failures");
}
