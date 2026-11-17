import { Pool, type PoolClient } from "pg";
import {
  agentRunErrorCodeOf,
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  insertAndNotifyAgentRunEvent,
  listAgentRunEvents,
  requireManagedTransaction,
  markManagedTransactionRollbackOnly,
  type AgentRunErrorCode,
  type AgentRunEventKind,
  type AgentRunEventRow,
  type AgentRunRow,
  type AgentRunUnit,
  type TriggeredBy,
  withTransaction,
} from "@semprec/data";
import { publishAgentRunDelta } from "@semprec/realtime";
import { withTraceContext } from "@semprec/shared";
import type { AgentMessage, CreateAgentSession } from "./types.js";
import { logger } from "./logger.js";
import { findDanglingToolUses, syntheticToolResult } from "./danglingToolCalls.js";
import { createSensitiveTurnRedactor } from "./sensitiveTurnRedaction.js";

const PERSISTED_EVENT_KINDS: ReadonlySet<string> = new Set<AgentRunEventKind>([
  "turn_start",
  "message",
  "tool_use",
  "tool_result",
  "turn_end",
  "run_status",
  "user_message",
]);

/** Resolves the abort race in `runAgentTurn`. */
const ABORTED = Symbol("aborted");

export interface RunAgentSessionInput {
  createAgentSession: CreateAgentSession;
  task: string;
  triggeredBy: TriggeredBy;
  /** Defaults to 'invocation'; managed conversations pass 'session'. */
  unit?: AgentRunUnit;
  projectItemId?: string | null;
  parentRunId?: string | null;
  heartbeatId?: string | null;
  systemPromptOverride?: (defaultPrompt: string) => string;
  /** Observer for every message, persisted or not. */
  onEvent?: (message: AgentMessage) => void;
  /** Aborting it stops the turn and closes the run as `error` with an `AgentRunCancelledError`. */
  signal?: AbortSignal;
}

/** Thrown by `runAgentTurn` once its signal aborts; the run then closes as `error` like any failed turn. */
export class AgentRunCancelledError extends Error {
  readonly agentRunErrorCode: AgentRunErrorCode;

  constructor() {
    super("account deactivated");
    this.agentRunErrorCode = "cancelled";
    this.name = "AgentRunCancelledError";
  }
}

export function extractResultSnapshot(lastMessage: AgentMessage | null): string | null {
  if (!lastMessage) return null;
  const { text } = lastMessage as { text?: unknown };
  return typeof text === "string" ? text : JSON.stringify(lastMessage);
}

/** Appends the event, then lets the data layer announce its thin reference after commit. */
async function recordPersistentEvent(
  client: Pool | PoolClient,
  agentRunId: string,
  kind: AgentRunEventKind,
  payload: unknown,
): Promise<AgentRunEventRow> {
  return insertAndNotifyAgentRunEvent(client, agentRunId, kind, payload);
}

/** Best-effort: a lost typing delta affects animation only; the completed message is durable. */
async function pushLiveDelta(
  client: Pool | PoolClient,
  agentRunId: string,
  delta: AgentMessage,
  sempMessageId?: string,
  afterEventId?: string,
  deltaSequence?: number,
): Promise<void> {
  try {
    await publishAgentRunDelta(client, agentRunId, delta, sempMessageId, afterEventId, deltaSequence);
  } catch (err) {
    logger.error({ err, agentRunId, kind: delta.kind }, "Failed to publish agent_run_delta realtime message");
  }
}

export async function pushRunStatus(
  client: Pool | PoolClient,
  agentRunId: string,
  status: "running" | "done" | "error",
): Promise<void> {
  await recordPersistentEvent(client, agentRunId, "run_status", { kind: "run_status", status });
}

/**
 * Drives one turn's message stream against an already-open `agent_runs` row: `message_update` deltas go to the
 * ephemeral stream (never persisted); persisted kinds are appended to `agent_run_events` in arrival order before their
 * thin references are announced.
 *
 * Once a `tool_result` with the sensitive mark is stored redacted, every later `tool_use` argument and assistant
 * `message` of this call is redacted too; a content-bearing write to a sensitive database is redacted from the start
 * (`createSensitiveTurnRedactor`). `onEvent` still sees every message unchanged.
 *
 * Returns the last live `message`, or null. An aborted `signal` ends the session through its iterator's `return()` and
 * throws `AgentRunCancelledError`. `onFirstEvent` is awaited once with the first stored event's row id; a throw ends
 * the turn. Shared by `runAgentSession` (one turn) and the delegation registry (many turns on one long-lived run).
 */
