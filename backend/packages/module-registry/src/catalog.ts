import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type ModuleCatalog = Record<string, string>;

/** A module's two shipped translation catalogs. */
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
    throw new Error(
      `Module at "${modulePath}" has an unreadable i18n catalog "${filePath}": ${(err as Error).message}`,
      {
        cause: err,
      },
    );
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
 * Loads `i18n/cs.json` and `i18n/en.json` beside the manifest at `modulePath`. A missing directory
 * or file yields an empty catalog; only a malformed file (invalid JSON, non-object top level, or a
 * non-string value) fails loading.
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
 * Resolves a system label in the `canonical-keys` fallback order: per-item override, the requested
 * locale's entry, the English entry, then the raw canonical key. Pure and synchronous.
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
