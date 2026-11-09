import type { Pool } from "pg";
import {
  type AgentRunRow,
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  withTransaction,
} from "@semprec/data";
import { currentTenantScope, labeledSempMessageRefSchema, runInTenant, withTraceContext } from "@semprec/shared";
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

/** What a reconstruction needs to know about the thread being woken: the thread to read and the project its run will belong to. */
export interface SempThreadWake {
  threadId: string;
  projectItemId: string;
  signal?: AbortSignal;
}

/**
 * The thread a turn belongs to. A tick thread's runs belong to its heartbeat's project, so it
 * carries that project item id; chat and item threads run in the Semprec project, which the
 * registry resolves per wake.
 */
export type SempThread =
  { threadId: string; kind: "chat" | "item" } | { threadId: string; kind: "tick"; projectItemId: string };

/**
 * Wake-time inheritance port: given the pool and the woken thread, returns prior
 * conversation context to seed a freshly woken session's `initialState.messages` with, or null
 * when there is none to inherit (a conversation's very first-ever wake). #119's real
 * implementation, `createReconstructConversationHistory`, enumerates this conversation's prior
 * `agent_runs` rows (every row with `triggered_by='user'`, `unit='session'`, no parent and this
 * thread's `thread_id`, in order), folds their `agent_run_events` into an `Entry[]` tree, and
 * compacts it when oversized. Options without a `compaction` adapter fall back to a stub that
 * always returns null, matching the pre-#119 behavior.
 */
export type ReconstructConversationHistory = (pool: Pool, wake: SempThreadWake) => Promise<ReconstructedHistory | null>;

const stubReconstructConversationHistory: ReconstructConversationHistory = async () => null;

/** #119's real `ReconstructConversationHistory`: closes over a `CompactionAdapter` so `SempConversationOptions` only needs the plain two-arg seam shape every caller (and every existing test) already expects. */
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
 * Records the `run_status` event for a close attempt that did not throw: the status this close
 * wrote, or — when another writer had already finished the run — the status that writer stored,
 * read back since it may differ from `status`.
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
   * Builds the session factory for one run. `send()` calls it with the run row it created for a
   * waking turn, after the run is `running` and before the first prompt, so the session's tools
   * bind to that run's id. A test double can return a constant factory.
   */
  createAgentSessionForRun: (
    run: AgentRunRow,
    currentSempMessage?: { current: string | null },
  ) => Promise<CreateAgentSession>;
  /**
   * Resolves the waking tenant's own Semprec project item id — `agent_runs.project_item_id` for
   * a chat or item thread's wake run (a tick thread supplies its heartbeat's project instead and
   * this is not called). Called once per such wake, inside the caller's tenant scope, before
   * history reconstruction and run creation.
   */
  resolveProjectItemId: (pool: Pool) => Promise<string>;
  /** Defaults to the always-empty stub; pass `createReconstructConversationHistory(compactionAdapter)` for the real #119 reconstruction. */
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
  /** Set for the span of a brand-new wake, before it has an entry to be `busy` on its own behalf. */
  waking: boolean;
  /**
   * Set by `dropTenant`. A turn or pause in flight closes the run as `error` once it settles; a
   * failed close keeps the entry and retries. `send()` rejects a dropped conversation as busy
   * until its entry is gone.
   */
  dropped?: boolean;
}

/** The error a wake run is closed with when its tenant is deactivated. */
const ACCOUNT_DEACTIVATED_MESSAGE = "account deactivated";

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
 * Manages Semp's ongoing conversation with each tenant's user through the same in-memory,
 * TTL-based session reuse issue #229's `DelegationRegistry` uses for delegated sessions, with
 * one crucial difference at TTL expiry: a delegated session's `agent_runs` row *is* the whole
 * task, so expiry finishes it as `done` and forgets it for good. Semp's conversation with the
 * user never "finishes" that way — expiry only *pauses* it. Each wake (the very first message
 * ever, or the first message after a pause) opens a new `agent_runs` row, seeded through
 * `reconstructHistory` with whatever came before, but the conversation itself stays resumable
 * indefinitely: there is no persisted "closed" state for it to be in, and no caller-supplied key
 * to resume it by — the next `send()` call, a minute or a month later, just resumes it.
 *
 * One conversation per thread, multiplexed by the tenant id of the scope `send()` runs in and the
 * thread id it is given: each `(tenant, thread)` has its own in-memory session, busy flag, waking
 * flag, dropped flag and TTL timer. Threads and tenants never wait on each other; a second
 * concurrent turn in the same thread is rejected as busy. Ordering of turns within a thread is
 * the turn queue's job, not this registry's.
 */
export class SempConversation {
  /** Keyed by `conversationKey(tenantId, threadId)`; holds only live conversations (a key is deleted once its state is idle again). */
  private readonly conversations = new Map<string, ThreadConversation>();

