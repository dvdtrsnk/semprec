import type { Pool } from "pg";
import { createAgentRun, finishAgentRun } from "@semprec/data";
import { extractResultSnapshot, pushRunStatus, runAgentTurn } from "./lifecycleAdapter.js";
import type { AgentSession, CreateAgentSession } from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const BUSY_ERROR_MESSAGE = "this project is already handling another request from this run, retry next turn";

export interface DelegateInput {
  /** Seam for the real `pi-agent-core` `createAgentSession` (or a fake, in tests). */
  createAgentSession: CreateAgentSession;
  supervisorRunId: string;
  targetProjectItemId: string;
  task: string;
  systemPromptOverride?: (defaultPrompt: string) => string;
}

export type DelegateResult = { ok: true; message: string | null } | { ok: false; error: string };

interface RegistryEntry {
  agentRunId: string;
  session: AgentSession;
  busy: boolean;
  lastActivityAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
}

function key(supervisorRunId: string, targetProjectItemId: string): string {
  return `${supervisorRunId}:${targetProjectItemId}`;
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
        if (!existing.session.send) {
          throw new Error("AgentSession does not support continuation (send) required to reuse a delegated session");
        }
        const lastMessage = await runAgentTurn(this.pool, existing.agentRunId, existing.session.send(input.task));
        this.touch(entryKey, existing);
        return { ok: true, message: extractResultSnapshot(lastMessage) };
      } finally {
        existing.busy = false;
      }
    }

    this.pendingKeys.add(entryKey);
    try {
      const run = await createAgentRun(this.pool, {
        projectItemId: input.targetProjectItemId,
        parentRunId: input.supervisorRunId,
        triggeredBy: "supervisor",
        unit: "session",
        task: input.task,
      });
      await pushRunStatus(this.pool, run.id, "running");

      const session = input.createAgentSession({
        task: input.task,
        systemPromptOverride: input.systemPromptOverride,
      });

      const lastMessage = await runAgentTurn(this.pool, run.id, session.messages());

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
    const timer = setTimeout(() => void this.expire(entryKey), this.ttlMs);
    // Never keep a process alive solely to fire a TTL sweep.
    timer.unref?.();
    return timer;
  }

  /**
   * 24 hours of inactivity (default) closes an idle delegated session: dropped from memory
   * and its `agent_runs` row finished as `done`, so `agent_runs` doesn't accumulate rows the
   * in-memory registry has already forgotten about. A `busy` entry's own next `touch()` call
   * reschedules a fresh timer past this fire, so this is a no-op for it.
   */
  private async expire(entryKey: string): Promise<void> {
    const entry = this.entries.get(entryKey);
    if (!entry || entry.busy) return;
    this.entries.delete(entryKey);
    await finishAgentRun(this.pool, entry.agentRunId, "done", null);
    await pushRunStatus(this.pool, entry.agentRunId, "done");
  }
}