export async function runAgentTurn(
  client: Pool | PoolClient,
  agentRunId: string,
  messages: AsyncIterable<AgentMessage>,
  onEvent?: (message: AgentMessage) => void,
  signal?: AbortSignal,
  onFirstEvent?: (eventId: string) => Promise<void> | void,
  sempMessageId?: string,
): Promise<AgentMessage | null> {
  return (await runAgentTurnWithStoredForm(client, agentRunId, messages, onEvent, signal, onFirstEvent, sempMessageId))
    .lastMessage;
}

export interface AgentTurnOutcome {
  /** What `runAgentTurn` returns. */
  lastMessage: AgentMessage | null;
  /**
   * The last `message` as written to `agent_run_events` (the marker text once a sensitive result was stored). Anything
   * persisting the outcome elsewhere, such as `agent_runs.result`, must derive it from this form.
   */
  storedLastMessage: AgentMessage | null;
}

/** For callers that write the outcome into a row other readers, other agents included, read back. */
export async function runAgentTurnWithStoredForm(
  client: Pool | PoolClient,
  agentRunId: string,
  messages: AsyncIterable<AgentMessage>,
  onEvent?: (message: AgentMessage) => void,
  signal?: AbortSignal,
  onFirstEvent?: (eventId: string) => Promise<void> | void,
  sempMessageId?: string,
): Promise<AgentTurnOutcome> {
  let firstEventReported = false;
  let lastMessage: AgentMessage | null = null;
  let storedLastMessage: AgentMessage | null = null;
  let lastPersistedId: string | undefined;
  let deltaSequence = 0;
  const redactor = createSensitiveTurnRedactor(client, agentRunId);
  const iterator = messages[Symbol.asyncIterator]();
  let finished = false;
  let cancelled = false;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<typeof ABORTED>((resolve) => {
        onAbort = () => resolve(ABORTED);
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;

  try {
    if (signal?.aborted) {
      cancelled = true;
      throw new AgentRunCancelledError();
    }
    for (;;) {
      let step: IteratorResult<AgentMessage> | typeof ABORTED;
      try {
        const pending = iterator.next();
        // Promise.race observes the pending next() even when cancellation wins.
        step = aborted ? await Promise.race([pending, aborted]) : await pending;
      } catch (err) {
        // Like for-await, a rejected next() propagates without calling return().
        finished = true;
        throw err;
      }
      if (step === ABORTED) {
        cancelled = true;
        throw new AgentRunCancelledError();
      }
      if (step.done) {
        finished = true;
        break;
      }
      const { value: message } = step;
      onEvent?.(message);

      // Watchers catch up on persisted kinds from `agent_run_events`; a missed message_update is deliberately lost.
      if (message.kind === "message_update") {
        deltaSequence++;
        await pushLiveDelta(
          client,
          agentRunId,
          message,
          sempMessageId,
          sempMessageId === undefined ? undefined : lastPersistedId,
          sempMessageId === undefined ? undefined : deltaSequence,
        );
      } else {
        if (PERSISTED_EVENT_KINDS.has(message.kind)) {
          const storedForm = await redactor.redact(message);
          const stored = await recordPersistentEvent(client, agentRunId, message.kind, storedForm);
          if (message.kind === "message") storedLastMessage = storedForm;
          lastPersistedId = stored.id;
          deltaSequence = 0;
          if (!firstEventReported) {
            firstEventReported = true;
            await onFirstEvent?.(stored.id);
          }
        }
        if (message.kind === "message") lastMessage = message;
      }

      // An abort that landed while the message above was being recorded stops before the next one.
      if (signal?.aborted) {
        cancelled = true;
        throw new AgentRunCancelledError();
      }
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (!finished) await closeSession(iterator, agentRunId, cancelled);
  }

  return { lastMessage, storedLastMessage };
}

/**
 * Ends an unfinished session through `return()`, as leaving `for await` early would. A generator queues `return()`
 * behind a pending `next()`, so on cancellation it is not awaited: the run closes now and the session ends when its
 * step settles. A failing `return()` is logged and never replaces the turn's outcome.
 */
async function closeSession(
  iterator: AsyncIterator<AgentMessage>,
  agentRunId: string,
  cancelled: boolean,
): Promise<void> {
  const logFailure = (err: unknown): void => {
    logger.error(
      { errorName: err instanceof Error ? err.name : typeof err, agentRunId },
      "Failed to close an agent session iterator",
    );
  };
  try {
    const closing = iterator.return?.();
    if (!closing) return;
    if (cancelled) closing.catch(logFailure);
    else await closing;
  } catch (err) {
    logFailure(err);
  }
}

/**
 * Maps pi-agent-core's lifecycle onto `agent_runs` (`agent_start`/`agent_end`) and `agent_run_events` (everything
 * between).
 */
export async function runAgentSession(client: Pool | PoolClient, input: RunAgentSessionInput): Promise<AgentRunRow> {
  const run = await createAgentRun(client, {
    projectItemId: input.projectItemId,
    parentRunId: input.parentRunId,
    heartbeatId: input.heartbeatId,
    triggeredBy: input.triggeredBy,
    unit: input.unit,
    task: input.task,
  });
  return withTraceContext({ agentRunId: run.id }, async () => {
    await pushRunStatus(client, run.id, "running");
    return runAgentSessionForRun(client, run, input);
  });
}

/** Pairs dangling calls and closes the failed run in one managed transaction. */
export async function closeFailedAgentRun(
  client: Pool | PoolClient,
  agentRunId: string,
  failure: unknown,
): Promise<void> {
  try {
    const close = async (c: PoolClient): Promise<void> => {
      const run = await getAgentRun(c, agentRunId, true);
      if (!run || run.status !== "running") return;
      const dangling = findDanglingToolUses(await listAgentRunEvents(c, agentRunId));
      const reason = agentRunErrorCodeOf(failure) === "cancelled" ? "cancelled" : "failed";
      for (const toolUse of dangling) {
        await recordPersistentEvent(
          c,
          agentRunId,
          "tool_result",
          syntheticToolResult(toolUse, `Turn ${reason} before this tool call completed.`),
        );
      }
      const closed = await finishAgentRunWithErrorNotification(c, agentRunId, agentRunErrorCodeOf(failure));
      if (closed) await pushRunStatus(c, agentRunId, "error");
    };
    if (client instanceof Pool) await withTransaction(client, close);
    else {
      requireManagedTransaction(client);
      try {
        await close(client);
      } catch (error) {
        markManagedTransactionRollbackOnly(client, error);
        throw error;
      }
    }
  } catch (secondary) {
    // The recovery ADR requires the original failure as cause and retains the caught error in errors[1].
    // eslint-disable-next-line preserve-caught-error
    throw new AggregateError([failure, secondary], "Failed to recover agent run", { cause: failure });
  }
}

/** A bare `Pool` gets one transaction; a supplied `PoolClient` is reused, so the caller's transaction decides. */
function closeAtomically(client: Pool | PoolClient, close: (c: PoolClient) => Promise<void>): Promise<void> {
  if (client instanceof Pool) return withTransaction(client, close);
  return close(client);
}

/**
 * `runAgentSession` for a run someone else already opened (queued `agentRun`/`delegatedAgentRun` jobs), using the row's
 * `task`. The caller records `running` first, in the same transaction as its check that the row is still `running`.
 */
export async function runAgentSessionForRun(
  client: Pool | PoolClient,
  run: AgentRunRow,
  input: Omit<RunAgentSessionInput, "task" | "triggeredBy" | "unit" | "projectItemId" | "parentRunId" | "heartbeatId">,
): Promise<AgentRunRow> {
  return withTraceContext({ agentRunId: run.id }, async () => {
    try {
      if (input.signal?.aborted) throw new AgentRunCancelledError();
      const session = input.createAgentSession({
        task: run.task,
        systemPromptOverride: input.systemPromptOverride,
        signal: input.signal,
      });
      // The run row keeps the stored form of the last message, not the live reply.
      const { storedLastMessage } = await runAgentTurnWithStoredForm(
        client,
        run.id,
        session.messages(),
        input.onEvent,
        input.signal,
      );
      // Terminal status and its `run_status` event commit together: a poller never sees one without the other, and the
      // catch below writes the only terminal state, `error`.
      await closeAtomically(client, async (c) => {
        if (!(await finishAgentRun(c, run.id, "done", extractResultSnapshot(storedLastMessage)))) return;
        await pushRunStatus(c, run.id, "done");
      });
    } catch (err) {
      await closeFailedAgentRun(client, run.id, err);
      throw err;
    }

    const finished = await getAgentRun(client, run.id);
    if (!finished) throw new Error(`agent run ${run.id} vanished after finishing`);
    return finished;
  });
}
