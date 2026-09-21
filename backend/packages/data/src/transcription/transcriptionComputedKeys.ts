/**
 * Issue #180's declared `items.computed` keys for Transcripts (see seedTenDatabases.ts's own
 * comment on the Transcripts property list: these deliberately live in the computed cache, not
 * as properties). Declaring them here and registering them into a process's `ComputedKeyRegistry`
 * (see seed/seedSystem.ts, mirroring `JOURNAL_INBOX_COMPUTED_KEY`) only reserves the keys against
 * collision with a future property/relation of the same name — the values themselves are written
 * by the transcription pipeline, a later issue's scope.
 */
export const TRANSCRIPT_SEGMENTS_COMPUTED_KEY = "segments";
export const TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY = "summaryByInstruction";
