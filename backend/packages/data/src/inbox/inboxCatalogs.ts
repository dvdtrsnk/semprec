import { loadModuleCatalogs, type ModuleCatalogs } from "@semprec/module-registry";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** The Inbox module's catalogs, loaded once per process; a failed load is not cached, so the next read retries. */
export function getInboxCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}
