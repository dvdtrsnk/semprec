/** Failed attempts allowed (since the last success, for one email+IP pair) before any lockout applies. */
export const LOCKOUT_THRESHOLD = 5;
/** Lockout duration for the first failure past the threshold; doubles with each further failure. */
export const LOCKOUT_BASE_SECONDS = 30;
/** Upper bound on lockout duration, so an attacker who keeps failing doesn't push the window out indefinitely. */
export const LOCKOUT_MAX_SECONDS = 60 * 60;

/**
 * Same doubling shape as `pullErrorBackoffDelayMs` in mail/gmailWatchLifecycle.ts: zero below
 * the threshold, then `LOCKOUT_BASE_SECONDS * 2^n` for the nth failure past it, capped at
 * `LOCKOUT_MAX_SECONDS`. `failureCount` is the number of consecutive failures for one
 * email+IP pair since their last success (see `getFailureStreak`), not a fixed time window.
 */
export function lockoutDurationSeconds(failureCount: number): number {
  if (failureCount < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** (failureCount - LOCKOUT_THRESHOLD), LOCKOUT_MAX_SECONDS);
}
