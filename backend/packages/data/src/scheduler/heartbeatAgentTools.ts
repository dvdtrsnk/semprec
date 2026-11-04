import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob } from "@semprec/queue";
import { withTransaction } from "../db/pool.js";
import {
  HeartbeatDisabledError,
  HeartbeatEventTriggeredError,
  HeartbeatRunningError,
  NotFoundError,
  type ActiveHeartbeatRunSummary,
} from "../errors.js";
import {
  getAgentRun,
  getRunningAgentRunOfHeartbeat,
  listAgentRunsByHeartbeat,
  type AgentRunRow,
} from "../agentRuns/agentRunsStore.js";
import {
  getHeartbeatForProject,
  hasWaitingHeartbeatFireJob,
  listHeartbeatsByProject,
  lockHeartbeatForManualFire,
  manualHeartbeatFireJobKey,
} from "./schedulerStore.js";
import { resolveAgentRunLane, resolveHeartbeatFireTaskName } from "./actions.js";
import { isOnItemEventRule, type HeartbeatRuleKindRegistry } from "./rule.js";

export const HEARTBEAT_HISTORY_DEFAULT_LIMIT = 10;
export const HEARTBEAT_HISTORY_MAX_LIMIT = 100;

/** Neither tool takes a project id — see the module doc comment below for why. */
export const heartbeatListArgsSchema = z.object({}).strict();
export type HeartbeatListArgs = z.infer<typeof heartbeatListArgsSchema>;

export const heartbeatHistoryArgsSchema = z
  .object({
    heartbeatId: z.string().uuid(),
    limit: z.number().int().positive().max(HEARTBEAT_HISTORY_MAX_LIMIT).optional(),
  })
  .strict();
export type HeartbeatHistoryArgs = z.infer<typeof heartbeatHistoryArgsSchema>;

export const heartbeatTriggerArgsSchema = z.object({ heartbeatId: z.string().uuid() }).strict();
export type HeartbeatTriggerArgs = z.infer<typeof heartbeatTriggerArgsSchema>;

/** The canonical, machine-matchable error `heartbeat.trigger` returns for an `onItemEvent` heartbeat (issue #136) — event rules only ever fire from the write that produced the event, never manually. */
export const HEARTBEAT_EVENT_TRIGGERED_ERROR = "heartbeat_event_triggered";

/** `heartbeat.trigger`'s error message for a heartbeat the user disabled via `setHeartbeatEnabled` (issue #685). */
const HEARTBEAT_DISABLED_ERROR = "this heartbeat is disabled; enable it before triggering it";

/** The message of the `HeartbeatEventTriggeredError` an `onItemEvent` manual trigger raises (issue #1453). */
const HEARTBEAT_EVENT_TRIGGERED_MESSAGE = "this heartbeat fires only from its triggering event, not on demand";

/** The message of the `HeartbeatRunningError` a manual trigger over HTTP raises while a run or a fire job is active (issue #1453). */
const HEARTBEAT_RUNNING_MESSAGE =
  "this heartbeat is already running or queued; wait for it to finish before triggering it again";

export interface HeartbeatListEntry {
  id: string;
  /** The heartbeat's assignment/purpose text (`project_heartbeats.name`), e.g. "Manifest drift check". */
  name: string;
  rule: unknown;
  enabled: boolean;
  lastFiredAt: string | null;
}

export interface HeartbeatHistoryEntry {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
}

/** Shaped like a pi-agent-core `tool_result` payload — the same local approximation `delegateTool.ts`'s `DelegateToolResult` uses. */
export interface HeartbeatAgentToolResult {
  error: boolean;
  result: string;
}

export type HeartbeatListTool = (currentRunId: string, args: unknown) => Promise<HeartbeatAgentToolResult>;
export type HeartbeatHistoryTool = (currentRunId: string, args: unknown) => Promise<HeartbeatAgentToolResult>;
export type HeartbeatTriggerTool = (currentRunId: string, args: unknown) => Promise<HeartbeatAgentToolResult>;

