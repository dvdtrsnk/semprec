/** Failures allowed per email+IP pair since its last success before any lockout applies. */
export const LOCKOUT_THRESHOLD = 5;
/** Doubles with each further failure. */
export const LOCKOUT_BASE_SECONDS = 30;
export const LOCKOUT_MAX_SECONDS = 60 * 60;

/** `failureCount` is the streak from `getFailureStreak`, not a fixed time window. */
export function lockoutDurationSeconds(failureCount: number): number {
  if (failureCount < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** (failureCount - LOCKOUT_THRESHOLD), LOCKOUT_MAX_SECONDS);
}
