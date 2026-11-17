const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * Reconnect backoff for `WS /api/sync`: the ceiling doubles from 1s per attempt up to 30s, and the
 * delay is jittered between the 1s floor and that ceiling so clients dropped by the same fault do not
 * reconnect at once. Only the ceiling, not the delay, is non-decreasing.
 */
export function nextReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
  }
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return BASE_DELAY_MS + random() * (ceiling - BASE_DELAY_MS);
}

export { BASE_DELAY_MS as RECONNECT_BASE_DELAY_MS, MAX_DELAY_MS as RECONNECT_MAX_DELAY_MS };
