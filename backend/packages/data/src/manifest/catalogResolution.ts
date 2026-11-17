import { resolveCatalogLabel, type ModuleCatalogs, type ModuleRegistry } from "@semprec/module-registry";
import { NumberFilterConfigSchema } from "@semprec/shared";
import type { PropertyRow, PropertyType, RelationDefinitionRow } from "../types.js";

export type ManifestLocale = "cs" | "en";

/** Narrows an untrusted stored locale; shared so every projection narrows identically. */
export function toManifestLocale(locale: string): ManifestLocale {
  return locale === "cs" ? "cs" : "en";
}

export interface ResolvedOption {
  key: string;
  label: string;
  color?: string;
}

/** Typed projection, not a dump of the stored config. Select options live in `ResolvedProperty.options`. */
export interface ResolvedPropertyConfig {
  default?: unknown;
  /** relation only; present together with `cardinality` when the relation definition is readable. */
  targetDatabaseId?: string;
  cardinality?: RelationDefinitionRow["cardinality"];
  /** date only; `false` when the stored config has no value. */
  includeTime?: boolean;
  /** number only: valid stored presets, labels localized; absent when none is valid. */
  filterPresets?: ResolvedFilterPreset[];
  /** number only. */
  emptyPreset?: { label: string; matchZero: boolean };
}

export interface ResolvedFilterPreset {
  value: number;
  op: "lte" | "gte";
  label: string;
}

export interface ResolvedProperty {
  id: string;
  type: PropertyType;
  filterable: boolean;
  key: string;
  name: string;
  owner: PropertyRow["owner"];
  locked: boolean;
  /** select/multi_select only. */
  options?: ResolvedOption[];
  config: ResolvedPropertyConfig;
}

export interface CatalogResolver {
  getCatalogsForDbKey(dbKey: string | null): Promise<ModuleCatalogs | undefined>;
  getCatalogsForModuleId(moduleId: string): Promise<ModuleCatalogs | undefined>;
}

/** Module that owns the generic `collection.custom.searchPlaceholder` entry. */
const SYSTEM_DATABASES_MODULE_ID = "systemDatabases";

/**
 * Shared so the permission manifest and `/api/schema` resolve labels identically.
 * `owner_module_id` stores the database key (e.g. "tasks"), not the module id that owns the
 * catalog (e.g. "systemDatabases"), so this maps key -> module once and caches catalogs.
 */
export async function createCatalogResolver(moduleRegistry: ModuleRegistry | undefined): Promise<CatalogResolver> {
  if (!moduleRegistry) {
    return {
      getCatalogsForDbKey: () => Promise.resolve(undefined),
      getCatalogsForModuleId: () => Promise.resolve(undefined),
    };
  }

  const allDbs = await moduleRegistry.getDatabases();
  const dbKeyToModuleId = new Map(allDbs.map((d) => [d.key, d.moduleId]));
  const catalogsByModuleId = new Map<string, ModuleCatalogs | undefined>();

  const getCatalogsForModuleId = async (moduleId: string): Promise<ModuleCatalogs | undefined> => {
    if (!catalogsByModuleId.has(moduleId)) {
      catalogsByModuleId.set(moduleId, await moduleRegistry.getCatalogs(moduleId));
    }
    return catalogsByModuleId.get(moduleId);
  };

  return {
    async getCatalogsForDbKey(dbKey) {
      if (!dbKey) return undefined;
      const moduleId = dbKeyToModuleId.get(dbKey);
      if (!moduleId) return undefined;
      return getCatalogsForModuleId(moduleId);
    },
    getCatalogsForModuleId,
  };
}

function rawKeyFallback(override: string | null, key: string | null, id: string): string {
  return override ?? key ?? id;
}

/**
 * Read-side DB boundary: a directly written option without a string `key` is dropped rather than
 * resolved into a lookup key like `...option.undefined`.
 */
