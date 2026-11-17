// Runs inside the write's transaction, so a rejection rolls the write back.
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import { RECIPES_MODULE_ID, RECIPE_SOURCE_URL_KEY } from "../seed/recipesModuleKeys.js";

/**
 * A written `sourceUrl` must be `null` or pass the stored-URL baseline (https, no userinfo or port, a DNS host that
 * is not `localhost` or an IP literal). A create is judged by its final properties, an update by its patch keys.
 * This is only the write-time baseline; names resolving to internal addresses are refused at request time
 * (`net/outboundAddressPolicy.ts`).
 */
export async function recipeSourceUrlWriteHook(context: ItemCreateHookContext | ItemUpdateHookContext): Promise<void> {
  if (context.database.ownerModuleId !== RECIPES_MODULE_ID) return;
  const written = "properties" in context ? context.properties : context.propertiesPatch;
  if (!Object.hasOwn(written, RECIPE_SOURCE_URL_KEY)) return;
  const value = written[RECIPE_SOURCE_URL_KEY];
  if (value === null) return;
  if (typeof value !== "string" || !isBaselineOutboundUrl(value)) {
    throw new ValidationError("sourceUrl must be an https URL on a public host name", { field: RECIPE_SOURCE_URL_KEY });
  }
}
