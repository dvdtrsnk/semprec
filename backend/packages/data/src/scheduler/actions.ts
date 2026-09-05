import type { Pool } from "pg";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { parseItemRelationFilterConfig, passesItemRelationFilter } from "./itemRelationFilter.js";

export interface ActionContext {
  heartbeatId: string;
  projectItemId: string;
  /** set for a rule fired via onItemEvent */
  itemId?: string;
}

export type ActionHandler = (actionConfig: Record<string, unknown>, context: ActionContext) => Promise<void>;

/** A temporary stand-in for the full module registry (issue #29): a map of action_id -> handler. */
export type ActionRegistry = Map<string, ActionHandler>;

export function createActionRegistry(): ActionRegistry {
  return new Map();
}

/**
 * Graphile-worker queue affinity (`queue_name`) per action id: jobs sharing a queue name
 * serialize against each other, never running concurrently. An action with no entry here
 * enqueues on the default, unaffinitized queue. Same "temporary stand-in" caveat as
 * `ActionRegistry` above — issue #29's module registry is the eventual real home for this.
 */
export type ActionQueueAffinity = Map<string, string>;

export function createActionQueueAffinity(): ActionQueueAffinity {
  return new Map();
}

export type RunAgentFn = (input: { agentRunId: string; projectItemId: string; task: string }) => Promise<{ result?: string } | void>;

/**
 * `core.agentRun`: "run the agent owning the project with the task from action_config.task."
 * Actually running an LLM session is out of scope for this issue — `runAgent` is the
 * pluggable/injected function a later agent-orchestration issue will supply.
 *
 * `actionConfig.itemRelationFilter` (optional, see itemRelationFilter.ts) gates the run on the
 * fired item's relation membership — e.g. issue #99's `newEmail` rule, which must only run for
 * an Emails item related to an inbox Folder and not to a junk/trash one, without any mail-specific
 * scheduler. Only applied for item-triggered (`onItemEvent`) heartbeats, where `context.itemId`
 * is set; time-based heartbeats ignore it.
 */
export function coreAgentRunAction(pool: Pool, runAgent: RunAgentFn): ActionHandler {
  return async (actionConfig, context) => {
    const relationFilter = parseItemRelationFilterConfig(actionConfig.itemRelationFilter);
    if (relationFilter && context.itemId) {
      const passes = await passesItemRelationFilter(pool, context.itemId, relationFilter);
      if (!passes) return;
    }

    const task = typeof actionConfig.task === "string" ? actionConfig.task : "";
    const run = await createAgentRun(pool, {
      projectItemId: context.projectItemId,
      heartbeatId: context.heartbeatId,
      triggeredBy: "heartbeat",
      task,
    });

    try {
      const outcome = await runAgent({ agentRunId: run.id, projectItemId: context.projectItemId, task });
      await finishAgentRun(pool, run.id, "done", outcome?.result ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishAgentRun(pool, run.id, "error", message);
      throw err;
    }
  };
}

export const CORE_AGENT_RUN_ACTION_ID = "core.agentRun";
