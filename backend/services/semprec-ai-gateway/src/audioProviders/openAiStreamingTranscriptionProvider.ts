import { WebSocket } from "ws";
import {
  AudioProviderCallError,
  type StreamingTranscriptionOpenRequest,
  type StreamingTranscriptionProvider,
  type StreamingTranscriptionSession,
} from "./types.js";
import { isObject } from "./httpUtils.js";

const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_STT_MODEL = "gpt-4o-transcribe";
/** Handshake deadline; an endpoint that accepts the connection and says nothing must not hold a stream slot. */
const OPEN_TIMEOUT_MS = 10_000;
/** After `end()`, how long the provider has to report its last final transcript. */
const END_TIMEOUT_MS = 10_000;
/** Provider events are small JSON objects; anything bigger is a protocol violation. */
const MAX_PROVIDER_MESSAGE_BYTES = 1024 * 1024;

/**
 * Resamples a continuous 16 kHz mono PCM stream to the 24 kHz the realtime transcription input
 * requires (linear interpolation), keeping state across frames so frame boundaries add no click.
 */
export class Pcm16To24kResampler {
  private consumed = 0;
  private outIndex = 0;
  private last = 0;

  /** `input` is signed 16-bit little-endian PCM with an even byte length. */
  push(input: Uint8Array): Buffer {
    const samples = input.byteLength >> 1;
    const src = Buffer.from(input.buffer, input.byteOffset, samples * 2);
    const total = this.consumed + samples;
    const at = (i: number): number => (i === this.consumed - 1 ? this.last : src.readInt16LE((i - this.consumed) * 2));
    const out: number[] = [];
    for (;;) {
      const i = Math.floor((this.outIndex * 2) / 3);
      if (i + 1 >= total) break;
      const frac = ((this.outIndex * 2) % 3) / 3;
      const a = at(i);
      const b = at(i + 1);
      out.push(Math.round(a + (b - a) * frac));
      this.outIndex += 1;
    }
    if (samples > 0) this.last = src.readInt16LE((samples - 1) * 2);
    this.consumed = total;
    const bytes = Buffer.alloc(out.length * 2);
    out.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
    return bytes;
  }
}

/** OpenAI's streaming transcription (`gpt-4o-transcribe`) through the realtime transcription interface. */
export function createOpenAiStreamingTranscriptionProvider(apiKey: string): StreamingTranscriptionProvider {
  return {
    id: "openai",
    model: OPENAI_STT_MODEL,
    open(request: StreamingTranscriptionOpenRequest): Promise<StreamingTranscriptionSession> {
      const { events } = request;
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(OPENAI_REALTIME_TRANSCRIPTION_URL, {
          headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" },
          maxPayload: MAX_PROVIDER_MESSAGE_BYTES,
          handshakeTimeout: OPEN_TIMEOUT_MS,
        });
        const resampler = new Pcm16To24kResampler();
        const partials = new Map<string, string>();
        let opened = false;
        let stopped = false;
        let ended = false;
        let wroteAudio = false;
        let pendingItems = 0;
        let commitAnswered = false;
        let endTimer: NodeJS.Timeout | undefined;

        const stop = (): void => {
          if (stopped) return;
          stopped = true;
          if (endTimer !== undefined) clearTimeout(endTimer);
          request.signal?.removeEventListener("abort", stop);
          ws.removeAllListeners("message");
          ws.removeAllListeners("close");
          // Errors after teardown must not become unhandled; terminate() needs no handshake.
          ws.removeAllListeners("error");
          ws.on("error", () => undefined);
          ws.terminate();
        };
        const fail = (message: string): void => {
          if (stopped) return;
          stop();
          const err = new AudioProviderCallError(message);
          if (opened) events.onError(err);
          else reject(err);
        };
        const maybeDone = (): void => {
          if (stopped || !ended || !commitAnswered || pendingItems > 0) return;
          stop();
          events.onDone();
        };
        const sendEvent = (event: Record<string, unknown>): void => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
        };

        const session: StreamingTranscriptionSession = {
          write(audio) {
            if (stopped || ended) return;
            const pcm = resampler.push(audio);
            if (pcm.length === 0) return;
            wroteAudio = true;
            sendEvent({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
          },
          end() {
            if (stopped || ended) return;
            ended = true;
            endTimer = setTimeout(() => fail("OpenAI did not finish transcribing in time"), END_TIMEOUT_MS);
            if (!wroteAudio) {
              commitAnswered = true;
              maybeDone();
              return;
            }
            sendEvent({ type: "input_audio_buffer.commit" });
          },
          abort: stop,
        };

        if (request.signal?.aborted) {
          stop();
          reject(new AudioProviderCallError("OpenAI session aborted before it opened"));
          return;
        }
        request.signal?.addEventListener("abort", stop, { once: true });

        ws.on("open", () => {
          opened = true;
          const transcription: Record<string, unknown> = { model: OPENAI_STT_MODEL };
          if (request.language !== undefined) transcription.language = request.language;
          sendEvent({
            type: "transcription_session.update",
            session: {
              input_audio_format: "pcm16",
              input_audio_transcription: transcription,
              turn_detection: { type: "server_vad" },
            },
          });
          resolve(session);
        });
        ws.on("error", (err) => fail(`OpenAI connection failed: ${err.name}`));
        ws.on("close", () => fail("OpenAI closed the transcription session"));
        ws.on("message", (data, isBinary) => {
          if (isBinary) return fail("OpenAI sent an unexpected binary message");
          let event: unknown;
          try {
            event = JSON.parse((data as Buffer).toString("utf8"));
          } catch {
            return fail("OpenAI sent a message that is not JSON");
          }
          if (!isObject(event) || typeof event.type !== "string") return fail("OpenAI event did not match the shape");
          switch (event.type) {
            case "input_audio_buffer.committed":
              pendingItems += 1;
              if (ended) commitAnswered = true;
              maybeDone();
              return;
            case "conversation.item.input_audio_transcription.delta": {
              if (typeof event.item_id !== "string" || typeof event.delta !== "string") {
                return fail("OpenAI delta event did not match the shape");
              }
              const text = (partials.get(event.item_id) ?? "") + event.delta;
              partials.set(event.item_id, text);
              events.onPartial(text);
              return;
            }
            case "conversation.item.input_audio_transcription.completed": {
              if (typeof event.item_id !== "string" || typeof event.transcript !== "string") {
                return fail("OpenAI completed event did not match the shape");
              }
              partials.delete(event.item_id);
              pendingItems = Math.max(0, pendingItems - 1);
              events.onFinal(event.transcript);
              maybeDone();
              return;
            }
            case "conversation.item.input_audio_transcription.failed":
              return fail("OpenAI could not transcribe an utterance");
            case "error": {
              const code = isObject(event.error) ? event.error.code : undefined;
              if (code === "input_audio_buffer_commit_empty" && ended) {
                commitAnswered = true;
                maybeDone();
                return;
              }
              return fail("OpenAI reported an error");
            }
            default:
              return;
          }
        });
      });
    },
  };
}
