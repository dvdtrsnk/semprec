export const DEFAULT_DOC_HISTORY_RETENTION_DAYS = 30;

/**
 * Invalid values fail startup rather than falling back. A day is exactly 24 hours: callers pass hours to
 * `make_interval(hours => ...)`, never `interval '1 day'`, so session DST cannot shift it.
 */
export function resolveDocHistoryRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOC_HISTORY_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_DOC_HISTORY_RETENTION_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`DOC_HISTORY_RETENTION_DAYS must be a positive integer, got: ${raw}`);
  }
  return value;
}

export function retentionHours(retentionDays: number): number {
  return 24 * retentionDays;
}
