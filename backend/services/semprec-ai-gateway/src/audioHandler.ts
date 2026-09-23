import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { ChokePointError, ValidationError } from "@semprec/data";
import { BudgetExceededError, diarize, transcribe } from "@semprec/ai-gateway";
import type { DiarizationProvider, TranscriptionProvider } from "./audioProviders/types.js";
import { AudioProviderCallError } from "./audioProviders/types.js";
import { logger } from "./logger.js";

/**
 * Loopback-only route (never internet-facing — see `serve.ts`'s bind-to-127.0.0.1 comment), so
 * this cap only guards against a runaway caller, not a hostile one: it has to fit a whole
 * normalized recording (`mediaNormalization.ts`'s ~7 MB/hour Opus output) base64-encoded, which
 * inflates size by about a third, comfortably covering a multi-hour recording.
 */
const MAX_BODY_BYTES = 150 * 1024 * 1024;

export interface AudioHandlerOptions {
  internalToken: string;
  diarizationProvider: DiarizationProvider;
  transcriptionProvider: TranscriptionProvider;
  pyannotePricePerAudioHour: number;
  deepInfraPricePerAudioHour: number;
}

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

interface AudioRequestBody {
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  audioSeconds: number;
  language?: string;
}

/** Canonical padded standard base64, as produced by `Buffer#toString("base64")`. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validateBody(raw: unknown): AudioRequestBody {
  if (typeof raw !== "object" || raw === null) throw new ValidationError("Request body must be a JSON object");
  const body = raw as Record<string, unknown>;

  if (typeof body.audioBase64 !== "string" || body.audioBase64.length === 0) {
    throw new ValidationError("'audioBase64' must be a non-empty string", { field: "audioBase64" });
  }
  if (typeof body.filename !== "string" || body.filename.length === 0) {
    throw new ValidationError("'filename' must be a non-empty string", { field: "filename" });
  }
  if (typeof body.mimeType !== "string" || body.mimeType.length === 0) {
    throw new ValidationError("'mimeType' must be a non-empty string", { field: "mimeType" });
  }
  if (typeof body.audioSeconds !== "number" || !Number.isFinite(body.audioSeconds) || body.audioSeconds <= 0) {
    throw new ValidationError("'audioSeconds' must be a positive finite number", { field: "audioSeconds" });
  }
  if (body.language !== undefined && typeof body.language !== "string") {
    throw new ValidationError("'language' must be a string when present", { field: "language" });
  }

  // Buffer.from(..., "base64") never throws — it silently drops invalid characters — so the
  // format is checked up front instead of forwarding garbled bytes to the provider.
  if (!BASE64_PATTERN.test(body.audioBase64)) {
    throw new ValidationError("'audioBase64' is not valid base64", { field: "audioBase64" });
  }

  return {
    audio: new Uint8Array(Buffer.from(body.audioBase64, "base64")),
    filename: body.filename,
    mimeType: body.mimeType,
    audioSeconds: body.audioSeconds,
    language: body.language,
  };
}

/**
 * Handles `POST /internal/diarize` and `POST /internal/transcribe` for issue #182 — the gateway's
 * audio routes, mirroring `completeHandler.ts`'s auth/validation/error-mapping shape. Each
 * dispatches to `@semprec/ai-gateway`'s `diarize()`/`transcribe()` so budget-checking and
 * `ai_gateway_calls` accounting (audio_seconds/cost_usd, no token columns, no agent_run_id) are
 * identical to every other gateway call.
 */
export function createAudioRequestListener(pool: Pool, options: AudioHandlerOptions) {
  async function handleDiarize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = validateBody(await readJsonBody(req));
    try {
      const result = await diarize(
        pool,
        { provider: options.diarizationProvider.id, model: options.diarizationProvider.model },
        async () => {
          const turns = await options.diarizationProvider.diarize({
            audio: body.audio,
            filename: body.filename,
            mimeType: body.mimeType,
          });
          const costUsd = (body.audioSeconds / 3600) * options.pyannotePricePerAudioHour;
          return { turns, audioSeconds: body.audioSeconds, costUsd };
        },
      );
      sendJson(res, 200, { turns: result.turns });
    } catch (err) {
      handleProviderError(res, err, options.diarizationProvider.id, options.diarizationProvider.model);
    }
  }

  async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = validateBody(await readJsonBody(req));
    try {
      const result = await transcribe(
        pool,
        { provider: options.transcriptionProvider.id, model: options.transcriptionProvider.model },
        async () => {
          const transcription = await options.transcriptionProvider.transcribe({
            audio: body.audio,
            filename: body.filename,
            mimeType: body.mimeType,
            language: body.language,
          });
          const costUsd = (body.audioSeconds / 3600) * options.deepInfraPricePerAudioHour;
          return { ...transcription, audioSeconds: body.audioSeconds, costUsd };
        },
      );
      sendJson(res, 200, { text: result.text, language: result.language, segments: result.segments });
    } catch (err) {
      handleProviderError(res, err, options.transcriptionProvider.id, options.transcriptionProvider.model);
    }
  }

  function handleProviderError(res: ServerResponse, err: unknown, provider: string, model: string): void {
    if (err instanceof BudgetExceededError) {
      sendJson(res, 403, { error: err.message, code: "budget_exceeded" });
      return;
    }
    if (err instanceof AudioProviderCallError) {
      logger.error({ err, provider, model }, "Audio provider call failed");
      sendJson(res, 502, { error: "Provider call failed", code: "provider_failed" });
      return;
    }
    throw err;
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    return (async () => {
      try {
        const providedToken = extractBearerToken(req);
        if (!providedToken || !tokensMatch(providedToken, options.internalToken)) {
          sendJson(res, 401, { error: "Invalid or missing bearer token", code: "unauthorized" });
          return;
        }

        if (req.method === "POST" && url.pathname === "/internal/diarize") {
          await handleDiarize(req, res);
          return;
        }
        if (req.method === "POST" && url.pathname === "/internal/transcribe") {
          await handleTranscribe(req, res);
          return;
        }
        sendJson(res, 404, { error: "Not found" });
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
    })();
  }

  /**
   * Same rationale as `completeHandler.ts`: keeping the boundary synchronous confines a rejection
   * that escapes the try/catch above to a 500 for that one request instead of an unhandled
   * rejection that takes the whole process down.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the audio request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
