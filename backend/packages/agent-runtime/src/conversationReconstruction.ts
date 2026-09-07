import type { Pool } from "pg";
import {
  insertAgentRunEvent,
  listAgentRunEvents,
  listSessionAgentRuns,
  type SessionAgentRunsFilter,
} from "@semprec/data";
import type { CompactionAdapter } from "./compaction.js";
import type { AgentMessage, AgentMessageKind, ConversationEntry } from "./types.js";

/**
 * Lifecycle bookkeeping only, never conversation content pi-agent-core needs to resume — the
 * live realtime channel (`pushRunStatus`) is `run_status`'s only real consumer.
 */
const NON_CONVERSATIONAL_KINDS: ReadonlySet<string> = new Set(["run_status"]);

const AGENT_MESSAGE_KINDS: ReadonlySet<string> = new Set<AgentMessageKind>([
  "turn_start",
  "message",
  "tool_use",
  "tool_result",
  "turn_end",
  "run_status",
  "message_update",
]);

function isAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    AGENT_MESSAGE_KINDS.has((value as { kind: string }).kind)
  );
}

/**
 * `agent_run_events.payload` is only ever written by this codebase's own turn loop, but this is
 * the first code to read it back as structured data rather than replay it verbatim — a payload
 * from a stale writer version or a hand-edited row must fail loudly here rather than silently
 * corrupt the `Entry[]` tree handed to pi-agent-core.
 */
function parseStoredAgentMessage(payload: unknown, eventId: string): AgentMessage {
  if (!isAgentMessage(payload)) {
    throw new Error(`agent_run_events row ${eventId} has a payload that is not a valid AgentMessage`);
  }
  return payload;
}

function isConversationEntry(value: unknown): value is ConversationEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ConversationEntry>;
  return (
    typeof entry.id === "string" &&
    (entry.parentId === null || typeof entry.parentId === "string") &&
    typeof entry.seq === "number" &&
    typeof entry.timestamp === "number" &&
    isAgentMessage(entry.message)
  );
}

/** Same rationale as {@link parseStoredAgentMessage}, for a `'compaction'` checkpoint's payload. */
function parseCompactionPayload(payload: unknown, agentRunId: string): ConversationEntry[] {
  if (!Array.isArray(payload) || !payload.every(isConversationEntry)) {
    throw new Error(`agent_run_events 'compaction' row for run ${agentRunId} has a payload that is not a valid ConversationEntry[]`);
  }
  return payload;
}

/**
 * Protocol validation for the reconstructed tree: every `tool_use` must be followed, in order,
 * by its own `tool_result` (matched on `toolCallId`), and nothing may end mid-call. A dormant
 * conversation's history is expected to already satisfy this — `repairInterruptedRuns` (#117)
 * closes out any run left with a trailing unmatched `tool_use` before reconstruction ever sees
 * it — so a violation here means the stored history itself is unsound, and pi-agent-core must
 * not be handed it.
 */
function validateProtocolInvariants(entries: ConversationEntry[]): void {
  const pendingToolCallIds: string[] = [];
  for (const entry of entries) {
    const kind = entry.message.kind;
    if (kind === "tool_use") {
      const toolCallId = (entry.message as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== "string") {
        throw new Error(`tool_use entry ${entry.id} is missing a string toolCallId`);
      }
      pendingToolCallIds.push(toolCallId);
    } else if (kind === "tool_result") {
      const toolCallId = (entry.message as { toolCallId?: unknown }).toolCallId;
      const expected = pendingToolCallIds.shift();
      if (typeof toolCallId !== "string" || toolCallId !== expected) {
        throw new Error(
          `tool_result entry ${entry.id} (toolCallId=${String(toolCallId)}) does not match the pending tool_use call (expected ${String(expected)})`,
        );
      }
    }
  }
  if (pendingToolCallIds.length > 0) {
    throw new Error(`reconstructed history has ${pendingToolCallIds.length} unmatched tool_use call(s): ${pendingToolCallIds.join(", ")}`);
  }
}

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
        entries = parseCompactionPayload(event.payload, run.id);
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
        message: parseStoredAgentMessage(event.payload, event.id),
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
  validateProtocolInvariants(entries);

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
