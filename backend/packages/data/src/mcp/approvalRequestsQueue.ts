import { deriveApprovalRiskLevel, type ApprovalRiskLevel, type RiskClass } from "@semprec/shared";
import type { Queryable } from "../db/pool.js";
import { getAgentRunsByIds } from "../agentRuns/agentRunsStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { approvalConflictReason, type ApprovalConflictReason } from "./approvalConflictReason.js";
import { getMcpToolRegistrationsByIds } from "./mcpToolRegistrationsStore.js";
import {
  isGenericOperationApprovalRequestPayload,
  listPendingApprovalRequests,
  type ApprovalDescription,
  type ApprovalRequest,
} from "./approvalRequestsStore.js";

/**
 * A payload summary safe to send to the client: which target and which argument *names* the
 * deferred call carries, never the argument *values* — those are exactly where a credential
 * or other sensitive value would live (issue #132's "sensitive credential values are never
 * rendered" criterion). A reviewer who needs the actual values still has the audit trail
 * (`approval_requests.payload` in the database); this queue is a triage list, not that trail.
 *
 * A discriminated union, not all-optional fields: `mcpToolRegistrationId`/`mcpServerItemId` are
 * only ever present together (an MCP-invoke-originated request), `operationName` only for a
 * generic-operation-originated request (issue #220) — the two payload shapes never mix on the
 * same entry, and the `kind` tag lets a client narrow to the right one instead of every field
 * reading `string | undefined` regardless of the entry's actual origin.
 */
export type ApprovalRequestSafeSummary =
  | {
      kind: "mcpInvoke";
      mcpToolRegistrationId: string;
      mcpServerItemId: string;
      /** The server item's current `name`; `null` when the server item no longer exists. */
      mcpServerName: string | null;
      /** The registration's current `tool_name`; `null` when the registration no longer exists. */
      mcpToolName: string | null;
      argKeys: string[];
    }
  | { kind: "genericOperation"; operationName: string; argKeys: string[] };

export interface ApprovalRequestQueueEntry {
  id: string;
  toolName: string;
  riskClass: RiskClass;
  /** Closed key the client maps to a label; derived from the class and, for generic operations, the operation. */
  riskLevel: ApprovalRiskLevel;
  requestedAt: string;
  safeSummary: ApprovalRequestSafeSummary;
  agentRunId: string;
  /** `null` when the run itself is not tied to any project (e.g. Semp's own supervisor run). */
  projectItemId: string | null;
  /** `null` alongside `projectItemId` when there is no project, or when the project item has since been deleted. */
  projectName: string | null;
  /** The agent's own explanation of why it asked; `null` when it gave none. */
  reason: string | null;
  /** The snapshotted template key and parameters clients render; `null` for requests created before issue #1683. */
  description: ApprovalDescription | null;
}

interface ResolvedMcpNames {
  serverNameById: Map<string, string | null>;
  toolNameById: Map<string, string>;
}

/** Batched read-time resolution of the server and tool names the `mcpInvoke` summaries carry. */
async function resolveMcpNames(client: Queryable, requests: ApprovalRequest[]): Promise<ResolvedMcpNames> {
  const registrationIds = new Set<string>();
  const serverItemIds = new Set<string>();
  for (const { payload } of requests) {
    if (isGenericOperationApprovalRequestPayload(payload)) continue;
    registrationIds.add(payload.mcpToolRegistrationId);
    serverItemIds.add(payload.mcpServerItemId);
  }
  const [registrations, serverItems] = await Promise.all([
    getMcpToolRegistrationsByIds(client, [...registrationIds]),
    getItemsByIds(client, [...serverItemIds]),
  ]);
  return {
    serverNameById: new Map(
      serverItems.map((item) => [item.id, typeof item.properties.name === "string" ? item.properties.name : null]),
    ),
    toolNameById: new Map(registrations.map((registration) => [registration.id, registration.toolName])),
  };
}

function safeSummaryOf(payload: ApprovalRequest["payload"], names: ResolvedMcpNames): ApprovalRequestSafeSummary {
  if (isGenericOperationApprovalRequestPayload(payload)) {
    const canonicalInput = payload.canonicalInput;
    return {
      kind: "genericOperation",
      operationName: payload.operationName,
      argKeys: canonicalInput && typeof canonicalInput === "object" ? Object.keys(canonicalInput) : [],
    };
  }
  return {
    kind: "mcpInvoke",
    mcpToolRegistrationId: payload.mcpToolRegistrationId,
    mcpServerItemId: payload.mcpServerItemId,
    mcpServerName: names.serverNameById.get(payload.mcpServerItemId) ?? null,
    mcpToolName: names.toolNameById.get(payload.mcpToolRegistrationId) ?? null,
    argKeys: Object.keys(payload.args),
  };
}

