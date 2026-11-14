import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, type AgentTaskName, type CoreTaskName } from "@semprec/queue";
import { withTraceContext } from "@semprec/shared";
import { agentRunErrorCodeOf } from "../agentRuns/agentRunErrorCodes.js";
import {
  createAgentRun,
  createChainedAgentRun,
  finishAgentRun,
  getAgentRun,
  getLatestRunOfOccurrence,
  type AgentRunRow,
} from "../agentRuns/agentRunsStore.js";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { finishTickRunWithMessage, getOrCreateTickThread } from "../semp/sempTickThreadStore.js";
import { withTransaction } from "../db/pool.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME } from "../inbox/inboxTickKeys.js";
import { JOURNAL_WEEKLY_CLEANUP_ACTION_ID } from "../journal/journalWeeklyCleanupKeys.js";
import { ValidationError } from "../errors.js";
import { parseItemRelationFilterConfig, passesItemRelationFilter } from "./itemRelationFilter.js";
import { logger } from "./logger.js";
import { parseSenderKnownFilterConfig, passesSenderKnownFilter } from "./senderKnownFilter.js";

export interface ActionContext {
  heartbeatId: string;
  projectItemId: string;
  /** set for a rule fired via onItemEvent */
  itemId?: string;
  /** the run id from `heartbeat.trigger`'s payload (issue #136) — the agent run that manually fired this heartbeat, becoming the new run's `parent_run_id`. Unset for a scheduler-fired (sweep or onItemEvent) run. */
  triggeredByRunId?: string;
  /** the user from the manual trigger's payload (`POST /api/heartbeats/:id/trigger`, issue #1453) — the person whose run this is, recorded as the new run's actor. Unset for every other fire, and a manual fire from a person has no `triggeredByRunId`. */
  triggeredByUserId?: string;
  /** the failed run from the retry's payload (`POST /api/agent-runs/:id/retry`, issue #1908). Set, the new run is the next attempt of that run in its chain. Unset for every other fire. */
  retryOfRunId?: string;
  /**
   * Set by the heartbeat fire task from the queue job's `attempts >= max_attempts`. `undefined`
   * for a caller outside the queue (treated as final — a direct caller has no retry).
   */
  isFinalAttempt?: boolean;
  /** Set for a run fired from a scheduled heartbeat occurrence (issue #1458); unset for a manual fire or an item event. */
  occurrenceId?: string;
  /** The queue attempt number (1-based) of the occurrence's fire job; set together with `occurrenceId`. */
  attempt?: number;
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
  itemId?: string;
}) => Promise<{ result?: string } | void>;

/**
 * The run of the retry of `retryOfRunId` (issue #1908): the next attempt of that run in its chain, with the
 * heartbeat, project, task and occurrence it was started with. `null`, with the ids logged, when the retried run
 * is gone or already has a successor, so the caller starts no agent.
 */
async function createRetryRun(
  client: PoolClient,
  heartbeatId: string,
  retryOfRunId: string,
  threadId: string,
): Promise<AgentRunRow | null> {
  const retried = await getAgentRun(client, retryOfRunId);
  if (!retried) {
    logger.warn({ heartbeatId, retryOfRunId }, "core.agentRun: the run to retry does not exist; nothing to run");
    return null;
  }
  const chained = await createChainedAgentRun(client, {
    projectItemId: retried.projectItemId,
    heartbeatId: retried.heartbeatId,
    heartbeatOccurrenceId: retried.heartbeatOccurrenceId,
    threadId,
    triggeredBy: "heartbeat",
    task: retried.task,
    retryOfRunId,
    attempt: retried.attempt + 1,
  });
  if (!chained) {
    logger.warn({ heartbeatId, retryOfRunId }, "core.agentRun: the run to retry already has a successor; not running");
  }
  return chained;
}

/** What the answer-expected gate decides for a fired message: no run, or a run whose task is followed by `taskNote`. */
export type AnswerExpectedDecision = { run: false } | { run: true; taskNote: string };

/** The answer-expected gate of `core.agentRun` for the item `itemId` (issue gh-1941, `scheduler/answerExpectedFilter.ts`). */
export type AnswerExpectedGate = (itemId: string) => Promise<AnswerExpectedDecision>;

/** A resolver a heartbeat's `runProject` config may name: the id of the project the run for `itemId` starts in. */
export type RunProjectResolver = (input: { itemId: string; defaultProjectItemId: string }) => Promise<string>;

