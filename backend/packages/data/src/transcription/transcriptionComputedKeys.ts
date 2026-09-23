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
export const TRANSCRIPT_SEGMENTS_COMPUTED_KEY = "segments";
export const TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY = "summaryByInstruction";
