/**
 * The neutral gateway-completion contract. Callers depend only on this port, never on the HTTP client, the gateway or
 * any provider SDK.
 */

export interface AiGatewayTextBlock {
  type: "text";
  text: string;
}

/** `data` is the base64 of a JPEG or PNG the caller already reduced; the gateway never reads a blob store. */
export interface AiGatewayImageBlock {
  type: "image";
  mimeType: "image/jpeg" | "image/png";
  data: string;
}

export type AiGatewayContentBlock = AiGatewayTextBlock | AiGatewayImageBlock;

/** A single turn in the conversation sent to the gateway's structured-completion route. */
export interface AiGatewayMessage {
  role: "user" | "assistant";
  content: string | AiGatewayContentBlock[];
}

export interface AiGatewayCompletionInput {
  /**
   * Billed/attributed project, written verbatim into `ai_gateway_calls`. `null` only for an operation the gateway
   * attributes to no project; required for `'agent_guidance_drift'`, `'agent_behavior_drift'`, `'inbox_proposal'` and
   * `'inbox_attachment_extraction'`.
   */
  projectItemId: string | null;
  /** Caller identifier for audit and attribution, e.g. `'inbox_proposal'` or `'transcript_summary'`. */
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
 * The only failure `AiGatewayClientPort.complete` may signal (`budget_exceeded` is not worth retrying). `reason` is the
 * only detail exposed, never a provider error body or secret.
 */
export type AiGatewayFailureReason = "timeout" | "http" | "budget_exceeded" | "invalid_response";

export class AiGatewayFailedError extends Error {
  readonly code = "ai_gateway_failed" as const;
  readonly reason: AiGatewayFailureReason;

  constructor(reason: AiGatewayFailureReason) {
    super(`AI gateway call failed: ${reason}`);
    this.name = "AiGatewayFailedError";
    this.reason = reason;
  }
}

/** Implemented over HTTP by `packages/ai-gateway-client` (`POST /internal/complete`). */
export interface AiGatewayClientPort {
  complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult>;
}
