import type { Pool, PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Publishes one tenant-wide `projectAgent` invalidation for a change of the project's agent setup. Call it in the
 * write's transaction: on a transaction client it fires after commit (nothing on rollback); on a bare pool at once.
 */
export function publishProjectAgentInvalidation(client: Pool | PoolClient, projectItemId: string): void {
  const notify = () => notifyInvalidation({ scope: "projectAgent", projectItemId });
  if ("release" in client) runAfterCommit(client, notify);
  else notify();
}
