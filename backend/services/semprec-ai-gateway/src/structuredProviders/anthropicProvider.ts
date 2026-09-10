import { ProviderCallError, type StructuredCompletionProvider, type StructuredCompletionRequest } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;

/** Caps how much of a provider response this process ever buffers, regardless of what Content-Length claims. */
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

/**
 * The Anthropic Messages API has no `response_format`; native JSON-Schema-constrained output is
 * obtained by forcing a single tool call whose `input_schema` is the caller's schema (Anthropic's
 * own documented technique for structured output) and reading the resulting `tool_use.input`
 * back as the structured content. The tool name is internal — never sent to the caller — so any
 * value stable enough not to collide with a doubly-nested schema property would do.
 */
const STRUCTURED_OUTPUT_TOOL_NAME = "emit_structured_output";

interface AnthropicContentBlock {
  type: string;
  input?: unknown;
}

interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isAnthropicMessagesResponse(value: unknown): value is AnthropicMessagesResponse {
  return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

/**
 * Reads the response body with a hard byte cap, independent of any (absent, wrong, or
 * adversarial) `Content-Length` header, so a pathologically large or malformed provider response
 * can't be buffered into memory wholesale before we even attempt to parse it.
 */
async function readJsonBodyWithSizeCap(res: Response, maxBytes: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new ProviderCallError("Anthropic response body stream was unavailable");

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ProviderCallError("Anthropic response body exceeded the maximum allowed size");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return JSON.parse(body);
}

/** Real Anthropic adapter. `apiKey` is read once at process startup, never per request. */
export function createAnthropicStructuredProvider(apiKey: string): StructuredCompletionProvider {
  return {
    id: "anthropic",
    supportsJsonSchemaStructuredOutput: true,
    async complete(request: StructuredCompletionRequest) {
      let res: Response;
      try {
        res = await fetch(ANTHROPIC_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: request.temperature,
            system: request.system,
            messages: request.messages,
            tools: [
              {
                name: STRUCTURED_OUTPUT_TOOL_NAME,
                description: "Emit the final structured result matching the required schema.",
                input_schema: request.responseSchema,
              },
            ],
            tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
          }),
          // 55s: comfortably inside the client's 60s budget after this process's own overhead.
          signal: AbortSignal.timeout(55_000),
        });
      } catch (err) {
        throw new ProviderCallError(`Anthropic request failed: ${err instanceof Error ? err.name : "unknown error"}`);
      }

      if (!res.ok) {
        throw new ProviderCallError(`Anthropic responded with HTTP ${res.status}`);
      }

      let rawBody: unknown;
      try {
        rawBody = await readJsonBodyWithSizeCap(res, MAX_RESPONSE_BODY_BYTES);
      } catch (err) {
        if (err instanceof ProviderCallError) throw err;
        throw new ProviderCallError("Anthropic response body was not valid JSON");
      }

      if (!isAnthropicMessagesResponse(rawBody)) {
        throw new ProviderCallError("Anthropic response did not match the expected shape");
      }
      const body = rawBody;

      const toolUse = body.content.find((block) => block.type === "tool_use");
      if (!toolUse) {
        throw new ProviderCallError("Anthropic response did not include the forced tool_use block");
      }

      return {
        content: toolUse.input,
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      };
    },
  };
}
