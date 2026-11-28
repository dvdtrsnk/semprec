import type { Pool } from "pg";
import {
  type AgentRunRow,
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  withTransaction,
} from "@alldots/data";
import { currentTenantScope, labeledSempMessageRefSchema, runInTenant, withTraceContext } from "@alldots/shared";
import type { CompactionAdapter } from "./compaction.js";
import {
  persistCompaction,
  reconstructConversationHistory as reconstructHistoryEntries,
  reconstructBoundedThreadHistory,
  type ReconstructedHistory,
} from "./conversationReconstruction.js";
import { closeFailedAgentRun, extractResultSnapshot, pushRunStatus, runAgentTurn } from "./lifecycleAdapter.js";
import type { AgentImage, AgentMessage, AgentSession, CreateAgentSession, UserTurnContextRef } from "./types.js";
import { logger } from "./logger.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Upper bound on the delay before a dropped conversation's failed run close is retried; a shorter TTL bounds it further. */
const DROPPED_RUN_RETRY_MAX_MS = 60 * 1000;

export const SEMP_BUSY_ERROR_MESSAGE = "Semp is already handling another message, retry once the current turn finishes";

export type SempTurnResult = { ok: true; message: string | null } | { ok: false; error: string };

export interface SempThreadWake {
  threadId: string;
  projectItemId: string;
  signal?: AbortSignal;
}

/**
 * A tick thread's runs belong to its heartbeat's project; chat and item threads run in the Alldots project, which the
 * registry resolves per wake.
 */
export type SempThread =
  { threadId: string; kind: "chat" | "item" } | { threadId: string; kind: "tick"; projectItemId: string };

/**
 * Wake-time inheritance port: returns prior conversation context to seed a freshly woken session's
 * `initialState.messages`, or null on a conversation's first wake. The real implementation is
 * `createReconstructConversationHistory`; without it, a stub always returns null.
 */
export type ReconstructConversationHistory = (pool: Pool, wake: SempThreadWake) => Promise<ReconstructedHistory | null>;

const stubReconstructConversationHistory: ReconstructConversationHistory = async () => null;

/** Closes over a `CompactionAdapter` so `SempConversationOptions` keeps the plain two-arg seam shape. */
export function createReconstructConversationHistory(compaction: CompactionAdapter): ReconstructConversationHistory {
  return (pool, { threadId }) =>
    reconstructHistoryEntries(pool, { threadId, triggeredBy: "user", parentRunId: null }, compaction);
}

export function createBoundedSempHistory(): ReconstructConversationHistory {
  return (pool, { threadId }) => reconstructBoundedThreadHistory(pool, threadId);
}

interface ConversationRegistryEntry {
  agentRunId: string;
  session: AgentSession;
  busy: boolean;
  lastCompletedToken?: string;
  currentSempMessage?: { current: string | null };
  /** The pending TTL pause, or, once its conversation is dropped, the pending close retry. */
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
}

async function failRun(pool: Pool, agentRunId: string, err: unknown): Promise<void> {
  await closeFailedAgentRun(pool, agentRunId, err);
}

/**
 * Records the `run_status` event for a close that did not throw: the status written, or, when another writer had
 * already finished the run, the status that writer stored.
 */
async function pushClosedRunStatus(
  pool: Pool,
  agentRunId: string,
  closed: boolean,
  status: "done" | "error",
): Promise<void> {
  if (closed) {
    await pushRunStatus(pool, agentRunId, status);
    return;
  }
  logger.warn({ agentRunId }, `SempConversation: run closed as ${status} was already finished by another writer`);
  const finished = await getAgentRun(pool, agentRunId);
  if (!finished) throw new Error(`agent run ${agentRunId} vanished after finishing`);
  await pushRunStatus(pool, agentRunId, finished.status);
}

