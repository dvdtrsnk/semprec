// A transcript that goes to the Trash takes its Semp status problem with it, resolved as
// `sourceDeleted`, which the resolved history leaves out.
import { transcriptionProblemKey } from "@alldots/shared";
import type { ItemDeleteHook } from "../chokePoint/hooks.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { resolveProblem } from "../semp/sempProblemsStore.js";

/**
 * Runs in the cascade's transaction for each actually-trashed transcript. No restore hook: restoring
 * raises no problem, a failed rerun does.
 */
export const transcriptProblemDeleteHook: ItemDeleteHook = async (context) => {
  if (!context.database.system || context.database.ownerModuleId !== TRANSCRIPTS_MODULE_ID) return;
  await resolveProblem(context.client, {
    dedupeKey: transcriptionProblemKey(context.item.id),
    resolutionKind: "sourceDeleted",
  });
};
