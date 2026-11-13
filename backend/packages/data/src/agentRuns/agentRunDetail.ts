import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { requireSingleRow, type Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { SEMP_THREAD_KINDS, type SempThreadKind } from "../semp/sempThreadsListStore.js";
import { deriveRunDisplayStatus, type AgentRunDisplayStatus } from "./agentRunDisplayStatus.js";
import type { AgentRunRow } from "./agentRunsStore.js";
import { replyOutcomeOfStoredSteps, type ReplyOutcome } from "./replyOutcome.js";

/** What started a run, as the run detail reports it (issue #1805). */
export type AgentRunTriggerKind = "user" | "tick" | "mcp" | "supervisor";

/** What `GET /api/agent-runs/:id` returns beside the run's own row (issue #1805). */
export interface AgentRunDetail {
  /**
   * What a client shows as the run's state (issue #1820): `deriveRunDisplayStatus` over the run's
   * `status`, the pending count of `approvals` below and, for a finished run, the outcome of its reply
   * (issue #1890: a run whose reply is incomplete reads `error`), evaluated on every read and never
   * stored. The row's own `status` is unchanged.
   */
  displayStatus: AgentRunDisplayStatus;
  /**
   * The name of the run's heartbeat for a run that names one, because the `task` of such a run is
   * the task text configured on the heartbeat's action; the run's `task` otherwise.
   */
  title: string;
  /**
   * The `name` of the run's project item; `null` for a run without a project, for a project item
   * that is in the Trash or gone, and for one whose `name` is not text.
   */
  projectName: string | null;
  /** The current `project_heartbeats.name` of the run's heartbeat; `null` for a run that names none. */
  heartbeatName: string | null;
  /**
   * The milliseconds between `startedAt` and `finishedAt` of a finished `invocation` run that no MCP
   * client started. `null` for a run that is still running, and for a `session` run and an MCP run,
   * whose two instants do not bound the time the work took: a session run can stay open while its
   * conversation idles, and an MCP run stays open until its credential expires.
   */
  durationMs: number | null;
  trigger: {
    /**
     * `tick` for a run a heartbeat started and for a run a user started in a tick thread (a
     * follow-up turn there); otherwise the run's `triggeredBy`.
     */
    kind: AgentRunTriggerKind;
    /** The run's Semp thread; `null` for a run without one, which every MCP run is. */
    threadId: string | null;
    /** The client name stored on an MCP run (issue #1788); `null` for every other run and for an MCP run without one. */
    mcpClientName: string | null;
  };
  /** The approval requests the run raised: how many there are, how many per status, and their ids from the oldest. */
  approvals: {
    count: number;
    pending: number;
    approved: number;
    rejected: number;
    requestIds: string[];
  };
}

async function getProjectName(client: Queryable, projectItemId: string | null): Promise<string | null> {
  if (projectItemId === null) return null;
  const [project] = await getItemsByIds(client, [projectItemId]);
  return typeof project?.properties.name === "string" ? project.properties.name : null;
}

function triggerKindOf(run: AgentRunRow, threadKind: SempThreadKind | null): AgentRunTriggerKind {
  if (run.triggeredBy === "heartbeat") return "tick";
  if (run.triggeredBy === "user" && threadKind === "tick") return "tick";
  return run.triggeredBy;
}

function durationMsOf(run: AgentRunRow): number | null {
  if (run.unit !== "invocation" || run.triggeredBy === "mcp" || run.finishedAt === null) return null;
  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}

/**
 * The outcome of the reply of `run` (issue #1890), derived on this read from the steps stored on the reply
 * (`replyOutcomeOfStoredSteps`, the derivation the reply list applies to every message it returns) and never
 * stored. The reply is the run's assistant message in the run's Semp thread; a tick's run has exactly one.
 * `null` when the run has no reply to judge: an MCP run has no thread and no reply, a run that has not written
 * one yet has none, and a run with several replies (a chat session) has no single reply that stands for the
 * run, so each of its replies carries its own outcome on the message list instead.
 */
export async function getAgentRunReplyOutcome(
  client: Queryable,
  run: Pick<AgentRunRow, "id" | "threadId" | "triggeredBy">,
): Promise<ReplyOutcome | null> {
  if (run.triggeredBy === "mcp" || run.threadId === null) return null;
  const { rows } = await client.query<{ steps: unknown }>(
    `SELECT steps FROM semp_messages WHERE thread_id = $1 AND agent_run_id = $2 AND role = 'assistant' LIMIT 2`,
    [run.threadId, run.id],
  );
  const [reply, other] = rows;
  if (reply === undefined || other !== undefined) return null;
  return replyOutcomeOfStoredSteps(reply.steps);
}

/**
 * Reads what the run detail shows beside the row of `run` (issue #1805): the project name, the
 * heartbeat name, the kind of the run's thread and the approval requests the run raised, and the
 * display status derived from the run, those requests and its reply (issues #1820 and #1890). It runs
 * the two statements of `getItemsByIds` for a run with a project, one statement for the heartbeat
 * and the thread and one aggregate over the run's approval requests, so the number of statements
 * does not depend on how many requests the run has. A finished run has its reply read with one more
 * statement (`getAgentRunReplyOutcome`), unless the caller that already read it passes it as
 * `replyOutcome` (`null` for a run without a reply).
 */
export async function getAgentRunDetail(
  client: Queryable,
  run: AgentRunRow,
  replyOutcome?: ReplyOutcome | null,
): Promise<AgentRunDetail> {
  const projectName = await getProjectName(client, run.projectItemId);
  const links = await client.query<{ heartbeat_name: string | null; thread_kind: string | null }>(
    `SELECT h.name AS heartbeat_name, t.kind AS thread_kind
     FROM agent_runs r
     LEFT JOIN project_heartbeats h ON h.id = r.heartbeat_id
     LEFT JOIN semp_threads t ON t.id = r.thread_id
     WHERE r.id = $1`,
    [run.id],
  );
  const { heartbeat_name: heartbeatName, thread_kind: storedThreadKind } = requireSingleRow(
    links.rows,
    "the heartbeat and thread of an agent run",
  );
  const threadKind =
    storedThreadKind === null ? null : assertKnownValue(SEMP_THREAD_KINDS, storedThreadKind, "thread kind");
  const approvals = await client.query<{
    count: number;
    pending: number;
    approved: number;
    rejected: number;
    request_ids: string[];
  }>(
    `SELECT count(*)::int AS count,
            (count(*) FILTER (WHERE status = 'pending'))::int AS pending,
            (count(*) FILTER (WHERE status = 'approved'))::int AS approved,
            (count(*) FILTER (WHERE status = 'rejected'))::int AS rejected,
            coalesce(array_agg(id ORDER BY requested_at, id), '{}') AS request_ids
     FROM approval_requests WHERE agent_run_id = $1`,
    [run.id],
  );
  const counted = requireSingleRow(approvals.rows, "the approval counts of an agent run");
  // Only a run that closed as done can be reclassified by its reply, so only that run reads it.
  const reply =
    run.status !== "done"
      ? null
      : replyOutcome === undefined
        ? await getAgentRunReplyOutcome(client, run)
        : replyOutcome;
  return {
    displayStatus: deriveRunDisplayStatus({ status: run.status, replyOutcome: reply?.outcome ?? null }, counted),
    title: heartbeatName ?? run.task,
    projectName,
    heartbeatName,
    durationMs: durationMsOf(run),
    trigger: {
      kind: triggerKindOf(run, threadKind),
      threadId: run.threadId,
      mcpClientName: run.triggeredBy === "mcp" ? run.mcpClientName : null,
    },
    approvals: {
      count: counted.count,
      pending: counted.pending,
      approved: counted.approved,
      rejected: counted.rejected,
      requestIds: counted.request_ids,
    },
  };
}
