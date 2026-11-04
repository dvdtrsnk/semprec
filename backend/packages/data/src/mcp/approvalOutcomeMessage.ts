import type { PoolClient } from "pg";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertApprovalOutcomeSystemMessage } from "../semp/sempMessagesStore.js";
import type { ApprovalRequest } from "./approvalRequestsStore.js";

export async function postApprovalOutcomeMessage(
  client: PoolClient,
  request: ApprovalRequest,
  outcome: "executed" | "rejected" | "conflict",
): Promise<void> {
  const run = await getAgentRun(client, request.agentRunId);
  if (!run?.threadId) return;
  await insertApprovalOutcomeSystemMessage(
    client,
    run.threadId,
    request.id,
    `approval.outcome.${outcome}`,
    request.description?.params ?? {},
  );
}
