import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import {
  claimApprovalRequestExecution,
  isGenericOperationApprovalRequestPayload,
  recordApprovalRequestOutcome,
  type ApprovalRequest,
  type ApprovalRequestOutcome,
  type GenericOperationApprovalRequestPayload,
} from "./approvalRequestsStore.js";
import { executeMcpInvocation } from "./mcpToolExecution.js";

/**
 * Replays one approved generic-operation request (issue #220): reloads the request and the
 * persisted `agent_run` provenance it was snapshotted from, rejects a mismatch as
 * `owner_violation`, then invokes the same `GENERIC_OPERATION_BINDINGS` entry REST/MCP/AgentTool
 * dispatch through, bypassing only the already-satisfied approval check. Lives in
 * `packages/application` (needs `createGenericApplicationService`), so `packages/data`'s worker
 * can't call it directly without an `application -> data -> application` cycle — a composition
 * root injects its own instance here the same way it already injects `mailSyncAdapters`/
 * `pushSenders` into `createCoreTaskList`.
 */
export type GenericOperationApprovalReplay = (
  pool: Pool,
  request: ApprovalRequest & { payload: GenericOperationApprovalRequestPayload },
) => Promise<ApprovalRequestOutcome>;

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
  genericOperationApprovalReplay?: GenericOperationApprovalReplay,
): Promise<void> {
  const claimed: ApprovalRequest | null = await withTransaction(pool, (client) =>
    claimApprovalRequestExecution(client, input.approvalRequestId),
  );
  if (!claimed) return;

  let outcome: ApprovalRequestOutcome;
  if (isGenericOperationApprovalRequestPayload(claimed.payload)) {
    const genericPayload = claimed.payload;
    outcome = genericOperationApprovalReplay
      ? await genericOperationApprovalReplay(pool, { ...claimed, payload: genericPayload })
      : { error: true, result: "No generic-operation approval replay handler is configured for this worker." };
  } else {
    const payload = claimed.payload;
    const serverItem = await withTransaction(pool, (client) => loadServerItem(client, payload.mcpServerItemId));
    outcome = serverItem
      ? await executeMcpInvocation(pool, { serverItem, toolName: claimed.toolName }, payload.args)
      : { error: true, result: "The MCP server for this approval request no longer exists." };
  }

  await withTransaction(pool, (client) => recordApprovalRequestOutcome(client, claimed.id, outcome));
}
