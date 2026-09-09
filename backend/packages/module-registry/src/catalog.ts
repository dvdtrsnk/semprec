import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type ModuleCatalog = Record<string, string>;

/** A module's two shipped translation catalogs (issue #236) — no third locale, see the issue's scope note. */
export interface ModuleCatalogs {
  cs: ModuleCatalog;
  en: ModuleCatalog;
}

type Locale = "cs" | "en";

const catalogSchema = z.record(z.string().min(1), z.string());

function toFilePath(modulePath: string): string {
  return modulePath.startsWith("file://") ? fileURLToPath(modulePath) : modulePath;
}

async function loadOneCatalog(i18nDir: string, locale: Locale, modulePath: string): Promise<ModuleCatalog> {
  const filePath = path.join(i18nDir, `${locale}.json`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Module at "${modulePath}" has an unreadable i18n catalog "${filePath}": ${(err as Error).message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Module at "${modulePath}" has a malformed i18n catalog "${filePath}": ${(err as Error).message}`, {
      cause: err,
    });
  }

  const result = catalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Module at "${modulePath}" has an invalid i18n catalog "${filePath}": ${result.error.message}`);
  }
  return result.data;
}

/**
 * Loads `i18n/cs.json` and `i18n/en.json` from beside the module manifest at `modulePath`
 * (issue #236). A module with no `i18n/` directory, or missing just one of the two locale
 * files, loads with an empty catalog for whatever isn't present — only a present-but-malformed
 * file (invalid JSON, a non-object top level, or any non-string value) fails loading.
 */
export async function loadModuleCatalogs(modulePath: string): Promise<ModuleCatalogs> {
  const i18nDir = path.join(path.dirname(toFilePath(modulePath)), "i18n");
  const [cs, en] = await Promise.all([
    loadOneCatalog(i18nDir, "cs", modulePath),
    loadOneCatalog(i18nDir, "en", modulePath),
  ]);
  return { cs, en };
}

/**
 * Resolves a system label's display string in the exact fallback order the `canonical-keys`
 * skill documents: an explicit per-item override, the requested locale's catalog entry, the
 * English reference catalog's entry, and finally the raw canonical key itself as a last-resort
 * placeholder. Pure and synchronous — every argument is already-loaded data, never an I/O call,
 * so it composes with any catalog source (a `ModuleRegistry`, a test fixture, ...).
 */
export function resolveCatalogLabel(
  override: string | null | undefined,
  requestedLocaleCatalog: ModuleCatalog | undefined,
  englishCatalog: ModuleCatalog,
  key: string,
): string {
  if (override !== null && override !== undefined) return override;
  const localeValue = requestedLocaleCatalog?.[key];
  if (localeValue !== undefined) return localeValue;
  const englishValue = englishCatalog[key];
  if (englishValue !== undefined) return englishValue;
  return key;
}
