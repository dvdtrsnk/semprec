/**
 * Dedupe key of the Semp status problem of a permanently failed transcript. `semp_problems.dedupe_key` is scoped to the
 * tenant, not the category, so the key carries its own prefix. Shared because `semprec-transcribe` raises and resolves
 * the problem and `semprec-api`'s item delete hook resolves it when a transcript is trashed.
 */
export function transcriptionProblemKey(transcriptId: string): string {
  return `transcription:${transcriptId}`;
}
