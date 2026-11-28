import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { resolveCatalogLabel } from "@alldots/module-registry";
import { getAgentRunCosts, getSempMessageCosts } from "../aiGateway/aiGatewayCallsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { durationMsOf, getAgentRunReplyOutcome, systemReplyTitle } from "./agentRunDetail.js";
import { deriveRunDisplayStatus, type AgentRunDisplayStatus } from "./agentRunDisplayStatus.js";
import { agentRunErrorFields, getAgentRunCatalogs } from "./agentRunErrorSummary.js";
import {
  listProjectAgentRuns,
  listRunsOfOccurrences,
  type AgentRunRow,
  type ProjectAgentRunAnswer,
  type ProjectAgentRunListEntry,
  type TriggeredBy,
} from "./agentRunsStore.js";
import { replyOutcomeOfStoredSteps, type ReplyOutcome } from "./replyOutcome.js";
import type { CustomRouteResult, RouteUser, RouteLocale, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const projectItemIdSchema = z.uuid();

export interface ProjectAgentRunAttempt {
  id: string;
  attempt: number;
  startedAt: string;
  durationMs: number | null;
  /** Rounded like the row's `costUsd`. */
  costUsd: number;
  displayStatus: AgentRunDisplayStatus;
}

/**
 * A row is one run, one heartbeat occurrence (its latest attempt, with `attempts` listing all), or one answer of a
 * chat run (`messageId` set; the row describes that answer alone).
 */
export interface ProjectAgentRunListRow {
  /** Shared by the rows of one chat run; `messageId` tells them apart. */
  id: string;
  agentRunId: string;
  /** `null` except on an answer row. */
  messageId: string | null;
  /**
   * The heartbeat name, else the run's `task`. An answer row uses the user message text, else the localized
   * `system_key` title of a text-less system message, else the run's `task`.
   */
  title: string;
  triggeredBy: TriggeredBy;
  /** An answer row in a heartbeat tick thread keeps the `heartbeat` label, even for a follow-up or approval turn. */
  triggerLabel: string;
  startedAt: string;
  /** Attempt durations are not summed. An answer row uses the message's `duration_ms` (`null` until the turn ends). */
  durationMs: number | null;
  /**
   * An occurrence sums all its attempts. An answer row sums only the calls attributed to its message, never the
   * whole chat run.
   */
  costUsd: number;
  /** An answer row derives it from the message's status, reply outcome and its turn's pending approvals. */
  displayStatus: AgentRunDisplayStatus;
  errorSummary: string | null;
  attempt: number;
  /** Present exactly on a heartbeat occurrence row, `attempt` ascending. */
  attempts?: ProjectAgentRunAttempt[];
}

function parseProjectItemId(raw: string | null): string {
  const parsed = projectItemIdSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError("'projectItemId' must be a UUID string", { field: "projectItemId" });
  return parsed.data;
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const limit = /^[0-9]{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) {
    throw new ValidationError(`'limit' must be an integer from 1 to ${MAX_LIMIT}`, { field: "limit" });
  }
  return limit;
}

async function readHeartbeatNames(client: PoolClient, runs: readonly AgentRunRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(runs.flatMap((run) => (run.heartbeatId === null ? [] : [run.heartbeatId])))];
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM project_heartbeats WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function readPendingApprovalCounts(client: PoolClient, runIds: readonly string[]): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map();
  const { rows } = await client.query<{ agent_run_id: string; pending: number }>(
    `SELECT agent_run_id, count(*)::int AS pending
     FROM approval_requests
     WHERE agent_run_id = ANY($1::uuid[]) AND status = 'pending'
     GROUP BY agent_run_id`,
    [runIds],
  );
  return new Map(rows.map((row) => [row.agent_run_id, row.pending]));
}

/**
 * Matches the reply-scoped run detail: a request belongs to the answer whose turn made its tool call (a
 * `toolCallId` of the message's stored steps, or of a `tool_use` in its event range; a turn without `event_to_id`
 * ends before the next reply's first event). A request without a tool call id belongs to no answer.
 */
