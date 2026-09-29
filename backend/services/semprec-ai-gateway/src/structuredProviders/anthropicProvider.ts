import { z } from "zod";
import { ProviderCallError, type StructuredCompletionProvider, type StructuredCompletionRequest } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 4096;

/** Caps how much of a provider response this process ever buffers, regardless of what Content-Length claims. */
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

/** The single deadline shared by every attempt of one `complete()` call. */
const ATTEMPT_DEADLINE_MS = 55_000;

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRYABLE_STATUSES = new Set([429, 529]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599);
}

/** Full jitter: a uniformly random delay between 0 and `base`. */
function fullJitter(base: number): number {
  return Math.random() * base;
}

/** Parses `retry-after` as either integer seconds or an HTTP-date; an unparsable value is ignored. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

/** Resolves after `ms`, or immediately once `signal` fires — whichever comes first. */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The Anthropic Messages API has no `response_format`; native JSON-Schema-constrained output is
 * obtained by forcing a single tool call whose `input_schema` is the caller's schema (Anthropic's
 * own documented technique for structured output) and reading the resulting `tool_use.input`
 * back as the structured content. The tool name is internal — never sent to the caller — so any
 * value stable enough not to collide with a doubly-nested schema property would do.
 */
const STRUCTURED_OUTPUT_TOOL_NAME = "emit_structured_output";

const anthropicContentBlockSchema = z.looseObject({
  type: z.string(),
  input: z.unknown().optional(),
});

/**
 * `usage` and both token counts are required: a response without them would otherwise be recorded
 * as a call that cost nothing, silently under-counting spend against the budget.
 */
const anthropicMessagesResponseSchema = z.looseObject({
  content: z.array(anthropicContentBlockSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

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
      // 55s: comfortably inside the client's 60s budget after this process's own overhead. Shared
      // by every attempt below, so a retry can never push the call past that budget.
      const deadline = AbortSignal.timeout(ATTEMPT_DEADLINE_MS);
      const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
      const deadlineAt = Date.now() + ATTEMPT_DEADLINE_MS;

      const requestBody = JSON.stringify({
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
      });

      let res: Response;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: requestBody,
            signal,
          });
        } catch (err) {
          throw new ProviderCallError(`Anthropic request failed: ${err instanceof Error ? err.name : "unknown error"}`);
        }

        if (res.ok) break;

        // Cancelling only hands the connection back to the pool; whether it succeeds changes nothing
        // about the failure reported below, so a cancel error must not replace it.
        await res.body?.cancel().catch(() => {});

        if (!isRetryableStatus(res.status)) {
          throw new ProviderCallError(`Anthropic responded with HTTP ${res.status}`);
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new ProviderCallError(`Anthropic responded with HTTP ${res.status} after ${attempt} attempts`);
        }

        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const delay = Math.min(
          RETRY_MAX_DELAY_MS,
          retryAfterMs ?? fullJitter(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)),
        );
        if (deadlineAt - Date.now() < delay) {
          throw new ProviderCallError(`Anthropic responded with HTTP ${res.status} after ${attempt} attempts`);
        }

        await sleepOrAbort(delay, signal);
        if (signal.aborted) {
          const reasonName = signal.reason instanceof Error ? signal.reason.name : "AbortError";
          throw new ProviderCallError(`Anthropic request aborted: ${reasonName}`);
        }
      }

      let rawBody: unknown;
      try {
        rawBody = await readJsonBodyWithSizeCap(res, MAX_RESPONSE_BODY_BYTES);
      } catch (err) {
        if (err instanceof ProviderCallError) throw err;
        throw new ProviderCallError("Anthropic response body was not valid JSON");
      }

      const parsed = anthropicMessagesResponseSchema.safeParse(rawBody);
      if (!parsed.success) {
        // Names the schema path only — never any response content.
        const issue = parsed.error.issues[0];
        const path = issue ? issue.path.map(String).join(".") : "";
        throw new ProviderCallError(
          `Anthropic response did not match the expected shape: ${path} ${issue?.message ?? "unknown issue"}`,
        );
      }
      const body = parsed.data;

      const toolUse = body.content.find((block) => block.type === "tool_use");
      if (!toolUse) {
        throw new ProviderCallError("Anthropic response did not include the forced tool_use block");
      }
      if (toolUse.input === undefined) {
        throw new ProviderCallError("Anthropic tool_use block carried no input");
      }

      return {
        content: toolUse.input,
        inputTokens: body.usage.input_tokens,
        outputTokens: body.usage.output_tokens,
      };
    },
  };
}
