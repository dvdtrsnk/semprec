import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { ChokePointError, ValidationError } from "@semprec/data";
import { BudgetExceededError, complete } from "@semprec/ai-gateway";
import type {
  Api,
  AssistantMessageEvent,
  Message,
  Model,
  Models,
  PiMessagesEvent,
  SimpleStreamOptions,
  StreamFunction,
  Tool,
} from "@earendil-works/pi-ai";
import { ProviderCallError } from "./structuredProviders/types.js";
import { logger } from "./logger.js";
import { readCallerTenantId, runForCallerTenant } from "./callerTenant.js";

const ROUTE = "/internal/pi/messages";

/** The only provider this route dispatches to: the gateway holds no credential but `ANTHROPIC_API_KEY`. */
const PROVIDER = "anthropic";

/** A whole agent context (system prompt, every prior message and tool result, tool schemas) travels in one body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Output tokens reserved against the budget when the caller sets no `maxTokens`, capped by the model's own maximum. */
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8192;

/**
 * Upper bound on one streamed turn, so a provider that opens the stream and then stalls cannot
 * hold the connection and keep its `ai_gateway_calls` row `reserved` for as long as the SDK allows.
 */
export const STREAM_TIMEOUT_MS = 10 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_RUN_ID_HEADER = "x-semprec-agent-run-id";

export interface PiMessagesHandlerOptions {
  /** Compared against the caller's `Authorization: Bearer <token>` header. */
  internalToken: string;
  /** Resolves the requested model id; only `anthropic` models are ever looked up. */
  models: Models;
  apiKey: string;
  /** pi-ai's provider-dispatching stream (`streamSimple` from `@earendil-works/pi-ai/compat` in production). */
  streamFn: StreamFunction<Api, SimpleStreamOptions>;
  /** Defaults to `STREAM_TIMEOUT_MS`; exists only so a test can shrink the bound to milliseconds. */
  streamTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check only: the content of a message is pi's own `Message` type and is handed to pi
 * unchanged, so the edge confirms it is an object with one of pi's three roles and nothing more.
 */
function isMessageShaped(value: unknown): value is Message {
  return isRecord(value) && (value.role === "user" || value.role === "assistant" || value.role === "toolResult");
}

/** Shape check only, like `isMessageShaped`: the JSON Schema in `parameters` is passed to the provider as-is. */
function isToolShaped(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.parameters)
  );
}

const requestBodySchema = z.object({
  model: z.string().min(1),
  context: z.object({
    systemPrompt: z.string().optional(),
    messages: z.array(z.custom<Message>(isMessageShaped, "must be a pi message object")).min(1),
    tools: z.array(z.custom<Tool>(isToolShaped, "must be a pi tool object")).optional(),
  }),
  options: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().int().positive().optional(),
      reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      cacheRetention: z.enum(["none", "short", "long"]).optional(),
      sessionId: z.string().optional(),
      // The pi-messages protocol also names "required" and a function selector, but pi's Anthropic
      // transport maps only these two onto a valid `tool_choice`; anything else is a guaranteed
      // provider rejection after the budget has been reserved, so it is refused here instead.
      toolChoice: z.enum(["auto", "none"]).optional(),
    })
    .optional(),
});

