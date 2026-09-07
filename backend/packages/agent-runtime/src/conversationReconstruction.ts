import type { Pool } from "pg";
import {
  insertAgentRunEvent,
  listAgentRunEvents,
  listSessionAgentRuns,
  type SessionAgentRunsFilter,
} from "@semprec/data";
import type { CompactionAdapter } from "./compaction.js";
import type { AgentMessage, ConversationEntry } from "./types.js";

/**
 * Lifecycle bookkeeping only, never conversation content pi-agent-core needs to resume — the
 * live realtime channel (`pushRunStatus`) is `run_status`'s only real consumer.
 */
const NON_CONVERSATIONAL_KINDS: ReadonlySet<string> = new Set(["run_status"]);

/**
 * Walks every prior `unit='session'` `agent_runs` row for one dormant conversation, in order,
 * folding their `agent_run_events` into one linear `Entry[]` chain. A stored `'compaction'`
 * event's payload *is* the continuation state as of that point — encountering one resets the
 * walk to it (rather than appending to it) so a restart replays the same checkpoint instead of
 * re-deriving, and potentially re-compacting, the full raw history all over again.
 */
async function walkStoredEntries(pool: Pool, filter: SessionAgentRunsFilter): Promise<ConversationEntry[]> {
  const runs = await listSessionAgentRuns(pool, filter);
  let entries: ConversationEntry[] = [];
  let seq = 0;
  let parentId: string | null = null;

  for (const run of runs) {
    const events = await listAgentRunEvents(pool, run.id);
    for (const event of events) {
      if (event.kind === "compaction") {
        entries = event.payload as ConversationEntry[];
        const last = entries[entries.length - 1];
        seq = last ? last.seq + 1 : 0;
        parentId = last ? last.id : null;
        continue;
      }
      if (NON_CONVERSATIONAL_KINDS.has(event.kind)) continue;

      const entry: ConversationEntry = {
        id: event.id,
        parentId,
        seq: seq++,
        timestamp: new Date(event.at).getTime(),
        message: event.payload as AgentMessage,
      };
      entries.push(entry);
      parentId = entry.id;
    }
  }

  return entries;
}

export interface ReconstructedHistory {
  entries: ConversationEntry[];
  /** True when this history was too large as reconstructed and `compaction` replaced it — the caller's cue to persist the checkpoint via `persistCompaction`. */
  compacted: boolean;
}

/**
 * The full #119 reconstruction: rebuilds the `Entry[]` tree from `agent_run_events`, sizes it
 * with pi-agent-core's public `estimateContextTokens`/`shouldCompact` before ever handing it to
 * a provider, and — only when required — reduces it through the public, low-level
 * `prepareCompaction`/`compact` pair. Returns null on a conversation's very first-ever wake (no
 * prior rows), same as #118's stub.
 */
export async function reconstructConversationHistory(
  pool: Pool,
  filter: SessionAgentRunsFilter,
  compaction: CompactionAdapter,
): Promise<ReconstructedHistory | null> {
  const entries = await walkStoredEntries(pool, filter);
  if (entries.length === 0) return null;

  const tokens = compaction.estimateContextTokens(entries.map((entry) => entry.message));
  if (!compaction.shouldCompact(tokens, compaction.contextWindow, compaction.settings)) {
    return { entries, compacted: false };
  }

  const prepared = compaction.prepareCompaction(entries, compaction.settings);
  const compacted = await compaction.compact(prepared);
  return { entries: compacted, compacted: true };
}

/**
 * Persists a compaction's result onto the wake run it seeds, as the single source of truth a
 * later restart's `walkStoredEntries` resumes from — the "repeated restart remains
 * deterministic" half of #119's Task, without which every restart would redo the same
 * (possibly expensive, and not guaranteed idempotent) compaction from scratch.
 */
export async function persistCompaction(pool: Pool, agentRunId: string, entries: ConversationEntry[]): Promise<void> {
  await insertAgentRunEvent(pool, agentRunId, "compaction", entries);
}
