import type { PoolClient } from "pg";
import {
  resolveCatalogLabel,
  type ModuleCatalogs,
  type ModuleDatabaseProjection,
  type ModuleRegistry,
} from "@alldots/module-registry";
import { listAllDatabases } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabases } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionsByPropertyIds } from "../chokePoint/relationsStore.js";
import { getCalendarClock } from "../calendarTime.js";
import { listUnreadableDatabaseIds, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { createCollectionMetadataResolver } from "./collectionMetadata.js";
import type { SortSpec } from "../views/sortSpec.js";
import {
  createCatalogResolver,
  resolveDatabaseName,
  resolveDatabasePlaceholderForRow,
  resolveProperty,
  type ManifestLocale,
  type ResolvedProperty,
} from "./catalogResolution.js";

export interface SchemaDatabaseProjection {
  databaseId: string;
  /** `null` for a user-authored database, which has no catalog entry. */
  key: string | null;
  name: string;
  /** `null` when the catalog has no entry (never the key). */
  searchPlaceholder: string | null;
  icon: string | null;
  color: string | null;
  overviewOrder: number | null;
  switcherOrder: number | null;
  clientVisible: boolean;
  overviewHidden: boolean;
  /** An agent must not read or write this database's data by default. */
  sensitive: boolean;
  properties: ResolvedProperty[];
  /** In display order; empty without declarations. */
  quickFilters: SchemaQuickFilterProjection[];
  /** Always present: the declared sort, otherwise `FALLBACK_DEFAULT_SORT`. */
  defaultSort: SortSpec;
  dateLabels?: { past: string; noDate: string };
  collectionFilter?: Record<string, unknown>;
  pickerFilter?: Record<string, unknown>;
}

/** Newest first. Computed on read; never written into a manifest or view config. */
export const FALLBACK_DEFAULT_SORT: SortSpec = Object.freeze({ system: "createdAt", direction: "desc" });

export interface SchemaSortProjection {
  property: string;
  direction: "asc" | "desc";
}

export interface SchemaQuickFilterProjection {
  key: string;
  label: string;
  /** Absent for the chip that shows every item. */
  filter?: Record<string, unknown>;
  sort?: SchemaSortProjection[];
  isDefault: boolean;
}

export interface SchemaViewTypeProjection {
  key: string;
  name: string;
}

export interface SchemaAgentToolProjection {
  moduleId: string;
  name: string;
  label: string;
}

export interface SchemaTenantProjection {
  timezone: string;
  /** `YYYY-MM-DD` in `timezone`. Stale after midnight; clients use it as a drift check. */
  today: string;
}

export interface SchemaProjection {
  tenant: SchemaTenantProjection;
  databases: SchemaDatabaseProjection[];
  viewTypes: SchemaViewTypeProjection[];
  agentTools: SchemaAgentToolProjection[];
}

export interface GenerateSchemaProjectionOptions {
  /** Defaults to `"en"`. */
  locale?: ManifestLocale;
  /**
   * Defaults to every capability of every active module: this is a system-wide catalog, not a
   * project's runtime MCP grant (that is `PermissionManifest.agentTools`).
   */
  grantedCapabilities?: ReadonlySet<string>;
  /** Clock seam for `tenant.today`. */
  now?: Date;
  /** Leaves out databases the agent's project may not read. Absent for a person. */
  agentProjectItemId?: string;
  /** For an external `/mcp` client: sensitive databases are left out. Ignored with `agentProjectItemId`. */
  externalClient?: true;
}

type DatabaseViewHints = Pick<
  SchemaDatabaseProjection,
  "quickFilters" | "defaultSort" | "dateLabels" | "collectionFilter" | "pickerFilter"
>;

/** Without a descriptor (e.g. user-created): empty quick filters and the fallback sort only. */
function resolveDatabaseViewHints(
  descriptor: ModuleDatabaseProjection | undefined,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): DatabaseViewHints {
  if (descriptor === undefined) return { quickFilters: [], defaultSort: { ...FALLBACK_DEFAULT_SORT } };
  const label = (key: string) => (catalogs ? resolveCatalogLabel(null, catalogs[locale], catalogs.en, key) : key);
  return {
    quickFilters: (descriptor.quickFilters ?? []).map((quickFilter) => ({
      key: quickFilter.key,
      label: label(quickFilter.labelKey),
      ...(quickFilter.filter !== undefined ? { filter: structuredClone(quickFilter.filter) } : {}),
      ...(quickFilter.sort !== undefined ? { sort: quickFilter.sort.map((spec) => ({ ...spec })) } : {}),
      isDefault: quickFilter.isDefault === true,
    })),
    defaultSort: { ...(descriptor.defaultSort ?? FALLBACK_DEFAULT_SORT) },
    ...(descriptor.dateLabels !== undefined
      ? {
          dateLabels: {
            past: label(descriptor.dateLabels.pastLabelKey),
            noDate: label(descriptor.dateLabels.noDateLabelKey),
          },
        }
      : {}),
    ...(descriptor.collectionFilter !== undefined
      ? { collectionFilter: structuredClone(descriptor.collectionFilter) }
      : {}),
    ...(descriptor.pickerFilter !== undefined ? { pickerFilter: structuredClone(descriptor.pickerFilter) } : {}),
  };
}

/**
 * System-wide counterpart to `generatePermissionManifest`, including system databases that carry
 * no project owner. `locale` comes from the authenticated user, never a request override.
 */
export async function generateSchemaProjection(
  client: PoolClient,
  moduleRegistry: ModuleRegistry,
  options: GenerateSchemaProjectionOptions = {},
): Promise<SchemaProjection> {
  const locale = options.locale ?? "en";
  const calendarClock = await getCalendarClock(client);
  const tenant: SchemaTenantProjection = { timezone: calendarClock.zone, today: calendarClock.today(options.now) };
  const catalogResolver = await createCatalogResolver(moduleRegistry);
  const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
  const descriptorsByKey = new Map(
    (await moduleRegistry.getDatabases()).map((descriptor) => [descriptor.key, descriptor]),
  );

  const reader: DatabaseReader | undefined =
    options.agentProjectItemId ?? (options.externalClient === true ? { externalClient: true } : undefined);
  const unreadableDatabaseIds = reader === undefined ? undefined : await listUnreadableDatabaseIds(client, reader);
  const databaseRows = (await listAllDatabases(client)).filter((db) => !unreadableDatabaseIds?.has(db.id));
  // Batched to avoid N+1 queries over databases.
  const propertiesByDatabaseId = await listPropertiesByDatabases(
    client,
    databaseRows.map((db) => db.id),
  );
  // Batched to avoid N+1 queries over relation properties.
  const relationPropertyIds = [...propertiesByDatabaseId.values()]
    .flat()
    .filter((p) => p.type === "relation")
    .map((p) => p.id);
  const relationDefinitions = await getRelationDefinitionsByPropertyIds(client, relationPropertyIds);
  const databases: SchemaDatabaseProjection[] = [];
  for (const db of databaseRows) {
    const properties = propertiesByDatabaseId.get(db.id) ?? [];
    const catalogs = await catalogResolver.getCatalogsForDbKey(db.key);
    databases.push({
      databaseId: db.id,
      key: db.key,
      name: resolveDatabaseName(db.name, db.key, db.id, catalogs, locale),
      searchPlaceholder: await resolveDatabasePlaceholderForRow(catalogResolver, db, locale),
      ...metadataResolver.resolve(db),
      sensitive: db.sensitive,
      properties: properties.map((p) => resolveProperty(p, db.key, catalogs, locale, relationDefinitions)),
      ...resolveDatabaseViewHints(
        db.system && db.key !== null ? descriptorsByKey.get(db.key) : undefined,
        catalogs,
        locale,
      ),
    });
  }

  // `getViewTypes()` has no per-key module id, so find whichever catalog defines the key.
  const activeModuleIds = await moduleRegistry.listActiveModuleIds();
  const catalogsByActiveModuleId = new Map<string, ModuleCatalogs | undefined>();
  for (const moduleId of activeModuleIds) {
    catalogsByActiveModuleId.set(moduleId, await moduleRegistry.getCatalogs(moduleId));
  }

  const viewTypeKeys = await moduleRegistry.getViewTypes();
  const viewTypes: SchemaViewTypeProjection[] = viewTypeKeys.map((key) => {
    const catalogKey = `viewType.${key}.name`;
    for (const catalogs of catalogsByActiveModuleId.values()) {
      if (catalogs && (catalogKey in catalogs.en || catalogKey in catalogs.cs)) {
        return { key, name: resolveCatalogLabel(null, catalogs[locale], catalogs.en, catalogKey) };
      }
    }
    return { key, name: key };
  });

  const grantedCapabilities = options.grantedCapabilities ?? new Set(await moduleRegistry.getCapabilities());
  const agentToolProjections = await moduleRegistry.getAgentTools(grantedCapabilities);
  const agentTools: SchemaAgentToolProjection[] = [];
  for (const tool of agentToolProjections) {
    // `getAgentTools` returns only active modules' tools, so this lookup always hits.
    const catalogs = catalogsByActiveModuleId.get(tool.moduleId);
    agentTools.push({
      moduleId: tool.moduleId,
      name: tool.name,
      label: catalogs
        ? resolveCatalogLabel(null, catalogs[locale], catalogs.en, `agentTool.${tool.name}.label`)
        : tool.name,
    });
  }

  return { tenant, databases, viewTypes, agentTools };
}
