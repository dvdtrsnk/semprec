import type { Pool, PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the agent setup of the project `projectItemId` changed (its guidance, a tool grant,
 * a user heartbeat or a guidance drift finding): one `projectAgent` invalidation for every socket of
 * the tenant. Call it in the transaction of the write that changed the setup. On a transaction client
 * it is announced once the transaction has committed and a rollback announces nothing; on a bare pool
 * the statement that made the change has already committed, so it is announced at once.
 */
export function publishProjectAgentInvalidation(client: Pool | PoolClient, projectItemId: string): void {
  const notify = () => notifyInvalidation({ scope: "projectAgent", projectItemId });
  if ("release" in client) runAfterCommit(client, notify);
  else notify();
}
