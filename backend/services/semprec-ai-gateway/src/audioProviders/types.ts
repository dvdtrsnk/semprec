/** The provider-neutral result consumed by the transcription pipeline. */
export interface DiarizationTurn {
  speaker: string;
  start: number;
  end: number;
}

export interface DiarizationRequest {
  /** pyannoteAI fetches this URL itself, so it must be accessible to the provider. */
  audioUrl: string;
}

export interface DiarizationProvider {
  readonly id: string;
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
