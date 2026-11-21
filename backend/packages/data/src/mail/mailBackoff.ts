/** A uniform value in [0, 1), as `Math.random`; injected so a test can pin the jitter. */
export type RandomSource = () => number;

/**
 * Decorrelated jitter: a uniform delay between `baseMs` and three times the previous delay, capped at `capMs`. A
 * streak grows by about a factor of two per step, and accounts failing at the same moment spread apart instead of
 * retrying in step. `previousMs` is `null` at the start of a streak, which counts as a previous delay of `baseMs`.
 */
export function decorrelatedJitterDelayMs(
  previousMs: number | null,
  baseMs: number,
  capMs: number,
  random: RandomSource,
): number {
  const previous = Math.min(capMs, Math.max(baseMs, previousMs ?? baseMs));
  const upper = Math.min(capMs, previous * 3);
  return Math.round(baseMs + random() * Math.max(0, upper - baseMs));
}

/** The first retry of a failing sync account comes after 5 to 15 minutes; a streak grows towards the cap. */
export const MAIL_SYNC_FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const MAIL_SYNC_FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
