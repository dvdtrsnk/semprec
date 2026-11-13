/**
 * The dedupe key of the one Semp status problem of a transcript that failed permanently (issue gh-1945).
 * `semp_problems.dedupe_key` is scoped to the tenant, not to the category, so the key carries its own prefix.
 * Two processes use it: `semprec-transcribe` raises and resolves the problem, and the item delete hook that
 * `semprec-api` runs when a transcript is trashed resolves it, so the key lives here.
 */
export function transcriptionProblemKey(transcriptId: string): string {
  return `transcription:${transcriptId}`;
}
