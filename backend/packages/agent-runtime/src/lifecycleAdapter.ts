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
  /** Seam for the real `pi-agent-core` `createAgentSession` (or a fake, in tests). */
  createAgentSession: CreateAgentSession;
  task: string;
  triggeredBy: TriggeredBy;
  /** Defaults to 'invocation'; #118 passes 'session' for managed conversations. */
  unit?: AgentRunUnit;
  projectItemId?: string | null;
  parentRunId?: string | null;
  heartbeatId?: string | null;
  systemPromptOverride?: (defaultPrompt: string) => string;
  /** Extra observer for every message, persisted or not (e.g. #118's session bookkeeping). */
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

/**
 * Appends a recovery event first, then delegates its post-commit thin-reference announcement to
 * the data layer that owns both the row and the after-commit hook.
 */
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
 * Drives one turn's message stream to completion against an already-open `agent_runs` row:
 * pushes `message_update` deltas through the ephemeral stream (never persisted) and appends the
 * persisted-kind ones to `agent_run_events` in arrival order before announcing thin references.
 * A `tool_result` that carries the sensitive mark is stored redacted (issue #1827), and so are, from then on in
 * this call, the arguments of every `tool_use` and the content of every assistant `message`; a `tool_use` of a
 * content-bearing write to a sensitive database is stored with redacted arguments from the start (issue #2001,
 * `createSensitiveTurnRedactor`). `onEvent` still receives every message unchanged. Returns the turn's last
 * `message`-kind event as the session produced it (the live one), or null if it never produced one. An aborted `signal` (already aborted, or
 * aborting while the loop waits for or records a message) ends the session through its iterator's
 * `return()` and throws `AgentRunCancelledError`. `onFirstEvent` is awaited once, with the row id
 * of the first event this call stores, right after its insert; a throw there ends the turn like
 * any failed step.
 *
 * Shared by `runAgentSession` (one turn, closing the run immediately after) and the
 * delegation registry (#229: many turns reusing one long-lived `agent_runs` row that only
 * closes on TTL expiry) — both need identical event bookkeeping, just different lifecycle
 * bookends around it.
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

/** What `runAgentTurnWithStoredForm` returns: the last `message` as the session produced it and as it was stored. */
export interface AgentTurnOutcome {
  /** The live last `message`, or null; what `runAgentTurn` returns. */
  lastMessage: AgentMessage | null;
  /**
   * The last `message` in the form written to `agent_run_events` (issue #2001): the marker as its text when the call
   * had already stored a sensitive result. Whatever persists the turn's outcome elsewhere, such as
   * `agent_runs.result`, derives it from this form. Null when there was no `message`.
   */
  storedLastMessage: AgentMessage | null;
}

/**
 * `runAgentTurn` that also returns the stored form of the last `message` (`AgentTurnOutcome`), for the callers that
 * write the turn's outcome into a row other readers, other agents included, read back.
 */
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

      // A watcher missing a live update for a persisted kind catches up from `agent_run_events`;
      // a missed message_update is deliberately lost, same as a dropped WS typing frame.
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
 * Ends an unfinished session through the iterator's `return()`, as leaving a `for await` early
 * would. A generator queues `return()` behind a `next()` it is still awaiting, so on cancellation
 * it is not awaited: the run must close now, and the session ends when its pending step settles.
 * A failing `return()` is logged and never replaces the turn's own outcome.
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
 * Runs one agent session end to end, mapping pi-agent-core's lifecycle onto `agent_runs`
 * (`agent_start`/`agent_end`) and the turn-level `agent_run_events` log (everything between).
 * Durable events are announced as thin post-commit references; `message_update` typing deltas
 * use the separate ephemeral stream and are never persisted to Postgres.
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

/**
 * Runs `close` atomically: a bare `Pool` gets one transaction for the whole close, while a
 * caller-supplied `PoolClient` is reused as is, so the caller's own transaction decides.
 */
function closeAtomically(client: Pool | PoolClient, close: (c: PoolClient) => Promise<void>): Promise<void> {
  if (client instanceof Pool) return withTransaction(client, close);
  return close(client);
}

/**
 * `runAgentSession` without the `createAgentRun`: drives one session for an `agent_runs` row
 * someone else already opened (issue #647's queued `agentRun`/`delegatedAgentRun` jobs), with the
 * row's own `task`, and closes it exactly as `runAgentSession` does. The caller records the run's
 * `running` status first, so it can do that in the same transaction as its own check that the row
 * is still `running`.
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
      // The run row keeps the stored form of the last message, not the live reply (issue #2001).
      const { storedLastMessage } = await runAgentTurnWithStoredForm(
        client,
        run.id,
        session.messages(),
        input.onEvent,
        input.signal,
      );
      // The row's terminal status and its `run_status` event commit together, so a poller never
      // sees the row closed before the event exists, and a failed close leaves neither behind —
      // the catch below then writes the only terminal state, `error`.
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
