/**
 * Issue #180's declared `items.computed` keys for Transcripts (see seedTenDatabases.ts's own
 * comment on the Transcripts property list: these deliberately live in the computed cache, not
 * as properties). Declaring them here and registering them into a process's `ComputedKeyRegistry`
 * (see seed/seedSystem.ts, mirroring `JOURNAL_INBOX_COMPUTED_KEY`) only reserves the keys against
 * collision with a future property/relation of the same name — the values themselves are written
 * by the transcription pipeline, a later issue's scope.
 */
/** Step 0 stores the created Transcripts item id on the source Files item. */
export const TRANSCRIPTION_CREATE_COMPUTED_KEY = "create";
/** Step 1 stores the normalized-audio blob reference, the source duration (seconds) and its `creation_time` (`null` when it had none usable) on the source Files item. */
export const TRANSCRIPTION_PREPARE_COMPUTED_KEY = "prepare";
/** Step 2 stores the whole recording's speaker turns `[{ speaker, start, end }]` on the source Files item, written once. */
export const TRANSCRIPTION_DIARIZE_COMPUTED_KEY = "diarize";
/** Step 3 stores `{ language, chunks }` on the source Files item: the language detected on chunk 0, and each ASR chunk's raw result keyed by its index, written as each chunk finishes. */
export const TRANSCRIPTION_ASR_COMPUTED_KEY = "asr";
/** Step 4 stores the merged `[{ speaker, text, startsAt, endsAt }]` on the Transcripts item, written once; speaker keys stay the diarization's own. */
export const TRANSCRIPT_SEGMENTS_COMPUTED_KEY = "segments";
/** Step 4 stores the language detected on ASR chunk 0 (`null` when Whisper reported none) on the Transcripts item, alongside `segments`. */
export const TRANSCRIPT_LANGUAGE_COMPUTED_KEY = "language";
/**
 * `{ [instructionKey]: summary }` on the Transcripts item, one free-text summary per instruction,
 * written by step 5 before issue #1695. No longer written; stored values are kept as they are.
 */
export const TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY = "summaryByInstruction";
/**
 * Step 5 (issue #1695) stores the structured meeting notes on the Transcripts item, written once:
 * `{ title, summary, shortSummary, decisions, actionItems: [{ text, ownerSpeaker, due, startsAt }] }`.
 * Speakers appear in the text only as `{SPEAKER_NN}` tokens; readers render names with
 * `renderMeetingNotes` (meetingNotesRendering.ts). An action item's id is its array position, so the
 * array is never rewritten or reordered.
 */
export const TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY = "meetingNotes";
/** Step 7 stores `{ proposedSpeakers }` on the source Files item once its one speaker-suggestion call has been turned into cards: the keys that got a card. */
export const TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY = "suggestSpeakers";
/**
 * Step 6 (issue #1848) stores `{ recommendedEventId, reason }` on the source Files item once its one
 * Event-recommendation call has been turned into a card: the Event the card recommends (`null` for
 * none) and the model's reason (`null` for none).
 */
export const TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY = "eventRecommendation";

/** Recording duration in seconds, copied from the Files prepare checkpoint. */
export const TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY = "durationSeconds";
/** UTC completion time, written on the first successful finalize. */
export const TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY = "finalizedAt";
