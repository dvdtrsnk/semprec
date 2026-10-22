import type { Pool } from "pg";
import {
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  withTransaction,
} from "@semprec/data";
import { currentTenantScope, runInTenant, withTraceContext } from "@semprec/shared";
import type { CompactionAdapter } from "./compaction.js";
import {
  persistCompaction,
  reconstructConversationHistory as reconstructHistoryEntries,
  type ReconstructedHistory,
} from "./conversationReconstruction.js";
import { extractResultSnapshot, pushRunStatus, runAgentTurn } from "./lifecycleAdapter.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "./types.js";
import { logger } from "./logger.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Upper bound on the delay before a dropped conversation's failed run close is retried; a shorter TTL bounds it further. */
const DROPPED_RUN_RETRY_MAX_MS = 60 * 1000;

export const SEMP_BUSY_ERROR_MESSAGE = "Semp is already handling another message, retry once the current turn finishes";

export type SempTurnResult = { ok: true; message: string | null } | { ok: false; error: string };

/**
 * Wake-time inheritance port: given the pool and Semp's own project item id, returns prior
 * conversation context to seed a freshly woken session's `initialState.messages` with, or null
 * when there is none to inherit (a conversation's very first-ever wake). #119's real
 * implementation, `createReconstructConversationHistory`, enumerates this conversation's prior
 * `agent_runs` rows (every row with `triggered_by='user'`, `unit='session'`, and this
 * `projectItemId`, in order), folds their `agent_run_events` into an `Entry[]` tree, and
 * compacts it when oversized. Options without a `compaction` adapter fall back to a stub that
 * always returns null, matching the pre-#119 behavior.
 */
export type ReconstructConversationHistory = (
  pool: Pool,
  projectItemId: string,
) => Promise<ReconstructedHistory | null>;

const stubReconstructConversationHistory: ReconstructConversationHistory = async () => null;

/** #119's real `ReconstructConversationHistory`: closes over a `CompactionAdapter` so `SempConversationOptions` only needs the plain two-arg seam shape every caller (and every existing test) already expects. */
export function createReconstructConversationHistory(compaction: CompactionAdapter): ReconstructConversationHistory {
  return (pool, projectItemId) =>
    reconstructHistoryEntries(pool, { projectItemId, triggeredBy: "user", parentRunId: null }, compaction);
}

interface ConversationRegistryEntry {
  agentRunId: string;
  session: AgentSession;
  busy: boolean;
  /** The pending TTL pause, or, once its conversation is dropped, the pending close retry. */
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Best-effort: matches `runAgentSession`'s error handling in `lifecycleAdapter.ts` so a failed
 * turn never leaves an `agent_runs` row stuck at `running` forever. Closing the run and writing
 * its `agent_run_error` notification (issue #149) run in one transaction, so a crash between the
 * two never leaves one without the other.
 */
async function failRun(pool: Pool, agentRunId: string, err: unknown): Promise<void> {
  try {
    const message = err instanceof Error ? err.message : String(err);
    await withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, agentRunId, message));
    await pushRunStatus(pool, agentRunId, "error");
  } catch (closeErr) {
    logger.error({ err: closeErr, agentRunId }, "SempConversation: failed to close errored run");
  }
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
  /** Seam for the real `pi-agent-core` `createAgentSession` (or a fake, in tests). */
  createAgentSession: CreateAgentSession;
  /**
   * Resolves the waking tenant's own Semprec project item id — `agent_runs.project_item_id` for
   * that tenant's wake run. Called once per wake, inside the caller's tenant scope, before
   * history reconstruction and run creation.
   */
  resolveProjectItemId: (pool: Pool) => Promise<string>;
  /** Defaults to the always-empty stub; pass `createReconstructConversationHistory(compactionAdapter)` for the real #119 reconstruction. */
  reconstructHistory?: ReconstructConversationHistory;
}

