import { resolveCatalogLabel, type ModuleCatalogs, type ModuleRegistry } from "@semprec/module-registry";
import { NumberFilterConfigSchema } from "@semprec/shared";
import type { PropertyRow, PropertyType, RelationDefinitionRow } from "../types.js";

/** The two locales `resolveCatalogLabel` resolves against (issue #236's scope note). */
export type ManifestLocale = "cs" | "en";

/**
 * Narrows an untrusted `users.locale` DB value (plain `string` at the type level, not a `cs|en`
 * union — see `auth/types.ts`) to `ManifestLocale`, the same way every locale-aware projection
 * (issue #147) does before calling `resolveCatalogLabel`. Shared by `schemaHandler.ts` and
 * `driftCheck.ts` so both narrow an arbitrary stored locale identically.
 */
export function toManifestLocale(locale: string): ManifestLocale {
  return locale === "cs" ? "cs" : "en";
}

export interface ResolvedOption {
  key: string;
  label: string;
  color?: string;
}

/**
 * Typed projection of a property's stored config (issue #1360), not a dump of the stored object.
 * Select and multi_select options stay in `ResolvedProperty.options`, never here.
 */
export interface ResolvedPropertyConfig {
  default?: unknown;
  /** relation only; present together with `cardinality` when the relation definition is readable. */
  targetDatabaseId?: string;
  cardinality?: RelationDefinitionRow["cardinality"];
  /** date only; `false` when the stored config has no value. */
  includeTime?: boolean;
  /** number only (issue #1622): the valid stored presets, labels localized; absent when none is valid. */
  filterPresets?: ResolvedFilterPreset[];
  /** number only (issue #1622): the valid stored empty preset, label localized. */
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
  /** Whether a filter can be built on this property (issue #1360). */
  filterable: boolean;
  key: string;
  name: string;
  owner: PropertyRow["owner"];
  locked: boolean;
  /** Resolved select/multi_select option labels (issue #147) — absent for every other property type. */
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
 * Runtime guard for a select/multi_select property's `config.options`, which is stored as
 * `unknown` (via `PropertyRow.config: Record<string, unknown>`). Write-side validation
 * (`assertValidSelectOptions` in `propertiesStore.ts`) ensures conformance for options written
 * through the choke point, but this is a read-side DB row boundary — a legacy or directly
 * written row lacking a valid string `key` must be dropped here rather than resolved into a
 * catalog lookup key like `...option.undefined`.
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

/**
 * The search-field placeholder of a collection: the requested locale, then English, then `null`
 * (never the raw key). `dbKey` is the entry's database key, or `null` for a user-created
 * database, which reads the generic `collection.custom.searchPlaceholder` entry of `catalogs`.
 */
export function resolveDatabaseSearchPlaceholder(
  dbKey: string | null,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): string | null {
  if (!catalogs) return null;
  const catalogKey = dbKey === null ? "collection.custom.searchPlaceholder" : `database.${dbKey}.searchPlaceholder`;
  return catalogs[locale][catalogKey] ?? catalogs.en[catalogKey] ?? null;
}

/**
 * `resolveDatabaseSearchPlaceholder` for a database row: a keyed database reads its owning
 * module's catalog, a user-created one (no key, not a system database) the system databases
 * module's generic entry. A keyless system database has no entry and resolves to `null`.
 */
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

/**
 * A preset's display label (issue #1622): its literal `label`, else `labelKey` resolved against the owning module's
 * catalog for `locale` like an option label, else the `labelKey` text itself.
 */
function presetLabel(
  preset: { labelKey: string; label?: string },
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): string {
  return catalogs
    ? resolveCatalogLabel(preset.label ?? null, catalogs[locale], catalogs.en, preset.labelKey)
    : (preset.label ?? preset.labelKey);
}

/**
 * The number-filter presets of a stored `number` config, validated entry by entry at this DB-row boundary: a stored
 * preset that fails the shape (legacy or written directly) is dropped rather than failing the whole projection.
 */
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

/**
 * The labels the catalogs give one option of a property (issue #1699): its Czech entry and its English entry, each
 * only when the catalog has one. Empty when no catalogs are given and for an option the catalogs do not name, such
 * as one added at runtime.
 */
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
    // A number is filterable only through presets (issue #1360), and only valid stored presets count (issue #1622).
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