type PiMessagesRequestBody = z.infer<typeof requestBodySchema>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
    chunks.push(buf);
  }
  try {
    return JSON.parse(chunks.length === 0 ? "{}" : Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

function parseBody(raw: unknown): PiMessagesRequestBody {
  const result = requestBodySchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join(".") : undefined;
    throw new ValidationError(
      field ? `'${field}': ${issue?.message ?? "invalid"}` : "Request body is invalid",
      field ? { field } : undefined,
    );
  }
  return result.data;
}

/** Constant-time so a network caller can't recover `AI_GATEWAY_INTERNAL_TOKEN` byte-by-byte from response timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

function extractBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length);
}

/** The run the `ai_gateway_calls` row is attributed to; absent means an unattributed call, malformed is a 400. */
function extractAgentRunId(req: IncomingMessage): string | null {
  const header = req.headers[AGENT_RUN_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  if (!UUID_PATTERN.test(value)) {
    throw new ValidationError(`'${AGENT_RUN_ID_HEADER}' must be a UUID`, { field: AGENT_RUN_ID_HEADER });
  }
  return value;
}

/**
 * Serializes one of pi-ai's `AssistantMessageEvent`s into the pi-messages wire event: `partial` is
 * dropped, and the few fields the wire event carries that pi's in-process event keeps only on
 * `partial` are read from it — a tool call's `id`/`toolName` at `toolcall_start`, and the text and
 * thinking signatures at `*_end`, which Anthropic requires back when the turn is replayed.
 * `done`/`error` hoist the final message's usage (and error message) as the protocol defines.
 */
function serializeEvent(event: AssistantMessageEvent): PiMessagesEvent {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
    case "thinking_start":
      return { type: event.type, contentIndex: event.contentIndex };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": {
      const block = event.partial.content[event.contentIndex];
      const signature = block?.type === "text" ? block.textSignature : undefined;
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        content: event.content,
        ...(signature !== undefined ? { contentSignature: signature } : {}),
      };
    }
    case "thinking_end": {
      const block = event.partial.content[event.contentIndex];
      const thinking = block?.type === "thinking" ? block : undefined;
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content: event.content,
        ...(thinking?.thinkingSignature !== undefined ? { contentSignature: thinking.thinkingSignature } : {}),
        ...(thinking?.redacted !== undefined ? { redacted: thinking.redacted } : {}),
      };
    }
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      if (block?.type !== "toolCall") {
        throw new ProviderCallError(`toolcall_start at index ${event.contentIndex} has no tool call block`);
      }
      return { type: "toolcall_start", contentIndex: event.contentIndex, id: block.id, toolName: block.name };
    }
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
    case "done":
      // A deferred response is only produced when the caller asks for one, which this route never does.
      if (event.reason === "deferred")
        throw new ProviderCallError("Provider returned an unrequested deferred response");
      return {
        type: "done",
        reason: event.reason,
        usage: event.message.usage,
        ...(event.message.responseId !== undefined ? { responseId: event.message.responseId } : {}),
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        usage: event.error.usage,
        ...(event.error.errorMessage !== undefined ? { errorMessage: event.error.errorMessage } : {}),
      };
  }
}

function isOpen(res: ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded;
}

/**
 * Writes one SSE event and, when the socket buffer is full, waits for it to drain (or for the
 * connection to close) before the next provider event is read, so a slow reader never makes this
 * process buffer the whole turn. A connection that is already gone is skipped: the abort signal
 * has already told the provider to stop, and its terminal `error` event ends the loop.
 */
function writeEvent(res: ServerResponse, event: PiMessagesEvent): Promise<void> {
  if (!isOpen(res)) return Promise.resolve();
  if (res.write(`data: ${JSON.stringify(event)}\n\n`)) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      res.off("drain", settle);
      res.off("close", settle);
      resolve();
    };
    res.on("drain", settle);
    res.on("close", settle);
  });
}

/**
 * Handles `POST /internal/pi/messages` — the server side of `@earendil-works/pi-ai`'s
 * `pi-messages` protocol, so `semprec-agents`' pi session drives Anthropic through this gateway
 * rather than calling the provider itself (docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md).
 * Authenticates the internal bearer token before reading the body, validates the body's shape,
 * resolves the requested model from pi-ai's catalog (Anthropic only), and runs the turn through
 * `@semprec/ai-gateway`'s `complete()`: one `ai_gateway_calls` row per request, `reserved` at an
 * estimate before the provider is contacted, then `settled` with the streamed usage and
 * `usage.cost.total`, or `failed` at cost 0.
 *
 * The provider stream is relayed as `data: <PiMessagesEvent>` SSE frames ending in exactly one
 * `done` or `error`. The response is ended right after that event, before the row leaves
 * `reserved`: a client that has read `done` can still see the row `reserved` at its estimate until
 * the settle lands, and an `error` event (the provider refused, or the turn was aborted) is
 * delivered before the row is marked `failed`, so nothing else is sent after it.
 * When the client disconnects mid-turn, an abort signal stops the provider stream, which ends in
 * an `aborted` error event and therefore a `failed` row. A turn still running after
 * `STREAM_TIMEOUT_MS` is aborted the same way, whatever the provider SDK's own timeout is.
 *
 * Shutdown needs nothing of its own: an in-flight SSE response is not an idle connection, so the
 * graceful drain in `shutdown.ts` waits for it up to `SHUTDOWN_DRAIN_TIMEOUT_MS` and then
 * `closeAllConnections()`; a turn cut there closes its response, which aborts the provider stream
 * and ends as a `failed` row through the same path as a client disconnect.
 */
