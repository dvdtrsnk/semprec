import type { Pool } from "pg";
import { createAgentRun, finishAgentRun, finishAgentRunWithErrorNotification, withTransaction } from "@semprec/data";
import type { CompactionAdapter } from "./compaction.js";
import {
  persistCompaction,
  reconstructConversationHistory as reconstructHistoryEntries,
  type ReconstructedHistory,
} from "./conversationReconstruction.js";
import { extractResultSnapshot, pushRunStatus, runAgentTurn } from "./lifecycleAdapter.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "./types.js";

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
    console.error("SempConversation: failed to close errored run", agentRunId, closeErr);
  }
}

export interface SempConversationOptions {
  /** Seam for the real `pi-agent-core` `createAgentSession` (or a fake, in tests). */
  createAgentSession: CreateAgentSession;
  /** Semprec's own project item id — `agent_runs.project_item_id` for every wake run. */
  projectItemId: string;
  /** Defaults to the always-empty stub; pass `createReconstructConversationHistory(compactionAdapter)` for the real #119 reconstruction. */
  reconstructHistory?: ReconstructConversationHistory;
}

/**
 * Manages Semp's own, singular conversation with the user through the same in-memory,
 * TTL-based session reuse issue #229's `DelegationRegistry` uses for delegated sessions, with
 * one crucial difference at TTL expiry: a delegated session's `agent_runs` row *is* the whole
 * task, so expiry finishes it as `done` and forgets it for good. Semp's conversation with the
 * user never "finishes" that way — expiry only *pauses* it. Each wake (the very first message
 * ever, or the first message after a pause) opens a new `agent_runs` row, seeded through
 * `reconstructHistory` with whatever came before, but the conversation itself stays resumable
 * indefinitely: there is no persisted "closed" state for it to be in, and no caller-supplied key
 * to resume it by — the next `send()` call, a minute or a month later, just resumes it.
 *
 * A singleton by construction: Semprec is a single-tenant system with exactly one ongoing
 * conversation between Semp and its one user, so unlike `DelegationRegistry` there is no
 * per-caller key to multiplex over — only one in-memory session at a time.
 */
export class SempConversation {
  private entry: ConversationRegistryEntry | null = null;
  /** Set for the span of a brand-new wake, before it has an entry to be `busy` on its own behalf. */
  private waking = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: SempConversationOptions,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Test/shutdown seam: cancels the pending TTL timer so a process can exit cleanly. */
  clear(): void {
    if (this.entry) clearTimeout(this.entry.ttlTimer);
    this.entry = null;
    this.waking = false;
  }

  async send(task: string): Promise<SempTurnResult> {
    const entry = this.entry;

    // Busy check and reservation happen synchronously, before any `await` below, so a
    // concurrent call always observes one of these and is rejected rather than racing to
    // dispatch against, or wake alongside, the in-flight one.
    if (entry?.busy || this.waking) {
      return { ok: false, error: SEMP_BUSY_ERROR_MESSAGE };
    }

    if (entry) {
      entry.busy = true;
      try {
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
          this.entry = null;
          clearTimeout(entry.ttlTimer);
          await failRun(this.pool, entry.agentRunId, err);
          throw err;
        }
        this.touch(entry);
        return { ok: true, message: extractResultSnapshot(lastMessage) };
      } finally {
        entry.busy = false;
      }
    }

    this.waking = true;
    try {
      const reconstruct = this.options.reconstructHistory ?? stubReconstructConversationHistory;
      const priorHistory = await reconstruct(this.pool, this.options.projectItemId);

      const run = await createAgentRun(this.pool, {
        projectItemId: this.options.projectItemId,
        triggeredBy: "user",
        unit: "session",
        task,
      });
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

      this.entry = {
        agentRunId: run.id,
        session,
        busy: false,
        ttlTimer: this.scheduleTtl(),
      };

      return { ok: true, message: extractResultSnapshot(lastMessage) };
    } finally {
      this.waking = false;
    }
  }

  private touch(entry: ConversationRegistryEntry): void {
    clearTimeout(entry.ttlTimer);
    entry.ttlTimer = this.scheduleTtl();
  }

  private scheduleTtl(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.pause().catch((err) => {
        console.error("SempConversation: pause failed", err);
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
   * memory to close it).
   *
   * Claims the entry as `busy` synchronously, before its first `await` — the same invariant
   * `send()`'s own busy check relies on — so a `send()` arriving mid-pause never reuses a
   * session whose run this is in the middle of finishing as `done`; it observes `busy` and is
   * rejected instead, same as if a turn were in flight.
   */
  private async pause(): Promise<void> {
    const entry = this.entry;
    if (!entry || entry.busy) return;
    entry.busy = true;
    try {
      await finishAgentRun(this.pool, entry.agentRunId, "done", null);
      await pushRunStatus(this.pool, entry.agentRunId, "done");
      this.entry = null;
    } catch (err) {
      console.error("SempConversation: failed to close paused run, will retry", err);
      entry.busy = false;
      entry.ttlTimer = this.scheduleTtl();
    }
  }
}
