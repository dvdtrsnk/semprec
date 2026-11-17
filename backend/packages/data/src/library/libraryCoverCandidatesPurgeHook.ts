import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { deleteCoverCandidatesForItem } from "./coverCandidatesStore.js";

/** Runs in the purge's transaction for an item of any database; most items have no candidates. */
export const libraryCoverCandidatesPurgeHook: ItemPurgeHook = async ({ client, item }) => {
  await deleteCoverCandidatesForItem(client, item.id);
};
