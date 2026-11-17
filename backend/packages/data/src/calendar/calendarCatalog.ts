import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

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
 * Lookup in the language of the tenant's user (Czech without a user, English for an unknown locale). A missing
 * key resolves to itself. Templates are filled by the caller through a replacer function so user content is
 * never read as a replacement pattern.
 */
export async function readCalendarCatalog(client: PoolClient): Promise<(key: string) => string> {
  const catalogs = await getCatalogs();
  const locale = toManifestLocale((await getTenantUserLocale(client)) ?? "cs");
  return (key) => resolveCatalogLabel(null, catalogs[locale], catalogs.en, key);
}
