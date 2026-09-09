import type { PoolClient } from "pg";
import { resolveCatalogLabel, type ModuleCatalogs, type ModuleRegistry } from "@semprec/module-registry";
import { listAllDatabases } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import {
  createCatalogResolver,
  resolveDatabaseName,
  resolveProperty,
  type ManifestLocale,
  type ResolvedProperty,
} from "./catalogResolution.js";

export interface SchemaDatabaseProjection {
  databaseId: string;
  /** The stable canonical key (issue #235/#147) — `null` for a user-authored database, which has no catalog entry and never will. */
  key: string | null;
  name: string;
  properties: ResolvedProperty[];
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

export interface SchemaProjection {
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
  const catalogResolver = await createCatalogResolver(moduleRegistry);

  const databaseRows = await listAllDatabases(client);
  const databases: SchemaDatabaseProjection[] = [];
  for (const db of databaseRows) {
    const properties = await listPropertiesByDatabase(client, db.id);
    const catalogs = await catalogResolver.getCatalogsForDbKey(db.key);
    databases.push({
      databaseId: db.id,
      key: db.key,
      name: resolveDatabaseName(db.name, db.key, db.id, catalogs, locale),
      properties: properties.map((p) => resolveProperty(p, db.key, catalogs, locale)),
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
    const catalogs = catalogsByActiveModuleId.get(tool.moduleId) ?? (await moduleRegistry.getCatalogs(tool.moduleId));
    agentTools.push({
      moduleId: tool.moduleId,
      name: tool.name,
      label: catalogs
        ? resolveCatalogLabel(null, catalogs[locale], catalogs.en, `agentTool.${tool.name}.label`)
        : tool.name,
    });
  }

  return { databases, viewTypes, agentTools };
}
