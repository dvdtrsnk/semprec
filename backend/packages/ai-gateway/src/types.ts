export interface GatewayCallContext {
  provider: string;
  model: string;
  /** Set when the call originates inside an agent run; omit/NULL otherwise. */
  agentRunId?: string | null;
  /**
   * #215: set together by `POST /internal/complete`, the only current caller that attributes a
   * call to a project item and an operation; every other caller omits both.
   */
  projectItemId?: string | null;
  operation?: string | null;
}

/** Native unit for complete()/embed(): tokens. */
export interface TokenCallResult {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Native unit for transcribe()/diarize(): audio seconds. */
export interface AudioCallResult {
  audioSeconds: number;
  costUsd: number;
}
