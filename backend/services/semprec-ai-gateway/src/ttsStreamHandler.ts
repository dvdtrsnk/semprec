import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ChokePointError, ValidationError } from "@semprec/data";
import { BudgetExceededError, synthesizeSpeech, type GlobalAiCaps } from "@semprec/ai-gateway";
import { AudioProviderCallError, type SpeechSynthesisProvider } from "./audioProviders/types.js";
import { createAudioConcurrencyLimit } from "./audioConcurrencyLimit.js";
import {
  abortOnDisconnect,
  extractBearerToken,
  PayloadTooLargeError,
  readJsonBody,
  sendJson,
  tokensMatch,
} from "./audioHandler.js";
import { readCallerTenantId, runForCallerTenant } from "./callerTenant.js";
import { extractAgentRunId, extractSempMessageId } from "./attributionHeaders.js";
import { logger } from "./logger.js";

export const TTS_STREAM_PATH = "/internal/tts/stream";

/** The `ai_gateway_calls.operation` of every row of this route. */
export const TTS_STREAM_OPERATION = "voice_synthesize";

/** The most characters one request may synthesize; also below the provider's own per-request input limit. */
export const MAX_TTS_TEXT_CHARS = 4000;
/** A body of `MAX_TTS_TEXT_CHARS` four-byte characters plus the JSON around them fits with room to spare. */
const MAX_BODY_BYTES = 32 * 1024;
/**
 * Spoken characters per second used for the up-front price estimate. Deliberately below real
 * speech rates, so the reserved estimate is an upper bound and the settled cost usually lower.
 */
const ESTIMATE_CHARS_PER_SECOND = 10;
/** How many syntheses may run at once; each one holds a provider connection and a reserved row. */
export const MAX_CONCURRENT_TTS_STREAMS = 8;
/** A caller that stops reading for this long is treated as gone. */
const DRAIN_TIMEOUT_MS = 30_000;

export interface TtsStreamHandlerOptions {
  internalToken: string;
  provider: SpeechSynthesisProvider;
  /** USD per hour of synthesized audio. */
  pricePerAudioHour: number;
  maxConcurrentStreams: number;
  globalCaps: GlobalAiCaps;
}

/** The turn a synthesis serves, from the optional `x-semprec-agent-run-id` and `x-semprec-semp-message-id` headers (#2020). */
interface TtsAttribution {
  agentRunId: string | null;
  sempMessageId: string | null;
}

interface TtsRequestBody {
  text: string;
  voice: string;
}

function validateBody(raw: unknown, provider: SpeechSynthesisProvider): TtsRequestBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    throw new ValidationError("'text' must be a non-empty string", { field: "text" });
  }
  if (body.text.length > MAX_TTS_TEXT_CHARS) {
    throw new ValidationError(`'text' must be at most ${MAX_TTS_TEXT_CHARS} characters`, { field: "text" });
  }
  if (typeof body.voice !== "string" || !provider.voices.includes(body.voice)) {
    throw new ValidationError("'voice' must be a known voice", { field: "voice" });
  }
  return { text: body.text, voice: body.voice };
}

/** Writes one chunk and waits for the socket to drain; a caller that does not drain in time is dropped. */
async function writeWithBackpressure(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (res.destroyed || res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      res.off("drain", finish);
      res.off("close", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      res.destroy();
      finish();
    }, DRAIN_TIMEOUT_MS);
    res.once("drain", finish);
    res.once("close", finish);
  });
}

/**
 * Ends the response without the chunked terminator, so the caller sees a broken stream instead of
 * a complete one. The socket is ended rather than destroyed so audio already written still arrives.
 */
function cutResponse(res: ServerResponse): void {
  const { socket } = res;
  if (socket === null) {
    res.destroy();
    return;
  }
  // A write is held back until the next tick, so ending the socket at once would drop the last chunk.
  setImmediate(() => socket.end());
}

/**
 * Handles `POST /internal/tts/stream` (#1399): a JSON `{text, voice}` in, raw 24 kHz mono PCM s16le
 * out as a chunked response, written as the provider produces it. The price is reserved from the
 * text length before the provider is called (`synthesizeSpeech`) and the row is settled with the
 * audio actually produced; a caller that disconnects aborts the provider request and the row is
 * settled with what was produced, or failed when nothing was. The optional attribution headers
 * `x-semprec-agent-run-id` and `x-semprec-semp-message-id` are written on the reserved row, so the
 * settled row carries them too; a run or message of another tenant, or an unknown one, is refused
 * as `attribution_refused` without a row. The text is never logged.
 */
