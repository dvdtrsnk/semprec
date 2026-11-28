import type { AgentMessage, ConversationEntry } from "./types.js";

/** Opaque pi compaction settings, only forwarded to `shouldCompact`/`prepareCompaction`. */
export type CompactionSettings = Record<string, unknown>;

/** Opaque handoff from `prepareCompaction` to `compact`. */
export type PreparedCompaction = unknown;

/**
 * Seams for pi-agent-core's public low-level compaction functions, kept as four narrow seams rather than one opaque
 * "compact the session" call. The currently published API has different native types and needs an explicit integration.
 */
export interface CompactionAdapter {
  /** Token estimate for a resumed turn's full reconstructed context, before the provider call. */
  estimateContextTokens: (messages: AgentMessage[]) => number;
  shouldCompact: (tokens: number, contextWindow: number, settings: CompactionSettings) => boolean;
  prepareCompaction: (entries: ConversationEntry[], settings: CompactionSettings) => PreparedCompaction;
  compact: (prepared: PreparedCompaction) => Promise<ConversationEntry[]> | ConversationEntry[];
  contextWindow: number;
  settings: CompactionSettings;
}
