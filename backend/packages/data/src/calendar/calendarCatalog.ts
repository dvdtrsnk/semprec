import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** The calendar module's catalogs (`calendar/i18n`), loaded once per process; a failed load is not cached. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/**
 * A lookup of the calendar module catalog (`calendar/i18n`) in the language of the tenant's user, Czech while
 * the tenant has no user and English for a locale the catalogs do not have. The tenant's user is read once, by
 * this call, whatever the number of entries looked up. A key missing from both catalogs resolves to the key
 * itself (`resolveCatalogLabel`). An entry is a template when it has `{placeholders}`; the caller fills them
 * through a replacer function so that user content is never read as a replacement pattern.
 */
export async function readCalendarCatalog(client: PoolClient): Promise<(key: string) => string> {
  const catalogs = await getCatalogs();
  const locale = toManifestLocale((await getTenantUserLocale(client)) ?? "cs");
  return (key) => resolveCatalogLabel(null, catalogs[locale], catalogs.en, key);
}