/**
 * What `coreAgentRunAction` is composed with by its composition root. They are injected, not imported, because the
 * choke point imports this module (`chokePoint/hooks.ts` and `chokePointDeps.ts` for the action types) and the mail module
 * imports the choke point: an import of the mail module here would close a cycle (`no-choke-point-rollup-cycle`).
 * docs/adr/2026-11-14-a-heartbeat-agent-run-takes-composition-root-dependencies-and-may-run-in-the-project-of-its-item.md records the mechanism, the `runProject` config and the gate's outcomes.
 */
export interface CoreAgentRunDependencies {
  /** The gate of the `answerExpectedFilter` config key. A heartbeat that turns the key on needs it. */
  answerExpectedGate?: AnswerExpectedGate;
  /** The resolvers of the `runProject` config key by name. A heartbeat that names one needs it. */
  runProjectResolvers?: Readonly<Record<string, RunProjectResolver>>;
}

const answerExpectedFilterConfigSchema = z.strictObject({});
const runProjectConfigSchema = z.strictObject({ resolver: z.string().min(1) });

/** `{}`: the answer-expected gate has no settings, its presence in `action_config` turns it on. `null` when absent. */
function parseAnswerExpectedFilterConfig(raw: unknown): true | null {
  if (raw === undefined) return null;
  if (!answerExpectedFilterConfigSchema.safeParse(raw).success) {
    throw new ValidationError("Invalid answer-expected filter", { field: "answerExpectedFilter" });
  }
  return true;
}

/** The `runProject` config of a heartbeat: the name of its resolver, or `null` when it has none. */
function parseRunProjectConfig(raw: unknown): string | null {
  if (raw === undefined) return null;
  const result = runProjectConfigSchema.safeParse(raw);
  if (!result.success) throw new ValidationError("Invalid run project", { field: "runProject" });
  return result.data.resolver;
}

function resolverNamed(dependencies: CoreAgentRunDependencies, name: string): RunProjectResolver {
  const resolvers = dependencies.runProjectResolvers ?? {};
  const resolver = Object.hasOwn(resolvers, name) ? resolvers[name] : undefined;
  if (resolver === undefined) throw new ValidationError("Unknown run project resolver", { field: "runProject" });
  return resolver;
}

