/** The provider-neutral result consumed by the transcription pipeline. */
export interface DiarizationTurn {
  speaker: string;
  start: number;
  end: number;
}

export interface DiarizationRequest {
  numSpeakers?: { exact: number } | { min: number };
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  /** Aborted when the gateway's own caller disconnects before the response is written. */
  signal?: AbortSignal;
}

export interface DiarizationProvider {
  readonly id: string;
  readonly model: string;
  diarize(request: DiarizationRequest): Promise<DiarizationTurn[]>;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionRequest {
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  /** Omit on the first chunk to let Whisper detect the recording language. */
  language?: string;
  /** Aborted when the gateway's own caller disconnects before the response is written. */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  segments: TranscriptionSegment[];
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly model: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Provider failures deliberately contain no response body or credentials. */
export class AudioProviderCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioProviderCallError";
  }
}

/**
 * Raw microphone audio the streaming route accepts: PCM signed 16-bit little-endian, mono, 16 kHz
 * (docs/adr/2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech.md). Used to
 * turn forwarded bytes into the seconds a chunk row is settled with.
 */
export const STREAM_AUDIO_BYTES_PER_SECOND = 16_000 * 2;

/** What a streaming transcription session reports back; no callback ever carries audio. */
export interface StreamingTranscriptionEvents {
  /** The running text of the utterance being spoken; replaces the previous partial. */
  onPartial(text: string): void;
  /** The finished text of one utterance. */
  onFinal(text: string): void;
  /** Called once after `end()` when every committed utterance has been reported as final. */
  onDone(): void;
  /** The session failed; no further callback follows. The error carries no provider text. */
  onError(err: AudioProviderCallError): void;
}

export interface StreamingTranscriptionSession {
  /** Forwards one frame of raw 16 kHz PCM (`STREAM_AUDIO_BYTES_PER_SECOND`); the bytes are not retained. */
  write(audio: Uint8Array): void;
  /** No more audio: commit what is buffered, then `onDone` once the last final has been emitted. */
  end(): void;
  /** Drops the session at once without any further callback. Safe to call more than once. */
  abort(): void;
}

export interface StreamingTranscriptionOpenRequest {
  /** ISO 639-1 code; omit to let the provider detect the language. */
  language?: string;
  events: StreamingTranscriptionEvents;
  /** Aborting it behaves like `session.abort()`, including while the session is still opening. */
  signal?: AbortSignal;
}

export interface StreamingTranscriptionProvider {
  readonly id: string;
  readonly model: string;
  open(request: StreamingTranscriptionOpenRequest): Promise<StreamingTranscriptionSession>;
}

/** Speech audio the synthesis route returns: PCM signed 16-bit little-endian, mono, 24000 Hz (same ADR). */
export const SYNTHESIS_AUDIO_BYTES_PER_SECOND = 24_000 * 2;

export interface SpeechSynthesisRequest {
  text: string;
  /** One of the provider's `voices`. */
  voice: string;
  /** Aborting it stops the provider request, also while the audio is being read. */
  signal?: AbortSignal;
}

export interface SpeechSynthesisStream {
  /**
   * The synthesized audio in order, as raw PCM (`SYNTHESIS_AUDIO_BYTES_PER_SECOND`). Reading it
   * throws `AudioProviderCallError` when the provider fails or the request is aborted.
   */
  readonly audio: AsyncIterable<Uint8Array>;
  /** Seconds of audio produced so far; once `audio` is exhausted, the duration of the whole speech. */
  durationSeconds(): number;
}

export interface SpeechSynthesisProvider {
  readonly id: string;
  readonly model: string;
  /** The voice names this provider accepts. */
  readonly voices: readonly string[];
  /** Starts the provider request; rejects with `AudioProviderCallError` when it cannot be started. */
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisStream>;
}
