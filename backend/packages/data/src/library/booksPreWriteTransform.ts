import type { ItemPreWriteTransform, ItemPreWriteTransformContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";

/** Checks a supplied publication year; omitted fields and null clearing remain valid. */
export const booksPreWriteTransform = (async ({ patch }: Pick<ItemPreWriteTransformContext, "patch">) => {
  if (Object.hasOwn(patch, "year") && patch.year !== null) {
    if (typeof patch.year !== "number" || !Number.isFinite(patch.year)) {
      throw new ValidationError("Property 'year' must be a finite number", { field: "year" });
    }
  }
  return patch;
}) satisfies ItemPreWriteTransform;
