import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob } from "@alldots/queue";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
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
  getHeartbeatVisibleToChatRun,
  hasWaitingHeartbeatFireJob,
  listHeartbeatsByProject,
  listHeartbeatsVisibleToChatRun,
  lockHeartbeatForManualFire,
  manualHeartbeatFireJobKey,
  type HeartbeatRow,
} from "./schedulerStore.js";
import { resolveAgentRunLane, resolveHeartbeatFireTaskName } from "./actions.js";
import { isOnItemEventRule, type HeartbeatRuleKindRegistry } from "./rule.js";
import { resolveHeartbeatReadScope } from "./heartbeatRunScope.js";

export const HEARTBEAT_HISTORY_DEFAULT_LIMIT = 10;
export const HEARTBEAT_HISTORY_MAX_LIMIT = 100;

/** Neither tool takes a project id; the scope comes from the calling run (`resolveHeartbeatReadScope`). */
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

/** Returned by `heartbeat.trigger` for an `onItemEvent` heartbeat, which only fires from its item write. */
export const HEARTBEAT_EVENT_TRIGGERED_ERROR = "heartbeat_event_triggered";

const HEARTBEAT_DISABLED_ERROR = "this heartbeat is disabled; enable it before triggering it";

const HEARTBEAT_EVENT_TRIGGERED_MESSAGE = "this heartbeat fires only from its triggering event, not on demand";

const HEARTBEAT_RUNNING_MESSAGE =
  "this heartbeat is already running or queued; wait for it to finish before triggering it again";

export interface HeartbeatListEntry {
  id: string;
  /** `project_heartbeats.name`, e.g. "Manifest drift check". */
  name: string;
  rule: unknown;
  enabled: boolean;
  lastFiredAt: string | null;
}

/** A `heartbeat.list` entry for a Semp chat run, with the project it belongs to. */
export interface TenantHeartbeatListEntry extends HeartbeatListEntry {
  projectItemId: string;
  /** `null` when the project item has no name or is gone. */
  projectName: string | null;
}

export interface HeartbeatHistoryEntry {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
}

/** Shaped like a pi-agent-core `tool_result` payload, as `delegateTool.ts`'s `DelegateToolResult`. */
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

function toListEntry(heartbeat: HeartbeatRow): HeartbeatListEntry {
  return {
    id: heartbeat.id,
    name: heartbeat.name,
    rule: heartbeat.rule,
    enabled: heartbeat.enabled,
    lastFiredAt: heartbeat.lastFiredAt,
  };
}

async function toTenantListEntries(pool: Pool, heartbeats: HeartbeatRow[]): Promise<TenantHeartbeatListEntry[]> {
  const projects = await getItemsByIds(pool, [...new Set(heartbeats.map((heartbeat) => heartbeat.projectItemId))]);
  const nameById = new Map(
    projects.map((project) => [
      project.id,
      typeof project.properties.name === "string" ? project.properties.name : null,
    ]),
  );
  return heartbeats.map((heartbeat) => ({
    ...toListEntry(heartbeat),
    projectItemId: heartbeat.projectItemId,
    projectName: nameById.get(heartbeat.projectItemId) ?? null,
  }));
}

