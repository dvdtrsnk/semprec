import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the numbers the Overview shows may have changed without a write that says so (the turn of
 * the day): one `overview` invalidation for every socket of the tenant, naming nothing. It must run inside
 * the tenant's scope, which the realtime publisher reads the tenant from. It is announced once the
 * transaction on `client` has committed, and a rollback announces nothing.
 */
export function publishOverviewInvalidation(client: PoolClient): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "overview" }));
}
