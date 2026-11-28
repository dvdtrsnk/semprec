import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@alldots/module-registry";
import type { ManifestLocale } from "../manifest/catalogResolution.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/**
 * Lookup in `locale`, English for a key it lacks. A missing key resolves to itself. Templates are filled by the
 * caller through a replacer function so user content is never read as a replacement pattern.
 */
export async function readCalendarCatalog(locale: ManifestLocale): Promise<(key: string) => string> {
  const catalogs = await getCatalogs();
  return (key) => resolveCatalogLabel(null, catalogs[locale], catalogs.en, key);
}
