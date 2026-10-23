const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Reconnect backoff for `WS /api/sync` (issue #164's Task): exponential growth from a 1s base,
 * doubling per attempt and clamped to a 30s ceiling, with full jitter spread across each
 * attempt's own window so many clients dropped by the same server-side fault (a LISTEN outage, a
 * deploy) don't all reconnect in the same instant. The floor stays at the 1s base on every
 * attempt — including the first — so a reconnect never fires faster than the Task's "from 1s"
 * requirement, while `ceiling` alone (not the returned delay) is what's guaranteed non-decreasing
 * and capped at 30s.
 */
export function nextReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
  }
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return BASE_DELAY_MS + random() * (ceiling - BASE_DELAY_MS);
}

export { BASE_DELAY_MS as RECONNECT_BASE_DELAY_MS, MAX_DELAY_MS as RECONNECT_MAX_DELAY_MS };
