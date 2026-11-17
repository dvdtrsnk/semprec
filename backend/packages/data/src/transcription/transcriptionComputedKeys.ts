/**
 * Declared `items.computed` keys for Transcripts and their source Files items. Registering them only
 * reserves the names against a future property or relation; the pipeline writes the values.
 */
/** Step 0 stores the created Transcripts item id on the source Files item. */
export const TRANSCRIPTION_CREATE_COMPUTED_KEY = "create";
/** On the Files item: normalized-audio blob, duration (seconds) and `creation_time` (`null` when unusable). */
export const TRANSCRIPTION_PREPARE_COMPUTED_KEY = "prepare";
/** On the Files item: speaker turns `[{ speaker, start, end }]`, written once. */
export const TRANSCRIPTION_DIARIZE_COMPUTED_KEY = "diarize";
/** On the Files item: `{ language, chunks }`, the language of chunk 0 and each chunk's raw result, written per chunk. */
export const TRANSCRIPTION_ASR_COMPUTED_KEY = "asr";
/** Written once; speaker keys stay the diarization's own. */
export const TRANSCRIPT_SEGMENTS_COMPUTED_KEY = "segments";
/** `null` when Whisper reported none. */
export const TRANSCRIPT_LANGUAGE_COMPUTED_KEY = "language";
/** Legacy per-instruction summaries; no longer written, stored values are kept. */
export const TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY = "summaryByInstruction";
/**
 * Written once. Speakers appear only as `{SPEAKER_NN}` tokens (rendered by `renderMeetingNotes`). An
 * action item's id is its array position, so the array is never rewritten or reordered.
 */
export const TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY = "meetingNotes";
/**
 * On the Files item: `{ proposedSpeakers, eventId, candidateIds }`, the keys that got a card and the
 * binding the call was asked for. The call is made again when the binding differs.
 */
export const TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY = "suggestSpeakers";
/** On the Files item: `{ recommendedEventId, reason }` once the recommendation became a card. */
export const TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY = "eventRecommendation";

/** Copied from the Files prepare checkpoint. */
export const TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY = "durationSeconds";
/** UTC completion time, written on the first successful finalize. */
export const TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY = "finalizedAt";
