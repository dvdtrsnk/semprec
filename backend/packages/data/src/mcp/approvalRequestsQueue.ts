import type { PoolClient } from "pg";
import { deriveApprovalRiskLevel, type ApprovalRiskLevel, type RiskClass } from "@semprec/shared";
import type { Queryable } from "../db/pool.js";
import { getAgentRun, getAgentRunsByIds, getRootAgentRuns, type AgentRunRow } from "../agentRuns/agentRunsStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { SempReplyStep } from "../semp/sempReplySteps.js";
import { loadSempThreadTitleResolver, SEMP_THREAD_KINDS, type SempThreadKind } from "../semp/sempThreadsListStore.js";
import { approvalConflictReason, type ApprovalConflictReason } from "./approvalConflictReason.js";
import { getMcpToolRegistrationsByIds } from "./mcpToolRegistrationsStore.js";
import {
  isGenericOperationApprovalRequestPayload,
  isMailSendApprovalRequestPayload,
  isMcpInvokeApprovalRequestPayload,
  listApprovalRequestsPage,
  listApprovalRequestStatesByIdsForOwner,
  listPendingApprovalRequests,
  type ApprovalDescription,
  type BreaksLinkEntry,
  type EndsInheritanceEntry,
  type ApprovalRequest,
  type ApprovalRequestSourceKind,
  type ApprovalRequestStateView,
  type ListApprovalRequestsPageInput,
  MAIL_DRAFT_SEND_TOOL_NAME,
} from "./approvalRequestsStore.js";

/**
 * Carries the target and argument *names*, never argument *values*: those are where credentials live. The full
 * values remain only in `approval_requests.payload`. A discriminated union so a client narrows on `kind` (MCP
 * invoke, generic operation, or module tool, which includes `mail.draft.send`).
 */
export type ApprovalRequestSafeSummary =
  | {
      kind: "mcpInvoke";
      mcpToolRegistrationId: string;
      mcpServerItemId: string;
      /** `null` when the server item no longer exists. */
      mcpServerName: string | null;
      /** `null` when the registration no longer exists. */
      mcpToolName: string | null;
      argKeys: string[];
    }
  | { kind: "genericOperation"; operationName: string; argKeys: string[] }
  | { kind: "moduleTool"; toolName: string; argKeys: string[] };

/** Derived at read time from the run that raised the request, never stored. */
export interface ApprovalRequestSource {
  /**
   * A thread decides first: tick thread is `tick`, chat or item thread `chat`. Without a thread, the root run's
   * `triggered_by` decides: `heartbeat` is `tick`, `mcp` is `mcp`, anything else `chat`.
   */
  kind: ApprovalRequestSourceKind;
  threadId: string | null;
  /** By the thread list's title rule. */
  threadTitle: string | null;
  heartbeatId: string | null;
  heartbeatName: string | null;
  /** Always `null`: the source does not read the name a run stores. */
  mcpClientName: string | null;
}

export interface ApprovalRequestQueueEntry {
  id: string;
  toolName: string;
  riskClass: RiskClass;
  /** Closed key the client maps to a label. */
  riskLevel: ApprovalRiskLevel;
  requestedAt: string;
  safeSummary: ApprovalRequestSafeSummary;
  agentRunId: string;
  /** `null` when the run is not tied to a project (e.g. Semp's own supervisor run). */
  projectItemId: string | null;
  /** Also `null` when the project item has since been deleted. */
  projectName: string | null;
  reason: string | null;
  /** `null` for older requests. */
  description: ApprovalDescription | null;
  breaksLinks: BreaksLinkEntry[];
  endsInheritance: EndsInheritanceEntry[];
  source: ApprovalRequestSource;
}

interface ResolvedMcpNames {
  serverNameById: Map<string, string | null>;
  toolNameById: Map<string, string>;
}

