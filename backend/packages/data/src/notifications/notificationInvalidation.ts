import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/** Call inside the write's transaction: fires after commit, a rollback announces nothing. */
export function publishNotificationPreferencesInvalidation(client: PoolClient, userId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "notificationPreferences", userId }));
}

/** Same commit semantics; may announce even when the count did not actually change. */
export function publishBadgeCountsInvalidation(client: PoolClient, userId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "badgeCounts", userId }));
}