export function createPiMessagesRequestListener(pool: Pool, options: PiMessagesHandlerOptions) {
  const streamTimeoutMs = options.streamTimeoutMs ?? STREAM_TIMEOUT_MS;

  async function streamTurn(
    res: ServerResponse,
    model: Model<Api>,
    body: PiMessagesRequestBody,
  ): Promise<{ inputTokens: number; outputTokens: number; costUsd: number }> {
    const abort = new AbortController();
    // `close` also fires after a normal finish; only a response closed before it finished means
    // the client went away mid-turn.
    const onClose = (): void => {
      if (!res.writableFinished) abort.abort();
    };
    res.on("close", onClose);
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const events = options.streamFn(model, body.context, {
        ...body.options,
        apiKey: options.apiKey,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(streamTimeoutMs)]),
      });
      for await (const event of events) {
        await writeEvent(res, serializeEvent(event));
        if (event.type === "done") {
          res.end();
          const { usage } = event.message;
          return { inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost.total };
        }
        if (event.type === "error") {
          res.end();
          throw new ProviderCallError(event.error.errorMessage ?? `Provider stream ended with '${event.reason}'`);
        }
      }
      throw new ProviderCallError("Provider stream ended without a terminal event");
    } finally {
      res.off("close", onClose);
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method !== "POST" || url.pathname !== ROUTE) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const providedToken = extractBearerToken(req);
      if (!providedToken || !tokensMatch(providedToken, options.internalToken)) {
        sendJson(res, 401, { error: "Invalid or missing bearer token", code: "unauthorized" });
        return;
      }

      const callerTenantId = readCallerTenantId(req);
      await runForCallerTenant(callerTenantId, async () => {
        const agentRunId = extractAgentRunId(req);
        const body = parseBody(await readJsonBody(req));

        const model = options.models.getModel(PROVIDER, body.model);
        if (!model) {
          sendJson(res, 400, { error: `Unknown ${PROVIDER} model '${body.model}'`, code: "unknown_model" });
          return;
        }

        // #620: a rough upper bound (about 4 characters per token for the whole context, the output
        // cap or a default one) reserved before the call and replaced by the real cost on settle.
        // pi's `ModelCost` is USD per million tokens.
        const estimatedInputTokens = Math.ceil(JSON.stringify(body.context).length / 4);
        const reservedOutputTokens =
          body.options?.maxTokens ?? Math.min(model.maxTokens, DEFAULT_RESERVED_OUTPUT_TOKENS);
        const estimatedCostUsd =
          (estimatedInputTokens / 1_000_000) * model.cost.input +
          (reservedOutputTokens / 1_000_000) * model.cost.output;

        try {
          await complete(
            pool,
            {
              provider: PROVIDER,
              model: model.id,
              agentRunId,
              projectItemId: null,
              operation: "agent_turn",
              estimatedCostUsd,
            },
            () => streamTurn(res, model, body),
          );
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            // Raised by the reservation, before `streamTurn` wrote the head; the pi client surfaces
            // the status as its own `error` event.
            sendJson(res, 403, { error: err.message, code: "budget_exceeded" });
            return;
          }
          // Anything else that escaped before the head was written (the reservation itself failing)
          // is not a provider failure; the outer handler answers it as a 500.
          if (!res.headersSent) throw err;
          // Standard failed-call observability event: the row is `failed` with no usage, so this log
          // carries the cause. The context and the key are deliberately never logged.
          logger.error({ err, provider: PROVIDER, model: model.id, agentRunId }, "Streamed provider call failed");
          if (isOpen(res)) res.end();
        }
      });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Same rationale as `completeHandler.ts`: keeping the boundary synchronous confines a rejection
   * that escapes the try/catch above to that one request instead of an unhandled rejection that
   * takes the whole process down.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the pi-messages request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
