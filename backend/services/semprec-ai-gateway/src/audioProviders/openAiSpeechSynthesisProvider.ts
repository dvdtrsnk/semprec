import {
  AudioProviderCallError,
  SYNTHESIS_AUDIO_BYTES_PER_SECOND,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisStream,
} from "./types.js";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
/** Time allowed until the response headers arrive; an endpoint that accepts and says nothing must not hold a slot. */
const HEADERS_TIMEOUT_MS = 30_000;
/** Whole-request deadline, covering the audio stream as well. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
/** Hard cap on the audio of one request (about 11 minutes), independent of the provider's headers. */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

/** The built-in voices of `gpt-4o-mini-tts`. */
const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

/** OpenAI text-to-speech (`gpt-4o-mini-tts`) asking for raw 24 kHz mono PCM, the format of the voice ADR. */
export function createOpenAiSpeechSynthesisProvider(apiKey: string): SpeechSynthesisProvider {
  return {
    id: "openai",
    model: OPENAI_TTS_MODEL,
    voices: OPENAI_VOICES,
    async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisStream> {
      const overall = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = request.signal ? AbortSignal.any([overall, request.signal]) : overall;
      const headersAbort = new AbortController();
      const headersTimer = setTimeout(() => headersAbort.abort(), HEADERS_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(OPENAI_SPEECH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OPENAI_TTS_MODEL,
            input: request.text,
            voice: request.voice,
            response_format: "pcm",
          }),
          signal: AbortSignal.any([signal, headersAbort.signal]),
        });
      } catch (err) {
        throw new AudioProviderCallError(`OpenAI request failed: ${err instanceof Error ? err.name : "unknown error"}`);
      } finally {
        clearTimeout(headersTimer);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new AudioProviderCallError(`OpenAI responded with HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new AudioProviderCallError("OpenAI response body stream was unavailable");

      let bytes = 0;
      async function* read(body: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            let result: Awaited<ReturnType<typeof body.read>>;
            try {
              result = await body.read();
            } catch (err) {
              throw new AudioProviderCallError(
                `OpenAI audio stream failed: ${err instanceof Error ? err.name : "unknown error"}`,
              );
            }
            if (result.done) return;
            bytes += result.value.byteLength;
            if (bytes > MAX_AUDIO_BYTES) {
              throw new AudioProviderCallError("OpenAI audio exceeded the maximum allowed size");
            }
            yield result.value;
          }
        } finally {
          // Also runs when the consumer stops early, which aborts the provider's body.
          await body.cancel().catch(() => {});
        }
      }

      return { audio: read(reader), durationSeconds: () => bytes / SYNTHESIS_AUDIO_BYTES_PER_SECOND };
    },
  };
}
