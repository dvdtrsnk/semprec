import { logger } from "./logger.js";

export interface SweepOutcome {
  succeeded: number;
  failed: number;
}

/** Throws only when every attempt failed (so the job retries); a partial failure warns; zero attempts is fine. */
export function assertSweepNotFailedEntirely(sweepName: string, outcome: SweepOutcome): void {
  const { succeeded, failed } = outcome;
  if (failed === 0) return;
  if (succeeded === 0) {
    throw new Error(`${sweepName}: all ${failed} attempted doc(s) failed`);
  }
  logger.warn({ sweepName, ...outcome }, "Sweep finished with per-doc failures");
}
