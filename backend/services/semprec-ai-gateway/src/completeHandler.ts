import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { ChokePointError, ValidationError } from "@semprec/data";
import { BudgetExceededError, complete, type GlobalAiCaps } from "@semprec/ai-gateway";
import { withTraceContext } from "@semprec/shared";
import { compileResponseSchema, InvalidResponseSchemaError } from "./schemaValidation.js";
import {
  ProviderCallError,
  type StructuredCompletionMessage,
  type StructuredCompletionProvider,
} from "./structuredProviders/types.js";
import { logger } from "./logger.js";
import { readCallerTenantId, runForCallerTenant } from "./callerTenant.js";

/**
 * Every `operation` `POST /internal/complete` accepts, mapped to whether the call is attributed to
 * a Projects item. #85's guidance-drift check always is; #183's transcript summary runs in
 * `semprec-transcribe` with no project in scope, so it sends `projectItemId: null` and its
 * `ai_gateway_calls` row carries none; #185's speaker-mapping suggestion runs in the same process,
 * the same way. The route rejects any other operation outright rather than accepting an arbitrary
 * string that nothing yet knows how to interpret.
 */
const OPERATION_REQUIRES_PROJECT_ITEM = new Map<string, boolean>([
  ["agent_guidance_drift", true],
  ["agent_behavior_drift", true],
  ["inbox_proposal", true],
  ["inbox_attachment_extraction", true],
  ["transcript_event_pick", false],
  ["transcript_summary", false],
  ["transcript_speaker_suggestion", false],
  ["semp_thread_title", false],
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Output tokens reserved against the budget for every structured completion — the most the
 * provider can bill for. Mirrors `MAX_OUTPUT_TOKENS` in `structuredProviders/anthropicProvider.ts`.
 */
const RESERVED_OUTPUT_TOKENS = 4096;

/** Body cap for a request without an image: generously above the 64 KiB `responseSchema` bound alone allows for prompt/messages content. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Body cap for a request that contains an image. The stream is read up to this; a body without an image is then held to `MAX_BODY_BYTES`. */
const MAX_BODY_BYTES_WITH_IMAGES = 8 * 1024 * 1024;

const MAX_IMAGES_PER_REQUEST = 4;
const MAX_IMAGE_DECODED_BYTES = 1.5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

/** The provider's ceiling for an image of about 1568 px; added to the input estimate per image. */
const ESTIMATED_TOKENS_PER_IMAGE = 1600;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface CompleteHandlerOptions {
  /** Compared against the caller's `Authorization: Bearer <token>` header. */
  internalToken: string;
  provider: StructuredCompletionProvider;
  model: string;
  pricePerMillionInputTokens: number;
  pricePerMillionOutputTokens: number;
  /** Operator-wide safety caps (`AI_GLOBAL_*_CAP_USD`), checked on every reservation against all tenants' spend. */
  globalCaps: GlobalAiCaps;
}

interface CompleteRequestBody {
  projectItemId: string | null;
  operation: string;
  temperature: number;
  system: string;
  messages: StructuredCompletionMessage[];
  responseSchema: object;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

class PayloadTooLargeError extends Error {
  constructor(
    message: string,
    readonly streaming = false,
  ) {
    super(message);
  }
}

/**
 * Reads up to the larger image-request cap; the caller applies the text-only cap with `bytes`
 * once it knows whether the body carries an image.
 */
async function readJsonBody(req: IncomingMessage): Promise<{ value: unknown; bytes: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array) && typeof value !== "string") {
      throw new ValidationError("Request body contains invalid data");
    }
    const buf = Buffer.from(value);
    size += buf.length;
    if (size > MAX_BODY_BYTES_WITH_IMAGES) {
      throw new PayloadTooLargeError("Request body exceeds the maximum allowed size", true);
    }
    chunks.push(buf);
  }
  try {
    return { value: JSON.parse(chunks.length === 0 ? "{}" : Buffer.concat(chunks).toString("utf8")), bytes: size };
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

function decodedBase64Length(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function isValidImageBlock(block: { mimeType?: unknown; data?: unknown }): boolean {
  return (
    typeof block.mimeType === "string" &&
    ALLOWED_IMAGE_MIME_TYPES.has(block.mimeType) &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    // The length bound comes first so an oversized string is never run through the pattern.
    block.data.length <= Math.ceil((MAX_IMAGE_DECODED_BYTES * 4) / 3) + 4 &&
    BASE64_PATTERN.test(block.data) &&
    decodedBase64Length(block.data) <= MAX_IMAGE_DECODED_BYTES
  );
}

function isContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image") return isValidImageBlock({ mimeType: value.mimeType, data: value.data });
  return false;
}

/** Number of image blocks in an array-form message; 0 for the string form. */
function countImages(content: StructuredCompletionMessage["content"]): number {
  return typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
}

function contentTextLength(content: StructuredCompletionMessage["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

/** Whether an unvalidated body holds an image block in `messages`, so the larger size cap can apply to it. */
function rawBodyHasImage(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  const messages = raw.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message: unknown) => {
    const content = isObject(message) ? message.content : null;
    return Array.isArray(content) && content.some((block: unknown) => isObject(block) && block.type === "image");
  });
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

/**
 * Issue #167: an `x-trace-id` the caller forwarded (`httpAiGatewayClient.ts`) continues that
 * caller's trace; an absent or malformed one (a direct call, or a caller with no trace set up)
 * gives `withTraceContext` nothing to key off, so it mints a fresh one for this request instead.
 */
function extractTraceId(req: IncomingMessage): string | undefined {
  const header = req.headers["x-trace-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && UUID_PATTERN.test(value) ? value : undefined;
}

function isStructuredCompletionMessage(value: unknown): value is StructuredCompletionMessage {
  if (!isObject(value) || (value.role !== "user" && value.role !== "assistant")) return false;
  const content = value.content;
  return typeof content === "string" || (Array.isArray(content) && content.length > 0 && content.every(isContentBlock));
}

function validateBody(raw: unknown): CompleteRequestBody {
  if (!isObject(raw)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const body = raw;

  const requiresProjectItem =
    typeof body.operation === "string" ? OPERATION_REQUIRES_PROJECT_ITEM.get(body.operation) : undefined;
  if (typeof body.operation !== "string" || requiresProjectItem === undefined) {
    throw new ValidationError("'operation' is missing or unsupported", { field: "operation" });
  }
  let projectItemId: string | null;
  if (requiresProjectItem) {
    if (typeof body.projectItemId !== "string" || !UUID_PATTERN.test(body.projectItemId)) {
      throw new ValidationError("'projectItemId' must be a UUID string", { field: "projectItemId" });
    }
    projectItemId = body.projectItemId;
  } else {
    if (body.projectItemId !== null) {
      throw new ValidationError(`'projectItemId' must be null for operation '${body.operation}'`, {
        field: "projectItemId",
      });
    }
    projectItemId = null;
  }
  if (
    typeof body.temperature !== "number" ||
    !Number.isFinite(body.temperature) ||
    body.temperature < 0 ||
    body.temperature > 1
  ) {
    throw new ValidationError("'temperature' must be a finite number between 0 and 1", { field: "temperature" });
  }
  if (typeof body.system !== "string" || body.system.length === 0) {
    throw new ValidationError("'system' must be a non-empty string", { field: "system" });
  }
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    !body.messages.every(isStructuredCompletionMessage)
  ) {
    throw new ValidationError("'messages' must be a non-empty array of { role, content }", { field: "messages" });
  }
  if (body.messages.reduce((sum, message) => sum + countImages(message.content), 0) > MAX_IMAGES_PER_REQUEST) {
    throw new ValidationError(`A request may carry at most ${MAX_IMAGES_PER_REQUEST} images`, { field: "messages" });
  }
  if (typeof body.responseSchema !== "object" || body.responseSchema === null) {
    throw new ValidationError("'responseSchema' must be a JSON object", { field: "responseSchema" });
  }

  return {
    projectItemId,
    operation: body.operation,
    temperature: body.temperature,
    system: body.system,
    messages: body.messages,
    responseSchema: body.responseSchema,
  };
}

/**
 * Handles `POST /internal/complete` for issue #215 — the gateway's structured-completion route.
 * Authenticates the internal bearer token before parsing the body, strictly validates the
 * request, budget-checks and dispatches to the configured provider via `@semprec/ai-gateway`'s
 * `complete()` (so budget/audit accounting is identical to every other gateway call), and
 * validates the provider's response against the caller's own schema before answering.
 */
export function createCompleteRequestListener(pool: Pool, options: CompleteHandlerOptions) {
  function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return withTraceContext({ traceId: extractTraceId(req) }, () => handleRequestTraced(req, res));
  }

  async function handleRequestTraced(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method !== "POST" || url.pathname !== "/internal/complete") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const providedToken = extractBearerToken(req);
      if (!providedToken || !tokensMatch(providedToken, options.internalToken)) {
        sendJson(res, 401, { error: "Invalid or missing bearer token", code: "unauthorized" });
        return;
      }

      const tenantId = readCallerTenantId(req);
      await runForCallerTenant(tenantId, async () => {
        const { value: rawBody, bytes } = await readJsonBody(req);
        if (bytes > MAX_BODY_BYTES && !rawBodyHasImage(rawBody)) {
          throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
        }
        const body = validateBody(rawBody);

        let validateResponse;
        try {
          validateResponse = compileResponseSchema(body.responseSchema);
        } catch (err) {
          if (err instanceof InvalidResponseSchemaError) {
            throw new ValidationError(err.message, { field: "responseSchema" });
          }
          throw err;
        }

        // #620: a rough upper bound (about 4 characters per token for the input, the full output
        // cap) reserved against the budget before the call and replaced by the real cost on settle.
        // Each image adds the provider's fixed ceiling on top of the text estimate.
        const imageCount = body.messages.reduce((sum, message) => sum + countImages(message.content), 0);
        const estimatedInputTokens =
          Math.ceil(
            (body.system.length +
              body.messages.reduce((sum, message) => sum + contentTextLength(message.content), 0) +
              JSON.stringify(body.responseSchema).length) /
              4,
          ) +
          imageCount * ESTIMATED_TOKENS_PER_IMAGE;
        const estimatedCostUsd =
          (estimatedInputTokens / 1_000_000) * options.pricePerMillionInputTokens +
          (RESERVED_OUTPUT_TOKENS / 1_000_000) * options.pricePerMillionOutputTokens;

        // A `ServerResponse` emits `close` both after a normal `end()` and on a premature connection
        // loss; `writableFinished` is only true for the former, so only a disconnect aborts.
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) abort.abort();
        });
        // The connection may already have dropped while the body was being validated.
        if (res.destroyed) abort.abort();

        let result;
        try {
          result = await complete(
            pool,
            {
              provider: options.provider.id,
              model: options.model,
              agentRunId: null,
              projectItemId: body.projectItemId,
              operation: body.operation,
              estimatedCostUsd,
              globalCaps: options.globalCaps,
            },
            async () => {
              // A transport failure throws here, so `complete()` marks its reservation `failed` at
              // cost 0 instead of settling it — #215's "no fabricated token/cost" for a call that
              // never produced a response.
              const providerResult = await options.provider.complete({
                model: options.model,
                temperature: body.temperature,
                system: body.system,
                messages: body.messages,
                responseSchema: body.responseSchema,
                signal: abort.signal,
              });

              // A schema-invalid response, unlike a transport failure, is still "a provider
              // response" — the call happened and cost money, so the audit row below must still
              // be written with its real usage. `valid` decides the client-facing status.
              const valid = validateResponse(providerResult.content);
              return {
                content: providerResult.content,
                valid,
                inputTokens: providerResult.inputTokens,
                outputTokens: providerResult.outputTokens,
                costUsd:
                  (providerResult.inputTokens / 1_000_000) * options.pricePerMillionInputTokens +
                  (providerResult.outputTokens / 1_000_000) * options.pricePerMillionOutputTokens,
              };
            },
          );
        } catch (err) {
          if (abort.signal.aborted) {
            // The socket is gone, so there is no one to answer; `complete()` has already marked the
            // reservation `failed`.
            logger.info(
              { provider: options.provider.id, model: options.model, path: url.pathname },
              "Client disconnected before the provider call finished",
            );
            return;
          }
          if (err instanceof BudgetExceededError) {
            sendJson(res, 403, { error: err.message, code: "budget_exceeded" });
            return;
          }
          if (err instanceof ProviderCallError) {
            // Standard failed-call observability event: a transport failure leaves only a `failed`
            // ai_gateway_calls row with no usage (see the comment above), so this log carries the cause.
            logger.error({ err, provider: options.provider.id, model: options.model }, "Provider call failed");
            sendJson(res, 502, { error: "Provider call failed", code: "provider_failed" });
            return;
          }
          throw err;
        }

        if (!result.valid) {
          sendJson(res, 502, { error: "Provider response failed schema validation", code: "invalid_response" });
          return;
        }

        sendJson(res, 200, {
          content: result.content,
          usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        });
      });
    } catch (err) {
      if (res.destroyed || res.writableEnded || req.aborted) return;
      if (err instanceof PayloadTooLargeError) {
        if (err.streaming && !req.complete && !req.destroyed) {
          let discarded = 0;
          let disposed = false;
          const dispose = (): void => {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            req.off("data", onData);
            req.off("end", dispose);
            req.off("close", dispose);
            req.off("aborted", dispose);
            req.off("error", dispose);
          };
          const onData = (chunk: unknown): void => {
            if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") {
              dispose();
              req.destroy();
              return;
            }
            discarded += Buffer.byteLength(chunk);
            if (discarded >= 2 * 1024 * 1024) {
              dispose();
              req.destroy();
            }
          };
          const timer = setTimeout(() => {
            dispose();
            req.destroy();
          }, 2000);
          timer.unref();
          req.on("data", onData);
          req.once("end", dispose);
          req.once("close", dispose);
          req.once("aborted", dispose);
          req.once("error", dispose);
        }
        if (err.streaming) res.setHeader("Connection", "close");
        sendJson(res, 413, { error: err.message });
        if (err.streaming && !req.complete && !req.destroyed) req.resume();
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
   * Same rationale as `semprec-api`'s handlers: keeping the boundary synchronous confines a
   * rejection that escapes the try/catch above to a 500 for that one request instead of an
   * unhandled rejection that takes the whole process down.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the complete request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
