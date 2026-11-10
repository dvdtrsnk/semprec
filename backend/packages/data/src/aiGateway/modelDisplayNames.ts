import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";

/** Ordered family patterns; the first match wins. Matching is case-sensitive and provider-independent. */
const MODEL_FAMILIES: readonly { pattern: RegExp; key: string }[] = [
  { pattern: /^claude-sonnet/, key: "model.claudeSonnet" },
  { pattern: /^claude-haiku/, key: "model.claudeHaiku" },
  { pattern: /(^|\/)whisper/, key: "model.whisper" },
  { pattern: /^pyannote/, key: "model.diarization" },
];

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Lazily loaded once per process and reused — `aiGateway/i18n/{cs,en}.json` never changes at runtime. */
export function getModelDisplayCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url);
  return catalogsPromise;
}

/**
 * Localized display name of a stored model id, derived from its family. An id that matches no
 * family is returned unchanged.
 */
export function resolveModelDisplayName(catalogs: ModuleCatalogs, locale: string, modelId: string): string {
  const family = MODEL_FAMILIES.find(({ pattern }) => pattern.test(modelId));
  if (family === undefined) return modelId;
  const manifestLocale = toManifestLocale(locale);
  return resolveCatalogLabel(null, catalogs[manifestLocale], catalogs.en, family.key);
}

/**
 * Localized label of a stored operation key: requested locale, then English, then the raw key, so
 * an operation without a catalog entry is never hidden.
 */
export function resolveOperationLabel(catalogs: ModuleCatalogs, locale: string, operation: string): string {
  const manifestLocale = toManifestLocale(locale);
  const label = resolveCatalogLabel(null, catalogs[manifestLocale], catalogs.en, `operation.${operation}`);
  return label === `operation.${operation}` ? operation : label;
}
