// Owns the library module's item purge hook (issue gh-1812): the cover candidates of a permanently deleted item are
// deleted with it, in the purge's transaction.
// Constrained by: docs/adr/2026-11-10-item-purge-domain-hooks.md
import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { deleteCoverCandidatesForItem } from "./coverCandidatesStore.js";

/**
 * The library module's item purge hook, registered by `../domainWriteHooks.ts`. It deletes the purged item's
 * `library_cover_candidates` rows through their store, for an item of any database as `item_automation` is deleted
 * for one; most items have none, so it may match no row.
 */
export const libraryCoverCandidatesPurgeHook: ItemPurgeHook = async ({ client, item }) => {
  await deleteCoverCandidatesForItem(client, item.id);
};