async function resolveCallingProjectItemId(pool: Pool, currentRunId: string): Promise<string | null> {
  const run = await getAgentRun(pool, currentRunId);
  return run?.projectItemId ?? null;
}

/**
 * `heartbeat.list` (issue #135): the calling agent's own project's heartbeat configuration —
 * full `rule`, assignment/purpose (`name`), `enabled` state, and `last_fired_at` — for every
 * heartbeat, agent-triggered and deterministic alike. Neither this tool nor `heartbeat.history`
 * below accepts a project id: the project is derived exclusively from the persisted
 * `agent_run.project_item_id` of `currentRunId`, so an agent cannot, by construction, list or
 * inspect another project's heartbeats — only delegation to a run in that project can.
 */
export function createHeartbeatListTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): HeartbeatListTool {
  return async function heartbeatList(currentRunId, rawArgs) {
    const parsedArgs = heartbeatListArgsSchema.safeParse(rawArgs ?? {});
    if (!parsedArgs.success) {
      return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    }

    const projectItemId = await resolveCallingProjectItemId(pool, currentRunId);
    if (!projectItemId) {
      return { error: true, result: `No project context for run ${currentRunId}` };
    }

    const heartbeats = await listHeartbeatsByProject(pool, projectItemId, moduleRuleKinds);
    const entries: HeartbeatListEntry[] = heartbeats.map((heartbeat) => ({
      id: heartbeat.id,
      name: heartbeat.name,
      rule: heartbeat.rule,
      enabled: heartbeat.enabled,
      lastFiredAt: heartbeat.lastFiredAt,
    }));

    return { error: false, result: JSON.stringify(entries) };
  };
}

/**
 * `heartbeat.history({heartbeatId, limit})` (issue #135): the last `limit` (default
 * `HEARTBEAT_HISTORY_DEFAULT_LIMIT`, bounded by `HEARTBEAT_HISTORY_MAX_LIMIT`) agent runs for
 * one of the calling agent's own heartbeats — status, timestamps, and `result`, never a full
 * transcript (those live in `agent_run_events`, untouched here). `heartbeatId` ownership is
 * checked with one scoped query (`getHeartbeatForProject`, `WHERE id = $1 AND
 * project_item_id = $2`), so an unknown id and a real id belonging to another project produce
 * the identical error — no way to distinguish "doesn't exist" from "not yours". A deterministic
 * heartbeat action that never started an agent run naturally returns an empty list, not an
 * error — there is no second run-log table for it to miss.
 */
export function createHeartbeatHistoryTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): HeartbeatHistoryTool {
  return async function heartbeatHistory(currentRunId, rawArgs) {
    const parsedArgs = heartbeatHistoryArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    }

    const projectItemId = await resolveCallingProjectItemId(pool, currentRunId);
    if (!projectItemId) {
      return { error: true, result: `No project context for run ${currentRunId}` };
    }

    const heartbeat = await getHeartbeatForProject(pool, projectItemId, parsedArgs.data.heartbeatId, moduleRuleKinds);
    if (!heartbeat) {
      return { error: true, result: `Heartbeat ${parsedArgs.data.heartbeatId} not found` };
    }

    const limit = parsedArgs.data.limit ?? HEARTBEAT_HISTORY_DEFAULT_LIMIT;
    const runs = await listAgentRunsByHeartbeat(pool, heartbeat.id, limit);
    const entries: HeartbeatHistoryEntry[] = runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      result: run.result,
    }));

    return { error: false, result: JSON.stringify(entries) };
  };
}

