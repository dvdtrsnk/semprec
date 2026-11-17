import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";

/** Why a relation may not point at an item: it is in the Trash, or it is an archived project. */
export type RelationTargetBlock = "targetDeleted" | "targetArchived";

/**
 * Shared by edge validation and the proposal options route. A trashed item is `targetDeleted`; a
 * project with `status` `archived` is `targetArchived`; a `done` project, or another database's item
 * with that status, is linkable. `targetOwnerModuleId` is needed only when `status` is `archived`.
 * `null` means linkable.
 */
export function relationTargetBlock(
  target: Pick<ItemRow, "deletedAt" | "properties">,
  targetOwnerModuleId: string | null,
): RelationTargetBlock | null {
  if (target.deletedAt) return "targetDeleted";
  if (target.properties.status === "archived" && targetOwnerModuleId === PROJECTS_MODULE_ID) return "targetArchived";
  return null;
}
