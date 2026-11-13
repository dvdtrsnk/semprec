/**
 * How many days a trashed item and an archived database stay restorable before the nightly sweep removes them.
 * Kept outside `trash/` so the choke point's database store can stamp an archived database's deadline with it
 * without importing a domain folder (`chokepoint-knows-no-domain`); `trash/purgeExpiredTrash.ts` re-exports it.
 */
export const RETENTION_DAYS = 30;