/**
 * `heartbeat.trigger({heartbeatId})` (issue #136): manually fires one of the calling agent's own
 * time-based heartbeats (`dailyTime`, `weekly`, `interval`, `everyNDays`) right now, without
 * waiting for the sweep. Ownership is the calling run's project: the lookup is scoped to it, so an
 * unknown id and one belonging to another project are indistinguishable.
 *
 * An `onItemEvent` heartbeat has no meaningful "now" to fire at outside the item write that
 * would trigger it — this returns `HEARTBEAT_EVENT_TRIGGERED_ERROR` (the canonical 409) and
 * enqueues nothing, rather than firing with no `itemId`.
 *
 * A heartbeat the user disabled via `setHeartbeatEnabled` is refused with no job enqueued,
 * the same rule the sweep and `prepareHeartbeatOccurrenceFire` already enforce for scheduled fires.
 * The lookup row-locks the heartbeat, and the `enabled` check and the enqueue run in the same
 * `withTransaction` (`enqueueManualHeartbeatFire`), so a concurrent `setHeartbeatEnabled(false)`
 * waits for it and cannot slip a job past the disabled check.
 *
 * The enqueued job payload carries `triggeredByRunId: currentRunId`, which `coreAgentRunAction`
 * (scheduler/actions.ts) writes onto the new run as `parent_run_id` — the child run's history
 * identifies exactly which run manually invoked it. The job key
 * (`manualHeartbeatFireJobKey`) is deliberately distinct from the sweep's own
 * `heartbeatFireJobKey`: a pending scheduled fire and a pending manual fire never collapse onto
 * or overwrite each other's attribution, while repeated manual triggers before the first has
 * started running do collapse onto the same job (graphile-worker's `job_key` replace semantics).
 * This never touches `next_fire_at`/`last_fired_at` — those are the sweep's own bookkeeping,
 * untouched by a manual fire.
 */
export function createHeartbeatTriggerTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
  options: { refuseWhileActive?: boolean } = {},
): HeartbeatTriggerTool {
  return async function heartbeatTrigger(currentRunId, rawArgs) {
    const parsedArgs = heartbeatTriggerArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    }

    const projectItemId = await resolveCallingProjectItemId(pool, currentRunId);
    if (!projectItemId) {
      return { error: true, result: `No project context for run ${currentRunId}` };
    }

    try {
      const fired = await withTransaction(pool, (client) =>
        enqueueManualHeartbeatFire(
          client,
          {
            heartbeatId: parsedArgs.data.heartbeatId,
            projectItemId,
            trigger: { triggeredByRunId: currentRunId },
            refuseWhileActive: options.refuseWhileActive ?? false,
          },
          moduleRuleKinds,
        ),
      );
      return { error: false, result: JSON.stringify({ heartbeatId: fired.heartbeatId }) };
    } catch (err) {
      const refusal = refusalForAgentTool(err, parsedArgs.data.heartbeatId);
      if (refusal) return refusal;
      throw err;
    }
  };
}

/**
 * Maps the refusals `enqueueManualHeartbeatFire` raises onto the tool's own results, byte for byte
 * the results this tool gave before issue #1453 extracted the enqueue. Any other error is not a
 * refusal this tool knows, so it is rethrown rather than reported as a result.
 */
function refusalForAgentTool(err: unknown, heartbeatId: string): HeartbeatAgentToolResult | null {
  if (err instanceof NotFoundError) return { error: true, result: `Heartbeat ${heartbeatId} not found` };
  if (err instanceof HeartbeatEventTriggeredError) return { error: true, result: HEARTBEAT_EVENT_TRIGGERED_ERROR };
  if (err instanceof HeartbeatDisabledError) return { error: true, result: HEARTBEAT_DISABLED_ERROR };
  if (err instanceof HeartbeatRunningError) return { error: true, result: HEARTBEAT_RUNNING_MESSAGE };
  return null;
}

/** The trigger attributed to a manual fire: the agent run whose `heartbeat.trigger` called it, or the person who pressed Run (issue #1453). */
export type ManualHeartbeatFireTrigger = { triggeredByRunId: string } | { triggeredByUserId: string };

export interface ManualHeartbeatFireRequest {
  heartbeatId: string;
  /** The agent tool passes the calling run's project and the lookup stays inside it; the HTTP route passes `null` and the lookup is tenant-scoped only. */
  projectItemId: string | null;
  trigger: ManualHeartbeatFireTrigger;
  /**
   * `true` on the HTTP route (issue #1453): a run of the heartbeat that is running, or a fire job of
   * it that is waiting, refuses the trigger with `HeartbeatRunningError`. `false` on the agent tool,
   * which keeps its earlier behaviour: a repeat trigger merges into a waiting job, and it may enqueue
   * alongside a running one.
   */
  refuseWhileActive: boolean;
}

