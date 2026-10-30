import type { ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";

/** Rejects explicitly pinning a finished project, and unpins it when its status is written as terminal. */
export const projectWriteTransform: ItemPreWriteTransform = async ({ stored, patch }) => {
  const status = Object.hasOwn(patch, "status") ? patch.status : stored?.properties.status;
  if (status !== "done" && status !== "archived") return patch;
  if (patch.pinned === true) {
    throw new ValidationError("A finished or archived project cannot be pinned", { field: "pinned" });
  }
  if (!Object.hasOwn(patch, "status")) return patch;
  const pinned = stored?.properties.pinned === true;
  return pinned ? { ...patch, pinned: false } : patch;
};
