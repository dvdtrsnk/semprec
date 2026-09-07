import type { Pool } from "pg";
import { createAgentRun, finishAgentRun } from "@semprec/data";
import type { CompactionAdapter } from "./compaction.js";
import {
  persistCompaction,
  reconstructConversationHistory as reconstructHistoryEntries,
  type ReconstructedHistory,
} from "./conversationReconstruction.js";
import { extractResultSnapshot, pushRunStatus, runAgentTurn } from "./lifecycleAdapter.js";
import type { AgentMessage, AgentSession, CreateAgentSession } from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const BUSY_ERROR_MESSAGE = "this project is already handling another request from this run, retry next turn";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wake-time inheritance port for a delegated session, the same job `sempConversation.ts`'s
 * `ReconstructConversationHistory` does for Semp's own conversation — a delegated one is keyed
 * by `(supervisorRunId, targetProjectItemId)` rather than a fixed project item id, so this seam
 * takes both. Defaults to the always-empty stub, matching pre-#119 behavior.
 */
export type ReconstructDelegatedHistory = (
  pool: Pool,
  targetProjectItemId: string,
  supervisorRunId: string,
) => Promise<ReconstructedHistory | null>;

const stubReconstructDelegatedHistory: ReconstructDelegatedHistory = async () => null;

/** #119's real `ReconstructDelegatedHistory`: closes over a `CompactionAdapter` so `DelegateInput` only needs the plain three-arg seam shape every caller (and every existing test) already expects. */
export function createReconstructDelegatedHistory(compaction: CompactionAdapter): ReconstructDelegatedHistory {
  return (pool, targetProjectItemId, supervisorRunId) =>
    reconstructHistoryEntries(pool, { projectItemId: targetProjectItemId, triggeredBy: "supervisor", parentRunId: supervisorRunId }, compaction);
}

export interface DelegateInput {
  /** Seam for the real `pi-agent-core` `createAgentSession` (or a fake, in tests). */
  createAgentSession: CreateAgentSession;
  supervisorRunId: string;
  targetProjectItemId: string;
  task: string;
  /** Defaults to the always-empty stub; pass `createReconstructDelegatedHistory(compactionAdapter)` for the real #119 reconstruction. */
  reconstructHistory?: ReconstructDelegatedHistory;
}

export type DelegateResult = { ok: true; message: string | null } | { ok: false; error: string };

interface RegistryEntry {
  agentRunId: string;
  session: AgentSession;
  busy: boolean;
  /** Issue #229 names this as one of the entry's required fields; `ttlTimer` is its live enforcement, this is the observable value behind it. */
  lastActivityAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
}

function key(supervisorRunId: string, targetProjectItemId: string): string {
  return `${supervisorRunId}:${targetProjectItemId}`;
}

/** Best-effort: matches `runAgentSession`'s error handling in `lifecycleAdapter.ts` so a failed turn never leaves an `agent_runs` row stuck at `running` forever. */
async function failRun(pool: Pool, agentRunId: string, err: unknown): Promise<void> {
  try {
    await finishAgentRun(pool, agentRunId, "error", err instanceof Error ? err.message : String(err));
    await pushRunStatus(pool, agentRunId, "error");
  } catch (closeErr) {
    console.error("DelegationRegistry: failed to close errored run", agentRunId, closeErr);
  }
}

/**
 * Process-memory registry of open supervisor->project-agent delegated sessions (#229's
 * delegation tool, `agentTool.delegate`, is the only intended caller). Entries are keyed by
 * `(supervisorRunId, targetProjectItemId)` so two unrelated supervisor runs delegating to the
 * same project never share a target session, while a further delegation from the *same*
 * supervisor run onto the *same* project reuses the still-open `AgentSession` as a new turn
 * in the same conversation.
 *
 * One instance must be shared across every delegate call in a process — a fresh instance per
 * call defeats both the busy check and the TTL reuse this exists for. There is deliberately
 * no persisted table backing this: a process restart abandons every entry, which is exactly
 * what `repairInterruptedRuns` (#117) already sweeps up on the next startup.
 */
