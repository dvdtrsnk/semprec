import type { Pool } from "pg";
import {
  agentRunErrorCodeOf,
  createAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  getDatabaseByModuleId,
  getItemById,
  lockItemById,
  PROJECTS_MODULE_ID,
  withTransaction,
} from "@semprec/data";
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

export const BUSY_ERROR_MESSAGE = "this project is already handling another request from this run, retry next turn";

/**
 * One answer for every refusal of a new delegated session (unknown id, another tenant's or a trashed project, a
 * non-Projects item, an invisible supervisor run), so the model cannot learn which ids exist elsewhere. Only checked
 * when creating a session; an existing session is reused without rechecking until its entry expires.
 */
export const UNKNOWN_DELEGATION_TARGET_MESSAGE = "targetProjectItemId does not name a project this run can delegate to";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wake-time inheritance port for a delegated session, keyed by `(supervisorRunId, targetProjectItemId)`. Defaults to
 * the always-empty stub.
 */
export type ReconstructDelegatedHistory = (
  pool: Pool,
  targetProjectItemId: string,
  supervisorRunId: string,
) => Promise<ReconstructedHistory | null>;

const stubReconstructDelegatedHistory: ReconstructDelegatedHistory = async () => null;

/** Closes over a `CompactionAdapter` so `DelegateInput` keeps the plain three-arg seam shape. */
export function createReconstructDelegatedHistory(compaction: CompactionAdapter): ReconstructDelegatedHistory {
  return (pool, targetProjectItemId, supervisorRunId) =>
    reconstructHistoryEntries(
      pool,
      { projectItemId: targetProjectItemId, triggeredBy: "supervisor", parentRunId: supervisorRunId },
      compaction,
    );
}

export interface DelegateInput {
  createAgentSession: CreateAgentSession;
  supervisorRunId: string;
  targetProjectItemId: string;
  task: string;
  /** Defaults to the always-empty stub. */
  reconstructHistory?: ReconstructDelegatedHistory;
}

export type DelegateResult = { ok: true; message: string | null } | { ok: false; error: string };

interface RegistryEntry {
  agentRunId: string;
  session: AgentSession;
  busy: boolean;
  /** Observable value behind `ttlTimer`. */
  lastActivityAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
}

function key(supervisorRunId: string, targetProjectItemId: string): string {
  return `${supervisorRunId}:${targetProjectItemId}`;
}

/**
 * Best-effort, like `runAgentSession`, so a failed turn never leaves a run stuck `running`. Closing the run and writing
 * its `agent_run_error` notification share one transaction.
 */
async function failRun(pool: Pool, agentRunId: string, err: unknown): Promise<void> {
  const errorCode = agentRunErrorCodeOf(err);
  try {
    await withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, agentRunId, errorCode));
    await pushRunStatus(pool, agentRunId, "error");
  } catch (closeErr) {
    // Code and error name only: a Postgres error's detail can carry the row, whose `task` is the user's prompt, and
    // logs are not tenant-scoped.
    logger.error(
      { errorName: closeErr instanceof Error ? closeErr.name : typeof closeErr, errorCode, agentRunId },
      "DelegationRegistry: failed to close errored run",
    );
  }
}

/**
 * Process-memory registry of open supervisor->project-agent delegated sessions, used by `agentTool.delegate`. Keyed by
 * `(supervisorRunId, targetProjectItemId)`: unrelated supervisors never share a session, while a repeat delegation from
 * the same supervisor to the same project continues the open session.
 *
 * One instance must be shared per process, or the busy check and TTL reuse are defeated. Nothing is persisted: a
 * restart abandons every entry and `repairInterruptedRuns` sweeps them up on the next startup.
 */
