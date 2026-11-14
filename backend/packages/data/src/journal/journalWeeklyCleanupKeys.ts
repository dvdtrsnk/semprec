/**
 * The heartbeat action of the weekly Journal cleanup (issue #1883). Kept apart from the handler in
 * `journalWeeklyCleanupAction.ts` so that `scheduler/actions.ts` can name it without importing the data layer the
 * handler reads.
 */
export const JOURNAL_WEEKLY_CLEANUP_ACTION_ID = "core.journalWeeklyCleanup";
