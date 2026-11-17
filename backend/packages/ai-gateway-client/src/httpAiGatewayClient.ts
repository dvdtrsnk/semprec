import { WebSocket } from "ws";
import {
  AiGatewayFailedError,
  currentTenantScope,
  getTraceId,
  mintTraceId,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";

/** Carries the caller's own tenant scope across the loopback hop; the gateway validates it and enters that tenant. */
const TENANT_ID_HEADER = "x-semprec-tenant-id";

/** The headers that attribute a speech synthesis to the agent run and the Semp message it serves. */
const AGENT_RUN_ID_HEADER = "x-semprec-agent-run-id";
const SEMP_MESSAGE_ID_HEADER = "x-semprec-semp-message-id";

/** The budget for the whole round trip to `semprec-ai-gateway`. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The gateway caps its own request bodies at 1 MiB (`completeHandler.ts`), so a larger response is refused rather than buffered. */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface HttpAiGatewayClientConfig {
  /** The port `semprec-ai-gateway` listens on; the client always addresses it over loopback. */
  port: number;
  /** Compared by the gateway against its own `AI_GATEWAY_INTERNAL_TOKEN`. */
  token: string;
}

function tenantHeader(): Record<string, string> {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? { [TENANT_ID_HEADER]: scope.tenantId } : {};
}

class ResponseTooLargeError extends Error {}

/** Reads the body with a hard byte cap, independent of any `Content-Length` header. */
async function readJsonBodyWithSizeCap(res: Response, maxBytes: number): Promise<unknown> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
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
 * Whether a non-2xx response is the gateway's budget rejection (`403`, `code: "budget_exceeded"`).
 * An unreadable body is not one and is reported as a plain `http` failure.
 */
async function isBudgetRejection(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  let body: unknown;
  try {
    body = await readJsonBodyWithSizeCap(res, MAX_RESPONSE_BODY_BYTES);
  } catch {
    return false;
  }
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "budget_exceeded";
}

/**
 * `AiGatewayClientPort` over `fetch` to `POST /internal/complete`, with a 60s timeout and strict
 * response validation. Every failure collapses to `AiGatewayFailedError` with only a `reason`
 * (`budget_exceeded` for the budget rejection), never the provider's error body, a response
 * snippet or the bearer token.
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
            // Correlates the gateway's logs with the caller's; minted when the caller has no active trace.
            "x-trace-id": getTraceId() ?? mintTraceId(),
            // Taken only from the ambient scope, never from input; no header outside a tenant scope.
            ...tenantHeader(),
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "http";
        throw new AiGatewayFailedError(reason);
      }

      if (!res.ok) {
        throw new AiGatewayFailedError((await isBudgetRejection(res)) ? "budget_exceeded" : "http");
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

/** Handshake deadline for `/internal/stt/stream` (a loopback connect; anything slower is a hung gateway). */
const STT_OPEN_TIMEOUT_MS = 10_000;
/** The gateway's messages are tiny JSON objects; a larger frame is a protocol violation. */
const STT_MAX_MESSAGE_BYTES = 64 * 1024;

/** The `code` of a gateway `{type: "error"}` message on `/internal/stt/stream`. */
export type SttStreamErrorCode =
  "budget_exceeded" | "provider_error" | "capacity" | "session_limit" | "idle_timeout" | "invalid_frame";

const STT_ERROR_CODES: readonly string[] = [
  "budget_exceeded",
  "provider_error",
  "capacity",
  "session_limit",
  "idle_timeout",
  "invalid_frame",
];

export interface SttStreamEvents {
  /** The running text of the utterance being spoken; replaces the previous partial. */
  onPartial(text: string): void;
  /** The finished text of one utterance. */
  onFinal(text: string): void;
  /** The gateway ended the stream with an error; `onClose` follows. */
  onError(code: SttStreamErrorCode): void;
  /** The stream is over, whichever side ended it. Called exactly once after a successful open. */
  onClose(): void;
}

export interface SttStream {
  /** One frame of raw PCM s16le, mono, 16 kHz. At most 16 KiB and an even byte length. */
  sendAudio(pcm: Uint8Array): boolean;
  /** Signals the end of the audio; the gateway then sends the last finals and closes. */
  end(): void;
  /**
   * Attributes every chunk row the gateway reserved on this stream since it opened, or since the previous call,
   * to the Semp assistant message of the turn the speech started. Speech never attributed stays
   * unattributed. Returns false when the stream is not open, in which case nothing was sent.
   */
  attribute(sempMessageId: string): boolean;
  /** Drops the stream at once; the gateway aborts the provider session and settles the open chunk row. */
  close(): void;
}

export interface OpenSttStreamOptions {
  /** ISO 639-1 code; omit to let the provider detect the language. */
  language?: string;
  /** Aborting it closes the stream, also while it is still opening. */
  signal?: AbortSignal;
}

type SttMessage = { type: "partial" | "final"; text: string } | { type: "error"; code: SttStreamErrorCode };

function parseSttMessage(raw: string): SttMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as { type?: unknown; text?: unknown; code?: unknown };
  if ((message.type === "partial" || message.type === "final") && typeof message.text === "string") {
    return { type: message.type, text: message.text };
  }
  if (message.type === "error" && typeof message.code === "string" && STT_ERROR_CODES.includes(message.code)) {
    return { type: "error", code: message.code as SttStreamErrorCode };
  }
  return null;
}