export interface ManualHeartbeatFireOutcome {
  heartbeatId: string;
  jobKey: string;
}

function summarizeActiveRun(run: AgentRunRow): ActiveHeartbeatRunSummary {
  return {
    id: run.id,
    status: run.status,
    triggeredBy: run.triggeredBy,
    startedAt: run.startedAt,
    threadId: run.threadId,
  };
}

/**
 * The one enqueue behind every manual fire (issue #136's `heartbeat.trigger`; issue #1453's
 * `POST /api/heartbeats/:id/trigger`, and the failed-run retry of #1908 once it lands). It runs in
 * the caller's transaction and refuses with a typed error instead of enqueuing:
 *
 * - `NotFoundError` for an unknown id, or one outside `projectItemId` (both give the same answer);
 * - `HeartbeatEventTriggeredError` for an `onItemEvent` heartbeat, which only fires from its item write;
 * - `HeartbeatDisabledError` for a disabled heartbeat;
 * - `HeartbeatRunningError` when `refuseWhileActive` is set and a run of the heartbeat is running or a
 *   fire job of it is waiting. `details.activeRun` is that run, or `null` while only a job is waiting.
 *
 * The heartbeat row is locked `FOR UPDATE` by `lockHeartbeatForManualFire`, so the checks and the
 * enqueue run against one state: a concurrent `setHeartbeatEnabled(false)` waits for this transaction
 * and cannot slip a job past the disabled check, and a second caller for the same heartbeat waits for
 * this one and then sees the job it committed.
 *
 * The enqueued payload carries the trigger's discriminator; `coreAgentRunAction` (scheduler/actions.ts)
 * writes `triggeredByRunId` onto the new run as `parent_run_id`, and `triggeredByUserId` as its actor
 * with no parent. The job key (`manualHeartbeatFireJobKey`) is deliberately distinct from the sweep's
 * own `heartbeatFireJobKey`: a pending scheduled fire and a pending manual fire never collapse onto or
 * overwrite each other's attribution, while repeated manual triggers before the first has started
 * running do collapse onto the same job (graphile-worker's `job_key` replace semantics). This never
 * touches `next_fire_at`/`last_fired_at`, the sweep's own bookkeeping.
 */
export async function enqueueManualHeartbeatFire(
  client: PoolClient,
  request: ManualHeartbeatFireRequest,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): Promise<ManualHeartbeatFireOutcome> {
  const heartbeat = await lockHeartbeatForManualFire(
    client,
    request.heartbeatId,
    request.projectItemId,
    moduleRuleKinds,
  );
  if (!heartbeat) throw new NotFoundError(`Heartbeat ${request.heartbeatId} not found`);

  if (isOnItemEventRule(heartbeat.rule)) {
    throw new HeartbeatEventTriggeredError(HEARTBEAT_EVENT_TRIGGERED_MESSAGE);
  }

  if (!heartbeat.enabled) {
    throw new HeartbeatDisabledError(HEARTBEAT_DISABLED_ERROR);
  }

  if (request.refuseWhileActive) {
    const activeRun = await getRunningAgentRunOfHeartbeat(client, heartbeat.id);
    if (activeRun || (await hasWaitingHeartbeatFireJob(client, heartbeat.id))) {
      throw new HeartbeatRunningError(HEARTBEAT_RUNNING_MESSAGE, {
        activeRun: activeRun ? summarizeActiveRun(activeRun) : null,
      });
    }
  }

  const jobKey = manualHeartbeatFireJobKey(heartbeat.id);
  await enqueueJob(
    client,
    resolveHeartbeatFireTaskName(heartbeat.actionId),
    { heartbeatId: heartbeat.id, ...request.trigger },
    {
      jobKey,
      maxAttempts: 3,
      queueName: resolveAgentRunLane(heartbeat.actionId),
    },
  );

  return { heartbeatId: heartbeat.id, jobKey };
}
