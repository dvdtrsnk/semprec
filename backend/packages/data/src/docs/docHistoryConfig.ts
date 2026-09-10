/** Service configuration for issue #216's retained history model — default 30 days. */
export const DEFAULT_DOC_HISTORY_RETENTION_DAYS = 30;

/**
 * `DOC_HISTORY_RETENTION_DAYS` must be a positive integer; invalid values fail startup
 * rather than silently falling back to the default (issue #216's Task). One retention day
 * is exactly 24 hours regardless of session timezone/DST — callers convert this to hours
 * (`24 * days`) and pass it into Postgres's `make_interval(hours => ...)`, never a bare
 * `... * interval '1 day'`, so DST transitions in the session timezone can't shift it.
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

/** Hours argument for `make_interval(hours => ...)`, computed from a validated retention-days value. */
export function retentionHours(retentionDays: number): number {
  return 24 * retentionDays;
}
