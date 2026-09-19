import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import {
  claimApprovalRequestExecution,
  getApprovalRequest,
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
 * The `approvalExecute` job's handler (issue #131, restructured for #89's exactly-once
 * protocol): dispatches by the request's payload kind *before* claiming or locking anything,
 * since the two kinds now settle their terminal state completely differently.
 *
 * A generic-operation payload (the five destructive ops, #89) is handed straight to
 * `genericOperationApprovalReplay`: that function opens its own single transaction, row-locks the
 * request itself, and — whether it succeeds, conflicts, or finds the row already terminal —
 * writes `execution_status`/`execution_result`/`executed_at` inside that same transaction. This
 * handler does nothing further for that kind; calling `claimApprovalRequestExecution` or
 * `recordApprovalRequestOutcome` first would race the executor's own locked read and double-write
 * the terminal columns.
 *
 * An mcpInvoke payload keeps the pre-#89 flow unchanged: `claimApprovalRequestExecution` is the
 * one atomic `UPDATE ... WHERE executed_at IS NULL`, so a request that is not `approved` or has
 * already been claimed (rejected, unknown, or a previous delivery already ran this) is a
 * deterministic no-op, and `recordApprovalRequestOutcome` records the deferred tool call's result
 * afterward.
 */
export async function handleApprovalRequestExecuteTask(
  pool: Pool,
  input: HandleApprovalRequestExecuteInput,
  genericOperationApprovalReplay?: GenericOperationApprovalReplay,
): Promise<void> {
  const request = await withTransaction(pool, (client) => getApprovalRequest(client, input.approvalRequestId));
  if (!request) return;

  if (isGenericOperationApprovalRequestPayload(request.payload)) {
    const genericPayload = request.payload;
    if (genericOperationApprovalReplay) {
      await genericOperationApprovalReplay(pool, { ...request, payload: genericPayload });
      return;
    }
    // No replay handler configured: fail the request instead of leaving it `queued` forever with no way to progress.
    await withTransaction(pool, (client) =>
      recordApprovalRequestOutcome(client, request.id, {
        error: true,
        result: "No generic-operation approval replay handler is configured for this worker.",
      }),
    );
    return;
  }

  const claimed: ApprovalRequest | null = await withTransaction(pool, (client) =>
    claimApprovalRequestExecution(client, input.approvalRequestId),
  );
  // `isGenericOperationApprovalRequestPayload(claimed.payload)` can never be true here — the
  // early return above already handles every generic-operation payload, and a payload's kind is
  // fixed at row-creation time, so `claimed` (re-read by id from `claimApprovalRequestExecution`)
  // carries the same kind `request` did. The check still has to run: `claimed` is a distinct read
  // from `request`, so TypeScript can't carry that invariant across them, and this is what
  // narrows `claimed.payload` to `McpInvokeApprovalRequestPayload` below without an unchecked `as`.
  if (!claimed || isGenericOperationApprovalRequestPayload(claimed.payload)) return;

  const payload = claimed.payload;
  const serverItem = await withTransaction(pool, (client) => loadServerItem(client, payload.mcpServerItemId));
  const outcome: ApprovalRequestOutcome = serverItem
    ? await executeMcpInvocation(pool, { serverItem, toolName: claimed.toolName }, payload.args)
    : { error: true, result: "The MCP server for this approval request no longer exists." };

  await withTransaction(pool, (client) => recordApprovalRequestOutcome(client, claimed.id, outcome));
}