function answerGateOf(dependencies: CoreAgentRunDependencies): AnswerExpectedGate {
  if (dependencies.answerExpectedGate === undefined) {
    throw new Error("No answer-expected gate is configured for this action");
  }
  return dependencies.answerExpectedGate;
}

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
 * `actionConfig.answerExpectedFilter` (issue gh-1941, see answerExpectedFilter.ts) runs after the sender gate: it asks the
 * AI gateway whether the fired message expects an answer and starts no run for one that does not, for a message that is
 * not the newest of its thread, for a thread whose agent draft the user edited, and when the tenant's AI budget is used up;
 * for a run that starts it appends its note, which names the thread's open agent draft when there is one, to the task.
 * `actionConfig.runProject` (`{ resolver }`) moves the run to the project that the named resolver answers for the fired
 * item, instead of the heartbeat's own project (the tick thread stays the heartbeat's). Both apply to an item-triggered
 * fire only, and both come from `dependencies`, which the composition root fills (`CoreAgentRunDependencies`).
 *
 * With `context.retryOfRunId` (issue #1908) the run is the next attempt of that run, made with
 * `createChainedAgentRun` and the retried run's own task; it starts no agent when the retried run is gone or was
 * retried already. The fire job of a retry has one attempt, so a failing retry is a final failure.
 *
 * A `runAgent` failure closes this attempt's `agent_runs` row as `error` on every attempt, but
 * writes the `agent_run_error` notification only on the final one (`context.isFinalAttempt !==
 * false`) — so a heartbeat occurrence retried up to `maxAttempts` times yields exactly one
 * `agent_run_error` notification (linking to the last attempt's run), not one per attempt. Each
 * run belongs to the heartbeat's tick thread (`semp_threads`, kind `tick`); a successful run and the
 * final failed attempt each write one assistant message there in the same transaction as the run's
 * close, while a non-final attempt writes no message. If
 * closing/notifying itself throws, that error is logged and the original `runAgent` error is what
 * this handler rejects with — never the close failure.
 */
export function coreAgentRunAction(
  pool: Pool,
  runAgent: RunAgentFn,
  dependencies: CoreAgentRunDependencies = {},
): ActionHandler {
  return async (actionConfig, context) => {
    const relationFilter = parseItemRelationFilterConfig(actionConfig.itemRelationFilter);
    if (relationFilter && context.itemId) {
      const passes = await passesItemRelationFilter(pool, context.itemId, relationFilter);
      if (!passes) return;
    }
    let runProjectItemId = context.projectItemId;
    let taskNote: string | null = null;
    if (context.itemId) {
      const senderFilter = parseSenderKnownFilterConfig(actionConfig.senderKnownFilter);
      const answerFilter = parseAnswerExpectedFilterConfig(actionConfig.answerExpectedFilter);
      const resolverName = parseRunProjectConfig(actionConfig.runProject);
      // A heartbeat that names a resolver or turns the gate on without the composition root providing it is
      // refused before anything is asked or written.
      const resolver = resolverName === null ? null : resolverNamed(dependencies, resolverName);
      const gate = answerFilter ? answerGateOf(dependencies) : null;
      if (senderFilter && !(await passesSenderKnownFilter(pool, context.itemId, senderFilter))) return;
      if (gate !== null) {
        const decision = await gate(context.itemId);
        if (!decision.run) return;
        taskNote = decision.taskNote;
      }
      if (resolver !== null) {
        runProjectItemId = await resolver({ itemId: context.itemId, defaultProjectItemId: context.projectItemId });
      }
    }

    const baseTask = typeof actionConfig.task === "string" ? actionConfig.task : "";
    const noted = taskNote === null ? baseTask : baseTask === "" ? taskNote : `${baseTask}\n${taskNote}`;
    const task = context.itemId ? `${noted}\nTriggering item id: ${context.itemId}` : noted;
    // Run start: the tick thread (one per heartbeat) is created on first use and the run is linked
    // to it in the same transaction; subscribers are told once that transaction commits.
    const started = await withTransaction(pool, async (client) => {
      const tickThread = await getOrCreateTickThread(client, context.heartbeatId);
      if (context.retryOfRunId !== undefined) {
        const retry = await createRetryRun(client, context.heartbeatId, context.retryOfRunId, tickThread.id);
        if (retry === null) return null;
        publishSempThreadInvalidation(client, tickThread.tenantId, tickThread.id);
        return { run: retry, thread: tickThread };
      }
      const runInput = {
        projectItemId: runProjectItemId,
        parentRunId: context.triggeredByRunId ?? null,
        heartbeatId: context.heartbeatId,
        threadId: tickThread.id,
        triggeredBy: "heartbeat" as const,
        task,
        // A manual fire from a person names that person as the run's actor (`createAgentRun`'s
        // `userId`); a scheduled or item-event fire leaves it unset, so the tenant's user stays the actor.
        userId: context.triggeredByUserId,
      };
      let created: AgentRunRow;
      if (context.occurrenceId === undefined) {
        created = await createAgentRun(client, runInput);
      } else {
        const occurrenceInput = {
          ...runInput,
          heartbeatOccurrenceId: context.occurrenceId,
          attempt: context.attempt ?? 1,
        };
        const previous = await getLatestRunOfOccurrence(client, context.occurrenceId);
        const chained = previous
          ? await createChainedAgentRun(client, { ...occurrenceInput, retryOfRunId: previous.id })
          : null;
        if (previous && !chained) {
          logger.warn(
            { heartbeatId: context.heartbeatId, occurrenceId: context.occurrenceId, retryOfRunId: previous.id },
            "core.agentRun: the previous attempt already has a successor; creating the run unchained",
          );
        }
        created = chained ?? (await createAgentRun(client, occurrenceInput));
      }
      publishSempThreadInvalidation(client, tickThread.tenantId, tickThread.id);
      return { run: created, thread: tickThread };
    });

    // A retry that found nothing to retry, or a run already retried, starts no agent.
    if (started === null) return;
    const { run, thread } = started;

    await withTraceContext({ agentRunId: run.id }, async () => {
      let outcome: { result?: string } | void;
      try {
        outcome = await runAgent({
          agentRunId: run.id,
          // The project the run row holds: the resolved one for a fire of an item, and for a retry the project of
          // the run it retries, which a resolver may have moved away from the heartbeat's.
          projectItemId: run.projectItemId ?? context.projectItemId,
          task: run.task,
          ...(context.itemId ? { itemId: context.itemId } : {}),
        });
      } catch (err) {
        const errorCode = agentRunErrorCodeOf(err);
        // A non-final attempt closes its run silently: only the last attempt of a failed
        // occurrence writes the `agent_run_error` notification, so three retries of the same
        // occurrence produce exactly one notification (linking to the last attempt's run)
        // instead of one per attempt. `isFinalAttempt === undefined` (a direct caller outside
        // the queue, with no retries) keeps the pre-existing single-notification behaviour.
        try {
          if (context.isFinalAttempt === false) {
            await withTransaction(pool, async (client) => {
              const closed = await finishAgentRun(client, run.id, "error", errorCode);
              if (closed) publishSempThreadInvalidation(client, thread.tenantId, thread.id);
            });
          } else {
            // Same transaction as the source write, per issue #149: a crash between closing the
            // run and writing its `agent_run_error` notification never leaves one without the other.
            // The final attempt also writes the run's assistant message into the tick thread.
            await withTransaction(pool, (client) =>
              finishTickRunWithMessage(client, {
                thread,
                agentRunId: run.id,
                outcome: { status: "error", errorCode },
              }),
            );
          }
        } catch (closeErr) {
          // The close/notify write failing must never replace `err` — the caller's retry
          // decision and the job's `last_error` have to reflect the actual `runAgent` failure.
          // The run's code and the close error's name only: a Postgres error's detail can carry the
          // failing row, whose `task` is the user's prompt, and logs are not tenant-scoped.
          logger.error(
            {
              errorName: closeErr instanceof Error ? closeErr.name : typeof closeErr,
              errorCode,
              agentRunId: run.id,
              heartbeatId: context.heartbeatId,
            },
            "core.agentRun: failed to record failed agent run lifecycle",
          );
        }
        throw err;
      }
      // A failed persistence transaction must not be mistaken for an agent failure.
      await withTransaction(pool, (client) =>
        finishTickRunWithMessage(client, {
          thread,
          agentRunId: run.id,
          outcome: { status: "done", result: outcome?.result ?? null },
        }),
      );
    });
  };
}

export const CORE_AGENT_RUN_ACTION_ID = "core.agentRun";

/**
 * The heartbeat actions whose fire starts or continues an agent session: `core.agentRun`, and
 * `core.journalWeeklyCleanup` (issue #1883), which runs the agent through the `core.agentRun` handler.
 */
const AGENT_SESSION_ACTION_IDS: ReadonlySet<string> = new Set([
  CORE_AGENT_RUN_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
]);

/**
 * Which of `heartbeatFire`'s two split task names (issue #222) a heartbeat action's fire job
 * belongs on: `heartbeatFireAgent` for the actions that start or continue an agent session
 * (`core.agentRun` and `core.journalWeeklyCleanup`); `heartbeatFireCore` for every other action (the
 * default — including library processing, drift checks, and every other known core action id).
 *
 * Deliberately not validated against `KNOWN_HEARTBEAT_ACTION_IDS` (manifest/knownActionIds.ts):
 * that catalog only covers real, module-registered actions, while tests register arbitrary ids
 * (`"noop"`, `"markRan"`, ...) that must still resolve to a task name to enqueue onto. An
 * unresolvable *heartbeat* (not action id) is a different failure mode, handled by the callers
 * that already look one up (schedulerStore.ts, the legacy job migration).
 */
export function resolveHeartbeatFireTaskName(actionId: string): CoreTaskName | AgentTaskName {
  return AGENT_SESSION_ACTION_IDS.has(actionId)
    ? AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT
    : CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE;
}

const AGENT_RUN_LANE = "agent-run";

/**
 * The per-tenant queue name for a heartbeat fire that starts an agent session (issue #1047): one
 * executing `heartbeatFireAgent` job per tenant, so one tenant's due agent heartbeats cannot hold
 * every agents-process slot. `undefined` for every other action and outside a tenant scope, so
 * those fires keep their existing queue name.
 *
 * The trade-off is head-of-line blocking within one tenant: a hung agent session holds back that
 * tenant's scheduled, item-triggered and manual agent fires, and an agents process that dies
 * without a graceful `Runner.stop()` leaves the lane locked until Graphile Worker treats the lock
 * as stale (4 hours). Other tenants' lanes are unaffected either way.
 */
export function resolveAgentRunLane(actionId: string): string | undefined {
  return resolveHeartbeatFireTaskName(actionId) === AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT
    ? tenantLane(AGENT_RUN_LANE)
    : undefined;
}
