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
  ttlTimer: ReturnType<typeof setTimeout>;
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
    const entry = state?.entry ?? null;

    // Busy check and reservation happen synchronously, before any `await` below, so a
    // concurrent call in the same tenant always observes one of these and is rejected rather
    // than racing to dispatch against, or wake alongside, the in-flight one.
    if (entry?.busy || state?.waking) {
      return { ok: false, error: SEMP_BUSY_ERROR_MESSAGE };
    }

    if (state && entry) {
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
          this.touch(tenantId, entry);
          return { ok: true, message: extractResultSnapshot(lastMessage) };
        });
      } finally {
        entry.busy = false;
      }
    }

    const wakeState: TenantConversation = state ?? { entry: null, waking: false };
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

        wakeState.entry = {
          agentRunId: run.id,
          session,
          busy: false,
          ttlTimer: this.scheduleTtl(tenantId),
        };

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
      const closed = await finishAgentRun(this.pool, entry.agentRunId, "done", null);
      if (closed) {
        await pushRunStatus(this.pool, entry.agentRunId, "done");
      } else {
        logger.warn(
          { agentRunId: entry.agentRunId },
          "SempConversation: paused run was already finished by another writer",
        );
        const finished = await getAgentRun(this.pool, entry.agentRunId);
        if (!finished) throw new Error(`agent run ${entry.agentRunId} vanished after finishing`);
        await pushRunStatus(this.pool, entry.agentRunId, finished.status);
      }
      state.entry = null;
      this.releaseIfIdle(tenantId);
    } catch (err) {
      logger.error({ err, agentRunId: entry.agentRunId }, "SempConversation: failed to close paused run, will retry");
      entry.busy = false;
      entry.ttlTimer = this.scheduleTtl(tenantId);
    }
  }
}
