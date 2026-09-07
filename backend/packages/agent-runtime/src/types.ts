export type AgentMessageKind =
  | "turn_start"
  | "message"
  | "tool_use"
  | "tool_result"
  | "turn_end"
  | "run_status"
  | "message_update";

/** The full pi-agent-core message shape, persisted verbatim into `agent_run_events.payload`. */
export interface AgentMessage {
  kind: AgentMessageKind;
  [key: string]: unknown;
}

export interface AgentSessionOptions {
  task: string;
  /** pi-agent-core's system-prompt override hook: given its default prompt, returns the one to use. */
  systemPromptOverride?: (defaultPrompt: string) => string;
}

/**
 * The subset of pi-agent-core's public session surface this adapter is written against:
 * an ordered async sequence of `AgentMessage`s for one run, ending when the run is done.
 * pi-agent-core has not published TypeScript types yet, so this interface is the contract
 * to satisfy with the real `createAgentSession` once it ships a matching shape.
 */
export interface AgentSession {
  messages(): AsyncIterable<AgentMessage>;
}

export type CreateAgentSession = (options: AgentSessionOptions) => AgentSession;
