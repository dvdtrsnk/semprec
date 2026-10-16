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
  /**
   * #215: set together with `operation` by `POST /internal/complete`, the only current caller that
   * attributes a call to a project item; every other caller omits it. The audio routes set only
   * `operation` (#625).
   */
  projectItemId?: string | null;
  operation?: string | null;
  /**
   * #620: the caller's upper-bound estimate of this call's cost in USD, reserved against the
   * budget cap before the provider is called and replaced by the real cost on settle.
   */
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
