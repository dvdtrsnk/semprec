import type { PoolClient } from "pg";
import {
  resolveCatalogLabel,
  type ModuleCatalogs,
  type ModuleDatabaseProjection,
  type ModuleRegistry,
} from "@semprec/module-registry";
import { listAllDatabases } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabases } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionsByPropertyIds } from "../chokePoint/relationsStore.js";
import { getCalendarClock } from "../calendarTime.js";
import { createCollectionMetadataResolver } from "./collectionMetadata.js";
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
  /** The stable canonical key (issue #235/#147) — `null` for a user-authored database, which has no catalog entry and never will. */
  key: string | null;
  name: string;
  /** The whole-sentence search placeholder; `null` when the catalog has no entry (never the key). */
  searchPlaceholder: string | null;
  icon: string | null;
  color: string | null;
  overviewOrder: number | null;
  switcherOrder: number | null;
  clientVisible: boolean;
  properties: ResolvedProperty[];
  /** The collection's quick-filter chips in display order, labels resolved for the locale; empty without declarations (issue #1647). */
  quickFilters: SchemaQuickFilterProjection[];
  /** The declared default order (issue #1647); absent when the manifest declares none. */
  defaultSort?: SchemaSortProjection;
  /** The resolved past and no-date labels of a date-grouped collection (issue #1647). */
  dateLabels?: { past: string; noDate: string };
  /** The filter tree of the items that belong in the collection (issue #1647). */
  collectionFilter?: Record<string, unknown>;
  /** The filter tree a picker for this database applies by default (issue #1647). */
  pickerFilter?: Record<string, unknown>;
}

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
  /** The tenant's IANA time zone (the System settings `timezone`). */
  timezone: string;
  /** The current calendar day in `timezone`, `YYYY-MM-DD`. Stale after midnight; clients use it as a drift check. */
  today: string;
}

export interface SchemaProjection {
  tenant: SchemaTenantProjection;
  databases: SchemaDatabaseProjection[];
  viewTypes: SchemaViewTypeProjection[];
  agentTools: SchemaAgentToolProjection[];
}

export interface GenerateSchemaProjectionOptions {
  /** Defaults to `"en"`, the reference locale — same default as `generatePermissionManifest`. */
  locale?: ManifestLocale;
  /**
   * Which module-declared agent tools (issue #106's `ModuleRegistry.getAgentTools`) are visible
   * in this projection. Defaults to every capability every active module declares — this is a
   * system-wide schema catalog, not one project's runtime MCP grant (`PermissionManifest.agentTools`,
   * sourced from `getGrantedMcpAgentTools`, is the separate, per-project mechanism for that); a
   * caller with a narrower notion of "granted" may pass its own set instead.
   */
  grantedCapabilities?: ReadonlySet<string>;
  /** The instant `tenant.today` is computed for; defaults to the current time. A test seam for the clock. */
  now?: Date;
}

type DatabaseViewHints = Pick<
  SchemaDatabaseProjection,
  "quickFilters" | "defaultSort" | "dateLabels" | "collectionFilter" | "pickerFilter"
>;

/**
 * A database's view hints from its manifest descriptor (issue #1647), with every `labelKey` resolved
 * against the owning module's catalog for `locale`. A database without a descriptor, every user-created
 * database among them, gets empty quick filters and nothing else.
 */
function resolveDatabaseViewHints(
  descriptor: ModuleDatabaseProjection | undefined,
  catalogs: ModuleCatalogs | undefined,
  locale: ManifestLocale,
): DatabaseViewHints {
  if (descriptor === undefined) return { quickFilters: [] };
  const label = (key: string) => (catalogs ? resolveCatalogLabel(null, catalogs[locale], catalogs.en, key) : key);
  return {
    quickFilters: (descriptor.quickFilters ?? []).map((quickFilter) => ({
      key: quickFilter.key,
      label: label(quickFilter.labelKey),
      ...(quickFilter.filter !== undefined ? { filter: structuredClone(quickFilter.filter) } : {}),
      ...(quickFilter.sort !== undefined ? { sort: quickFilter.sort.map((spec) => ({ ...spec })) } : {}),
      isDefault: quickFilter.isDefault === true,
    })),
    ...(descriptor.defaultSort !== undefined ? { defaultSort: { ...descriptor.defaultSort } } : {}),
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
 * The system-wide counterpart to `generatePermissionManifest` (issue #147): every non-archived
 * database (including the ten hardcoded system databases, which carry no `owner_project_item_id`
 * and so never appear in a project-scoped manifest), every active module's view types, and every
 * module-declared agent tool — each with its name/label resolved through the same
 * `catalogResolution.ts` resolver the manifest uses, against the caller-supplied locale only
 * (never a query/body override — see `services/semprec-api/src/schemaHandler.ts`, the one caller
 * that turns an authenticated request's `users.locale` into this function's `locale` option).
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

  const databaseRows = await listAllDatabases(client);
  // One batch query for every database's properties (issue #147 review: the naive per-database
  // loop was an N+1 that grows unboundedly with the number of databases in a deployment).
  const propertiesByDatabaseId = await listPropertiesByDatabases(
    client,
    databaseRows.map((db) => db.id),
  );
  // One batch query for the relation definitions of every relation property (issue #1360), so the
  // query count does not grow with the number of relation properties.
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
      properties: properties.map((p) => resolveProperty(p, db.key, catalogs, locale, relationDefinitions)),
      ...resolveDatabaseViewHints(
        db.system && db.key !== null ? descriptorsByKey.get(db.key) : undefined,
        catalogs,
        locale,
      ),
    });
  }

  // `getViewTypes()` returns a flat key list with no per-key moduleId (several modules each
  // declare their own view types — see systemDatabases/inbox/library/mail's manifests): find
  // whichever active module's catalog actually defines `viewType.<key>.name` rather than
  // assuming one owning module.
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
    // `getAgentTools` only ever returns tools from active modules (the same set
    // `catalogsByActiveModuleId` was built from above), so this lookup always hits.
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
