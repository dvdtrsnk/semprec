/**
 * Issue #215: the neutral gateway-completion contract. `packages/application` (and, in #85,
 * `core.agentGuidanceDrift`) depends only on this port — never on `packages/ai-gateway-client`'s
 * HTTP implementation, `packages/ai-gateway`, or any model-provider SDK — so a structured
 * completion can be requested without importing anything that knows how the request actually
 * reaches a provider.
 */

/** A single turn in the conversation sent to the gateway's structured-completion route. */
export interface AiGatewayMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiGatewayCompletionInput {
  /** The project item the call is billed/attributed to; written verbatim into `ai_gateway_calls`. */
  projectItemId: string;
  /** Caller identifier for audit/attribution; #85 is this batch's only caller, using `'agent_guidance_drift'`. */
  operation: string;
  temperature: number;
  system: string;
  messages: AiGatewayMessage[];
  /** Draft 2020-12 JSON Schema the provider's response content must satisfy. */
  responseSchema: unknown;
}

export interface AiGatewayCompletionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiGatewayCompletionResult {
  content: unknown;
  usage: AiGatewayCompletionUsage;
}

/**
 * The one failure mode `AiGatewayClientPort.complete` is allowed to signal: a network timeout,
 * a non-2xx response, an unparseable body, or a response that fails schema validation. `reason`
 * is the only detail exposed — never the provider's own error body or any secret — so a caller
 * that surfaces this to a user or a log can't leak gateway internals.
 */
export type AiGatewayFailureReason = "timeout" | "http" | "invalid_response";

export class AiGatewayFailedError extends Error {
  readonly code = "ai_gateway_failed" as const;
  readonly reason: AiGatewayFailureReason;

  constructor(reason: AiGatewayFailureReason) {
    super(`AI gateway call failed: ${reason}`);
    this.name = "AiGatewayFailedError";
    this.reason = reason;
  }
}

/**
 * Implemented over HTTP by `packages/ai-gateway-client` (`POST /internal/complete` against
 * `semprec-ai-gateway`). `packages/application` imports only this interface, never the HTTP
 * implementation, so it stays free of any transport or provider dependency.
 */
export interface AiGatewayClientPort {
  complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult>;
}
