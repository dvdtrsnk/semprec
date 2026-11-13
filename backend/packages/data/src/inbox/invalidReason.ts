import { resolveCatalogLabel } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { getInboxCatalogs } from "./inboxCatalogs.js";
import type { InvalidReason } from "./inboxTickAction.js";

/**
 * The sentence that tells a person why a Processing proposal is `invalid` (issue #1482), in the
 * catalog of `locale` with English as the fallback. The entry is keyed by the reason's code, and
 * `{label}` is filled with the reason's stored label. The label is user content, so it is inserted
 * through a replacer function: a `$` in it is never read as a replacement pattern. The code `unknown` (issue #2027)
 * is the generic sentence for a card that has no stored reason.
 */
export async function renderInvalidReason(
  reason: Pick<InvalidReason, "label"> & { code: InvalidReason["code"] | "unknown" },
  locale: string,
): Promise<string> {
  const catalogs = await getInboxCatalogs();
  const template = resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    `invalidReason.${reason.code}`,
  );
  return template.replaceAll("{label}", () => reason.label);
}
