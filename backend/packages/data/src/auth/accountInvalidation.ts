import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the profile of `userId` (its display name or its language) changed: one `account`
 * invalidation for every socket of that user in the tenant, carrying neither the name nor the language;
 * the client rereads the profile. Call it in the transaction of the write that changed the profile. It is
 * announced once the transaction on `client` has committed, and a rollback announces nothing.
 */
export function publishAccountInvalidation(client: PoolClient, userId: string): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "account", userId }));
}