async function readPendingApprovalCountsOfAnswers(
  client: PoolClient,
  messageIds: readonly string[],
): Promise<Map<string, number>> {
  if (messageIds.length === 0) return new Map();
  const { rows } = await client.query<{ message_id: string; pending: number }>(
    `SELECT m.id AS message_id, count(*)::int AS pending
     FROM semp_messages m
     JOIN approval_requests ar ON ar.agent_run_id = m.agent_run_id AND ar.status = 'pending' AND ar.tool_call_id IS NOT NULL
     WHERE m.id = ANY($1::uuid[]) AND (
       ar.tool_call_id IN (
         SELECT s->>'toolCallId'
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.steps) = 'array' THEN m.steps ELSE '[]'::jsonb END) s
         WHERE jsonb_typeof(s->'toolCallId') = 'string')
       OR EXISTS (
         SELECT 1 FROM agent_run_events e
         WHERE e.agent_run_id = ar.agent_run_id AND e.kind = 'tool_use' AND m.event_from_id IS NOT NULL
           AND e.id >= m.event_from_id
           AND e.id <= COALESCE(
             m.event_to_id,
             (SELECT min(n.event_from_id) - 1 FROM semp_messages n
              WHERE n.agent_run_id = m.agent_run_id AND n.role = 'assistant' AND n.event_from_id > m.event_from_id),
             9223372036854775807::bigint)
           AND e.payload->>'toolCallId' = ar.tool_call_id))
     GROUP BY m.id`,
    [messageIds],
  );
  return new Map(rows.map((row) => [row.message_id, row.pending]));
}

interface RunStatusReading {
  displayStatus: AgentRunDisplayStatus;
  replyOutcome: ReplyOutcome | null;
}

/**
 * 15 significant digits drops binary floating-point noise (0.30000000000000004 shows as 0.3). Every cost of a
 * row goes through here, so a single-attempt row equals its one attempt entry.
 */
function roundCost(cost: number): number {
  return Number(cost.toPrecision(15));
}

/** Rounded again so that 0.1 and 0.2 sum to 0.3. */
function sumCosts(costs: readonly number[]): number {
  return roundCost(costs.reduce((total, cost) => total + cost, 0));
}

interface AnswerRowContext {
  locale: string;
  catalogs: Awaited<ReturnType<typeof getAgentRunCatalogs>>;
  messageCosts: ReadonlyMap<string, number>;
  pendingOfMessages: ReadonlyMap<string, number>;
}

function runStatusOfReply(status: ProjectAgentRunAnswer["status"]): AgentRunRow["status"] {
  if (status === "error") return "error";
  return status === "done" ? "done" : "running";
}

/**
 * Start, duration, cost, status, error and attempt come from the message; display status and error summary go
 * through the same functions as a run's, so a done reply that left a failed tool call reads `error`.
 */
async function projectAnswerRow(
  run: AgentRunRow,
  answer: ProjectAgentRunAnswer,
  context: AnswerRowContext,
): Promise<ProjectAgentRunListRow> {
  const { locale, catalogs } = context;
  const replyOutcome = answer.status === "done" ? replyOutcomeOfStoredSteps(answer.steps) : null;
  const status = runStatusOfReply(answer.status);
  const displayStatus = deriveRunDisplayStatus(
    { status, replyOutcome: replyOutcome?.outcome ?? null },
    { pending: context.pendingOfMessages.get(answer.messageId) ?? 0 },
  );
  const incompleteReply = displayStatus === "error" && replyOutcome?.outcome === "incomplete" ? replyOutcome : null;
  const title =
    answer.userText ??
    (answer.systemKey === null ? undefined : await systemReplyTitle(answer.systemKey, locale)) ??
    run.task;
  return {
    id: run.id,
    agentRunId: run.id,
    messageId: answer.messageId,
    title,
    triggeredBy: run.triggeredBy,
    triggerLabel: resolveCatalogLabel(
      null,
      catalogs[toManifestLocale(locale)],
      catalogs.en,
      `agentRun.trigger.${answer.threadKind === "tick" ? "heartbeat" : run.triggeredBy}`,
    ),
    startedAt: answer.startedAt,
    durationMs: answer.durationMs,
    costUsd: context.messageCosts.get(answer.messageId) ?? 0,
    displayStatus,
    errorSummary: (await agentRunErrorFields({ status, errorCode: answer.errorCode }, locale, incompleteReply))
      .errorSummary,
    attempt: answer.attempt,
  };
}

/**
 * Every batched read is one statement regardless of row count (none for answer data when there is no answer
 * row). Only a run closed as `done` gets its reply read, because its display status depends on whether the reply
 * left a failed tool call; an answer row is judged by the steps stored on its message.
 */
