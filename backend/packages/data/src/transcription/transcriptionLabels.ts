import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;
function loadCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * A text of the pipeline's own catalog (`transcription/i18n/{cs,en}.json`) in the language of `locale`
 * (`resolveCatalogLabel`: that locale, then English, then the raw key). Each `{name}` in the text is
 * replaced by `values[name]`; a placeholder without a value is left as written. A catalog that fails to
 * load rejects this call and is loaded again by the next one.
 */
export async function renderTranscriptionLabel(
  locale: string,
  key: string,
  values: Readonly<Record<string, string | number>> = {},
): Promise<string> {
  const catalogs = await loadCatalogs();
  const template = resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
  return template.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