export function createTtsStreamRequestListener(pool: Pool, options: TtsStreamHandlerOptions) {
  const limit = createAudioConcurrencyLimit(options.maxConcurrentStreams);
  const { provider } = options;

  async function handleSynthesize(
    req: IncomingMessage,
    res: ServerResponse,
    attribution: TtsAttribution,
  ): Promise<void> {
    const body = validateBody(await readJsonBody(req, MAX_BODY_BYTES), provider);
    const signal = abortOnDisconnect(res);
    const estimatedSeconds = body.text.length / ESTIMATE_CHARS_PER_SECOND;
    let cut = false;
    const priceOf = (seconds: number): number => (seconds / 3600) * options.pricePerAudioHour;
    try {
      const result = await synthesizeSpeech(
        pool,
        {
          provider: provider.id,
          model: provider.model,
          operation: TTS_STREAM_OPERATION,
          agentRunId: attribution.agentRunId,
          sempMessageId: attribution.sempMessageId,
          estimatedCostUsd: priceOf(estimatedSeconds),
          globalCaps: options.globalCaps,
        },
        async () => {
          const stream = await provider.synthesize({ text: body.text, voice: body.voice, signal });
          let sentBytes = 0;
          try {
            for await (const chunk of stream.audio) {
              if (signal.aborted) break;
              if (!res.headersSent) {
                res.writeHead(200, {
                  "Content-Type": "audio/L16; rate=24000; channels=1",
                  "Cache-Control": "no-store",
                });
              }
              await writeWithBackpressure(res, chunk);
              sentBytes += chunk.byteLength;
            }
          } catch (err) {
            // Nothing was produced: the whole call failed, and the caller still gets an error status.
            if (sentBytes === 0) throw err;
            // The speech is cut off part-way; what was produced is still settled. A caller that
            // is still connected learns of the cut by the response ending without its terminator.
            if (!signal.aborted) {
              logger.error(
                { err: { name: err instanceof Error ? err.name : "unknown" } },
                "Speech synthesis ended early",
              );
              cut = true;
              cutResponse(res);
            }
          }
          const audioSeconds = sentBytes === 0 ? 0 : stream.durationSeconds();
          return { audioSeconds, costUsd: priceOf(audioSeconds) };
        },
      );
      if (signal.aborted || res.destroyed || cut) return;
      if (result.audioSeconds <= 0) {
        sendJson(res, 502, { error: "Provider call failed", code: "provider_failed" });
        return;
      }
      res.end();
    } catch (err) {
      handleSynthesizeError(res, err, signal);
    }
  }

  function handleSynthesizeError(res: ServerResponse, err: unknown, signal: AbortSignal): void {
    if (signal.aborted) {
      // The socket is gone, so there is no one to answer; `synthesizeSpeech()` has already settled or failed the row.
      logger.info({ provider: provider.id, model: provider.model }, "Client disconnected during speech synthesis");
      return;
    }
    if (res.headersSent) {
      logger.error(
        { err: { name: err instanceof Error ? err.name : "unknown" } },
        "Speech synthesis failed mid-response",
      );
      cutResponse(res);
      return;
    }
    if (err instanceof BudgetExceededError) {
      sendJson(res, 403, { error: err.message, code: "budget_exceeded" });
      return;
    }
    if (err instanceof AudioProviderCallError) {
      logger.error(
        { err: { name: err.name }, provider: provider.id, model: provider.model },
        "Speech provider call failed",
      );
      sendJson(res, 502, { error: "Provider call failed", code: "provider_failed" });
      return;
    }
    throw err;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const providedToken = extractBearerToken(req);
      if (!providedToken || !tokensMatch(providedToken, options.internalToken)) {
        sendJson(res, 401, { error: "Invalid or missing bearer token", code: "unauthorized" });
        return;
      }
      if (req.method !== "POST" || url.pathname !== TTS_STREAM_PATH) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const tenantId = readCallerTenantId(req);
      // Validated before a slot is taken or the body is read, so a malformed header costs nothing.
      const attribution: TtsAttribution = {
        agentRunId: extractAgentRunId(req),
        sempMessageId: extractSempMessageId(req),
      };
      const release = limit.tryAcquire();
      if (release === null) {
        // Refused before the body is read or anything is reserved, so a rejected request costs nothing.
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" });
        res.end(JSON.stringify({ error: "Speech synthesis capacity exhausted", code: "tts_capacity_exhausted" }));
        return;
      }
      // `close` fires after a finished response and when the connection drops first: every path out frees the slot.
      res.on("close", release);
      await runForCallerTenant(tenantId, () => handleSynthesize(req, res, attribution));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      throw err;
    }
  }

  /** Keeps a rejection that escapes `handleRequest` to a 500 for this request instead of an unhandled rejection. */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error(
        { err: { name: err instanceof Error ? err.name : "unknown" } },
        "Unhandled error in the speech synthesis listener",
      );
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
