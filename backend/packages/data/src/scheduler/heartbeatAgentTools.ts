import type { Pool } from "pg";
import { z } from "zod";
import { getAgentRun, listAgentRunsByHeartbeat } from "../agentRuns/agentRunsStore.js";
import { getHeartbeatForProject, listHeartbeatsByProject } from "./schedulerStore.js";
import type { HeartbeatRuleKindRegistry } from "./rule.js";

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
