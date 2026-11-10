import type { LabeledSempMessageRef } from "@semprec/shared";

export type AgentMessageKind =
  "turn_start" | "message" | "tool_use" | "tool_result" | "turn_end" | "run_status" | "message_update" | "user_message";

/**
 * One context ref attached to a user turn, stored as sent: the ref object (item, block,
 * transcript segment, ...) plus its label at send time. Expanded ref content is never stored.
 */
export type UserTurnContextRef = LabeledSempMessageRef;

/** Ephemeral image input for a model prompt; never written to a run event. */
export interface AgentImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** The full pi-agent-core message shape, persisted verbatim into `agent_run_events.payload`. */
export interface AgentMessage {
  kind: AgentMessageKind;
  [key: string]: unknown;
}

/**
 * pi-agent-core's own transcript-tree node shape: `parentId` links each entry back to the one
 * before it (a linear chain for every conversation this codebase reconstructs, never a real
 * branch) and `seq` is its position in that chain. #119's reconstruction path is the producer;
 * `AgentSessionOptions.initialState` is the consumer.
 */
export interface ConversationEntry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  message: AgentMessage;
  /** Rebuilt for this wake only and never stored with the event. */
  images?: readonly AgentImage[];
}

export interface AgentSessionOptions {
  task: string;
  /** Context refs sent with the wake turn's `task`; persisted on its `user_message` event. */
  context?: readonly UserTurnContextRef[];
  images?: readonly AgentImage[];
  /** Cancels the underlying agent, including a prompt blocked waiting for its next event. */
  signal?: AbortSignal;
  /** pi-agent-core's system-prompt override hook: given its default prompt, returns the one to use. */
  systemPromptOverride?: (defaultPrompt: string) => string;
  /**
   * Seeds a freshly created session with a prior conversation's reconstructed (and, when
   * oversized, already-compacted) history, so pi-agent-core resumes with full context instead
   * of starting cold. Absent on a conversation's very first-ever wake.
   */
  initialState?: { messages: ConversationEntry[] };
}

/**
 * The subset of pi-agent-core's public session surface this adapter is written against:
 * an ordered async sequence of `AgentMessage`s for one run, ending when the run is done.
 * pi-agent-core has not published TypeScript types yet, so this interface is the contract
 * to satisfy with the real `createAgentSession` once it ships a matching shape.
 */
export interface AgentSession {
  /** This session's first turn, started as soon as `createAgentSession` returns it. */
  messages(): AsyncIterable<AgentMessage>;
  /**
   * Continues this same conversation with a new turn. The delegation registry (#229) and
   * Semp's own conversation registry (#118) are the first callers: both reuse a still-open
   * `AgentSession` for a later message instead of starting a fresh one, so pi-agent-core
   * keeps prior turns as context — only the new turn's messages are yielded here, not the
   * whole transcript again. Optional because every session up to #228/#117 only ever ran
   * one turn to completion and never needed it.
   */
  send?(
    task: string,
    context?: readonly UserTurnContextRef[],
    images?: readonly AgentImage[],
  ): AsyncIterable<AgentMessage>;
}

export type CreateAgentSession = (options: AgentSessionOptions) => AgentSession;
