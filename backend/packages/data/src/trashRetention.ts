/**
 * Days a trashed item or archived database stays restorable. Lives outside `trash/` so the choke point's database
 * store can use it without importing a domain folder; `trash/purgeExpiredTrash.ts` re-exports it.
 */
export const RETENTION_DAYS = 30;
