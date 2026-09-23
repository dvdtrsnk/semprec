/**
 * `semprec-transcribe`'s own client for `semprec-ai-gateway`'s `POST /internal/diarize` and
 * `POST /internal/transcribe` (issue #182), mirroring `packages/ai-gateway-client`'s
 * `createHttpAiGatewayClient` — a plain loopback `fetch` with a timeout and a capped response
 * read, kept local to this service since these two routes have no other caller yet. This is the
 * only path from `semprec-transcribe` to an AI provider, per
 * `docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md`: it never imports a provider SDK
 * or holds a provider API key itself.
 */

export interface DiarizationTurn {
  speaker: string;
  start: number;
  end: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  segments: TranscriptionSegment[];
}

export interface DiarizeRequest {
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  audioSeconds: number;
}

export interface TranscribeRequest {
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  audioSeconds: number;
  /** Omit on the first chunk to let Whisper detect the recording language. */
  language?: string;
}

export interface AudioGatewayClient {
  diarize(request: DiarizeRequest): Promise<DiarizationTurn[]>;
  transcribe(request: TranscribeRequest): Promise<TranscriptionResult>;
}

export class AudioGatewayCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioGatewayCallError";
  }
}

/** The gateway rejected the call against its budget caps (`403`, `code: "budget_exceeded"`); retrying it cannot succeed. */
export class AudioGatewayBudgetExceededError extends AudioGatewayCallError {
  constructor() {
    super("Gateway rejected the call: budget exceeded");
    this.name = "AudioGatewayBudgetExceededError";
  }
}

export interface HttpAudioGatewayClientConfig {
  /** The port `semprec-ai-gateway` listens on; the client always addresses it over loopback. */
  port: number;
  /** Compared by the gateway against its own `AI_GATEWAY_INTERNAL_TOKEN`. */
  token: string;
}

const REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Well above the largest legitimate JSON response (a full transcript's segments); guards against a malformed or adversarial body. */
const MAX_RESPONSE_BODY_BYTES = 20 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBodyWithSizeCap(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new AudioGatewayCallError("Response body stream was unavailable");

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AudioGatewayCallError("Response body exceeded the maximum allowed size");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new AudioGatewayCallError("Response body was not valid JSON");
  }
}

function parseTurns(value: unknown): DiarizationTurn[] {
  if (!isObject(value) || !Array.isArray(value.turns)) {
    throw new AudioGatewayCallError("Gateway diarize response did not match the expected shape");
  }
  return value.turns.map((turn) => {
    if (
      !isObject(turn) ||
      typeof turn.speaker !== "string" ||
      typeof turn.start !== "number" ||
      typeof turn.end !== "number"
    ) {
      throw new AudioGatewayCallError("Gateway diarize response contained an invalid turn");
    }
    return { speaker: turn.speaker, start: turn.start, end: turn.end };
  });
}

function parseTranscription(value: unknown): TranscriptionResult {
  if (!isObject(value) || typeof value.text !== "string" || !Array.isArray(value.segments)) {
    throw new AudioGatewayCallError("Gateway transcribe response did not match the expected shape");
  }
  if (value.language !== null && typeof value.language !== "string") {
    throw new AudioGatewayCallError("Gateway transcribe response language did not match the expected shape");
  }
  const segments = value.segments.map((segment) => {
    if (
      !isObject(segment) ||
      typeof segment.start !== "number" ||
      typeof segment.end !== "number" ||
      typeof segment.text !== "string"
    ) {
      throw new AudioGatewayCallError("Gateway transcribe response contained an invalid segment");
    }
    return { start: segment.start, end: segment.end, text: segment.text };
  });
  return { text: value.text, language: value.language, segments };
}

async function post(config: HttpAudioGatewayClientConfig, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AudioGatewayCallError(`Gateway request failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  if (!res.ok) {
    if (await isBudgetRejection(res)) throw new AudioGatewayBudgetExceededError();
    throw new AudioGatewayCallError(`Gateway responded with HTTP ${res.status}`);
  }
  return readJsonBodyWithSizeCap(res);
}

/**
 * Whether a non-2xx response is the gateway's budget rejection, as `audioHandler.ts` sends it. A
 * body that can't be read or parsed is just not one: the caller reports the plain HTTP status.
 */
async function isBudgetRejection(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  let body: unknown;
  try {
    body = await readJsonBodyWithSizeCap(res);
  } catch (err) {
    if (err instanceof AudioGatewayCallError) return false;
    throw err;
  }
  return isObject(body) && body.code === "budget_exceeded";
}

/** The production `AudioGatewayClient`: a loopback HTTP call to `semprec-ai-gateway`'s audio routes. */
export function createHttpAudioGatewayClient(config: HttpAudioGatewayClientConfig): AudioGatewayClient {
  return {
    async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
      return parseTurns(
        await post(config, "/internal/diarize", {
          audioBase64: Buffer.from(request.audio).toString("base64"),
          filename: request.filename,
          mimeType: request.mimeType,
          audioSeconds: request.audioSeconds,
        }),
      );
    },
    async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
      return parseTranscription(
        await post(config, "/internal/transcribe", {
          audioBase64: Buffer.from(request.audio).toString("base64"),
          filename: request.filename,
          mimeType: request.mimeType,
          audioSeconds: request.audioSeconds,
          language: request.language,
        }),
      );
    },
  };
}
