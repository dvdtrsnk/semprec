// What the Calendars switch of an internet account and the account's removal do to its calendar sync. Both run in the
// transaction of the write, after the caller took the account's calendar sync guard.
import type { PoolClient } from "pg";
import { resolveProblem } from "../../semp/sempProblemsStore.js";
import { calendarProblemKey } from "../../semp/sourceProblemKeys.js";
import { enqueueCalendarAccountCleanup, enqueueCalendarAccountSync } from "./calendarAccountSyncEnqueue.js";
import {
  deleteAccountCalendarRemoteStates,
  deleteCalendarAccountSyncState,
  resolveCalendarSyncIds,
} from "./calendarSyncStore.js";

/** Calendars switched on, or an account created with them on: a pass is queued. */
export async function startCalendarAccountSync(client: PoolClient, accountItemId: string): Promise<void> {
  await enqueueCalendarAccountSync(client, accountItemId);
}

/**
 * Calendars switched off, or the account removed: the sync state goes, the account's calendars are no longer
 * tracked (their `calendar_remote_state` rows are deleted, so no pass touches them again), the calendar problem is
 * resolved, and the cleanup that trashes those calendars and their Events is queued. A pass already queued finds
 * Calendars off, or the account gone, and does nothing. Repeating it changes nothing.
 */
export async function stopCalendarAccountSync(client: PoolClient, accountItemId: string): Promise<void> {
  await deleteCalendarAccountSyncState(client, accountItemId);
  const ids = await resolveCalendarSyncIds(client);
  if (ids === null) return;
  await deleteAccountCalendarRemoteStates(client, ids, accountItemId);
  await resolveProblem(client, { dedupeKey: calendarProblemKey(accountItemId), resolutionKind: "sourceDeleted" });
  await enqueueCalendarAccountCleanup(client, accountItemId);
}
