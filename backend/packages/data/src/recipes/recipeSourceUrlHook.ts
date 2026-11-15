// Validates the `sourceUrl` of a Recipes item on each create and update that reaches the choke point, inside the
// write's own transaction, so a rejection rolls the write back.
// Registered through ../domainWriteHooks.ts; see docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
// and docs/adr/2026-10-09-item-create-domain-hooks.md. Constrained by
// docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md.
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import { RECIPES_MODULE_ID, RECIPE_SOURCE_URL_KEY } from "../seed/recipesModuleKeys.js";

/**
 * Create and update hook of the `recipes` database (issue gh-1974). When the write sets `sourceUrl`, the value must be
 * `null` (no source) or a string that passes the stored-URL baseline `isBaselineOutboundUrl`: an `https:` URL with no
 * userinfo and no port on a DNS host name that is neither `localhost` nor an IP literal. Any other value is a
 * `ValidationError` (HTTP 400) on the field `sourceUrl`. A create is judged by its final properties, an update by the
 * keys of its patch, so a write that does not touch `sourceUrl` is not checked. Writes to other databases pass through.
 * The check is the write-time baseline only; a name that resolves to an internal address is refused when the URL is
 * requested (`net/outboundAddressPolicy.ts`).
 */
export async function recipeSourceUrlWriteHook(context: ItemCreateHookContext | ItemUpdateHookContext): Promise<void> {
  if (context.database.ownerModuleId !== RECIPES_MODULE_ID) return;
  const written = "properties" in context ? context.properties : context.propertiesPatch;
  if (!Object.hasOwn(written, RECIPE_SOURCE_URL_KEY)) return;
  const value = written[RECIPE_SOURCE_URL_KEY];
  // `null` clears the source.
  if (value === null) return;
  if (typeof value !== "string" || !isBaselineOutboundUrl(value)) {
    throw new ValidationError("sourceUrl must be an https URL on a public host name", { field: RECIPE_SOURCE_URL_KEY });
  }
}
