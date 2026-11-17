import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * For changes no write announces (the turn of the day). Must run in the tenant's scope, which the realtime publisher
 * reads; published after commit.
 */
export function publishOverviewInvalidation(client: PoolClient): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "overview" }));
}
