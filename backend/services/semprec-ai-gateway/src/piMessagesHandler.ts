import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { ChokePointError, ValidationError } from "@semprec/data";
import { BudgetExceededError, complete, type GlobalAiCaps } from "@semprec/ai-gateway";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  Models,
  PiMessagesEvent,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { ProviderCallError } from "./structuredProviders/types.js";
import { logger } from "./logger.js";
import { readCallerTenantId, runForCallerTenant } from "./callerTenant.js";
import { extractAgentRunId, extractSempMessageId } from "./attributionHeaders.js";

const ROUTE = "/internal/pi/messages";

/** The only provider this route dispatches to: the gateway holds no credential but `ANTHROPIC_API_KEY`. */
const PROVIDER = "anthropic";

/** A whole agent context travels in one body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Output tokens reserved against the budget when the caller sets no `maxTokens`, capped by the model's own maximum. */
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8192;

/** A stalled provider stream must not keep its `ai_gateway_calls` row `reserved` indefinitely. */
export const STREAM_TIMEOUT_MS = 10 * 60 * 1000;

export interface PiMessagesHandlerOptions {
  internalToken: string;
  models: Models;
  apiKey: string;
  /** pi-ai's provider-dispatching stream (`streamSimple` from `@earendil-works/pi-ai/compat` in production). */
  streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  /** Test seam; defaults to `STREAM_TIMEOUT_MS`. */
  streamTimeoutMs?: number;
  /** Operator-wide caps across all tenants' spend. */
  globalCaps: GlobalAiCaps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape check only: `parameters` is passed to the provider as-is. */
function isToolShaped(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.parameters)
  );
}

/** pi's client sends the prompt and the tools it declares as `system` messages of the transcript. */
function isSystemMessageShaped(value: Record<string, unknown>): boolean {
  const { content, toolsAdded } = value;
  return (
    (typeof content === "string" || Array.isArray(content)) &&
    (toolsAdded === undefined || (Array.isArray(toolsAdded) && toolsAdded.every(isToolShaped)))
  );
}

/** Shape check only: the message is handed to pi unchanged. */
function isMessageShaped(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  if (value.role === "system") return isSystemMessageShaped(value);
  return value.role === "user" || value.role === "assistant" || value.role === "toolResult";
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
      // pi's Anthropic transport maps only these two to a valid `tool_choice`; anything else would be
      // a provider rejection after the budget was reserved.
      toolChoice: z.enum(["auto", "none"]).optional(),
    })
    .optional(),
});

type PiMessagesRequestBody = z.infer<typeof requestBodySchema>;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
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

/** Constant-time, so the token cannot be recovered from response timing. */
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

/**
 * Drops `partial`, but first reads the fields the wire event needs from it: a tool call's
 * `id`/`toolName` at `toolcall_start`, and the signatures at `*_end` Anthropic requires on replay.
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
 * Waits for drain (or close) when the buffer is full, so a slow reader never makes this process
 * buffer the whole turn. A gone connection is skipped: the abort already stopped the provider.
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
 * `POST /internal/pi/messages`: the server side of pi-ai's `pi-messages` protocol, so the agents'
 * pi session reaches Anthropic only through this gateway. One `ai_gateway_calls` row per request,
 * `reserved` at an estimate, then `settled` or `failed` at cost 0.
 *
 * SSE frames end in exactly one `done` or `error`, and the response ends before the row leaves
 * `reserved`, so a client may briefly still see it `reserved`. A disconnect, `STREAM_TIMEOUT_MS`,
 * or the shutdown drain's `closeAllConnections()` all abort the provider stream into a `failed` row.
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
        const sempMessageId = extractSempMessageId(req);
        const body = parseBody(await readJsonBody(req));

        const model = options.models.getModel(PROVIDER, body.model);
        if (!model) {
          sendJson(res, 400, { error: `Unknown ${PROVIDER} model '${body.model}'`, code: "unknown_model" });
          return;
        }

        // Rough upper bound (about 4 characters per token plus the output cap), replaced by the real
        // cost on settle. pi's `ModelCost` is USD per million tokens.
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
              sempMessageId,
              projectItemId: null,
              operation: "agent_turn",
              estimatedCostUsd,
              globalCaps: options.globalCaps,
            },
            () => streamTurn(res, model, body),
          );
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            // Raised by the reservation, before `streamTurn` wrote the head; the pi client surfaces
            // the status as its own `error` event.
            sendJson(
              res,
              403,
              { error: err.message, code: "budget_exceeded" },
              { "x-semprec-error-code": "budget_exceeded" },
            );
            return;
          }
          // Anything else that escaped before the head was written (the reservation itself failing)
          // is not a provider failure; the outer handler answers it as a 500.
          if (!res.headersSent) throw err;
          // The `failed` row has no usage, so this log carries the cause. Never log the context or key.
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

  /** Synchronous boundary: an escaped rejection fails one request, not the process. */
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
