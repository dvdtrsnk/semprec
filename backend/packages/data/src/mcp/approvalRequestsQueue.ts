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
 * generic-operation-originated request (issue #220), `toolName` only for a module-agent-tool
 * request (issue #1791) — the three payload shapes never mix on the same entry, and the `kind` tag
 * lets a client narrow to the right one instead of every field reading `string | undefined`
 * regardless of the entry's actual origin.
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
  | { kind: "genericOperation"; operationName: string; argKeys: string[] }
  | { kind: "moduleTool"; toolName: string; argKeys: string[] };

/**
 * Where an approval request came from (issue #1766), derived when it is read from the run that
 * raised it and never stored on the request.
 */
export interface ApprovalRequestSource {
  /**
   * `tick`: a tick thread, or a run without a thread whose root run a heartbeat started. `mcp`: a run
   * without a thread whose root run an external MCP client started. `chat`: a chat or item thread, and
   * every other run. The root run is the run at which following `parent_run_id` ends
   * (`getRootAgentRuns`); a run without a parent is its own root. For a run without a thread only the
   * root run's `triggered_by` decides the kind.
   */
  kind: ApprovalRequestSourceKind;
  /** The Semp thread of the run that raised the request; `null` when that run has no thread. */
  threadId: string | null;
  /** The thread's title by the rule of the thread list; `null` without a thread, and for a thread that has no title. */
  threadTitle: string | null;
  /** The heartbeat of a `tick` source; `null` for the other kinds, and for a tick run that names no heartbeat. */
  heartbeatId: string | null;
  /** The current `project_heartbeats.name` of `heartbeatId`; `null` with it. */
  heartbeatName: string | null;
  /** The name of the MCP client of a `mcp` source. The source does not read the name a run stores (issue #1788), so it is `null`. */
  mcpClientName: string | null;
}

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
  /** The active value links the request would end (issue #1758); empty for a request that ends none. */
  breaksLinks: BreaksLinkEntry[];
  /** The links that follow a broken link's property and so lose its value; empty when there are none. */
  endsInheritance: EndsInheritanceEntry[];
  source: ApprovalRequestSource;
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
  /** As on `ApprovalRequestQueueEntry`, so the single-request read carries the same lists as the list. */
  breaksLinks: BreaksLinkEntry[];
  endsInheritance: EndsInheritanceEntry[];
  source: ApprovalRequestSource;
}

/** The `semp_threads` columns a source is derived from. */
interface SourceThreadRow {
  id: string;
  kind: string;
  title: string | null;
  heartbeat_id: string | null;
  subject_inbox_item_id: string | null;
}

/** The value of `key` in `map`; `null` for a `null` key and for a key the map does not hold. */
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

/** The fields of a source that has neither a thread nor a heartbeat. */
const NO_SOURCE_DETAIL = {
  threadId: null,
  threadTitle: null,
  heartbeatId: null,
  heartbeatName: null,
  mcpClientName: null,
};

/** The kind of the source of a run that has a thread: a tick thread is `tick`, a chat or item thread `chat`. */
function threadSourceKind(threadKind: SempThreadKind): ApprovalRequestSourceKind {
  return threadKind === "tick" ? "tick" : "chat";
}

/**
 * The kind of the source of a run without a thread, from the `triggered_by` of its root run: `mcp`
 * is `mcp`, `heartbeat` is `tick`, and anything else, a root run that was not read included, is `chat`.
 */
function rootSourceKind(root: AgentRunRow | undefined): ApprovalRequestSourceKind {
  if (root?.triggeredBy === "mcp") return "mcp";
  return root?.triggeredBy === "heartbeat" ? "tick" : "chat";
}

/**
 * Reads what the sources of the requests of `runs` are derived from and returns the derivation by
 * run id (issue #1766). It reads the threads, the parent runs level by level, the heartbeats and the
 * Inbox items of item threads, each for all `runs` at once, so the number of queries does not grow
 * with the number of runs.
 *
 * A run that has a thread takes its source from the thread: a chat or item thread is `chat`, a tick
 * thread is `tick` with the thread's heartbeat, also when the heartbeat's run was started by a chat
 * run. `threadTitle` is the title the thread list shows for `locale`. A run without a thread takes
 * its kind from the `triggered_by` of its root run (`getRootAgentRuns`): `mcp` is `mcp`, `heartbeat`
 * is `tick` with the root run's heartbeat, and anything else is `chat`.
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
        // Only a tick thread stores a heartbeat (`semp_threads_kind_columns_check`).
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

/**
 * The kind of the source of a request raised by run `agentRunId` (issue #1787), for a caller that
 * needs it when it creates the request. It applies the rules the queue derives `source.kind` by
 * (`threadSourceKind`, `rootSourceKind`): the kind of the run's thread, and for a run without a
 * visible thread the root run that `getRootAgentRuns` reaches. `null` when the run is not visible
 * to `client`.
 */
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

/** `locale` is the caller's `users.locale`; the title of an item thread in `source` is written in it. */
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

/**
 * Reads what the queue entries of `requests` are joined with and returns the projection of one of
 * them: the source project's display name and agent-run id, so the UI can show "where this came
 * from" without a per-project detour, the MCP names of `safeSummary` and the `source` (issue #1766,
 * `loadApprovalSources`). `agent_runs.project_item_id` and `items.id` carry no Postgres FK to each
 * other (see `0001_core_schema.sql`'s header note on partitioned `items`), so both joins are done
 * here as two batched follow-up reads instead of one SQL join. `locale` is the caller's
 * `users.locale`, in which the title of an item thread is written.
 */
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

/**
 * The approval queue's read model (issue #132): every pending request of `ownerUserId`'s runs
 * across every project, oldest first, as `loadQueueEntries` projects it. This is the answer of
 * `GET /api/approval-requests` without parameters; `listApprovalRequestsQueuePage` is the paged one.
 */
export async function listApprovalRequestsQueue(
  client: Queryable,
  ownerUserId: string,
  locale: string,
): Promise<ApprovalRequestQueueEntry[]> {
  const pending = await listPendingApprovalRequests(client, ownerUserId);
  if (pending.length === 0) return [];
  return pending.map(await loadQueueEntries(client, pending, locale));
}

/** A row of the decided list (issue #1785): the queue entry, the decision and what became of it. */
export interface DecidedApprovalRequestQueueEntry extends ApprovalRequestQueueEntry {
  status: ApprovalRequest["status"];
  decidedAt: string | null;
  executionStatus: ApprovalRequest["executionStatus"];
  /** Why an approved request was not carried out; `null` unless `executionStatus` is `conflict`. */
  conflictReason: ApprovalConflictReason | null;
}

/**
 * One page of the owner's requests as queue entries (issue #1785): `listApprovalRequestsPage`
 * selects and orders the requests of the page and `loadQueueEntries` projects them. A row of the
 * decided list also carries `status`, `decidedAt`, `executionStatus` and `conflictReason`; a row of
 * the pending list has exactly the fields `listApprovalRequestsQueue` returns.
 */
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

/**
 * The live state of the approval request a stored Semp reply step asked for (issue #1887): the three fields a
 * reader may see. The payload, the arguments and the execution result are never part of it.
 */
export interface LiveStepApproval {
  status: ApprovalRequest["status"];
  executionStatus: ApprovalRequest["executionStatus"];
  /** Why an approved request was not carried out; `null` unless `executionStatus` is `conflict`. */
  conflictReason: ApprovalConflictReason | null;
}

/** A stored step as the messages read returns it: with `approval` on a step that carries an `approvalRequestId`. */
export type SempReplyStepWithApproval = SempReplyStep & {
  /** `null` when the request no longer exists or its run belongs to another user than the caller. */
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
 * Attaches the live approval state to the steps of `messages`, the messages of one page of a Semp thread
 * (issue #1887). The requests of every step of the page that carries an `approvalRequestId` are read in one
 * query, owned by `ownerUserId`, and each such step gets `approval`: the request's `status`, `executionStatus`
 * and `conflictReason` as they are now, or `null` when the caller's scope reads no such request (a missing one
 * and one of another user cannot be told apart). A step without an `approvalRequestId` is returned as it is. The
 * stored steps are not rewritten: the object is added to the copy that is returned.
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
