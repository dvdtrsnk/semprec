import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation, publishInvalidation } from "../realtimeHook.js";

/**
 * One `sempStatus` invalidation to every socket of the tenant, naming nothing. Fire and forget: send failures
 * are logged by the realtime layer. Must run inside the tenant scope, which the publisher reads.
 */
export function publishSempStatusInvalidationNow(): void {
  notifyInvalidation({ scope: "sempStatus" });
}

/**
 * For callers announcing something other than their own committing write (e.g. the AI gateway after a refusal)
 * that must know it was sent: resolves once sent, rejects with the unlogged publisher failure. Needs tenant scope.
 */
export function publishSempStatusInvalidationAndWait(): Promise<void> {
  return publishInvalidation({ scope: "sempStatus" });
}

/** Call in the transaction that changed the status; announced after `client` commits, nothing on rollback. */
export function publishSempStatusInvalidation(client: PoolClient): void {
  runAfterCommit(client, publishSempStatusInvalidationNow);
}
