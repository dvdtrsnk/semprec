import type { LabeledSempMessageRef } from "@alldots/shared";

export type AgentMessageKind =
  "turn_start" | "message" | "tool_use" | "tool_result" | "turn_end" | "run_status" | "message_update" | "user_message";

/** A context ref of a user turn, stored as sent with its label at send time; expanded content is never stored. */
export type UserTurnContextRef = LabeledSempMessageRef;

/** Ephemeral image input for a model prompt; never written to a run event. */
export interface AgentImage {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * What a session knows about one tool call before it starts: the `toolCall` block id, the generic operation and the
 * databases and items its arguments name. Carried on `message` events as `toolCallTargets` so the block can be stored
 * redacted when it is a content-bearing write to a sensitive database.
 */
export interface ToolCallTarget {
  toolCallId: string;
  operation: string;
  targetDatabaseId?: string;
  targetItemId?: string;
}

/**
 * The pi-agent-core message shape, persisted verbatim into `agent_run_events.payload`, except sensitive content
 * (`createSensitiveTurnRedactor`). `toolCallTargets` steer that redaction and are never stored.
 */
export interface AgentMessage {
  kind: AgentMessageKind;
  [key: string]: unknown;
}

/**
 * pi-agent-core's transcript-tree node: `parentId` links to the previous entry (always a linear chain here) and `seq`
 * is its position.
 */
export interface ConversationEntry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  message: AgentMessage;
  images?: readonly AgentImage[];
}

export interface AgentSessionOptions {
  task: string;
  /** Context refs sent with the wake turn's `task`; persisted on its `user_message` event. */
  context?: readonly UserTurnContextRef[];
  images?: readonly AgentImage[];
  /** Also cancels a prompt blocked waiting for its next event. */
  signal?: AbortSignal;
  /** Given pi-agent-core's default prompt, returns the one to use. */
  systemPromptOverride?: (defaultPrompt: string) => string;
  /**
   * Prior reconstructed (and, if oversized, compacted) history, so pi-agent-core resumes with context. Absent on a
   * conversation's first wake.
   */
  initialState?: { messages: ConversationEntry[] };
}

/**
 * The subset of pi-agent-core's session surface this adapter uses: an ordered async sequence of messages for one run.
 * pi-agent-core publishes no TypeScript types, so this interface is the contract.
 */
export interface AgentSession {
  /** This session's first turn, started as soon as `createAgentSession` returns it. */
  messages(): AsyncIterable<AgentMessage>;
  /**
   * Continues the same conversation with a new turn, yielding only that turn's messages; pi-agent-core keeps prior
   * turns as context. Optional because single-turn sessions never need it.
   */
  send?(
    task: string,
    context?: readonly UserTurnContextRef[],
    images?: readonly AgentImage[],
  ): AsyncIterable<AgentMessage>;
}

export type CreateAgentSession = (options: AgentSessionOptions) => AgentSession;