export class DelegationRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /**
   * Keys with a create-in-flight but not yet in `entries`. A brand-new key's busy check and
   * its first `await` (creating the `agent_runs` row) must be atomic from a concurrent
   * caller's point of view, otherwise two calls arriving before either finishes creating
   * would both see "no entry" and each create their own session for the same target.
   */
  private readonly pendingKeys = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Test/shutdown seam: cancels every pending TTL timer so a process can exit cleanly. */
  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.ttlTimer);
    this.entries.clear();
    this.pendingKeys.clear();
  }

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    // `targetProjectItemId` comes from the model's own tool-call arguments — untrusted input
    // that must not reach `createAgentRun`'s SQL unvalidated. Full authorization (is this
    // supervisor run actually allowed to reach this project?) belongs to the permission
    // manifest the not-yet-built composition root (#91) resolves; this is only the format
    // guard against a malformed/malicious id landing in `agent_runs.project_item_id`.
    if (!UUID_PATTERN.test(input.targetProjectItemId)) {
      return { ok: false, error: `targetProjectItemId "${input.targetProjectItemId}" is not a well-formed UUID` };
    }

    const entryKey = key(input.supervisorRunId, input.targetProjectItemId);
    const existing = this.entries.get(entryKey);

    // Busy check and reservation happen synchronously, before any `await` below, so a
    // concurrent call onto the same key — new or existing — always observes one of these
    // and is rejected rather than racing to dispatch or create alongside it.
    if (existing?.busy || this.pendingKeys.has(entryKey)) {
      return { ok: false, error: BUSY_ERROR_MESSAGE };
    }

    if (existing) {
      existing.busy = true;
      try {
        let lastMessage: AgentMessage | null;
        try {
          if (!existing.session.send) {
            throw new Error("AgentSession does not support continuation (send) required to reuse a delegated session");
          }
          lastMessage = await runAgentTurn(this.pool, existing.agentRunId, existing.session.send(input.task));
        } catch (err) {
          // A broken turn (including a session that can't be continued at all) leaves the
          // underlying AgentSession in an unknown state — close the run as error and drop the
          // entry rather than leaving a busy-cleared but unusable session in the registry for
          // the next delegation to reuse.
          this.entries.delete(entryKey);
          clearTimeout(existing.ttlTimer);
          await failRun(this.pool, existing.agentRunId, err);
          throw err;
        }
        this.touch(entryKey, existing);
        return { ok: true, message: extractResultSnapshot(lastMessage) };
      } finally {
        existing.busy = false;
      }
    }

    this.pendingKeys.add(entryKey);
    try {
      const reconstruct = input.reconstructHistory ?? stubReconstructDelegatedHistory;
      const priorHistory = await reconstruct(this.pool, input.targetProjectItemId, input.supervisorRunId);

      const run = await createAgentRun(this.pool, {
        projectItemId: input.targetProjectItemId,
        parentRunId: input.supervisorRunId,
        triggeredBy: "supervisor",
        unit: "session",
        task: input.task,
      });
      await pushRunStatus(this.pool, run.id, "running");

      // The compacted continuation replaces the raw history it was derived from — persisted
      // here, on the run it seeds, so a later restart's reconstruction resumes from this
      // checkpoint instead of re-deriving (and potentially re-compacting) it all over again.
      if (priorHistory?.compacted) {
        await persistCompaction(this.pool, run.id, priorHistory.entries);
      }

      const session = input.createAgentSession({
        task: input.task,
        initialState: priorHistory ? { messages: priorHistory.entries } : undefined,
      });

      let lastMessage: AgentMessage | null;
      try {
        lastMessage = await runAgentTurn(this.pool, run.id, session.messages());
      } catch (err) {
        await failRun(this.pool, run.id, err);
        throw err;
      }

      const entry: RegistryEntry = {
        agentRunId: run.id,
        session,
        busy: false,
        lastActivityAt: Date.now(),
        ttlTimer: this.scheduleTtl(entryKey),
      };
      this.entries.set(entryKey, entry);

      return { ok: true, message: extractResultSnapshot(lastMessage) };
    } finally {
      this.pendingKeys.delete(entryKey);
    }
  }

  private touch(entryKey: string, entry: RegistryEntry): void {
    entry.lastActivityAt = Date.now();
    clearTimeout(entry.ttlTimer);
    entry.ttlTimer = this.scheduleTtl(entryKey);
  }

  private scheduleTtl(entryKey: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.expire(entryKey).catch((err) => {
        console.error("DelegationRegistry: expire failed for", entryKey, err);
      });
    }, this.ttlMs);
    // Never keep a process alive solely to fire a TTL sweep.
    timer.unref?.();
    return timer;
  }

  /**
   * 24 hours of inactivity (default) closes an idle delegated session: dropped from memory
   * and its `agent_runs` row finished as `done`, so `agent_runs` doesn't accumulate rows the
   * in-memory registry has already forgotten about. A `busy` entry's own next `touch()` call
   * reschedules a fresh timer past this fire, so this is a no-op for it.
   *
   * The entry is only removed from `entries` once both DB writes succeed — a transient DB
   * failure here reschedules another attempt on the same cadence instead of losing track of
   * the entry (which would otherwise leave its `agent_runs` row stuck at `running` forever
   * with nothing left in memory to close it).
   */
  private async expire(entryKey: string): Promise<void> {
    const entry = this.entries.get(entryKey);
    if (!entry || entry.busy) return;
    try {
      await finishAgentRun(this.pool, entry.agentRunId, "done", null);
      await pushRunStatus(this.pool, entry.agentRunId, "done");
      this.entries.delete(entryKey);
    } catch (err) {
      console.error("DelegationRegistry: failed to close expired session, will retry", entryKey, err);
      entry.ttlTimer = this.scheduleTtl(entryKey);
    }
  }
}
