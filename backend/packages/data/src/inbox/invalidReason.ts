import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { InvalidReason } from "./inboxTickAction.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** The Inbox module's catalogs, loaded once per process; a failed load is not cached, so the next render retries. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/**
 * The sentence that tells a person why a Processing proposal is `invalid` (issue #1482), in the
 * catalog of `locale` with English as the fallback. The entry is keyed by the reason's code, and
 * `{label}` is filled with the reason's stored label. The label is user content, so it is inserted
 * through a replacer function: a `$` in it is never read as a replacement pattern.
 */
export async function renderInvalidReason(reason: InvalidReason, locale: string): Promise<string> {
  const catalogs = await getCatalogs();
  const template = resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    `invalidReason.${reason.code}`,
  );
  return template.replaceAll("{label}", () => reason.label);
}