export interface SempConversationOptions {
  /**
   * Builds the session factory for one run. Called after the run is `running` and before the first prompt, so the
   * session's tools bind to that run's id.
   */
  createAgentSessionForRun: (
    run: AgentRunRow,
    currentSempMessage?: { current: string | null },
  ) => Promise<CreateAgentSession>;
  /**
   * Resolves the tenant's Alldots project item id for a chat or item thread's wake run (tick threads supply their
   * heartbeat's project). Called once per wake, inside the tenant scope, before reconstruction and run creation.
   */
  resolveProjectItemId: (pool: Pool) => Promise<string>;
  /** Defaults to the always-empty stub. */
  reconstructHistory?: ReconstructConversationHistory;
}

/** Reported by `onTurnStart` once a turn's run is `running` and its first event is stored. */
export interface SempTurnStart {
  agentRunId: string;
  firstEventId: string;
}

export interface SempSendOptions {
  context?: readonly UserTurnContextRef[];
  images?: readonly AgentImage[];
  /** Text prepended only to the model input; the durable user event keeps the original task. */
  modelPrefix?: string;
  messageId?: string;
  /** Cancels the turn, including a prompt blocked on its next event; the run then closes as `error`. */
  signal?: AbortSignal;
  /**
   * Awaited once per turn, right after the first event the turn stores and before the model is
   * prompted further. A throw ends the turn: the run closes as `error` and the error propagates.
   */
  onTurnStart?: (turn: SempTurnStart) => Promise<void> | void;
  onFailurePersistenceError?: (error: unknown) => void;
}

async function* preserveUserText(messages: AsyncIterable<AgentMessage>, task: string): AsyncIterable<AgentMessage> {
  for await (const message of messages) {
    yield message.kind === "user_message" ? { ...message, text: task } : message;
  }
}

interface ThreadConversation {
  tenantId: string;
  threadId: string;
  entry: ConversationRegistryEntry | null;
  /** Set for the span of a new wake, before it has an entry to be `busy` on. */
  waking: boolean;
  /**
   * Set by `dropTenant`. A turn or pause in flight closes the run as `error` once it settles; a failed close keeps the
   * entry and retries. `send()` rejects a dropped conversation as busy until its entry is gone.
   */
  dropped?: boolean;
}

