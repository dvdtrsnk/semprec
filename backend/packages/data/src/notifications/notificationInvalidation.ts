import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the stored notification preferences of `userId` changed: one `notificationPreferences`
 * invalidation for that user's sockets in the tenant, naming nothing else. Call it in the transaction of
 * the write that changed them. It is announced once the transaction on `client` has committed, and a
 * rollback announces nothing.
 */
export function publishNotificationPreferencesInvalidation(client: PoolClient, userId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "notificationPreferences", userId }));
}

/**
 * Announces that the number of decisions pending for `userId` may have changed (an approval request of one
 * of the user's runs appeared, was decided or finished executing): one `badgeCounts` invalidation for that
 * user's sockets in the tenant, naming nothing else. Call it in the transaction of the write. It is
 * announced once the transaction on `client` has committed, and a rollback announces nothing. A write that
 * leaves the count as it was may still announce it.
 */
export function publishBadgeCountsInvalidation(client: PoolClient, userId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "badgeCounts", userId }));
}
