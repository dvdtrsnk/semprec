import type { AgentMessage, ConversationEntry } from "./types.js";

/**
 * pi-agent-core's own compaction-settings shape (target ratio, reserved output tokens, etc.) —
 * opaque here. This adapter only ever forwards it to `shouldCompact`/`prepareCompaction`,
 * never reads a field off it itself.
 */
export type CompactionSettings = Record<string, unknown>;

/** pi-agent-core's own handoff from `prepareCompaction` to `compact` — opaque here, never inspected. */
export type PreparedCompaction = unknown;

/**
 * Seams for pi-agent-core's public, low-level compaction API (not yet published — see
 * `CreateAgentSession`'s note in `types.ts` for the same situation). The Task for #119 is
 * explicit that these are the *public* `estimateContextTokens`/`shouldCompact`/
 * `prepareCompaction`/`compact` functions, not the unfinished `AgentLane.compact()` wrapper or
 * any unexported pi-agent-core internal — so this stays four narrow function seams rather than
 * one opaque "compact the session" call, matching the exact contract to satisfy once
 * pi-agent-core ships a matching shape.
 */
export interface CompactionAdapter {
  /** Token estimate for a resumed turn's full reconstructed context, pre-provider-call. */
  estimateContextTokens: (messages: AgentMessage[]) => number;
  /** Whether that estimate is over budget for this provider's context window. */
  shouldCompact: (tokens: number, contextWindow: number, settings: CompactionSettings) => boolean;
  /** Prepares the oversized `Entry[]` tree for `compact` — pi-agent-core's own low-level split. */
  prepareCompaction: (entries: ConversationEntry[], settings: CompactionSettings) => PreparedCompaction;
  /** Produces the replacement, right-sized `Entry[]` continuation. */
  compact: (prepared: PreparedCompaction) => Promise<ConversationEntry[]> | ConversationEntry[];
  contextWindow: number;
  settings: CompactionSettings;
}