async function resolveMcpNames(client: Queryable, requests: ApprovalRequest[]): Promise<ResolvedMcpNames> {
  const registrationIds = new Set<string>();
  const serverItemIds = new Set<string>();
  for (const { payload } of requests) {
    if (!isMcpInvokeApprovalRequestPayload(payload)) continue;
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
  if (isMailSendApprovalRequestPayload(payload)) {
    return { kind: "moduleTool", toolName: MAIL_DRAFT_SEND_TOOL_NAME, argKeys: Object.keys(payload) };
  }
  if (!isMcpInvokeApprovalRequestPayload(payload)) {
    return { kind: "moduleTool", toolName: payload.moduleToolName, argKeys: Object.keys(payload.args) };
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

/** `payload`, `resourceSnapshot` and the execution outcome fields are deliberately absent. */
export interface ApprovalRequestDecisionView {
  id: string;
  status: ApprovalRequest["status"];
  decidedAt: string | null;
  decidedBy: string | null;
  executionStatus: ApprovalRequest["executionStatus"];
  /** `null` unless `executionStatus` is `conflict`. */
  conflictReason: ApprovalConflictReason | null;
  toolName: string;
  riskClass: RiskClass;
  riskLevel: ApprovalRiskLevel;
  requestedAt: string;
  agentRunId: string;
  safeSummary: ApprovalRequestSafeSummary;
  reason: string | null;
  description: ApprovalDescription | null;
  breaksLinks: BreaksLinkEntry[];
  endsInheritance: EndsInheritanceEntry[];
  source: ApprovalRequestSource;
}

interface SourceThreadRow {
  id: string;
  kind: string;
  title: string | null;
  heartbeat_id: string | null;
  subject_inbox_item_id: string | null;
}

function lookup<V>(map: Map<string, V>, key: string | null): V | null {
  return (key === null ? undefined : map.get(key)) ?? null;
}

async function getSourceThreads(client: Queryable, threadIds: string[]): Promise<Map<string, SourceThreadRow>> {
  if (threadIds.length === 0) return new Map();
  const { rows } = await client.query<SourceThreadRow>(
    `SELECT id, kind, title, heartbeat_id, subject_inbox_item_id FROM semp_threads WHERE id = ANY($1::uuid[])`,
    [threadIds],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function getHeartbeatNames(client: Queryable, heartbeatIds: string[]): Promise<Map<string, string>> {
  if (heartbeatIds.length === 0) return new Map();
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM project_heartbeats WHERE id = ANY($1::uuid[])`,
    [heartbeatIds],
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

const NO_SOURCE_DETAIL = {
  threadId: null,
  threadTitle: null,
  heartbeatId: null,
  heartbeatName: null,
  mcpClientName: null,
};

function threadSourceKind(threadKind: SempThreadKind): ApprovalRequestSourceKind {
  return threadKind === "tick" ? "tick" : "chat";
}

/** A root run that was not read counts as `chat`. */
function rootSourceKind(root: AgentRunRow | undefined): ApprovalRequestSourceKind {
  if (root?.triggeredBy === "mcp") return "mcp";
  return root?.triggeredBy === "heartbeat" ? "tick" : "chat";
}

/**
 * Each lookup (threads, parent levels, heartbeats, item-thread Inbox items) is batched for all runs, so the query
 * count does not grow with the run count. A tick thread keeps its heartbeat even when a chat run started it.
 */
async function loadApprovalSources(
  client: Queryable,
  runs: AgentRunRow[],
  locale: string,
): Promise<(agentRunId: string) => ApprovalRequestSource> {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const threadById = await getSourceThreads(client, [...new Set(runs.flatMap((run) => run.threadId ?? []))]);
  const rootByRunId = await getRootAgentRuns(
    client,
    runs.filter((run) => lookup(threadById, run.threadId) === null),
  );
  const heartbeatIds = new Set([...threadById.values()].flatMap((thread) => thread.heartbeat_id ?? []));
  for (const root of rootByRunId.values()) {
    if (root.triggeredBy === "heartbeat" && root.heartbeatId !== null) heartbeatIds.add(root.heartbeatId);
  }
  const heartbeatNameById = await getHeartbeatNames(client, [...heartbeatIds]);
  const subjects = await getItemsByIds(
    client,
    [...threadById.values()].flatMap((thread) => thread.subject_inbox_item_id ?? []),
  );
  const subjectTextById = new Map<string, string>();
  for (const item of subjects) {
    if (typeof item.properties.text === "string") subjectTextById.set(item.id, item.properties.text);
  }
  const resolveTitle = await loadSempThreadTitleResolver(locale);

  return (agentRunId) => {
    const thread = lookup(threadById, runById.get(agentRunId)?.threadId ?? null);
    if (thread) {
      const kind = assertKnownValue(SEMP_THREAD_KINDS, thread.kind, "thread kind");
      const heartbeatName = lookup(heartbeatNameById, thread.heartbeat_id);
      return {
        kind: threadSourceKind(kind),
        threadId: thread.id,
        threadTitle: resolveTitle({
          kind,
          title: thread.title,
          heartbeatName,
          subjectText: lookup(subjectTextById, thread.subject_inbox_item_id),
        }),
        heartbeatId: thread.heartbeat_id,
        heartbeatName,
        mcpClientName: null,
      };
    }
    const root = rootByRunId.get(agentRunId);
    const kind = rootSourceKind(root);
    if (root?.triggeredBy === "heartbeat") {
      return {
        ...NO_SOURCE_DETAIL,
        kind,
        heartbeatId: root.heartbeatId,
        heartbeatName: lookup(heartbeatNameById, root.heartbeatId),
      };
    }
    return { ...NO_SOURCE_DETAIL, kind };
  };
}

/** For a caller creating a request; same rules as the queue. `null` when the run is not visible to `client`. */
export async function getApprovalRequestSourceKind(
  client: Queryable,
  agentRunId: string,
): Promise<ApprovalRequestSourceKind | null> {
  const run = await getAgentRun(client, agentRunId);
  if (!run) return null;
  const threads = await getSourceThreads(client, run.threadId === null ? [] : [run.threadId]);
  const thread = lookup(threads, run.threadId);
  if (thread) return threadSourceKind(assertKnownValue(SEMP_THREAD_KINDS, thread.kind, "thread kind"));
  return rootSourceKind((await getRootAgentRuns(client, [run])).get(run.id));
}

export async function toApprovalRequestDecisionView(
  client: Queryable,
  request: ApprovalRequest,
  locale: string,
): Promise<ApprovalRequestDecisionView> {
  const names = await resolveMcpNames(client, [request]);
  const sourceOf = await loadApprovalSources(client, await getAgentRunsByIds(client, [request.agentRunId]), locale);
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
    breaksLinks: request.description?.breaksLinks ?? [],
    endsInheritance: request.description?.endsInheritance ?? [],
    source: sourceOf(request.agentRunId),
  };
}

/** The project of each request's run is read in two batched follow-up reads rather than one SQL join. */
async function loadQueueEntries(
  client: Queryable,
  requests: ApprovalRequest[],
  locale: string,
): Promise<(request: ApprovalRequest) => ApprovalRequestQueueEntry> {
  const agentRunIds = [...new Set(requests.map((request) => request.agentRunId))];
  const runs = await getAgentRunsByIds(client, agentRunIds);
  const runById = new Map(runs.map((run) => [run.id, run]));

  const projectItemIds = [...new Set(runs.flatMap((run) => (run.projectItemId ? [run.projectItemId] : [])))];
  const projectItems = await getItemsByIds(client, projectItemIds);
  const projectNameById = new Map(
    projectItems.map((item) => [item.id, typeof item.properties.name === "string" ? item.properties.name : null]),
  );

  const names = await resolveMcpNames(client, requests);
  const sourceOf = await loadApprovalSources(client, runs, locale);

  return (request) => {
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
      breaksLinks: request.description?.breaksLinks ?? [],
      endsInheritance: request.description?.endsInheritance ?? [],
      source: sourceOf(request.agentRunId),
    };
  };
}

/** Oldest first; the unparameterized `GET /api/approval-requests`. */
export async function listApprovalRequestsQueue(
  client: Queryable,
  ownerUserId: string,
  locale: string,
): Promise<ApprovalRequestQueueEntry[]> {
  const pending = await listPendingApprovalRequests(client, ownerUserId);
  if (pending.length === 0) return [];
  return pending.map(await loadQueueEntries(client, pending, locale));
}

export interface DecidedApprovalRequestQueueEntry extends ApprovalRequestQueueEntry {
  status: ApprovalRequest["status"];
  decidedAt: string | null;
  executionStatus: ApprovalRequest["executionStatus"];
  /** `null` unless `executionStatus` is `conflict`. */
  conflictReason: ApprovalConflictReason | null;
}

/** A pending row has exactly the fields `listApprovalRequestsQueue` returns; a decided row adds the decision. */
export async function listApprovalRequestsQueuePage(
  client: PoolClient,
  input: ListApprovalRequestsPageInput & { locale: string },
): Promise<{ rows: Array<ApprovalRequestQueueEntry | DecidedApprovalRequestQueueEntry>; nextCursor: string | null }> {
  const { requests, nextCursor } = await listApprovalRequestsPage(client, input);
  const entryOf = await loadQueueEntries(client, requests, input.locale);
  if (input.status === "pending") return { rows: requests.map(entryOf), nextCursor };
  return {
    rows: requests.map((request) => ({
      ...entryOf(request),
      status: request.status,
      decidedAt: request.decidedAt,
      executionStatus: request.executionStatus,
      conflictReason: approvalConflictReason(request.executionStatus, request.executionResult),
    })),
    nextCursor,
  };
}

/** The payload, arguments and execution result are never part of it. */
export interface LiveStepApproval {
  status: ApprovalRequest["status"];
  executionStatus: ApprovalRequest["executionStatus"];
  /** `null` unless `executionStatus` is `conflict`. */
  conflictReason: ApprovalConflictReason | null;
}

export type SempReplyStepWithApproval = SempReplyStep & {
  /** `null` when the request is gone or belongs to another user (indistinguishable). */
  approval?: LiveStepApproval | null;
};

function liveStepApproval(state: ApprovalRequestStateView | undefined): LiveStepApproval | null {
  if (state === undefined) return null;
  return {
    status: state.status,
    executionStatus: state.executionStatus,
    conflictReason: approvalConflictReason(state.executionStatus, state.executionResult),
  };
}

/**
 * One query for every step of the page. The stored steps are not rewritten; `approval` is added to the returned
 * copy.
 */
export async function attachLiveStepApprovals<M extends { steps?: SempReplyStep[] }>(
  client: Queryable,
  messages: readonly M[],
  ownerUserId: string,
): Promise<Array<Omit<M, "steps"> & { steps?: SempReplyStepWithApproval[] }>> {
  const ids = new Set(
    messages.flatMap((message) => (message.steps ?? []).flatMap((step) => step.approvalRequestId ?? [])),
  );
  const states = new Map(
    (await listApprovalRequestStatesByIdsForOwner(client, [...ids], ownerUserId)).map((state) => [state.id, state]),
  );
  return messages.map(({ steps, ...rest }) => ({
    ...rest,
    ...(steps === undefined
      ? {}
      : {
          steps: steps.map((step): SempReplyStepWithApproval =>
            step.approvalRequestId === undefined
              ? step
              : { ...step, approval: liveStepApproval(states.get(step.approvalRequestId)) },
          ),
        }),
  }));
}