async function projectRows(
  client: PoolClient,
  entries: readonly ProjectAgentRunListEntry[],
  locale: string,
): Promise<ProjectAgentRunListRow[]> {
  const runs = entries.filter((entry) => entry.answer === null);
  const occurrenceRuns = await listRunsOfOccurrences(client, [
    ...new Set(runs.flatMap((run) => (run.heartbeatOccurrenceId === null ? [] : [run.heartbeatOccurrenceId]))),
  ]);
  const attemptsOf = new Map<string, AgentRunRow[]>();
  for (const attempt of occurrenceRuns) {
    const key = attempt.heartbeatOccurrenceId;
    if (key !== null) attemptsOf.set(key, [...(attemptsOf.get(key) ?? []), attempt]);
  }
  const runIds = [...new Set([...runs, ...occurrenceRuns].map((run) => run.id))];
  const catalogs = await getAgentRunCatalogs();
  const costs = await getAgentRunCosts(client, runIds);
  const heartbeatNames = await readHeartbeatNames(client, runs);
  const pending = await readPendingApprovalCounts(client, runIds);
  const messageIds = entries.flatMap((entry) => (entry.answer === null ? [] : [entry.answer.messageId]));
  const messageCosts = new Map(
    [...(await getSempMessageCosts(client, messageIds))].map(([id, cost]) => [id, roundCost(cost)]),
  );
  const pendingOfMessages = await readPendingApprovalCountsOfAnswers(client, messageIds);
  const readings = new Map<string, RunStatusReading>();
  const readStatus = async (run: AgentRunRow): Promise<RunStatusReading> => {
    const known = readings.get(run.id);
    if (known !== undefined) return known;
    const replyOutcome = run.status === "done" ? await getAgentRunReplyOutcome(client, run) : null;
    const reading = {
      displayStatus: deriveRunDisplayStatus(
        { status: run.status, replyOutcome: replyOutcome?.outcome ?? null },
        { pending: pending.get(run.id) ?? 0 },
      ),
      replyOutcome,
    };
    readings.set(run.id, reading);
    return reading;
  };
  const rows: ProjectAgentRunListRow[] = [];
  for (const run of entries) {
    if (run.answer !== null) {
      rows.push(await projectAnswerRow(run, run.answer, { locale, catalogs, messageCosts, pendingOfMessages }));
      continue;
    }
    const { displayStatus, replyOutcome } = await readStatus(run);
    const incompleteReply = displayStatus === "error" && replyOutcome?.outcome === "incomplete" ? replyOutcome : null;
    const group = run.heartbeatOccurrenceId === null ? undefined : attemptsOf.get(run.heartbeatOccurrenceId);
    let attempts: ProjectAgentRunAttempt[] | undefined;
    if (group !== undefined) {
      attempts = [];
      for (const attempt of group) {
        attempts.push({
          id: attempt.id,
          attempt: attempt.attempt,
          startedAt: attempt.startedAt,
          durationMs: durationMsOf(attempt),
          costUsd: roundCost(costs.get(attempt.id) ?? 0),
          displayStatus: (await readStatus(attempt)).displayStatus,
        });
      }
    }
    rows.push({
      id: run.id,
      agentRunId: run.id,
      messageId: null,
      title: (run.heartbeatId === null ? undefined : heartbeatNames.get(run.heartbeatId)) ?? run.task,
      triggeredBy: run.triggeredBy,
      triggerLabel: resolveCatalogLabel(
        null,
        catalogs[toManifestLocale(locale)],
        catalogs.en,
        `agentRun.trigger.${run.triggeredBy}`,
      ),
      startedAt: run.startedAt,
      durationMs: durationMsOf(run),
      costUsd:
        attempts === undefined
          ? roundCost(costs.get(run.id) ?? 0)
          : sumCosts(attempts.map((attempt) => attempt.costUsd)),
      displayStatus,
      errorSummary: (await agentRunErrorFields(run, locale, incompleteReply)).errorSummary,
      attempt: run.attempt,
      ...(attempts === undefined ? {} : { attempts }),
    });
  }
  return rows;
}

/**
 * `GET /api/agent-runs?projectItemId=&limit=`, shaped for the project's agent page only. `limit` (default 20,
 * 1-100) counts rows. Only the session user's own runs, never a supervisor's. An unknown or foreign project id
 * answers `{ rows: [] }`. Tenant and user come only from the session, whose `users.locale` localizes labels and
 * summaries; all reads share one REPEATABLE READ snapshot.
 */
export function createListAgentRunsRouteHandler(pool: Pool) {
  return async (ctx: RouteUser & RouteLocale & RouteUrl): Promise<CustomRouteResult> => {
    const url = requestUrl(ctx.req);
    const projectItemId = parseProjectItemId(url.searchParams.get("projectItemId"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const rows = await withTransaction(
      pool,
      async (client) => {
        const runs = await listProjectAgentRuns(client, { projectItemId, actorUserId: ctx.identity.user.id, limit });
        return projectRows(client, runs, ctx.identity.user.locale);
      },
      { isolation: "repeatable_read" },
    );
    return { status: 200, body: { rows } };
  };
}