interface TenantConversation {
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
 * One conversation per tenant, multiplexed by the tenant id of the scope `send()` runs in: each
 * tenant has its own in-memory session, busy flag and TTL timer, and its own project (resolved
 * on every wake). Tenants never wait on each other.
 */
export class SempConversation {
  /** Keyed by tenant id; holds only live conversations (a key is deleted once its state is idle again). */
  private readonly conversations = new Map<string, TenantConversation>();

  constructor(
    private readonly pool: Pool,
    private readonly options: SempConversationOptions,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Test/shutdown seam: cancels every tenant's pending TTL timer so a process can exit cleanly. */
  clear(): void {
    for (const state of this.conversations.values()) {
      if (state.entry) clearTimeout(state.entry.ttlTimer);
    }
    this.conversations.clear();
  }

  /**
   * Discards `tenantId`'s conversation after its tenant was deactivated, clearing its TTL timer.
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
    const state = this.conversations.get(tenantId);
    if (!state || state.dropped) return;
    state.dropped = true;
    const entry = state.entry;
    if (entry) clearTimeout(entry.ttlTimer);
    if (state.waking || entry?.busy || !entry) return;
    await this.closeDropped(tenantId, state, entry);
  }

  /**
   * Closes a dropped conversation's run as `error` inside its tenant, then removes its entry. On a
   * failure the entry stays, holding a timer that runs this again.
   */
  private async closeDropped(
    tenantId: string,
    state: TenantConversation,
    entry: ConversationRegistryEntry,
  ): Promise<void> {
    entry.busy = true;
    try {
      await runInTenant(tenantId, async () => {
        const closed = await finishAgentRunWithErrorNotification(
          this.pool,
          entry.agentRunId,
          ACCOUNT_DEACTIVATED_MESSAGE,
        );
        await pushClosedRunStatus(this.pool, entry.agentRunId, closed, "error");
      });
      if (state.entry === entry) state.entry = null;
      this.releaseIfIdle(tenantId);
    } catch (err) {
      // Only the error's name: a Postgres error's detail can carry the failing `agent_runs` row,
      // whose `task` is the user's prompt, and logs are not tenant-scoped.
      logger.error(
        { errorName: errorName(err), tenantId, agentRunId: entry.agentRunId },
        "SempConversation: failed to close dropped run, will retry",
      );
      entry.busy = false;
      const timer = setTimeout(
        () => {
          this.closeDropped(tenantId, state, entry).catch((retryErr) => {
            logger.error({ errorName: errorName(retryErr), tenantId }, "SempConversation: dropped run retry failed");
          });
        },
        Math.min(this.ttlMs, DROPPED_RUN_RETRY_MAX_MS),
      );
      timer.unref?.();
      entry.ttlTimer = timer;
    }
  }

  /** Drops the tenant's key once it is back to `{ entry: null, waking: false }`. */
  private releaseIfIdle(tenantId: string): void {
    const state = this.conversations.get(tenantId);
    if (state && !state.entry && !state.waking) this.conversations.delete(tenantId);
  }

  async send(task: string): Promise<SempTurnResult> {
    // Read synchronously, before any `await`: nothing is read or written without a tenant.
    const scope = currentTenantScope();
    if (scope?.kind !== "tenant") {
      throw new Error("SempConversation.send must run inside a tenant scope");
    }
    const tenantId = scope.tenantId;

    const state = this.conversations.get(tenantId);

    // Busy check and reservation happen synchronously, before any `await` below, so a
    // concurrent call in the same tenant always observes one of these and is rejected rather
    // than racing to dispatch against, or wake alongside, the in-flight one.
    if (state?.entry?.busy || state?.waking || state?.dropped) {
      return { ok: false, error: SEMP_BUSY_ERROR_MESSAGE };
    }

    if (state?.entry) {
      const entry = state.entry;
      entry.busy = true;
      try {
        return await withTraceContext({ agentRunId: entry.agentRunId }, async () => {
          let lastMessage: AgentMessage | null;
          try {
            if (!entry.session.send) {
              throw new Error(
                "AgentSession does not support continuation (send) required to continue Semp's conversation",
              );
            }
            lastMessage = await runAgentTurn(this.pool, entry.agentRunId, entry.session.send(task));
          } catch (err) {
            // A broken turn leaves the underlying AgentSession in an unknown state — close the
            // run as error and drop the entry rather than leaving a busy-cleared but unusable
            // session around for the next message to reuse. The conversation itself is
            // unaffected: the next send() just wakes a fresh run, same as after a TTL pause.
            state.entry = null;
            clearTimeout(entry.ttlTimer);
            this.releaseIfIdle(tenantId);
            await failRun(this.pool, entry.agentRunId, err);
            throw err;
          }
          if (state.dropped) {
            await this.closeDropped(tenantId, state, entry);
          } else {
            this.touch(tenantId, entry);
          }
          return { ok: true, message: extractResultSnapshot(lastMessage) };
        });
      } finally {
        entry.busy = false;
      }
    }

    const wakeState: TenantConversation = { entry: null, waking: false };
    wakeState.waking = true;
    this.conversations.set(tenantId, wakeState);
    try {
      const projectItemId = await this.options.resolveProjectItemId(this.pool);
      const reconstruct = this.options.reconstructHistory ?? stubReconstructConversationHistory;
      const priorHistory = await reconstruct(this.pool, projectItemId);

      const run = await createAgentRun(this.pool, {
        projectItemId,
        triggeredBy: "user",
        unit: "session",
        task,
      });

      return await withTraceContext({ agentRunId: run.id }, async () => {
        await pushRunStatus(this.pool, run.id, "running");

        // The compacted continuation replaces the raw history it was derived from — persisted
        // here, on the run it seeds, so a later restart's reconstruction resumes from this
        // checkpoint instead of re-deriving (and potentially re-compacting) it all over again.
        if (priorHistory?.compacted) {
          await persistCompaction(this.pool, run.id, priorHistory.entries);
        }

        const session = this.options.createAgentSession({
          task,
          initialState: priorHistory ? { messages: priorHistory.entries } : undefined,
        });

        let lastMessage: AgentMessage | null;
        try {
          lastMessage = await runAgentTurn(this.pool, run.id, session.messages());
        } catch (err) {
          await failRun(this.pool, run.id, err);
          throw err;
        }

        if (wakeState.dropped) {
          const entry: ConversationRegistryEntry = { agentRunId: run.id, session, busy: true, ttlTimer: undefined };
          wakeState.entry = entry;
          await this.closeDropped(tenantId, wakeState, entry);
        } else {
          wakeState.entry = {
            agentRunId: run.id,
            session,
            busy: false,
            ttlTimer: this.scheduleTtl(tenantId),
          };
        }

        return { ok: true, message: extractResultSnapshot(lastMessage) };
      });
    } finally {
      wakeState.waking = false;
      this.releaseIfIdle(tenantId);
    }
  }

  private touch(tenantId: string, entry: ConversationRegistryEntry): void {
    clearTimeout(entry.ttlTimer);
    entry.ttlTimer = this.scheduleTtl(tenantId);
  }

  /** The callback re-enters the tenant explicitly: it never relies on whatever scope is active when the timer fires. */
  private scheduleTtl(tenantId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      runInTenant(tenantId, () => this.pause(tenantId)).catch((err) => {
        logger.error({ err, tenantId }, "SempConversation: pause failed");
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
  private async pause(tenantId: string): Promise<void> {
    const state = this.conversations.get(tenantId);
    const entry = state?.entry;
    if (!state || !entry || entry.busy) return;
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
      this.releaseIfIdle(tenantId);
    } catch (err) {
      if (!(err instanceof PauseSupersededByDrop)) {
        logger.error({ err, agentRunId: entry.agentRunId }, "SempConversation: failed to close paused run, will retry");
      }
      entry.busy = false;
      // A tenant dropped while this pause held the entry closes its run as `error` instead.
      if (state.dropped) {
        await this.closeDropped(tenantId, state, entry);
        return;
      }
      entry.ttlTimer = this.scheduleTtl(tenantId);
    }
  }
}
