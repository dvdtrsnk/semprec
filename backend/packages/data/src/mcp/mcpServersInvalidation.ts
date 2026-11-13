import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the effective tools of every project that has grants on an MCP server may have changed (a
 * server switched on or off, its tools synchronized): one `mcpServers` invalidation for every socket of the
 * tenant, naming no server and no project. Call it once per such write, in the transaction of the write. It
 * must run inside the tenant's scope, which the realtime publisher reads the tenant from. It is announced
 * once the transaction on `client` has committed, and a rollback announces nothing.
 */
export function publishMcpServersInvalidation(client: PoolClient): void {
  runAfterCommit(client, () => notifyInvalidation({ scope: "mcpServers" }));
}
