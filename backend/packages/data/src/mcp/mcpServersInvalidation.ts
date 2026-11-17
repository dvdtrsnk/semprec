import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * One tenant-wide `mcpServers` invalidation naming no server or project. Call once per such write, inside the
 * tenant scope (the publisher reads the tenant from it); announced after commit, nothing on rollback.
 */
export function publishMcpServersInvalidation(client: PoolClient): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "mcpServers" }));
}
