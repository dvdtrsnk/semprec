import type { Queryable } from "../db/pool.js";
import { getAgentRunsByIds } from "../agentRuns/agentRunsStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { listPendingApprovalRequests, type ApprovalRequest } from "./approvalRequestsStore.js";

/**
 * A payload summary safe to send to the client: which target and which argument *names* the
 * deferred call carries, never the argument *values* — those are exactly where a credential
 * or other sensitive value would live (issue #132's "sensitive credential values are never
 * rendered" criterion). A reviewer who needs the actual values still has the audit trail
 * (`approval_requests.payload` in the database); this queue is a triage list, not that trail.
 */
export interface ApprovalRequestSafeSummary {
  mcpToolRegistrationId: string;
  mcpServerItemId: string;
  argKeys: string[];
}

export interface ApprovalRequestQueueEntry {
  id: string;
  toolName: string;
  riskClass: string;
  requestedAt: string;
  safeSummary: ApprovalRequestSafeSummary;
  agentRunId: string;
  /** `null` when the run itself is not tied to any project (e.g. Semp's own supervisor run). */
  projectItemId: string | null;
  /** `null` alongside `projectItemId` when there is no project, or when the project item has since been deleted. */
  projectName: string | null;
}

function safeSummaryOf(payload: ApprovalRequest["payload"]): ApprovalRequestSafeSummary {
  return {
    mcpToolRegistrationId: payload.mcpToolRegistrationId,
    mcpServerItemId: payload.mcpServerItemId,
    argKeys: Object.keys(payload.args),
  };
}

/**
 * The global approval queue's read model (issue #132): every pending request across every
 * project, each joined with its source project's display name and agent-run id so the UI can
 * show "where this came from" without a per-project detour. `agent_runs.project_item_id` and
 * `items.id` carry no Postgres FK to each other (see `0001_core_schema.sql`'s header note on
 * partitioned `items`), so both joins are done here as two batched follow-up reads instead of
 * one SQL join.
 */
export async function listApprovalRequestsQueue(client: Queryable): Promise<ApprovalRequestQueueEntry[]> {
  const pending = await listPendingApprovalRequests(client);
  if (pending.length === 0) return [];

  const agentRunIds = [...new Set(pending.map((request) => request.agentRunId))];
  const runs = await getAgentRunsByIds(client, agentRunIds);
  const runById = new Map(runs.map((run) => [run.id, run]));

  const projectItemIds = [...new Set(runs.flatMap((run) => (run.projectItemId ? [run.projectItemId] : [])))];
  const projectItems = await getItemsByIds(client, projectItemIds);
  const projectNameById = new Map(
    projectItems.map((item) => [item.id, typeof item.properties.name === "string" ? item.properties.name : null]),
  );

  return pending.map((request) => {
    const run = runById.get(request.agentRunId);
    const projectItemId = run?.projectItemId ?? null;
    return {
      id: request.id,
      toolName: request.toolName,
      riskClass: request.riskClass,
      requestedAt: request.requestedAt,
      safeSummary: safeSummaryOf(request.payload),
      agentRunId: request.agentRunId,
      projectItemId,
      projectName: projectItemId ? (projectNameById.get(projectItemId) ?? null) : null,
    };
  });
}
