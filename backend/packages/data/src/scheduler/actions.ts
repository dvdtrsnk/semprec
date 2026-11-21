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
import {
  CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
  CALENDAR_INGEST_INVITATION_ACTION_ID,
} from "../calendar/invitationActionKeys.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID } from "../mail/personLinkingKeys.js";
import { ValidationError } from "../errors.js";
import { parseItemRelationFilterConfig, passesItemRelationFilter } from "./itemRelationFilter.js";
import { logger } from "./logger.js";
import { parseSenderKnownFilterConfig, passesSenderKnownFilter } from "./senderKnownFilter.js";

export interface ActionContext {
  heartbeatId: string;
  projectItemId: string;
  /** Set for a rule fired via onItemEvent; a batched fire calls the handler once per item. */
  itemId?: string;
  /** The agent run that fired this heartbeat via `heartbeat.trigger`; becomes the new run's `parent_run_id`. */
  triggeredByRunId?: string;
  /** The person who fired it via `POST /api/heartbeats/:id/trigger`; recorded as the new run's actor. */
  triggeredByUserId?: string;
  /** The failed run being retried; the new run is its next attempt in the chain. */
  retryOfRunId?: string;
  /** `attempts >= max_attempts` of the queue job; `undefined` outside the queue is treated as final. */
  isFinalAttempt?: boolean;
  /** Set for a run fired from a scheduled heartbeat occurrence. */
  occurrenceId?: string;
  /** 1-based queue attempt of the occurrence's fire job; set together with `occurrenceId`. */
  attempt?: number;
}

export type ActionHandler = (actionConfig: Record<string, unknown>, context: ActionContext) => Promise<void>;

/** Stand-in for a full module registry: action_id -> handler. */
export type ActionRegistry = Map<string, ActionHandler>;

export function createActionRegistry(): ActionRegistry {
  return new Map();
}

/** Jobs sharing a queue name never run concurrently; enqueue appends `:<tenantId>` in a tenant scope. */
export type ActionQueueAffinity = Map<string, string>;

/** Routes `semprec.tick` to `semprec-tick` so two ticks for one Inbox item cannot both create a proposal card. */
export function createActionQueueAffinity(): ActionQueueAffinity {
  return new Map([[SEMPREC_TICK_ACTION_ID, SEMPREC_TICK_QUEUE_NAME]]);
}

export type RunAgentFn = (input: {
  agentRunId: string;
  projectItemId: string;
  task: string;
  itemId?: string;
}) => Promise<{ result?: string } | void>;

/** `null` (ids logged) when the retried run is gone or already has a successor, so no agent starts. */
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

/** The answer-expected gate of `core.agentRun` (`answerExpectedFilter.ts`). */
export type AnswerExpectedGate = (itemId: string) => Promise<AnswerExpectedDecision>;

/** A resolver a heartbeat's `runProject` config may name: the project the run for `itemId` starts in. */
export type RunProjectResolver = (input: { itemId: string; defaultProjectItemId: string }) => Promise<string>;

/** Injected, not imported: the choke point imports this module and mail imports the choke point (cycle). */
export interface CoreAgentRunDependencies {
  /** Required by a heartbeat that sets `answerExpectedFilter`. */
  answerExpectedGate?: AnswerExpectedGate;
  /** `runProject` resolvers by name; required by a heartbeat that names one. */
  runProjectResolvers?: Readonly<Record<string, RunProjectResolver>>;
}

const answerExpectedFilterConfigSchema = z.strictObject({});
const runProjectConfigSchema = z.strictObject({ resolver: z.string().min(1) });

/** The gate has no settings; its presence in `action_config` turns it on. `null` when absent. */
function parseAnswerExpectedFilterConfig(raw: unknown): true | null {
  if (raw === undefined) return null;
  if (!answerExpectedFilterConfigSchema.safeParse(raw).success) {
    throw new ValidationError("Invalid answer-expected filter", { field: "answerExpectedFilter" });
  }
  return true;
}

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
 * `core.agentRun`: runs the project's agent with `action_config.task`. Item-triggered fires may be gated by
 * `itemRelationFilter` and `answerExpectedFilter` and moved by `runProject`. A retry runs as the next
 * attempt of the retried run.
 *
 * Every failed attempt closes its run as `error`, but only the final attempt writes the `agent_run_error`
 * notification and tick-thread message. A failure while closing is logged; the `runAgent` error is rethrown.
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
      // A heartbeat needing a dependency the composition root did not provide is refused before any work.
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
    // The tick thread is created on first use and linked to the run in the same transaction.
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
        // A person's manual fire names them as actor; otherwise the tenant's user stays the actor.
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
          // A resolver or the retried run may have placed the run outside the heartbeat's project.
          projectItemId: run.projectItemId ?? context.projectItemId,
          task: run.task,
          ...(context.itemId ? { itemId: context.itemId } : {}),
        });
      } catch (err) {
        const errorCode = agentRunErrorCodeOf(err);
        // Only the final attempt (or a direct caller, `isFinalAttempt === undefined`) writes the notification.
        try {
          if (context.isFinalAttempt === false) {
            await withTransaction(pool, async (client) => {
              const closed = await finishAgentRun(client, run.id, "error", errorCode);
              if (closed) publishSempThreadInvalidation(client, thread.tenantId, thread.id);
            });
          } else {
            // Closing the run and writing its notification share one transaction, so neither exists without the other.
            await withTransaction(pool, (client) =>
              finishTickRunWithMessage(client, {
                thread,
                agentRunId: run.id,
                outcome: { status: "error", errorCode },
              }),
            );
          }
        } catch (closeErr) {
          // Never replace `err`: retry decisions and `last_error` must reflect the `runAgent` failure. Log only
          // codes and names; a Postgres error detail can carry the user's prompt and logs are not tenant-scoped.
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

/** Actions whose fire starts or continues an agent session (`core.journalWeeklyCleanup` runs through `core.agentRun`). */
const AGENT_SESSION_ACTION_IDS: ReadonlySet<string> = new Set([
  CORE_AGENT_RUN_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
]);

/** Not validated against `KNOWN_HEARTBEAT_ACTION_IDS`: tests register arbitrary action ids. */
export function resolveHeartbeatFireTaskName(actionId: string): CoreTaskName | AgentTaskName {
  return AGENT_SESSION_ACTION_IDS.has(actionId)
    ? AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT
    : CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE;
}

/**
 * Deterministic `onItemEvent` actions on every new Email whose fires of one transaction share one job: a mail sync
 * batch creates many Emails at once, and for most of them these actions find nothing to do. Their handlers are
 * idempotent per item, as a queue retry already requires.
 */
export const ITEM_EVENT_BATCH_ACTION_IDS: ReadonlySet<string> = new Set([
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  CALENDAR_INGEST_INVITATION_ACTION_ID,
  CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
]);

const AGENT_RUN_LANE = "agent-run";

/**
 * One running agent fire per tenant, so one tenant cannot hold every agents slot. A hung session blocks that
 * tenant's agent fires; a crashed process leaves the lane locked until the lock is stale (4 hours).
 */
export function resolveAgentRunLane(actionId: string): string | undefined {
  return resolveHeartbeatFireTaskName(actionId) === AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT
    ? tenantLane(AGENT_RUN_LANE)
    : undefined;
}