function riskLevelOf(request: ApprovalRequest): ApprovalRiskLevel {
  return deriveApprovalRiskLevel({
    riskClass: request.riskClass,
    operationName: isGenericOperationApprovalRequestPayload(request.payload)
      ? request.payload.operationName
      : undefined,
  });
}

/**
 * What `PATCH /api/approval-requests/:id` returns for a decided (or already-decided) request: the
 * decision's outcome plus the same triage fields the queue shows, with the payload reduced to
 * `safeSummary` for the same reason as there. `payload`, `resourceSnapshot` and the execution
 * outcome fields (`executionResult`, `executionError`, `executedAt`) are deliberately absent.
 */
export interface ApprovalRequestDecisionView {
  id: string;
  status: ApprovalRequest["status"];
  decidedAt: string | null;
  decidedBy: string | null;
  executionStatus: ApprovalRequest["executionStatus"];
  /** Why an approved request was not carried out; `null` unless `executionStatus` is `conflict`. */
  conflictReason: ApprovalConflictReason | null;
  toolName: string;
  riskClass: RiskClass;
  /** Closed key the client maps to a label; derived from the class and, for generic operations, the operation. */
  riskLevel: ApprovalRiskLevel;
  requestedAt: string;
  agentRunId: string;
  safeSummary: ApprovalRequestSafeSummary;
  reason: string | null;
  description: ApprovalDescription | null;
}

export async function toApprovalRequestDecisionView(
  client: Queryable,
  request: ApprovalRequest,
): Promise<ApprovalRequestDecisionView> {
  const names = await resolveMcpNames(client, [request]);
  return {
    id: request.id,
    status: request.status,
    decidedAt: request.decidedAt,
    decidedBy: request.decidedBy,
    executionStatus: request.executionStatus,
    conflictReason: approvalConflictReason(request.executionStatus, request.executionResult),
    toolName: request.toolName,
    riskClass: request.riskClass,
    riskLevel: riskLevelOf(request),
    requestedAt: request.requestedAt,
    agentRunId: request.agentRunId,
    safeSummary: safeSummaryOf(request.payload, names),
    reason: request.reason,
    description: request.description,
  };
}

/**
 * The approval queue's read model (issue #132): every pending request of `ownerUserId`'s runs
 * across every project, each joined with its source project's display name and agent-run id so the UI can
 * show "where this came from" without a per-project detour. `agent_runs.project_item_id` and
 * `items.id` carry no Postgres FK to each other (see `0001_core_schema.sql`'s header note on
 * partitioned `items`), so both joins are done here as two batched follow-up reads instead of
 * one SQL join.
 */
export async function listApprovalRequestsQueue(
  client: Queryable,
  ownerUserId: string,
): Promise<ApprovalRequestQueueEntry[]> {
  const pending = await listPendingApprovalRequests(client, ownerUserId);
  if (pending.length === 0) return [];

  const agentRunIds = [...new Set(pending.map((request) => request.agentRunId))];
  const runs = await getAgentRunsByIds(client, agentRunIds);
  const runById = new Map(runs.map((run) => [run.id, run]));

  const projectItemIds = [...new Set(runs.flatMap((run) => (run.projectItemId ? [run.projectItemId] : [])))];
  const projectItems = await getItemsByIds(client, projectItemIds);
  const projectNameById = new Map(
    projectItems.map((item) => [item.id, typeof item.properties.name === "string" ? item.properties.name : null]),
  );

  const names = await resolveMcpNames(client, pending);

  return pending.map((request) => {
    const run = runById.get(request.agentRunId);
    const projectItemId = run?.projectItemId ?? null;
    return {
      id: request.id,
      toolName: request.toolName,
      riskClass: request.riskClass,
      riskLevel: riskLevelOf(request),
      requestedAt: request.requestedAt,
      safeSummary: safeSummaryOf(request.payload, names),
      agentRunId: request.agentRunId,
      projectItemId,
      projectName: projectItemId ? (projectNameById.get(projectItemId) ?? null) : null,
      reason: request.reason,
      description: request.description,
    };
  });
}
