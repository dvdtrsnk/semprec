import {
  AiGatewayFailedError,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";

/** #215's 60-second budget for the whole round trip to `semprec-ai-gateway`. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * This is a loopback round trip to a process whose own request cap (`MAX_BODY_BYTES` in
 * `completeHandler.ts`) is 1 MiB, so the response can't legitimately exceed that either — cap it
 * the same way rather than buffering an unbounded or malformed response into memory.
 */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface HttpAiGatewayClientConfig {
  /** The port `semprec-ai-gateway` listens on; the client always addresses it over loopback. */
  port: number;
  /** Compared by the gateway against its own `AI_GATEWAY_INTERNAL_TOKEN`. */
  token: string;
}

class ResponseTooLargeError extends Error {}

/**
 * Reads the response body with a hard byte cap, independent of any (absent, wrong, or
 * adversarial) `Content-Length` header, so a malformed or oversized response can't be buffered
 * into memory wholesale before it's even parsed.
 */
async function readJsonBodyWithSizeCap(res: Response, maxBytes: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new ResponseTooLargeError("Response body stream was unavailable");

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError("Response body exceeded the maximum allowed size");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return JSON.parse(body);
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
        body = await readJsonBodyWithSizeCap(res, MAX_RESPONSE_BODY_BYTES);
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
