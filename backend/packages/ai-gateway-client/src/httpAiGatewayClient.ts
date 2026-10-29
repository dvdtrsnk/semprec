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

function tenantHeader(): Record<string, string> {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? { [TENANT_ID_HEADER]: scope.tenantId } : {};
}

class ResponseTooLargeError extends Error {}

/**
 * Reads the response body with a hard byte cap, independent of any (absent, wrong, or
 * adversarial) `Content-Length` header, so a malformed or oversized response can't be buffered
 * into memory wholesale before it's even parsed.
 */
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
 * Whether a non-2xx response is the gateway's own budget rejection (`403` with
 * `code: "budget_exceeded"`, as `completeHandler.ts` sends it). A body that can't be read or
 * parsed is just not one: the caller still reports the response as a plain `http` failure.
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
 * `packages/ai-gateway-client`'s only implementation of `AiGatewayClientPort` (#215): a plain
 * `fetch` against `semprec-ai-gateway`'s `POST /internal/complete`, with a 60s timeout and
 * strict response validation. Every failure mode — timeout, non-2xx (`budget_exceeded` for the
 * gateway's budget rejection), invalid JSON, schema mismatch — collapses to `AiGatewayFailedError` with only a `reason`, never the provider's own
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
            // Issue #167: carries this call's trace across the loopback hop so the gateway's own
            // logs correlate with the caller's. Minting a fallback here (rather than requiring an
            // active trace) keeps this client usable from a caller that hasn't set one up.
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
  sendAudio(pcm: Uint8Array): void;
  /** Signals the end of the audio; the gateway then sends the last finals and closes. */
  end(): void;
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
 * Opens `semprec-ai-gateway`'s streaming speech-to-text route (`/internal/stt/stream`, #1396) over
 * loopback with the same bearer token and ambient tenant header as {@link createHttpAiGatewayClient}.
 * The tenant must be in scope: the gateway refuses a stream without one. Rejects with
 * `AiGatewayFailedError` when the connection cannot be opened (`timeout` or `http`); once open,
 * every outcome is reported through `events`, and an unparseable gateway message ends the stream
 * as a `provider_error`.
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
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
        },
        end: () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
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
