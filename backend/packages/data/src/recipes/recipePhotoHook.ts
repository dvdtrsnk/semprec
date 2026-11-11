// Validates the `photo` of a Recipes item on each create and update that reaches the choke point, inside the
// write's own transaction, so a rejection rolls the write back.
// Registered through ../domainWriteHooks.ts; see docs/adr/2026-10-09-item-create-domain-hooks.md and
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md.
import { getBlob } from "../blobs/blobsStore.js";
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";

const PHOTO_KEY = "photo";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One answer for each refusal, so a blob of another tenant is indistinguishable from an unknown one. */
function invalidPhoto(): ValidationError {
  return new ValidationError("photo must reference an image blob", { field: PHOTO_KEY });
}

/**
 * Create and update hook of the `recipes` database (issue #1707). When the write sets `photo`, the value must
 * be `null` (no photo) or `{ blobId }` naming a blob that `getBlob` finds in the caller's tenant scope and whose
 * `mime_type` starts with `image/`. A create is judged by its final properties, an update by the keys of its
 * patch, so a write that does not touch `photo` is not checked. Writes to other databases pass through.
 */
export async function recipePhotoWriteHook(context: ItemCreateHookContext | ItemUpdateHookContext): Promise<void> {
  if (context.database.ownerModuleId !== RECIPES_MODULE_ID) return;
  const written = "properties" in context ? context.properties : context.propertiesPatch;
  if (!Object.hasOwn(written, PHOTO_KEY)) return;
  const value = written[PHOTO_KEY];
  // `null` clears the photo.
  if (value === null) return;
  const blobId: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "blobId") : undefined;
  if (typeof blobId !== "string" || !UUID_RE.test(blobId)) throw invalidPhoto();
  const blob = await getBlob(context.client, blobId);
  if (!blob || !blob.mimeType.startsWith("image/")) throw invalidPhoto();
}