function conversationKey(tenantId: string, threadId: string): string {
  return `${tenantId}:${threadId}`;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Rolls back a TTL pause's `done` close when its tenant was dropped before that close committed. */
class PauseSupersededByDrop extends Error {
  constructor() {
    super("TTL pause superseded by a tenant drop");
    this.name = "PauseSupersededByDrop";
  }
}

/**
 * Semp's ongoing conversation with each tenant's user, with TTL-based in-memory session reuse. Unlike a delegated
 * session, TTL expiry only pauses the conversation: each wake (first message ever, or first after a pause) opens a new
 * `agent_runs` row seeded through `reconstructHistory`, and there is no persisted closed state.
 *
 * One conversation per `(tenant, thread)`, each with its own session, busy/waking/dropped flags and TTL timer. A second
 * concurrent turn in the same thread is rejected as busy; ordering turns is the turn queue's job.
 */
export class SempConversation {
  /** Holds only live conversations; a key is deleted once its state is idle again. */
  private readonly conversations = new Map<string, ThreadConversation>();

  constructor(
    private readonly pool: Pool,
    private readonly options: SempConversationOptions,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Test/shutdown seam: cancels every pending TTL timer so the process can exit. */
  clear(): void {
    for (const state of this.conversations.values()) {
      if (state.entry) clearTimeout(state.entry.ttlTimer);
    }
    this.conversations.clear();
  }

  async ensureFresh(threadId: string, frontier: string | null): Promise<void> {
    const scope = currentTenantScope();
    if (scope?.kind !== "tenant") throw new Error("Semp conversation requires a tenant scope");
    const state = this.conversations.get(conversationKey(scope.tenantId, threadId));
    if (!state?.entry) return;
    if (state.entry.busy || state.waking || state.dropped) throw new Error("Semp conversation is not idle");
    if (state.entry.lastCompletedToken !== undefined && state.entry.lastCompletedToken === frontier) return;
    await this.pause(state, true);
    if (state.entry) throw new Error("Could not pause stale Semp conversation");
  }

  markCompleted(threadId: string, token: string): void {
    const scope = currentTenantScope();
    if (scope?.kind !== "tenant") throw new Error("Semp conversation requires a tenant scope");
    const state = this.conversations.get(conversationKey(scope.tenantId, threadId));
    if (state?.entry && !state.dropped) state.entry.lastCompletedToken = token;
  }

  /**
   * Discards every conversation of a deactivated tenant. With no turn in flight the wake run is closed as `error`
   * (`cancelled`) and the entry removed. A turn in flight (`busy` or `waking`) is not aborted: it is marked dropped and
   * its run closed as `error` once it settles. A TTL pause in progress checks the drop after its `done` update and
   * before `COMMIT`, rolls back and closes as `error`; only a drop arriving after that `COMMIT` finds the run `done`.
   *
   * The entry is removed only once the close succeeded; a failed close keeps it and retries on a timer, so the run is
   * never left `running` with nothing in memory to close it.
   */
  async dropTenant(tenantId: string): Promise<void> {
    const states = [...this.conversations.values()].filter((state) => state.tenantId === tenantId);
    await Promise.all(states.map((state) => this.dropThread(state)));
  }

  private async dropThread(state: ThreadConversation): Promise<void> {
    if (state.dropped) return;
    state.dropped = true;
    const entry = state.entry;
    if (entry) clearTimeout(entry.ttlTimer);
    if (state.waking || entry?.busy || !entry) return;
    await this.closeDropped(state, entry);
  }

  /** On failure the entry stays, holding a timer that runs this again. */
  private async closeDropped(state: ThreadConversation, entry: ConversationRegistryEntry): Promise<void> {
    const { tenantId, threadId } = state;
    entry.busy = true;
    try {
      await runInTenant(tenantId, async () => {
        const closed = await finishAgentRunWithErrorNotification(this.pool, entry.agentRunId, "cancelled");
        await pushClosedRunStatus(this.pool, entry.agentRunId, closed, "error");
      });
      if (state.entry === entry) state.entry = null;
      this.releaseIfIdle(state);
    } catch (err) {
      // Only the error's name: a Postgres error's detail can carry the `agent_runs` row, whose `task` is the user's
      // prompt, and logs are not tenant-scoped.
      logger.error(
        { errorName: errorName(err), errorCode: "cancelled", tenantId, threadId, agentRunId: entry.agentRunId },
        "SempConversation: failed to close dropped run, will retry",
      );
      entry.busy = false;
      const timer = setTimeout(
        () => {
          this.closeDropped(state, entry).catch((retryErr) => {
            logger.error(
              { errorName: errorName(retryErr), tenantId, threadId },
              "SempConversation: dropped run retry failed",
            );
          });
        },
        Math.min(this.ttlMs, DROPPED_RUN_RETRY_MAX_MS),
      );
      timer.unref?.();
      entry.ttlTimer = timer;
    }
  }

  private releaseIfIdle(state: ThreadConversation): void {
    const key = conversationKey(state.tenantId, state.threadId);
    if (this.conversations.get(key) === state && !state.entry && !state.waking) this.conversations.delete(key);
  }

  async send(task: string, thread: SempThread, sendOptions: SempSendOptions = {}): Promise<SempTurnResult> {
    const { signal, onTurnStart } = sendOptions;
    const sempMessageId = sendOptions.messageId;
    const modelTask = sendOptions.modelPrefix ? `${sendOptions.modelPrefix}\n\n${task}` : task;
    const parsedContext = labeledSempMessageRefSchema
      .array()
      .safeParse(sendOptions.context === undefined ? [] : sendOptions.context);
    if (!parsedContext.success) throw new Error("Invalid user turn context");
    const context = parsedContext.data;
    // Read synchronously, before any `await`: nothing is read or written without a tenant.
    const scope = currentTenantScope();
    if (scope?.kind !== "tenant") {
      throw new Error("SempConversation.send must run inside a tenant scope");
    }
    const tenantId = scope.tenantId;

    const key = conversationKey(tenantId, thread.threadId);
    const state = this.conversations.get(key);

    // Busy check and reservation happen synchronously, before any `await`, so a concurrent call is rejected instead of
    // racing the in-flight one.
    if (state?.entry?.busy || state?.waking || state?.dropped) {
      return { ok: false, error: SEMP_BUSY_ERROR_MESSAGE };
    }

    if (state?.entry) {
      const entry = state.entry;
      entry.busy = true;
      if (entry.currentSempMessage) entry.currentSempMessage.current = sempMessageId ?? null;
      try {
        return await withTraceContext({ agentRunId: entry.agentRunId }, async () => {
          let lastMessage: AgentMessage | null;
          try {
            if (!entry.session.send) {
              throw new Error(
                "AgentSession does not support continuation (send) required to continue Semp's conversation",
              );
            }
            lastMessage = await runAgentTurn(
              this.pool,
              entry.agentRunId,
              preserveUserText(entry.session.send(modelTask, context, sendOptions.images), task),
              undefined,
              signal,
              onTurnStart && ((firstEventId) => onTurnStart({ agentRunId: entry.agentRunId, firstEventId })),
              sempMessageId,
            );
          } catch (err) {
            // A broken turn leaves the AgentSession in an unknown state: close the run as error and drop the entry. The
            // next send() wakes a fresh run, as after a TTL pause.
            state.entry = null;
            clearTimeout(entry.ttlTimer);
            this.releaseIfIdle(state);
            try {
              await failRun(this.pool, entry.agentRunId, err);
            } catch (cleanupError) {
              sendOptions.onFailurePersistenceError?.(cleanupError);
              throw cleanupError;
            }
            throw err;
          }
          if (state.dropped) {
            await this.closeDropped(state, entry);
          } else {
            this.touch(state, entry);
          }
          return { ok: true, message: extractResultSnapshot(lastMessage) };
        });
      } finally {
        if (entry.currentSempMessage) entry.currentSempMessage.current = null;
        entry.busy = false;
      }
    }

    const wakeState: ThreadConversation = { tenantId, threadId: thread.threadId, entry: null, waking: true };
    const currentSempMessage = { current: sempMessageId ?? null };
    this.conversations.set(key, wakeState);
    try {
      const projectItemId =
        thread.kind === "tick" ? thread.projectItemId : await this.options.resolveProjectItemId(this.pool);
      const reconstruct = this.options.reconstructHistory ?? stubReconstructConversationHistory;
      const priorHistory = await reconstruct(this.pool, { threadId: thread.threadId, projectItemId, signal });

      const run = await createAgentRun(this.pool, {
        projectItemId,
        threadId: thread.threadId,
        triggeredBy: "user",
        unit: "session",
        task,
      });

      return await withTraceContext({ agentRunId: run.id }, async () => {
        await pushRunStatus(this.pool, run.id, "running");

        let session: AgentSession;
        let lastMessage: AgentMessage | null;
        try {
          // Persist the checkpoint on the same thread's run before creating a session.
          if (priorHistory?.compacted) {
            await persistCompaction(this.pool, run.id, priorHistory.entries, {
              threadId: thread.threadId,
              triggeredBy: "user",
              parentRunId: null,
            });
          }
          const createAgentSession = await this.options.createAgentSessionForRun(run, currentSempMessage);
          session = createAgentSession({
            task: modelTask,
            context,
            images: sendOptions.images,
            signal,
            initialState: priorHistory ? { messages: priorHistory.entries } : undefined,
          });
          lastMessage = await runAgentTurn(
            this.pool,
            run.id,
            preserveUserText(session.messages(), task),
            undefined,
            signal,
            onTurnStart && ((firstEventId) => onTurnStart({ agentRunId: run.id, firstEventId })),
            sempMessageId,
          );
        } catch (err) {
          try {
            await failRun(this.pool, run.id, err);
          } catch (cleanupError) {
            sendOptions.onFailurePersistenceError?.(cleanupError);
            throw cleanupError;
          }
          throw err;
        }

        if (wakeState.dropped) {
          const entry: ConversationRegistryEntry = {
            agentRunId: run.id,
            session,
            busy: true,
            ttlTimer: undefined,
            currentSempMessage,
          };
          wakeState.entry = entry;
          await this.closeDropped(wakeState, entry);
        } else {
          wakeState.entry = {
            agentRunId: run.id,
            session,
            currentSempMessage,
            busy: false,
            ttlTimer: this.scheduleTtl(wakeState),
          };
        }

        return { ok: true, message: extractResultSnapshot(lastMessage) };
      });
    } finally {
      currentSempMessage.current = null;
      wakeState.waking = false;
      this.releaseIfIdle(wakeState);
    }
  }

  private touch(state: ThreadConversation, entry: ConversationRegistryEntry): void {
    clearTimeout(entry.ttlTimer);
    entry.ttlTimer = this.scheduleTtl(state);
  }

  /** Re-enters the tenant explicitly, never relying on the scope active when the timer fires. */
  private scheduleTtl(state: ThreadConversation): ReturnType<typeof setTimeout> {
    const { tenantId, threadId } = state;
    const timer = setTimeout(() => {
      runInTenant(tenantId, () => this.pause(state)).catch((err) => {
        logger.error({ err, tenantId, threadId }, "SempConversation: pause failed");
      });
    }, this.ttlMs);
    // Never keep a process alive solely to fire a TTL sweep.
    timer.unref?.();
    return timer;
  }

  /**
   * Inactivity (default 24h) drops the in-memory session and finishes its wake run as `done`, so `agent_runs` does not
   * keep rows memory has forgotten. The next `send()` wakes a new run through `reconstructHistory`.
   *
   * The entry is cleared only once both DB writes succeed; a DB failure reschedules, so the row is never stuck
   * `running`. A run another writer already finished is logged and cleared, recording the status that writer stored.
   *
   * Claims the entry as `busy` synchronously, before the first `await`, so a `send()` arriving mid-pause is rejected
   * instead of reusing a session being finished.
   */
  private async pause(state: ThreadConversation, strict = false): Promise<void> {
    const entry = state.entry;
    if (!entry || entry.busy) return;
    entry.busy = true;
    try {
      const closed = await withTransaction(this.pool, async (client) => {
        const updated = await finishAgentRun(client, entry.agentRunId, "done", null);
        // Read before `COMMIT`, so a drop during the update still rolls it back.
        if (state.dropped) throw new PauseSupersededByDrop();
        return updated;
      });
      await pushClosedRunStatus(this.pool, entry.agentRunId, closed, "done");
      state.entry = null;
      this.releaseIfIdle(state);
    } catch (err) {
      if (!(err instanceof PauseSupersededByDrop)) {
        logger.error({ err, agentRunId: entry.agentRunId }, "SempConversation: failed to close paused run, will retry");
      }
      entry.busy = false;
      if (state.dropped) {
        try {
          await this.closeDropped(state, entry);
        } catch (cleanupError) {
          if (strict) {
            // The pause error is primary; preserve the later cleanup error in the aggregate.
            // eslint-disable-next-line preserve-caught-error
            throw new AggregateError([err, cleanupError], "Semp pause and drop cleanup failed", { cause: err });
          }
          throw cleanupError;
        }
        if (strict) throw err;
        return;
      }
      entry.ttlTimer = this.scheduleTtl(state);
      if (strict) throw err;
    }
  }
}