export class DelegationRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /**
   * Keys with a create in flight. A new key's busy check and its first `await` must be atomic to a concurrent caller,
   * or two calls would each create a session for the same target.
   */
  private readonly pendingKeys = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Test/shutdown seam: cancels every pending TTL timer so the process can exit. */
  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.ttlTimer);
    this.entries.clear();
    this.pendingKeys.clear();
  }

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    // `targetProjectItemId` is untrusted model input and must not reach SQL unvalidated. New sessions also require a
    // visible supervisor and a live Projects item in this tenant.
    if (!UUID_PATTERN.test(input.targetProjectItemId)) {
      return { ok: false, error: `targetProjectItemId "${input.targetProjectItemId}" is not a well-formed UUID` };
    }

    const entryKey = key(input.supervisorRunId, input.targetProjectItemId);
    const existing = this.entries.get(entryKey);

    // Busy check and reservation happen synchronously, before any `await`, so a concurrent call on the same key is
    // rejected instead of racing.
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
          // A broken turn leaves the session in an unknown state: close the run as error and drop the entry.
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
      // Refuse invalid targets before reconstruction (which may call the model); revalidated under row locks in the
      // write transaction below.
      const targetIsDelegable = await withTransaction(this.pool, async (client) => {
        const supervisor = await getAgentRun(client, input.supervisorRunId);
        // A missing Projects database is an infrastructure failure, not a refusal to report to the model.
        const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
        if (!projects) {
          throw new Error(`Projects module database not found for module ${PROJECTS_MODULE_ID}`);
        }
        const target = await getItemById(client, projects.id, input.targetProjectItemId);
        return supervisor !== null && target !== null && target.deletedAt === null;
      });
      if (!targetIsDelegable) {
        return { ok: false, error: UNKNOWN_DELEGATION_TARGET_MESSAGE };
      }

      const reconstruct = input.reconstructHistory ?? stubReconstructDelegatedHistory;
      const priorHistory = await reconstruct(this.pool, input.targetProjectItemId, input.supervisorRunId);

      const run = await withTransaction(this.pool, async (client) => {
        const supervisor = await getAgentRun(client, input.supervisorRunId, true);
        const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
        if (!projects) {
          throw new Error(`Projects module database not found for module ${PROJECTS_MODULE_ID}`);
        }
        const target = await lockItemById(client, projects.id, input.targetProjectItemId);
        if (!supervisor || !target || target.deletedAt !== null) return null;

        // Keep the supervisor and target locked until the guarded insert commits.
        return createAgentRun(client, {
          projectItemId: input.targetProjectItemId,
          parentRunId: input.supervisorRunId,
          triggeredBy: "supervisor",
          unit: "session",
          task: input.task,
        });
      });
      if (!run) {
        return { ok: false, error: UNKNOWN_DELEGATION_TARGET_MESSAGE };
      }
      await pushRunStatus(this.pool, run.id, "running");

      // Persisted on the run it seeds, so a later restart resumes from this checkpoint instead of re-compacting.
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
        logger.error({ err, entryKey }, "DelegationRegistry: expire failed");
      });
    }, this.ttlMs);
    // Never keep a process alive solely to fire a TTL sweep.
    timer.unref?.();
    return timer;
  }

  /**
   * Inactivity (default 24h) drops an idle session from memory and finishes its run as `done`.
   *
   * Claims the entry as `busy` synchronously, before the first `await`, so a `delegate()` arriving mid-expiry is
   * rejected with `BUSY_ERROR_MESSAGE` instead of reusing a session being finished.
   *
   * The entry is removed as soon as the row is confirmed terminal, before `pushRunStatus` (which can throw): a
   * busy-reset entry pointing at a closed run would let `delegate()` reuse it. Only a failure before the row is
   * confirmed terminal resets `busy` and reschedules. When another writer already finished the row, the entry is
   * dropped even if reading back that writer's status fails, and the run_status event records that writer's status.
   */
  private async expire(entryKey: string): Promise<void> {
    const entry = this.entries.get(entryKey);
    if (!entry || entry.busy) return;
    entry.busy = true;
    let rowConfirmedTerminal = false;
    try {
      const closed = await finishAgentRun(this.pool, entry.agentRunId, "done", null);
      let status: "running" | "done" | "error";
      if (closed) {
        status = "done";
      } else {
        logger.warn(
          { agentRunId: entry.agentRunId },
          "DelegationRegistry: expired session's run was already finished by another writer",
        );
        rowConfirmedTerminal = true;
        const finished = await getAgentRun(this.pool, entry.agentRunId);
        if (!finished) throw new Error(`agent run ${entry.agentRunId} vanished after finishing`);
        status = finished.status;
      }
      // Row is terminal: drop the entry before `pushRunStatus`, which can still throw.
      this.entries.delete(entryKey);
      clearTimeout(entry.ttlTimer);
      await pushRunStatus(this.pool, entry.agentRunId, status);
    } catch (err) {
      // Compare identity, not key presence: a concurrent `delegate()` may have inserted a new entry under the same key,
      // and retrying must never touch someone else's live session.
      if (this.entries.get(entryKey) === entry && !rowConfirmedTerminal) {
        logger.error({ err, entryKey }, "DelegationRegistry: failed to close expired session, will retry");
        entry.busy = false;
        entry.ttlTimer = this.scheduleTtl(entryKey);
      } else {
        // A replaced entry, or a row already confirmed terminal: nothing to retry. Drop the stale entry only if it is
        // still the current one.
        if (this.entries.get(entryKey) === entry) {
          this.entries.delete(entryKey);
          clearTimeout(entry.ttlTimer);
        }
        logger.error(
          { err, entryKey },
          "DelegationRegistry: expired session's run was already closed, but recording its final status failed; will not retry",
        );
      }
    }
  }
}
