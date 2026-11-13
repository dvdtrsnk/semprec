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
 * `replyOutcome` (`null` for a run without a reply). `replyOutcome` describes the whole run and is ignored
 * when `reply` is given.
 *
 * With `reply` (issue #1889), the fields that describe the work of the run describe that one reply of the
 * conversation instead: `title` is the reply's, `durationMs` the one stored on its message, `approvals` count
 * the requests whose tool call lies in the reply's events (the `tool_use` events of its range or the steps
 * stored on its message), and `displayStatus` derives from the reply's own outcome and those requests. The
 * project, heartbeat and trigger stay the run's. A request stored without a tool call id belongs to no reply.
 * The number of statements is the same.
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
  // Only a run that closed as done can be reclassified by its reply, so only that run reads it. A reply-scoped
  // read judges the one reply it describes (`reply.runStatus`), so it reads no whole-run outcome.
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

/** The i18n key of the title of a reply that answers a system message with a `system_key` the catalog has no entry for. */
const GENERIC_REPLY_TITLE_KEY = "agentRun.replyTitle.system";

/**
 * One reply of a chat conversation as `GET /api/agent-runs/:id?messageId=` and
 * `GET /api/agent-runs/:id/steps?messageId=` scope the run to it (issue #1889): the assistant message in
 * the run, with the title, start and range of events that belong to it.
 */
export interface AgentRunReplyScope {
  /** The assistant message the scope describes: the latest attempt of the reply the request named. */
  messageId: string;
  /** What the reply's detail is computed from: `running` while it is queued or running, `error` when it failed, else `done`. */
  runStatus: AgentRunRow["status"];
  /**
   * The text of the user message the reply answers; for an answer to a system message without text (an approval
   * outcome) the title of its `system_key` in the caller's locale; `null` for a reply that answers no message,
   * which the run detail gives the title of the run.
   */
  title: string | null;
  /** When the reply's first event was stored; the time the message was created once retention removed that event. */
  startedAt: string;
  /** The `duration_ms` stored on the message when its turn ended; `null` while it runs and for a turn stored without one. */
  durationMs: number | null;
  /** The events of the reply; `null` for a reply that stored none. */
  range: AgentRunEventRange | null;
  /** The reply is over: its status is `done` or `error`, so its range gets no more events. */
  finished: boolean;
  /** The `toolCallId` of every step of the summary stored on the message, which retention does not remove. */
  stepToolCallIds: string[];
}

/** What `resolveAgentRunReply` found for a `messageId` of the run. */
export type AgentRunReplyResolution =
  /** Not an assistant message of the run in the caller's tenant: the route answers 404. */
  | { kind: "notFound" }
  /** The run is no chat conversation (a heartbeat tick holds one message), so the whole run applies. */
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

/** The title of a reply that answers the system message with `systemKey`, in `locale` (a `users.locale`). */
async function systemReplyTitle(systemKey: string, locale: string): Promise<string> {
  const catalogs = await getAgentRunCatalogs();
  const localized = catalogs[toManifestLocale(locale)];
  const lookup = (key: string): string | undefined => localized[key] ?? catalogs.en[key];
  return lookup(`agentRun.replyTitle.${systemKey}`) ?? lookup(GENERIC_REPLY_TITLE_KEY) ?? GENERIC_REPLY_TITLE_KEY;
}

/**
 * Resolves `messageId` against `run` for the reply-scoped reads (issue #1889). The message must be an assistant
 * message whose `agent_run_id` is the run, in the caller's tenant (row-level security): another run's message,
 * another tenant's, a user message and an unknown id are all `notFound`. A run that is not a `session` run
 * (a heartbeat tick, one message per run) is `wholeRun` once the message passed that check.
 *
 * The scope of a session run is the latest attempt of the reply: among the assistant messages of the run in
 * the same thread that answer the same message (`reply_to_message_id`), the newest by `created_at`, so a
 * retried reply shows its last attempt whichever attempt the request named. The reply's events run from its
 * `event_from_id` through its `event_to_id`; a reply that stored no `event_to_id` (a turn that ended in an
 * error, or one that is still running) ends before the first event of the next reply of the run, and at the
 * end of the run when there is none.
 *
 * `locale` is the caller's `users.locale`, in which a system title is written.
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
 * Whether the opening events of the reply are gone (issue #1889): the event the message names as its first
 * is no longer stored in the run. Retention (`handleAgentRunEventsRetentionTask`) removes events before a
 * compaction checkpoint, so what remains of the reply starts later; the summary stored on the message
 * survives. A reply that stored no event has no history to be missing.
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