/**
 * `heartbeat.list`: the heartbeats of the calling run's own project; the scope comes only from persisted
 * rows. A Semp chat run lists every project's, minus those with a sensitive grant its project lacks.
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

    const readScope = await resolveHeartbeatReadScope(pool, currentRunId);
    if (!readScope) {
      return { error: true, result: `No project context for run ${currentRunId}` };
    }

    if (readScope.scope === "tenant") {
      const visible = await listHeartbeatsVisibleToChatRun(pool, readScope.projectItemId, moduleRuleKinds);
      return { error: false, result: JSON.stringify(await toTenantListEntries(pool, visible)) };
    }

    const heartbeats = await listHeartbeatsByProject(pool, readScope.projectItemId, moduleRuleKinds);
    const entries: HeartbeatListEntry[] = heartbeats.map(toListEntry);

    return { error: false, result: JSON.stringify(entries) };
  };
}

/** `heartbeat.history`: recent runs of one in-scope heartbeat; unknown and out-of-scope ids give the same error. */
export function createHeartbeatHistoryTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): HeartbeatHistoryTool {
  return async function heartbeatHistory(currentRunId, rawArgs) {
    const parsedArgs = heartbeatHistoryArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    }

    const readScope = await resolveHeartbeatReadScope(pool, currentRunId);
    if (!readScope) {
      return { error: true, result: `No project context for run ${currentRunId}` };
    }

    const heartbeat =
      readScope.scope === "tenant"
        ? await getHeartbeatVisibleToChatRun(
            pool,
            readScope.projectItemId,
            parsedArgs.data.heartbeatId,
            moduleRuleKinds,
          )
        : await getHeartbeatForProject(pool, readScope.projectItemId, parsedArgs.data.heartbeatId, moduleRuleKinds);
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
 * `heartbeat.trigger`: fires one of the run's own time-based heartbeats now, scoped to its project even for
 * a chat run. See `enqueueManualHeartbeatFire` for refusals, locking and job keys.
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

/** Maps known refusals onto tool results; any other error is rethrown. */
function refusalForAgentTool(err: unknown, heartbeatId: string): HeartbeatAgentToolResult | null {
  if (err instanceof NotFoundError) return { error: true, result: `Heartbeat ${heartbeatId} not found` };
  if (err instanceof HeartbeatEventTriggeredError) return { error: true, result: HEARTBEAT_EVENT_TRIGGERED_ERROR };
  if (err instanceof HeartbeatDisabledError) return { error: true, result: HEARTBEAT_DISABLED_ERROR };
  if (err instanceof HeartbeatRunningError) return { error: true, result: HEARTBEAT_RUNNING_MESSAGE };
  return null;
}

/** Who a manual fire is attributed to; the key is the payload discriminator the fire task reads. */
export type ManualHeartbeatFireTrigger =
  { triggeredByRunId: string } | { triggeredByUserId: string } | { retryOfRunId: string };

export interface ManualHeartbeatFireRequest {
  heartbeatId: string;
  /** The agent tool passes the run's project; the HTTP route passes `null` (tenant-scoped lookup). */
  projectItemId: string | null;
  trigger: ManualHeartbeatFireTrigger;
  /** `true` on the HTTP route (an active run or waiting job refuses); `false` on the agent tool (repeats merge). */
  refuseWhileActive: boolean;
  /** Defaults to `manualHeartbeatFireJobKey` of the heartbeat. */
  jobKey?: string;
  /** Defaults to 3, like every other heartbeat fire. */
  maxAttempts?: number;
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
 * The one enqueue behind every manual fire, in the caller's transaction. Refuses with `NotFoundError`
 * (unknown or out of scope), `HeartbeatEventTriggeredError`, `HeartbeatDisabledError`, or, with
 * `refuseWhileActive`, `HeartbeatRunningError`.
 *
 * The row is locked `FOR UPDATE`, so a concurrent disable or second trigger waits and sees this result. The
 * manual job key differs from the sweep's, so attributions never overwrite each other while repeated manual
 * triggers collapse. `next_fire_at`/`last_fired_at` are left to the sweep.
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

  const jobKey = request.jobKey ?? manualHeartbeatFireJobKey(heartbeat.id);
  await enqueueJob(
    client,
    resolveHeartbeatFireTaskName(heartbeat.actionId),
    { heartbeatId: heartbeat.id, ...request.trigger },
    {
      jobKey,
      maxAttempts: request.maxAttempts ?? 3,
      queueName: resolveAgentRunLane(heartbeat.actionId),
    },
  );

  return { heartbeatId: heartbeat.id, jobKey };
}
