import type { ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { deriveTaskTime } from "./deriveTaskTime.js";

/**
 * The Tasks pre-write transform, registered by `../domainWriteHooks.ts` under `TASKS_MODULE_ID`: Tasks'
 * `time` is derived from `timeFrom`/`timeTo`. A create always stores it, computed from the incoming pair.
 * An update stores it only when the patch names `timeFrom` or `timeTo`, computed from the patch merged over
 * the locked stored row. See docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md.
 */
export const tasksItemPreWriteTransform: ItemPreWriteTransform = async ({ stored, patch }) => {
  if (stored !== null && !Object.hasOwn(patch, "timeFrom") && !Object.hasOwn(patch, "timeTo")) return patch;
  const timeFrom = Object.hasOwn(patch, "timeFrom") ? patch.timeFrom : stored?.properties.timeFrom;
  const timeTo = Object.hasOwn(patch, "timeTo") ? patch.timeTo : stored?.properties.timeTo;
  return {
    ...patch,
    time: deriveTaskTime(typeof timeFrom === "string" ? timeFrom : null, typeof timeTo === "string" ? timeTo : null),
  };
};
