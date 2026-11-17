import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { requireSingleRow, type Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { SEMP_THREAD_KINDS, type SempThreadKind } from "../semp/sempThreadsListStore.js";
import { deriveRunDisplayStatus, type AgentRunDisplayStatus } from "./agentRunDisplayStatus.js";
import type { AgentRunEventRange } from "./agentRunEventsStore.js";
import { getAgentRunCatalogs } from "./agentRunErrorSummary.js";
import type { AgentRunRow } from "./agentRunsStore.js";
import { replyOutcomeOfStoredSteps, type ReplyOutcome } from "./replyOutcome.js";

export type AgentRunTriggerKind = "user" | "tick" | "mcp" | "supervisor";

/** What `GET /api/agent-runs/:id` returns beside the run's own row. */
export interface AgentRunDetail {
  /** Derived on every read (`deriveRunDisplayStatus`) and never stored; the row's `status` is unchanged. */
  displayStatus: AgentRunDisplayStatus;
  /** The heartbeat's name when the run names one, because such a run's `task` is the heartbeat action's text. */
  title: string;
  /** `null` without a project, for a trashed or gone project item, and for a non-text `name`. */
  projectName: string | null;
  heartbeatName: string | null;
  /**
   * Only for a finished `invocation` run no MCP client started. A session run stays open while its conversation
   * idles and an MCP run until its credential expires, so their instants do not bound the work.
   */
  durationMs: number | null;
  trigger: {
    /** `tick` also for a user's follow-up turn in a tick thread. */
    kind: AgentRunTriggerKind;
    /** `null` for every MCP run. */
    threadId: string | null;
    mcpClientName: string | null;
  };
  /** Request ids are ordered oldest first. */
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

export function durationMsOf(
  run: Pick<AgentRunRow, "unit" | "triggeredBy" | "startedAt" | "finishedAt">,
): number | null {
  if (run.unit !== "invocation" || run.triggeredBy === "mcp" || run.finishedAt === null) return null;
  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}

/**
 * Derived from the reply's stored steps on every read. The reply is the run's assistant message in its thread (a
 * tick's run has exactly one). `null` for an MCP run, a run with no reply yet, and a run with several replies (a
 * chat session), whose replies each carry their own outcome on the message list.
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
 * The statement count does not depend on how many requests the run has. A finished run reads its reply with one
 * more statement unless the caller passes `replyOutcome` (which is ignored when `reply` is given).
 *
 * With `reply`, the work fields describe that one reply: its title, its stored duration, the requests whose tool
 * call lies in its events or stored steps, and a display status from its own outcome. Project, heartbeat and
 * trigger stay the run's. A request without a tool call id belongs to no reply.
 */
export async function getAgentRunDetail(
  client: Queryable,
  run: AgentRunRow,
  replyOutcome?: ReplyOutcome | null,
  reply?: AgentRunReplyScope,
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
            (count(*) FILTER (WHERE ar.status = 'pending'))::int AS pending,
            (count(*) FILTER (WHERE ar.status = 'approved'))::int AS approved,
            (count(*) FILTER (WHERE ar.status = 'rejected'))::int AS rejected,
            coalesce(array_agg(ar.id ORDER BY ar.requested_at, ar.id), '{}') AS request_ids
     FROM approval_requests ar
     WHERE ar.agent_run_id = $1
       AND (NOT $2::boolean OR (ar.tool_call_id IS NOT NULL AND (
         ar.tool_call_id = ANY($5::text[])
         OR EXISTS (
           SELECT 1 FROM agent_run_events e
           WHERE e.agent_run_id = ar.agent_run_id AND e.kind = 'tool_use' AND e.id >= $3::bigint
             AND ($4::bigint IS NULL OR e.id <= $4::bigint) AND e.payload->>'toolCallId' = ar.tool_call_id
         ))))`,
    [
      run.id,
      reply !== undefined,
      reply?.range?.fromEventId ?? null,
      reply?.range?.throughEventId ?? null,
      reply?.stepToolCallIds ?? [],
    ],
  );
  const counted = requireSingleRow(approvals.rows, "the approval counts of an agent run");
  // Only a run closed as done can be reclassified by its reply; a reply-scoped read judges `reply.runStatus` instead.
  const wholeRunOutcome =
    reply !== undefined || run.status !== "done"
      ? null
      : replyOutcome === undefined
        ? await getAgentRunReplyOutcome(client, run)
        : replyOutcome;
  return {
    displayStatus: deriveRunDisplayStatus(
      reply === undefined
        ? { status: run.status, replyOutcome: wholeRunOutcome?.outcome ?? null }
        : { status: reply.runStatus },
      counted,
    ),
    title: reply?.title ?? heartbeatName ?? run.task,
    projectName,
    heartbeatName,
    durationMs: reply === undefined ? durationMsOf(run) : reply.durationMs,
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

const REPLY_STATUSES = ["queued", "running", "done", "error"] as const;

/** For a `system_key` the catalog has no entry for. */
const GENERIC_REPLY_TITLE_KEY = "agentRun.replyTitle.system";

/** One reply of a chat conversation that `?messageId=` scopes the run detail and steps routes to. */
export interface AgentRunReplyScope {
  /** The latest attempt of the reply the request named. */
  messageId: string;
  /** `running` while queued or running, `error` when failed, else `done`. */
  runStatus: AgentRunRow["status"];
  /**
   * The user message text, else the localized `system_key` title; `null` when the reply answers no message (the run
   * detail then uses the run's title).
   */
  title: string | null;
  /** The message's creation time once retention removed the first event. */
  startedAt: string;
  durationMs: number | null;
  range: AgentRunEventRange | null;
  finished: boolean;
  /** From the summary stored on the message, which retention does not remove. */
  stepToolCallIds: string[];
}

export type AgentRunReplyResolution =
  /** The route answers 404. */
  | { kind: "notFound" }
  /** A heartbeat tick holds one message, so the whole run applies. */
  | { kind: "wholeRun" }
  | { kind: "reply"; reply: AgentRunReplyScope };

interface ReplyRow {
  id: string;
  status: string | null;
  created_at: Date;
  duration_ms: number | null;
  first_event_at: Date | null;
  event_from_id: string | null;
  through_event_id: string | null;
  has_error_step: boolean;
  step_tool_call_ids: string[];
  user_text: string | null;
  system_key: string | null;
}

export async function systemReplyTitle(systemKey: string, locale: string): Promise<string> {
  const catalogs = await getAgentRunCatalogs();
  const localized = catalogs[toManifestLocale(locale)];
  const lookup = (key: string): string | undefined => localized[key] ?? catalogs.en[key];
  return lookup(`agentRun.replyTitle.${systemKey}`) ?? lookup(GENERIC_REPLY_TITLE_KEY) ?? GENERIC_REPLY_TITLE_KEY;
}

/**
 * Another run's or tenant's message (row-level security), a user message and an unknown id are all `notFound`. A
 * non-`session` run is `wholeRun` once the message passed that check.
 *
 * A session run's scope is the newest assistant message answering the same `reply_to_message_id`, so a retried
 * reply shows its last attempt whichever one was named. A reply without `event_to_id` (failed or still running)
 * ends before the next reply's first event, or at the end of the run.
 */
export async function resolveAgentRunReply(
  client: Queryable,
  run: Pick<AgentRunRow, "id" | "unit">,
  messageId: string,
  locale: string,
): Promise<AgentRunReplyResolution> {
  if (run.unit !== "session") {
    const { rows } = await client.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM semp_messages WHERE id = $1 AND role = 'assistant' AND agent_run_id = $2) AS found`,
      [messageId, run.id],
    );
    return rows[0]?.found === true ? { kind: "wholeRun" } : { kind: "notFound" };
  }
  const { rows } = await client.query<ReplyRow>(
    `SELECT m.id, m.status, m.created_at, m.duration_ms, m.event_from_id,
            (SELECT e.at FROM agent_run_events e WHERE e.id = m.event_from_id AND e.agent_run_id = m.agent_run_id) AS first_event_at,
            COALESCE(m.event_to_id, (
              SELECT min(n.event_from_id) - 1 FROM semp_messages n
              WHERE n.agent_run_id = m.agent_run_id AND n.role = 'assistant' AND n.event_from_id > m.event_from_id
            )) AS through_event_id,
            EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.steps) = 'array' THEN m.steps ELSE '[]'::jsonb END) s
                    WHERE s->>'status' = 'error') AS has_error_step,
            COALESCE((SELECT array_agg(s->>'toolCallId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.steps) = 'array' THEN m.steps ELSE '[]'::jsonb END) s
                      WHERE jsonb_typeof(s->'toolCallId') = 'string'), '{}') AS step_tool_call_ids,
            CASE WHEN u.role = 'user' THEN u.text END AS user_text,
            CASE WHEN u.role = 'system' THEN u.system_key END AS system_key
     FROM semp_messages requested
     JOIN LATERAL (
       SELECT a.id, a.agent_run_id, a.reply_to_message_id, a.status, a.created_at, a.duration_ms, a.steps,
              a.event_from_id, a.event_to_id
       FROM semp_messages a
       WHERE a.role = 'assistant' AND a.agent_run_id = requested.agent_run_id AND a.thread_id = requested.thread_id
         AND (a.id = requested.id
              OR (requested.reply_to_message_id IS NOT NULL AND a.reply_to_message_id = requested.reply_to_message_id))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 1
     ) m ON true
     LEFT JOIN semp_messages u ON u.id = m.reply_to_message_id
     WHERE requested.id = $1 AND requested.role = 'assistant' AND requested.agent_run_id = $2`,
    [messageId, run.id],
  );
  const row = rows[0];
  if (!row) return { kind: "notFound" };
  // `status` is nullable in the table (a user message has none), but every assistant message has one.
  const status = assertKnownValue(REPLY_STATUSES, row.status ?? "null", "Semp message status");
  const finished = status === "done" || status === "error";
  const title = row.user_text ?? (row.system_key === null ? null : await systemReplyTitle(row.system_key, locale));
  return {
    kind: "reply",
    reply: {
      messageId: row.id,
      runStatus: status === "error" || row.has_error_step ? "error" : finished ? "done" : "running",
      title,
      startedAt: (row.first_event_at ?? row.created_at).toISOString(),
      durationMs: row.duration_ms,
      range:
        row.event_from_id === null ? null : { fromEventId: row.event_from_id, throughEventId: row.through_event_id },
      finished,
      stepToolCallIds: row.step_tool_call_ids,
    },
  };
}

/**
 * Retention removes events before a compaction checkpoint, so the message's first event may be gone while its
 * stored summary survives. A reply that stored no event is never truncated.
 */
export async function isAgentRunReplyHistoryTruncated(
  client: Queryable,
  runId: string,
  reply: Pick<AgentRunReplyScope, "range">,
): Promise<boolean> {
  if (reply.range === null) return false;
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agent_run_events WHERE agent_run_id = $1 AND id = $2::bigint) AS present`,
    [runId, reply.range.fromEventId],
  );
  return rows[0]?.present !== true;
}
