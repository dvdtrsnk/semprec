/** Operator-wide safety caps over all tenants' spend, in USD (UTC day and month). */
export interface GlobalAiCaps {
  dailyCapUsd: number;
  monthlyCapUsd: number;
}

export interface GatewayCallContext {
  provider: string;
  model: string;
  /** Set when the call originates inside an agent run; omit/NULL otherwise. */
  agentRunId?: string | null;
  sempMessageId?: string | null;
  /** Set with `operation` by `POST /internal/complete` only; the audio routes set only `operation`. */
  projectItemId?: string | null;
  operation?: string | null;
  /** Upper-bound cost estimate in USD, reserved before the provider call and replaced by the real cost on settle. */
  estimatedCostUsd: number;
  /** The operator-wide safety caps, checked with the tenant's own caps before each reservation. */
  globalCaps: GlobalAiCaps;
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
