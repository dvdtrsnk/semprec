import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation, publishInvalidation } from "../realtimeHook.js";

/**
 * Announces that the Semp status of the current tenant changed, now: one `sempStatus` invalidation for
 * every socket of the tenant, naming nothing. Fire and forget, like every write-path invalidation: a
 * failure to send is logged by the realtime layer and not reported here. It must run inside the tenant's
 * scope, which the realtime publisher reads the tenant from.
 */
export function publishSempStatusInvalidationNow(): void {
  notifyInvalidation({ scope: "sempStatus" });
}

/**
 * The same announcement as `publishSempStatusInvalidationNow`, for a caller whose reason to announce is not a
 * write of its own that could commit, such as the AI gateway after it refused a call, and which must know
 * whether it went out: it resolves once the message has been sent and rejects with the publisher's failure,
 * which it does not log. It must run inside the tenant's scope.
 */
export function publishSempStatusInvalidationAndWait(): Promise<void> {
  return publishInvalidation({ scope: "sempStatus" });
}

/**
 * Announces that the Semp status of the tenant changed (a problem raised, merged into, escalated or
 * resolved; the state of a service derives from the active problems): one `sempStatus` invalidation
 * for every socket of the tenant, naming nothing. Call it in the transaction of the write that changed
 * the status. It is announced once the transaction on `client` has committed, and a rollback announces
 * nothing.
 */
export function publishSempStatusInvalidation(client: PoolClient): void {
  runAfterCommit(client, publishSempStatusInvalidationNow);
}
