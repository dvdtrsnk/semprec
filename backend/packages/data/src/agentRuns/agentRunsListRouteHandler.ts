import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { resolveCatalogLabel } from "@semprec/module-registry";
import { getAgentRunCosts } from "../aiGateway/aiGatewayCallsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { durationMsOf, getAgentRunReplyOutcome } from "./agentRunDetail.js";
import { deriveRunDisplayStatus, type AgentRunDisplayStatus } from "./agentRunDisplayStatus.js";
import { agentRunErrorFields, getAgentRunCatalogs } from "./agentRunErrorSummary.js";
import { listProjectAgentRuns, listRunsOfOccurrences, type AgentRunRow, type TriggeredBy } from "./agentRunsStore.js";
import type { ReplyOutcome } from "./replyOutcome.js";

/**
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue #239), duck-typed
 * here as in `aiUsageRouteHandler.ts`. `req.url` carries the query string; the adapter always supplies the
 * caller, whose id scopes the runs and whose `users.locale` the labels and error summaries are written in.
 */
interface ListAgentRunsRouteRequestContext {
  req: { url?: string };
  identity: { user: { id: string; locale: string } };
}

type CustomRouteResult = { status: number; body: unknown };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const projectItemIdSchema = z.uuid();

/** One attempt of a heartbeat occurrence, as its row lists it (issue gh-1914). */
export interface ProjectAgentRunAttempt {
  id: string;
  /** The attempt number of the run (`agent_runs.attempt`). */
  attempt: number;
  startedAt: string;
  /** `durationMs` of the run detail (`durationMsOf`). */
  durationMs: number | null;
  /** The attempt's own cost (`getAgentRunCosts`), rounded to 15 significant digits as the row's `costUsd` is. */
  costUsd: number;
  /** `displayStatus` of the run detail for this attempt. */
  displayStatus: AgentRunDisplayStatus;
}

/**
 * One row of the project's list (issues gh-1909 and gh-1914). A row stands for one run, or for one heartbeat
 * occurrence: then it is the occurrence's latest attempt, and `attempts` lists every attempt.
 */
export interface ProjectAgentRunListRow {
  id: string;
  /** The `project_heartbeats.name` of the run's heartbeat for a run that names one, otherwise the run's `task`. */
  title: string;
  /** The stored `agent_runs.triggered_by`. */
  triggeredBy: TriggeredBy;
  /** The label of `triggeredBy` in the caller's locale (`agentRun.trigger.<triggeredBy>` of the agent run catalog). */
  triggerLabel: string;
  /** The start of the row's run: the latest attempt for an occurrence. */
  startedAt: string;
  /** `durationMs` of the run detail (`durationMsOf`) of the row's run; durations of attempts are not summed. */
  durationMs: number | null;
  /**
   * The sum of the AI gateway costs of the row's run (`getAgentRunCosts`), `0` for a run without calls; for an
   * occurrence the sum over all of its attempts; rounded to 15 significant digits to drop binary floating-point
   * noise, like the `costUsd` of each attempt, so a row with one attempt equals its entry.
   */
  costUsd: number;
  /** `displayStatus` of the run detail: `deriveRunDisplayStatus` over the run, its pending approvals and its reply. */
  displayStatus: AgentRunDisplayStatus;
  /** The bare reason of a run whose `displayStatus` is `error` in the caller's locale (`agentRunErrorFields`); `null` otherwise. */
  errorSummary: string | null;
  /** The attempt number of the row's run (`agent_runs.attempt`): `1` for a run that retries nothing. */
  attempt: number;
  /** Present exactly on a row of a heartbeat occurrence: all its attempts, `attempt` ascending. */
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

/** The `name` of every heartbeat the runs name, by heartbeat id, in one statement. */
async function readHeartbeatNames(client: PoolClient, runs: readonly AgentRunRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(runs.flatMap((run) => (run.heartbeatId === null ? [] : [run.heartbeatId])))];
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM project_heartbeats WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The number of pending approval requests of every run in `runIds` that has one, by run id, in one statement. */
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

/** What the display status of one run was derived from; the row of the run reads the reply for its error summary. */
interface RunStatusReading {
  displayStatus: AgentRunDisplayStatus;
  replyOutcome: ReplyOutcome | null;
}

/**
 * A cost as the list shows it: rounded to 15 significant digits, the precision a double holds for every decimal,
 * which drops binary floating-point noise (a gateway call settled at 0.30000000000000004 shows as 0.3). A cost
 * needing more than that was already beyond what a number in the response can carry. Every cost of a row goes
 * through here, the row's own and each attempt's, so the one entry of a single-attempt row equals the row.
 */
function roundCost(cost: number): number {
  return Number(cost.toPrecision(15));
}

/** The sum of `costs`, which are already rounded by `roundCost`, rounded again so that 0.1 and 0.2 sum to 0.3. */
function sumCosts(costs: readonly number[]): number {
  return roundCost(costs.reduce((total, cost) => total + cost, 0));
}

/**
 * The rows of `runs`, in their order (issues gh-1909 and gh-1914). The runs of the occurrences the rows stand for
 * are read in one statement, and the cost, the heartbeat names and the pending approval counts of all of those
 * runs are each read in at most one statement however many runs there are. A run that closed as `done` has its
 * reply read with one statement of its own (`getAgentRunReplyOutcome`), as the run detail does, because the
 * display status of a finished run depends on whether its reply left a failed tool call (issue #1890); an
 * attempt that failed has no reply read.
 */
async function projectRows(
  client: PoolClient,
  runs: readonly AgentRunRow[],
  locale: string,
): Promise<ProjectAgentRunListRow[]> {
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
  for (const run of runs) {
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
 * `GET /api/agent-runs?projectItemId=&limit=` (issues gh-1909 and gh-1914): the most recent runs of one project
 * that the session user started, newest first, as `{ rows }` of `ProjectAgentRunListRow`, shaped for exactly one
 * consumer, the project's agent page (`single-consumer-read`). `projectItemId` is required and must be a UUID;
 * `limit` defaults to 20 and takes an integer from 1 to 100; anything else is a `ValidationError`. The runs are
 * those of `listProjectAgentRuns`: the session user's own, never a supervisor's, and one row per heartbeat
 * occurrence, which carries its attempts. A project id that is unknown, or that belongs to another tenant,
 * answers `{ rows: [] }`, as any id that holds no run of the caller does. The tenant and the user come only from
 * the session, and the reads share one REPEATABLE READ snapshot.
 */
export function createListAgentRunsRouteHandler(pool: Pool) {
  return async (ctx: ListAgentRunsRouteRequestContext): Promise<CustomRouteResult> => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
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
