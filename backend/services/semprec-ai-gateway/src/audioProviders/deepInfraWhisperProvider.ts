import {
  AudioProviderCallError,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./types.js";

const DEEPINFRA_TRANSCRIPTIONS_URL = "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

type DeepInfraResponse = { text?: unknown; language?: unknown; segments?: unknown };

function isDeepInfraResponse(value: unknown): value is DeepInfraResponse {
  return typeof value === "object" && value !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseResponse(value: unknown): TranscriptionResult {
  if (!isDeepInfraResponse(value) || typeof value.text !== "string") {
    throw new AudioProviderCallError("DeepInfra response did not match the expected shape");
  }
  if (value.language !== undefined && typeof value.language !== "string") {
    throw new AudioProviderCallError("DeepInfra response language did not match the expected shape");
  }
  if (!Array.isArray(value.segments)) {
    throw new AudioProviderCallError("DeepInfra response did not include timestamped segments");
  }
  const segments = value.segments.map((segment: unknown) => {
    if (
      !isObject(segment) ||
      typeof segment.start !== "number" ||
      !Number.isFinite(segment.start) ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.end) ||
      typeof segment.text !== "string"
    ) {
      throw new AudioProviderCallError("DeepInfra response contained an invalid segment");
    }
    return { start: segment.start, end: segment.end, text: segment.text };
  });
  return { text: value.text, language: value.language ?? null, segments };
}

async function readJsonBodyWithSizeCap(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new AudioProviderCallError("DeepInfra response body stream was unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw new AudioProviderCallError("DeepInfra response body exceeded the maximum allowed size");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new AudioProviderCallError("DeepInfra response body was not valid JSON");
  }
}

/** DeepInfra's OpenAI-compatible Whisper large-v3 adapter. */
export function createDeepInfraWhisperProvider(apiKey: string): TranscriptionProvider {
  return {
    id: "deepinfra",
    model: "whisper-large-v3",
    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      const form = new FormData();
      form.set("model", "openai/whisper-large-v3");
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      if (request.language !== undefined) form.set("language", request.language);
      form.set("file", new Blob([request.audio], { type: request.mimeType }), request.filename);

      let res: Response;
      try {
        res = await fetch(DEEPINFRA_TRANSCRIPTIONS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(55_000),
        });
      } catch (err) {
        throw new AudioProviderCallError(
          `DeepInfra request failed: ${err instanceof Error ? err.name : "unknown error"}`,
        );
      }
      if (!res.ok) throw new AudioProviderCallError(`DeepInfra responded with HTTP ${res.status}`);
      return parseResponse(await readJsonBodyWithSizeCap(res));
    },
  };
}
