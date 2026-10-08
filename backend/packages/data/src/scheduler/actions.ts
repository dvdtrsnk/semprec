import type { Pool } from "pg";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, type AgentTaskName, type CoreTaskName } from "@semprec/queue";
import { createLogger, withTraceContext } from "@semprec/shared";
import { createAgentRun, finishAgentRun, finishAgentRunWithErrorNotification } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME } from "../inbox/inboxTickKeys.js";
import { parseItemRelationFilterConfig, passesItemRelationFilter } from "./itemRelationFilter.js";

const logger = createLogger("scheduler");

export interface ActionContext {
  heartbeatId: string;
  projectItemId: string;
  /** set for a rule fired via onItemEvent */
  itemId?: string;
  /** the run id from `heartbeat.trigger`'s payload (issue #136) — the agent run that manually fired this heartbeat, becoming the new run's `parent_run_id`. Unset for a scheduler-fired (sweep or onItemEvent) run. */
  triggeredByRunId?: string;
  /**
   * Set by the heartbeat fire task from the queue job's `attempts >= max_attempts`. `undefined`
   * for a caller outside the queue (treated as final — a direct caller has no retry).
   */
  isFinalAttempt?: boolean;
}

export type ActionHandler = (actionConfig: Record<string, unknown>, context: ActionContext) => Promise<void>;

/** A temporary stand-in for the full module registry (issue #29): a map of action_id -> handler. */
export type ActionRegistry = Map<string, ActionHandler>;

export function createActionRegistry(): ActionRegistry {
  return new Map();
}

/**
 * Graphile-worker base lane name per action id: enqueue appends the tenant (`<lane>:<tenantId>`)
 * inside a tenant scope, and jobs sharing the resulting queue name serialize against each other,
 * never running concurrently. An action with no entry here
 * enqueues on the default, unaffinitized queue. Same "temporary stand-in" caveat as
 * `ActionRegistry` above — issue #29's module registry is the eventual real home for this.
 */
export type ActionQueueAffinity = Map<string, string>;

/**
 * This is the production routing table: every call site that does not pass an explicit
 * `ActionQueueAffinity` gets this one, not an empty map. A caller only ever supplies its own map
 * to override it (tests exercising the unaffinitized case, or a narrower affinity). Today it
 * routes exactly `semprec.tick` to the base lane `semprec-tick`, closing the race where two ticks for the same
 * Inbox item run concurrently and both create a Processing-proposal card.
 */
export function createActionQueueAffinity(): ActionQueueAffinity {
  return new Map([[SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME]]);
}

export type RunAgentFn = (input: {
  agentRunId: string;
  projectItemId: string;
  task: string;
}) => Promise<{ result?: string } | void>;

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
 *
 * A `runAgent` failure closes this attempt's `agent_runs` row as `error` on every attempt, but
 * writes the `agent_run_error` notification only on the final one (`context.isFinalAttempt !==
 * false`) — so a heartbeat occurrence retried up to `maxAttempts` times yields exactly one
 * `agent_run_error` notification (linking to the last attempt's run), not one per attempt. If
 * closing/notifying itself throws, that error is logged and the original `runAgent` error is what
 * this handler rejects with — never the close failure.
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
      parentRunId: context.triggeredByRunId ?? null,
      heartbeatId: context.heartbeatId,
      triggeredBy: "heartbeat",
      task,
    });

    await withTraceContext({ agentRunId: run.id }, async () => {
      try {
        const outcome = await runAgent({ agentRunId: run.id, projectItemId: context.projectItemId, task });
        await finishAgentRun(pool, run.id, "done", outcome?.result ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A non-final attempt closes its run silently: only the last attempt of a failed
        // occurrence writes the `agent_run_error` notification, so three retries of the same
        // occurrence produce exactly one notification (linking to the last attempt's run)
        // instead of one per attempt. `isFinalAttempt === undefined` (a direct caller outside
        // the queue, with no retries) keeps the pre-existing single-notification behaviour.
        try {
          if (context.isFinalAttempt === false) {
            await finishAgentRun(pool, run.id, "error", message);
          } else {
            // Same transaction as the source write, per issue #149: a crash between closing the
            // run and writing its `agent_run_error` notification never leaves one without the other.
            await withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, run.id, message));
          }
        } catch (closeErr) {
          // The close/notify write failing must never replace `err` — the caller's retry
          // decision and the job's `last_error` have to reflect the actual `runAgent` failure.
          logger.error(
            { err: closeErr, agentRunId: run.id, heartbeatId: context.heartbeatId },
            "core.agentRun: failed to record failed agent run lifecycle",
          );
        }
        throw err;
      }
    });
  };
}

export const CORE_AGENT_RUN_ACTION_ID = "core.agentRun";

/**
 * Which of `heartbeatFire`'s two split task names (issue #222) a heartbeat action's fire job
 * belongs on: `heartbeatFireAgent` for `core.agentRun`, the only action id that starts or
 * continues an agent session; `heartbeatFireCore` for every other action (the default —
 * including library processing, drift checks, and every other known core action id).
 *
 * Deliberately not validated against `KNOWN_HEARTBEAT_ACTION_IDS` (manifest/knownActionIds.ts):
 * that catalog only covers real, module-registered actions, while tests register arbitrary ids
 * (`"noop"`, `"markRan"`, ...) that must still resolve to a task name to enqueue onto. An
 * unresolvable *heartbeat* (not action id) is a different failure mode, handled by the callers
 * that already look one up (schedulerStore.ts, the legacy job migration).
 */
export function resolveHeartbeatFireTaskName(actionId: string): CoreTaskName | AgentTaskName {
  return actionId === CORE_AGENT_RUN_ACTION_ID
    ? AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT
    : CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE;
}
