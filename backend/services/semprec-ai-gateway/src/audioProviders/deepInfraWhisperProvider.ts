import {
  AudioProviderCallError,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./types.js";
import { readJsonBodyWithSizeCap } from "./httpUtils.js";

const DEEPINFRA_TRANSCRIPTIONS_URL = "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseResponse(value: unknown): TranscriptionResult {
  if (!isObject(value) || typeof value.text !== "string") {
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
      return parseResponse(await readJsonBodyWithSizeCap(res, "DeepInfra", MAX_RESPONSE_BODY_BYTES));
    },
  };
}
