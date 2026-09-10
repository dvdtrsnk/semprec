import {
  AiGatewayFailedError,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";

/** #215's 60-second budget for the whole round trip to `semprec-ai-gateway`. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface HttpAiGatewayClientConfig {
  /** The port `semprec-ai-gateway` listens on; the client always addresses it over loopback. */
  port: number;
  /** Compared by the gateway against its own `AI_GATEWAY_INTERNAL_TOKEN`. */
  token: string;
}

function isCompletionResult(value: unknown): value is AiGatewayCompletionResult {
  if (typeof value !== "object" || value === null) return false;
  const usage = (value as { usage?: unknown }).usage;
  return (
    "content" in value &&
    typeof usage === "object" &&
    usage !== null &&
    typeof (usage as { inputTokens?: unknown }).inputTokens === "number" &&
    typeof (usage as { outputTokens?: unknown }).outputTokens === "number"
  );
}

/**
 * `packages/ai-gateway-client`'s only implementation of `AiGatewayClientPort` (#215): a plain
 * `fetch` against `semprec-ai-gateway`'s `POST /internal/complete`, with a 60s timeout and
 * strict response validation. Every failure mode — timeout, non-2xx, invalid JSON, schema
 * mismatch — collapses to `AiGatewayFailedError` with only a `reason`, never the provider's own
 * error body, a response snippet, or the bearer token.
 */
export function createHttpAiGatewayClient(config: HttpAiGatewayClientConfig): AiGatewayClientPort {
  return {
    async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${config.port}/internal/complete`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "http";
        throw new AiGatewayFailedError(reason);
      }

      if (!res.ok) {
        throw new AiGatewayFailedError("http");
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AiGatewayFailedError("invalid_response");
      }

      if (!isCompletionResult(body)) {
        throw new AiGatewayFailedError("invalid_response");
      }

      return body;
    },
  };
}