/**
 * Opens `/internal/stt/stream` over loopback with the same token and ambient tenant header as
 * {@link createHttpAiGatewayClient}; the gateway refuses a stream without a tenant. Rejects with
 * `AiGatewayFailedError` (`timeout` or `http`) when it cannot open; once open every outcome goes
 * through `events`, and an unparseable gateway message ends the stream as `provider_error`.
 */
export function openSttStream(
  config: HttpAiGatewayClientConfig,
  options: OpenSttStreamOptions,
  events: SttStreamEvents,
): Promise<SttStream> {
  const query = options.language === undefined ? "" : `?language=${encodeURIComponent(options.language)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/internal/stt/stream${query}`, {
      headers: {
        authorization: `Bearer ${config.token}`,
        "x-trace-id": getTraceId() ?? mintTraceId(),
        ...tenantHeader(),
      },
      maxPayload: STT_MAX_MESSAGE_BYTES,
      handshakeTimeout: STT_OPEN_TIMEOUT_MS,
    });
    let opened = false;
    let closed = false;

    const close = (): void => {
      options.signal?.removeEventListener("abort", close);
      ws.terminate();
    };
    options.signal?.addEventListener("abort", close, { once: true });
    if (options.signal?.aborted) close();

    ws.on("error", (err) => {
      if (opened) return; // the `close` event that follows reports the end of an open stream
      reject(new AiGatewayFailedError(err.message.includes("timed out") ? "timeout" : "http"));
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      reject(new AiGatewayFailedError("http"));
      ws.terminate();
    });
    ws.on("open", () => {
      opened = true;
      resolve({
        sendAudio: (pcm) => {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + pcm.byteLength > 256 * 1024) return false;
          ws.send(pcm, { binary: true });
          return true;
        },
        end: () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
        },
        attribute: (sempMessageId) => {
          if (ws.readyState !== WebSocket.OPEN) return false;
          ws.send(JSON.stringify({ type: "attribute", sempMessageId }));
          return true;
        },
        close,
      });
    });
    ws.on("message", (data, isBinary) => {
      const message = isBinary ? null : parseSttMessage((data as Buffer).toString("utf8"));
      if (message === null) {
        events.onError("provider_error");
        close();
        return;
      }
      if (message.type === "error") events.onError(message.code);
      else if (message.type === "partial") events.onPartial(message.text);
      else events.onFinal(message.text);
    });
    ws.on("close", () => {
      options.signal?.removeEventListener("abort", close);
      if (!opened) {
        reject(new AiGatewayFailedError("http"));
        return;
      }
      if (closed) return;
      closed = true;
      events.onClose();
    });
  });
}

