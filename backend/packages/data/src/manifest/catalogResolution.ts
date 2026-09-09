import { resolveCatalogLabel, type ModuleCatalogs, type ModuleRegistry } from "@semprec/module-registry";
import type { PropertyRow } from "../types.js";

/** The two locales `resolveCatalogLabel` resolves against (issue #236's scope note). */
export type ManifestLocale = "cs" | "en";

export interface ResolvedOption {
  key: string;
  label: string;
}

export interface ResolvedProperty {
  key: string;
  name: string;
  owner: PropertyRow["owner"];
  locked: boolean;
  /** Resolved select/multi_select option labels (issue #147) — absent for every other property type. */
  options?: ResolvedOption[];
}

export interface CatalogResolver {
  getCatalogsForDbKey(dbKey: string | null): Promise<ModuleCatalogs | undefined>;
}

/**
 * Builds the dbKey -> catalogs lookup shared by every locale-aware projection (issue #147),
 * so `generatePermissionManifest` and the `/api/schema` projection resolve labels identically
 * instead of each carrying its own copy of this logic (and its own chance to drift or
 * reintroduce the unchecked-cast bug fixed here once, in `resolveProperty` below).
 *
 * A database's `owner_module_id` column stores the database *key* (e.g. "tasks"), not the
 * `ModuleManifest.id` that actually owns its i18n catalog (e.g. "systemDatabases") — this
 * resolves key -> owning module id once and caches each module's catalogs for reuse.
 */
export async function createCatalogResolver(moduleRegistry: ModuleRegistry | undefined): Promise<CatalogResolver> {
  if (!moduleRegistry) {
    return { getCatalogsForDbKey: () => Promise.resolve(undefined) };
  }

  const allDbs = await moduleRegistry.getDatabases();
  const dbKeyToModuleId = new Map(allDbs.map((d) => [d.key, d.moduleId]));
  const catalogsByModuleId = new Map<string, ModuleCatalogs | undefined>();

  return {
    async getCatalogsForDbKey(dbKey) {
      if (!dbKey) return undefined;
      const moduleId = dbKeyToModuleId.get(dbKey);
      if (!moduleId) return undefined;
      if (!catalogsByModuleId.has(moduleId)) {
        catalogsByModuleId.set(moduleId, await moduleRegistry.getCatalogs(moduleId));
      }
      return catalogsByModuleId.get(moduleId);
    },
  };
}

function rawKeyFallback(override: string | null, key: string | null, id: string): string {
  return override ?? key ?? id;
}

/**
 * Runtime guard for a select/multi_select property's `config.options`, which is stored as
 * `unknown` (via `PropertyRow.config: Record<string, unknown>`). Write-side validation
 * (`assertValidSelectOptions` in `propertiesStore.ts`) ensures conformance for options written
 * through the choke point, but this is a read-side DB row boundary — a legacy or directly
 * written row lacking a valid string `key` must be dropped here rather than resolved into a
 * catalog lookup key like `...option.undefined`.
 */
function filterValidOptions(rawOptions: unknown[]): { key: string; label?: string }[] {
  return rawOptions.filter((o): o is { key: string; label?: string } => {
    if (typeof o !== "object" || o === null) return false;
    const { key, label } = o as Record<string, unknown>;
    if (typeof key !== "string") return false;
    return label === undefined || typeof label === "string";
  });
}

export function resolveDatabaseName(
  dbName: string | null,
  dbKey: string | null,
  dbId: string,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): string {
  return catalogs
    ? resolveCatalogLabel(dbName, catalogs[locale], catalogs.en, `database.${dbKey}.name`)
    : rawKeyFallback(dbName, dbKey, dbId);
}

export function resolveProperty(
  p: PropertyRow,
  dbKey: string | null,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): ResolvedProperty {
  const propName = catalogs
    ? resolveCatalogLabel(p.name, catalogs[locale], catalogs.en, `property.${dbKey}.${p.key}.name`)
    : rawKeyFallback(p.name, p.key, p.key);

  const resolved: ResolvedProperty = { key: p.key, name: propName, owner: p.owner, locked: p.locked };

  if (p.type === "select" || p.type === "multi_select") {
    const rawOptions = p.config.options;
    if (Array.isArray(rawOptions)) {
      resolved.options = filterValidOptions(rawOptions).map((option) => ({
        key: option.key,
        label: catalogs
          ? resolveCatalogLabel(
              option.label ?? null,
              catalogs[locale],
              catalogs.en,
              `property.${dbKey}.${p.key}.option.${option.key}`,
            )
          : rawKeyFallback(option.label ?? null, option.key, option.key),
      }));
    }
  }

  return resolved;
}