function filterValidOptions(rawOptions: unknown[]): { key: string; label?: string; color?: unknown }[] {
  return rawOptions.filter((o): o is { key: string; label?: string; color?: unknown } => {
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

/** Falls back to English, then `null` (never the raw key). A `null` `dbKey` reads the generic entry. */
export function resolveDatabaseSearchPlaceholder(
  dbKey: string | null,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): string | null {
  if (!catalogs) return null;
  const catalogKey = dbKey === null ? "collection.custom.searchPlaceholder" : `database.${dbKey}.searchPlaceholder`;
  return catalogs[locale][catalogKey] ?? catalogs.en[catalogKey] ?? null;
}

/** A keyless system database has no entry and resolves to `null`. */
export async function resolveDatabasePlaceholderForRow(
  catalogResolver: CatalogResolver,
  database: { key: string | null; system: boolean },
  locale: ManifestLocale,
): Promise<string | null> {
  if (database.key === null && database.system) return null;
  const catalogs =
    database.key === null
      ? await catalogResolver.getCatalogsForModuleId(SYSTEM_DATABASES_MODULE_ID)
      : await catalogResolver.getCatalogsForDbKey(database.key);
  return resolveDatabaseSearchPlaceholder(database.key, catalogs, locale);
}

const ALWAYS_FILTERABLE_TYPES: readonly PropertyType[] = ["select", "multi_select", "relation", "date", "checkbox"];
const DEFAULT_TYPES: readonly PropertyType[] = ["select", "multi_select", "checkbox", "number", "text", "date"];

const filterPresetSchema = NumberFilterConfigSchema.shape.filterPresets.element;
const emptyPresetSchema = NumberFilterConfigSchema.shape.emptyPreset.unwrap();

/** Literal `label`, else `labelKey` resolved, else the `labelKey` text itself. */
function presetLabel(
  preset: { labelKey: string; label?: string },
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): string {
  return catalogs
    ? resolveCatalogLabel(preset.label ?? null, catalogs[locale], catalogs.en, preset.labelKey)
    : (preset.label ?? preset.labelKey);
}

/** Validated per entry at this DB boundary: a malformed preset is dropped, not fatal. */
function resolveNumberFilter(
  config: Record<string, unknown>,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): Pick<ResolvedPropertyConfig, "filterPresets" | "emptyPreset"> {
  const stored: unknown[] = Array.isArray(config.filterPresets) ? config.filterPresets : [];
  const filterPresets = stored.flatMap((entry) => {
    const parsed = filterPresetSchema.safeParse(entry);
    return parsed.success
      ? [{ value: parsed.data.value, op: parsed.data.op, label: presetLabel(parsed.data, catalogs, locale) }]
      : [];
  });
  const empty = emptyPresetSchema.safeParse(config.emptyPreset);
  return {
    ...(filterPresets.length > 0 ? { filterPresets } : {}),
    ...(empty.success
      ? { emptyPreset: { label: presetLabel(empty.data, catalogs, locale), matchZero: empty.data.matchZero } }
      : {}),
  };
}

function resolveConfig(
  p: PropertyRow,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
  relationDefinitions: ReadonlyMap<string, RelationDefinitionRow> | undefined,
): ResolvedPropertyConfig {
  if (p.type === "relation") {
    const definition = relationDefinitions?.get(p.id);
    const targetDatabaseId = p.config.targetDatabaseId;
    if (!definition || typeof targetDatabaseId !== "string") return {};
    return { targetDatabaseId, cardinality: definition.cardinality };
  }
  const config: ResolvedPropertyConfig = {};
  if (p.type === "date") config.includeTime = p.config.includeTime === true;
  if (p.type === "number") Object.assign(config, resolveNumberFilter(p.config, catalogs, locale));
  if (DEFAULT_TYPES.includes(p.type) && Object.hasOwn(p.config, "default")) config.default = p.config.default;
  return config;
}

/** Only the locales whose catalog names the option; empty for runtime-added options. */
export function catalogOptionLabels(
  catalogs: ModuleCatalogs | undefined,
  dbKey: string | null,
  propertyKey: string,
  optionKey: string,
): string[] {
  if (!catalogs) return [];
  const catalogKey = `property.${dbKey}.${propertyKey}.option.${optionKey}`;
  return [catalogs.cs[catalogKey], catalogs.en[catalogKey]].filter((label) => label !== undefined);
}

export function resolveProperty(
  p: PropertyRow,
  dbKey: string | null,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
  relationDefinitions?: ReadonlyMap<string, RelationDefinitionRow>,
): ResolvedProperty {
  const propName = catalogs
    ? resolveCatalogLabel(p.name, catalogs[locale], catalogs.en, `property.${dbKey}.${p.key}.name`)
    : rawKeyFallback(p.name, p.key, p.key);

  const config = resolveConfig(p, catalogs, locale, relationDefinitions);
  const resolved: ResolvedProperty = {
    id: p.id,
    type: p.type,
    // A number is filterable only through valid stored presets.
    filterable: p.type === "number" ? config.filterPresets !== undefined : ALWAYS_FILTERABLE_TYPES.includes(p.type),
    key: p.key,
    name: propName,
    owner: p.owner,
    locked: p.locked,
    config,
  };

  if (p.type === "select" || p.type === "multi_select") {
    const rawOptions = p.config.options;
    if (Array.isArray(rawOptions)) {
      resolved.options = filterValidOptions(rawOptions).map((option) => ({
        key: option.key,
        ...(typeof option.color === "string" && /^#[0-9a-f]{6}$/i.test(option.color) ? { color: option.color } : {}),
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
