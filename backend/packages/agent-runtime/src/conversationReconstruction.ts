import type { Pool } from "pg";
import { labeledSempMessageRefSchema } from "@alldots/shared";
import {
  getAgentRun,
  insertAgentRunEvent,
  listSessionAgentRunEventsFromLastCompaction,
  withTransaction,
  type SessionAgentRunsFilter,
} from "@alldots/data";
import type { CompactionAdapter } from "./compaction.js";
import { redactReplayedToolCalls } from "./sensitiveMessageRedaction.js";
import type { AgentMessage, AgentMessageKind, ConversationEntry } from "./types.js";

/** Lifecycle bookkeeping, never conversation content; `run_status` is consumed only by the realtime channel. */
const NON_CONVERSATIONAL_KINDS: ReadonlySet<string> = new Set(["run_status"]);

const AGENT_MESSAGE_KINDS: ReadonlySet<string> = new Set<AgentMessageKind>([
  "turn_start",
  "message",
  "tool_use",
  "tool_result",
  "turn_end",
  "run_status",
  "message_update",
  "user_message",
]);

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) return false;
  if (typeof value.kind !== "string" || !AGENT_MESSAGE_KINDS.has(value.kind)) return false;
  if (
    value.kind === "user_message" &&
    (!("text" in value) ||
      typeof value.text !== "string" ||
      !("context" in value) ||
      !labeledSempMessageRefSchema.array().safeParse(value.context).success)
  ) {
    throw new Error("Invalid stored user message");
  }
  return true;
}

/**
 * A payload from a stale writer version or a hand-edited row must fail loudly here rather than corrupt the `Entry[]`
 * tree handed to pi-agent-core.
 */
function parseStoredAgentMessage(payload: unknown, eventId: string): AgentMessage {
  if (!isAgentMessage(payload)) {
    throw new Error(`agent_run_events row ${eventId} has a payload that is not a valid AgentMessage`);
  }
  return payload;
}

function isConversationEntry(value: unknown): value is ConversationEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "parentId" in value &&
    (value.parentId === null || typeof value.parentId === "string") &&
    "seq" in value &&
    typeof value.seq === "number" &&
    "timestamp" in value &&
    typeof value.timestamp === "number" &&
    "message" in value &&
    isAgentMessage(value.message)
  );
}

function parseCompactionPayload(payload: unknown, agentRunId: string): ConversationEntry[] {
  if (!Array.isArray(payload) || !payload.every(isConversationEntry)) {
    throw new Error(
      `agent_run_events 'compaction' row for run ${agentRunId} has a payload that is not a valid ConversationEntry[]`,
    );
  }
  return payload.map((entry) => {
    const replayEntry = { ...entry };
    delete replayEntry.images;
    return replayEntry;
  });
}

/**
 * Every `tool_use` must be followed, in order, by its own `tool_result` (by `toolCallId`), and nothing may end
 * mid-call. `repairInterruptedRuns` already closes trailing unmatched calls, so a violation means the stored history is
 * unsound and must not reach pi-agent-core.
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
    throw new Error(
      `reconstructed history has ${pendingToolCallIds.length} unmatched tool_use call(s): ${pendingToolCallIds.join(", ")}`,
    );
  }
}

/**
 * Rebuilds a dormant conversation's `Entry[]` chain from only the tail of `agent_run_events` after its latest
 * `compaction` checkpoint, in `(wake_seq, id)` order across the session runs. A checkpoint's payload is the
 * continuation state, so meeting one resets the walk to it: a restart replays the checkpoint instead of re-compacting.
 * Consumers, compaction included, get the redacted form of the stored history (`redactReplayedToolCalls`).
 *
 * The listed events leave out every turn a regeneration replaced, whole, with its tool calls and results. Callers run
 * `validateProtocolInvariants`, so a range that split a call from its result fails instead of reaching the model.
 */
async function walkStoredEntries(
  pool: Pool,
  filter: SessionAgentRunsFilter,
  bounds?: { maxRows: number; maxBytes: number },
): Promise<ConversationEntry[]> {
  const events = await listSessionAgentRunEventsFromLastCompaction(pool, filter, bounds);
  if (events.length === 0) return [];

  let entries: ConversationEntry[] = [];
  let seq = 0;
  let parentId: string | null = null;

  for (const event of events) {
    if (event.kind === "compaction") {
      entries = parseCompactionPayload(event.payload, event.agentRunId);
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

  return redactReplayedToolCalls(entries);
}

export async function reconstructBoundedThreadHistory(
  pool: Pool,
  threadId: string,
): Promise<ReconstructedHistory | null> {
  const bounds = { maxRows: 2000, maxBytes: 262144 };
  const entries = await walkStoredEntries(pool, { threadId, triggeredBy: "user", parentRunId: null }, bounds);
  const expandedBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry.message), "utf8"),
    0,
  );
  if (entries.length > bounds.maxRows || expandedBytes > bounds.maxBytes) {
    throw new Error("Semp conversation history exceeds replay limits");
  }
  if (!entries.length) return null;
  validateProtocolInvariants(entries);
  return { entries, compacted: false };
}

export interface ReconstructedHistory {
  entries: ConversationEntry[];
  /** The caller's cue to persist the checkpoint via `persistCompaction`. */
  compacted: boolean;
}

/**
 * Rebuilds the tree, sizes it with pi-agent-core's `estimateContextTokens`/`shouldCompact` before it reaches a
 * provider, and compacts through `prepareCompaction`/`compact` only when required. Null on a conversation's first wake.
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
  // A non-conforming CompactionAdapter can break a transcript as well as a corrupted payload can.
  validateProtocolInvariants(compacted);
  return { entries: compacted, compacted: true };
}

/**
 * Persists the compaction on the wake run it seeds, so restarts resume from it deterministically instead of redoing a
 * possibly expensive, non-idempotent compaction.
 */
export async function persistCompaction(
  pool: Pool,
  agentRunId: string,
  entries: ConversationEntry[],
  filter?: SessionAgentRunsFilter,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const run = await getAgentRun(client, agentRunId, true);
    const mainThread =
      run !== null &&
      run.unit === "session" &&
      run.threadId !== null &&
      run.triggeredBy === "user" &&
      run.parentRunId === null;
    const matches =
      run !== null &&
      (filter === undefined
        ? !mainThread
        : "threadId" in filter
          ? mainThread && run.threadId === filter.threadId
          : !mainThread &&
            run.unit === "session" &&
            run.projectItemId === filter.projectItemId &&
            run.triggeredBy === filter.triggeredBy &&
            run.parentRunId === filter.parentRunId);
    if (!matches) throw new Error("Invalid compaction target");
    await insertAgentRunEvent(client, agentRunId, "compaction", entries);
  });
}
