import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the Semp status of the tenant changed (a problem raised, merged into, escalated or
 * resolved; the state of a service derives from the active problems): one `sempStatus` invalidation
 * for every socket of the tenant, naming nothing. Call it in the transaction of the write that changed
 * the status. It is announced once the transaction on `client` has committed, and a rollback announces
 * nothing.
 */
export function publishSempStatusInvalidation(client: PoolClient): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "sempStatus" }));
}
