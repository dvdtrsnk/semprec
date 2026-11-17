import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Carries no profile data; clients reread. Call inside the profile write's transaction: it fires
 * after commit, and a rollback announces nothing.
 */
export function publishAccountInvalidation(client: PoolClient, userId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "account", userId }));
}
