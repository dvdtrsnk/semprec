// Runs inside the write's transaction, so a rejection rolls the write back.
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
 * A written `photo` must be `null` or `{ blobId }` of an `image/*` blob visible in the caller's tenant. A create is
 * judged by its final properties, an update by its patch keys.
 */
export async function recipePhotoWriteHook(context: ItemCreateHookContext | ItemUpdateHookContext): Promise<void> {
  if (context.database.ownerModuleId !== RECIPES_MODULE_ID) return;
  const written = "properties" in context ? context.properties : context.propertiesPatch;
  if (!Object.hasOwn(written, PHOTO_KEY)) return;
  const value = written[PHOTO_KEY];
  if (value === null) return;
  const blobId: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "blobId") : undefined;
  if (typeof blobId !== "string" || !UUID_RE.test(blobId)) throw invalidPhoto();
  const blob = await getBlob(context.client, blobId);
  if (!blob || !blob.mimeType.startsWith("image/")) throw invalidPhoto();
}
