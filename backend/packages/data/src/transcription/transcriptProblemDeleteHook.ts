// Issue gh-1945: a transcript that goes to the Trash takes its Semp status problem with it. The problem is
// resolved as `sourceDeleted`, which `resolvedRecent` of `GET /api/semp-status` leaves out, so a deleted
// transcript is neither an active problem nor an entry of the resolved history.
// Registered in `../domainWriteHooks.ts`. Constrained by:
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md
import { transcriptionProblemKey } from "@semprec/shared";
import type { ItemDeleteHook } from "../chokePoint/hooks.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { resolveProblem } from "../semp/sempProblemsStore.js";

/**
 * For each Transcripts row the trash cascade actually trashed (issue #1601's hook): resolves its active
 * `transcription` problem as `sourceDeleted`, in the cascade's transaction. A transcript without an active
 * problem changes nothing, and an item of another database is left alone. No restore hook exists: restoring
 * the transcript raises no problem, a failed rerun does.
 */
export const transcriptProblemDeleteHook: ItemDeleteHook = async (context) => {
  if (!context.database.system || context.database.ownerModuleId !== TRANSCRIPTS_MODULE_ID) return;
  await resolveProblem(context.client, {
    dedupeKey: transcriptionProblemKey(context.item.id),
    resolutionKind: "sourceDeleted",
  });
};
