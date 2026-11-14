import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";

/** Why a relation may not point at an item: it is in the Trash, or it is an archived project. */
export type RelationTargetBlock = "targetDeleted" | "targetArchived";

/**
 * The state of a relation target that relation validation refuses (issue #1426), evaluated in one place for the edge
 * validation (`assertRelationTargetLinkableWithClient`) and for the proposal options route. A trashed item is
 * `targetDeleted`; a project whose `status` is `archived` is `targetArchived`; a `done` project and an item of
 * another database with the same `status` are linkable. `targetOwnerModuleId` is the `databases.owner_module_id` of
 * the item's database, read by the caller only when `status` is `archived`, which is the only case that needs it.
 * `null` means the item may be linked.
 */
export function relationTargetBlock(
  target: Pick<ItemRow, "deletedAt" | "properties">,
  targetOwnerModuleId: string | null,
): RelationTargetBlock | null {
  if (target.deletedAt) return "targetDeleted";
  if (target.properties.status === "archived" && targetOwnerModuleId === PROJECTS_MODULE_ID) return "targetArchived";
  return null;
}
