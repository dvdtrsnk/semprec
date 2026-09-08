import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import {
  claimApprovalRequestExecution,
  recordApprovalRequestOutcome,
  type ApprovalRequest,
} from "./approvalRequestsStore.js";
import { executeMcpInvocation } from "./mcpToolExecution.js";

async function loadServerItem(client: PoolClient, itemId: string): Promise<Pick<ItemRow, "id" | "properties"> | null> {
  const { rows } = await client.query<Pick<ItemRow, "id" | "properties">>(
    `SELECT id, properties FROM items WHERE id = $1 AND deleted_at IS NULL`,
    [itemId],
  );
  return rows[0] ?? null;
}

export interface HandleApprovalRequestExecuteInput {
  approvalRequestId: string;
}

/**
 * The `approvalExecute` job's handler (issue #131): reloads the request's stored payload and
 * performs only that deferred choke-point call — it never creates an `AgentSession`,
 * reconstructs the originating conversation, or touches `agent_runs` at all (see
 * `mcpInvokeTool.ts`'s split of `resolveMcpInvocation`/`executeMcpInvocation` for why this needs
 * only the latter). Idempotent under queue redelivery: `claimApprovalRequestExecution` is the
 * one atomic `UPDATE ... WHERE executed_at IS NULL`, so a request whose row is not `approved` or
 * has already been claimed (rejected, unknown, or a previous delivery already ran this) is a
 * deterministic no-op — this handler returns without ever calling `executeMcpInvocation` again.
 */
export async function handleApprovalRequestExecuteTask(
  pool: Pool,
  input: HandleApprovalRequestExecuteInput,
): Promise<void> {
  const claimed: ApprovalRequest | null = await withTransaction(pool, (client) =>
    claimApprovalRequestExecution(client, input.approvalRequestId),
  );
  if (!claimed) return;

  const serverItem = await withTransaction(pool, (client) => loadServerItem(client, claimed.payload.mcpServerItemId));
  const outcome = serverItem
    ? await executeMcpInvocation(pool, { serverItem, toolName: claimed.toolName }, claimed.payload.args)
    : { error: true, result: "The MCP server for this approval request no longer exists." };

  await withTransaction(pool, (client) => recordApprovalRequestOutcome(client, claimed.id, outcome));
}
