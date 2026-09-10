import { ProviderCallError, type StructuredCompletionProvider, type StructuredCompletionRequest } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;

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

      let body: AnthropicMessagesResponse;
      try {
        body = (await res.json()) as AnthropicMessagesResponse;
      } catch {
        throw new ProviderCallError("Anthropic response body was not valid JSON");
      }

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