  constructor(
    private readonly pool: Pool,
    private readonly options: SempConversationOptions,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Test/shutdown seam: cancels every thread's pending TTL timer so a process can exit cleanly. */
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
   * Discards every thread conversation of `tenantId` after its tenant was deactivated, clearing
   * their TTL timers; other tenants are untouched. Each thread is then handled independently.
   * With no turn in flight, the wake run is closed as `error` ("account deactivated") and the entry
   * removed. With a turn in flight (`busy` or `waking`), the conversation is marked dropped and the
   * turn is not aborted: once it settles, its run is closed as `error` and its entry discarded
   * instead of being kept. A TTL pause in progress also holds the entry `busy`: it checks the drop
   * inside its own transaction after its `done` update and before `COMMIT`, rolls that update back,
   * and closes the run as `error` the same way; a failed pause does the same instead of
   * rescheduling. Only a drop arriving once the pause's `COMMIT` was sent finds the run already
   * `done`, as it would after any finished pause.
   *
   * Like `pause()`, the entry is only removed once the close succeeded: a failed close keeps it,
   * still dropped, and retries on a timer, so the run is never left `running` with nothing in
   * memory to close it. A call for a tenant with no conversation, or one already dropped, does
   * nothing.
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

  /**
   * Closes a dropped conversation's run as `error` inside its tenant, then removes its entry. On a
   * failure the entry stays, holding a timer that runs this again.
   */
  private async closeDropped(state: ThreadConversation, entry: ConversationRegistryEntry): Promise<void> {
    const { tenantId, threadId } = state;
    entry.busy = true;
    try {
      await runInTenant(tenantId, async () => {
        const closed = await finishAgentRunWithErrorNotification(
          this.pool,
          entry.agentRunId,
          ACCOUNT_DEACTIVATED_MESSAGE,
          "cancelled",
        );
        await pushClosedRunStatus(this.pool, entry.agentRunId, closed, "error");
      });
      if (state.entry === entry) state.entry = null;
      this.releaseIfIdle(state);
    } catch (err) {
      // Only the error's name: a Postgres error's detail can carry the failing `agent_runs` row,
      // whose `task` is the user's prompt, and logs are not tenant-scoped.
      logger.error(
        { errorName: errorName(err), tenantId, threadId, agentRunId: entry.agentRunId },
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

  /** Drops the thread's key once it is back to `{ entry: null, waking: false }`. */
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

    // Busy check and reservation happen synchronously, before any `await` below, so a
    // concurrent call in the same tenant always observes one of these and is rejected rather
    // than racing to dispatch against, or wake alongside, the in-flight one.
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
            // A broken turn leaves the underlying AgentSession in an unknown state — close the
            // run as error and drop the entry rather than leaving a busy-cleared but unusable
            // session around for the next message to reuse. The conversation itself is
            // unaffected: the next send() just wakes a fresh run, same as after a TTL pause.
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

  /** The callback re-enters the tenant explicitly: it never relies on whatever scope is active when the timer fires. */
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
   * 24 hours of inactivity (default) pauses the conversation: the in-memory session is dropped
   * and its wake run finished as `done`, so `agent_runs` doesn't accumulate rows the in-memory
   * state has already forgotten about. Unlike `DelegationRegistry.expire`, nothing here marks
   * the *conversation* itself as finished — there is no such state — so the next `send()` call,
   * whenever it arrives, just wakes a brand-new run through `reconstructHistory` instead of
   * finding an entry to reuse.
   *
   * The entry is only cleared once both DB writes succeed — a transient DB failure here
   * reschedules another attempt on the same cadence instead of losing track of the entry (which
   * would otherwise leave its `agent_runs` row stuck at `running` forever with nothing left in
   * memory to close it). A run another writer already finished is logged and still cleared: its
   * row is terminal either way, and its run_status event records the status that writer stored
   * (read back after the lost close, since it may have been `error`) rather than `done`.
   *
   * Claims the entry as `busy` synchronously, before its first `await` — the same invariant
   * `send()`'s own busy check relies on — so a `send()` arriving mid-pause never reuses a
   * session whose run this is in the middle of finishing as `done`; it observes `busy` and is
   * rejected instead, same as if a turn were in flight.
   */
  private async pause(state: ThreadConversation, strict = false): Promise<void> {
    const entry = state.entry;
    if (!entry || entry.busy) return;
    entry.busy = true;
    try {
      const closed = await withTransaction(this.pool, async (client) => {
        const updated = await finishAgentRun(client, entry.agentRunId, "done", null);
        // Read after the update and before `COMMIT`, so a drop that arrived while the update ran
        // still rolls it back and the run closes as `error` below.
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
      // A tenant dropped while this pause held the entry closes its run as `error` instead.
      if (state.dropped) {
        await this.closeDropped(state, entry);
        if (strict) throw err;
        return;
      }
      entry.ttlTimer = this.scheduleTtl(state);
      if (strict) throw err;
    }
  }
}