/** The deadline for the whole synthesis exchange, from the request to the last audio byte. */
const TTS_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** The gateway caps one synthesis at 4000 characters, about 5 minutes of 24 kHz PCM; this is the hard stop above it. */
const TTS_MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export interface SynthesizeSpeechOptions {
  /** The text to speak, at most 4000 characters. Never logged by the gateway. */
  text: string;
  /** One of the voice names the gateway's provider accepts. */
  voice: string;
  /** Aborting it ends the request; the gateway aborts the provider and settles the audio produced so far. */
  signal?: AbortSignal;
  /** The agent run whose turn is spoken (`x-semprec-agent-run-id`); omit when the speech serves no run. */
  agentRunId?: string;
  /** The Semp assistant message that is spoken (`x-semprec-semp-message-id`); omit when the speech serves none. */
  sempMessageId?: string;
}

/** The gateway refused a synthesis because its bounded stream capacity was exhausted. */
export class SpeechSynthesisCapacityError extends AiGatewayFailedError {
  constructor() {
    super("http");
    this.name = "SpeechSynthesisCapacityError";
    this.message = "Speech synthesis capacity exhausted";
  }
}

async function isSpeechCapacityRejection(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = await readJsonBodyWithSizeCap(res, 4096);
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      "code" in body &&
      body.code === "tts_capacity_exhausted"
    );
  } catch {
    return false;
  }
}

/**
 * Calls `POST /internal/tts/stream` over loopback (same token and tenant header as
 * {@link createHttpAiGatewayClient}) and resolves once headers arrive, with the audio as raw PCM
 * chunks (s16le, mono, 24000 Hz) playable while the rest is synthesized. Rejects with
 * `AiGatewayFailedError`: `budget_exceeded`, `timeout`, or `http` for another non-2xx. Reading
 * throws `http` when the stream breaks, `timeout` at the deadline and `invalid_response` past the
 * audio cap. A reader that stops early cancels the request.
 */
export async function synthesizeSpeech(
  config: HttpAiGatewayClientConfig,
  options: SynthesizeSpeechOptions,
): Promise<AsyncIterable<Uint8Array>> {
  const deadline = AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS);
  const cancel = new AbortController();
  const signal = AbortSignal.any([deadline, cancel.signal, ...(options.signal ? [options.signal] : [])]);
  const failure = (): AiGatewayFailedError => new AiGatewayFailedError(deadline.aborted ? "timeout" : "http");

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${config.port}/internal/tts/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        "x-trace-id": getTraceId() ?? mintTraceId(),
        ...tenantHeader(),
        ...(options.agentRunId === undefined ? {} : { [AGENT_RUN_ID_HEADER]: options.agentRunId }),
        ...(options.sempMessageId === undefined ? {} : { [SEMP_MESSAGE_ID_HEADER]: options.sempMessageId }),
      },
      body: JSON.stringify({ text: options.text, voice: options.voice }),
      signal,
    });
  } catch {
    throw failure();
  }
  if (!res.ok) {
    try {
      if (await isBudgetRejection(res)) throw new AiGatewayFailedError("budget_exceeded");
      if (await isSpeechCapacityRejection(res)) throw new SpeechSynthesisCapacityError();
      throw new AiGatewayFailedError("http");
    } finally {
      cancel.abort();
    }
  }
  const reader = res.body?.getReader();
  if (!reader) {
    cancel.abort();
    throw new AiGatewayFailedError("invalid_response");
  }

  async function* read(body: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Uint8Array> {
    let bytes = 0;
    try {
      for (;;) {
        let result: Awaited<ReturnType<typeof body.read>>;
        try {
          result = await body.read();
        } catch {
          throw failure();
        }
        if (result.done) return;
        bytes += result.value.byteLength;
        if (bytes > TTS_MAX_AUDIO_BYTES) throw new AiGatewayFailedError("invalid_response");
        yield result.value;
      }
    } finally {
      // Runs on completion, on an error and when the reader stops early: the request ends in every case.
      cancel.abort();
    }
  }
  return read(reader);
}
