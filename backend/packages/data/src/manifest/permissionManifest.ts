import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { CAPABILITY_IDS } from "@semprec/shared";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { parseHeartbeatRule, type AnyHeartbeatRule } from "../scheduler/rule.js";
import { SEMPREC_READ_ONLY_MODULE_IDS } from "../seed/inboxPipelineKeys.js";
import { getGrantedMcpAgentTools, type McpAgentToolProjection } from "../mcp/mcpAgentTools.js";
import { createCatalogResolver, resolveDatabaseName, resolveProperty } from "./catalogResolution.js";
import type { ManifestLocale } from "./catalogResolution.js";

export type { ManifestLocale } from "./catalogResolution.js";

export interface ManifestPropertyOption {
  key: string;
  label: string;
}

export interface ManifestProperty {
  key: string;
  name: string;
  owner: "user" | "system";
  locked: boolean;
  /** select/multi_select only. */
  options?: ManifestPropertyOption[];
}

export interface ManifestDatabase {
  databaseId: string;
  name: string;
  schemaLocked: boolean;
  /**
   * `false` for Inbox and Inbox item types: Semprec owns them but they are user content the agent
   * only reads. Databases without a project owner never appear in a grant at all.
   */
  writable: boolean;
  properties: ManifestProperty[];
}

export interface ManifestHeartbeat {
  id: string;
  name: string;
  actionId: string;
  rule: AnyHeartbeatRule;
}

/**
 * Whole-project autonomy grants, checked by the choke point, never the agent. `email.send` ignores
 * `autonomous`: every agent send needs approval in v1. `emailSendAutonomous` is a raw property
 * set only by direct DB access and deliberately undeclared, so no agent-reachable write path can
 * ever grant it.
 */
export interface ManifestCapabilities {
  email: { send: { autonomous: boolean } };
}

export interface PermissionManifest {
  projectItemId: string;
  databases: ManifestDatabase[];
  heartbeats: ManifestHeartbeat[];
  capabilities: ManifestCapabilities;
  agentTools: McpAgentToolProjection[];
  /**
   * Active core capabilities plus module capabilities admitted by the project's database
   * ownership. The generic adapter intersects this with its closed catalog. Empty without a registry.
   */
  grantedCapabilities: string[];
}

export interface GeneratePermissionManifestOptions {
  /** Without it every name/label falls back to the raw-key placeholder. */
  moduleRegistry?: ModuleRegistry;
  /** Ignored without `moduleRegistry`. Defaults to `"en"`. */
  locale?: ManifestLocale;
}

/** Never cached: computed fresh from current schema at the start of every agent run. */
export async function generatePermissionManifest(
  client: PoolClient,
  projectItemId: string,
  options: GeneratePermissionManifestOptions = {},
): Promise<PermissionManifest> {
  const { moduleRegistry } = options;
  const locale = options.locale ?? "en";
  const catalogResolver = await createCatalogResolver(moduleRegistry);

  const { rows: databaseRows } = await client.query<{
    id: string;
    name: string | null;
    key: string | null;
    schema_locked: boolean;
    owner_module_id: string | null;
  }>(
    `SELECT id, name, key, schema_locked, owner_module_id FROM databases WHERE owner_project_item_id = $1 AND archived_at IS NULL`,
    [projectItemId],
  );

  const databases: ManifestDatabase[] = [];
  for (const db of databaseRows) {
    const properties = await listPropertiesByDatabase(client, db.id);
    const catalogs = await catalogResolver.getCatalogsForDbKey(db.key);

    const dbName = resolveDatabaseName(db.name, db.key, db.id, catalogs, locale);
    const manifestProperties: ManifestProperty[] = properties.map((p) => {
      // id, type, filterable and the typed config belong to /api/schema, not the manifest.
      const { key, name, owner, locked, options, config } = resolveProperty(p, db.key, catalogs, locale);
      return {
        key,
        name,
        owner,
        locked,
        ...(options ? { options } : {}),
        ...(Object.hasOwn(config, "default") ? { config: { default: config.default } } : {}),
      };
    });

    databases.push({
      databaseId: db.id,
      name: dbName,
      schemaLocked: db.schema_locked,
      writable: !(db.owner_module_id && SEMPREC_READ_ONLY_MODULE_IDS.includes(db.owner_module_id)),
      properties: manifestProperties,
    });
  }

  const { rows: heartbeatRows } = await client.query<{ id: string; name: string; action_id: string; rule: unknown }>(
    `SELECT id, name, action_id, rule FROM project_heartbeats WHERE project_item_id = $1`,
    [projectItemId],
  );
  const ruleKinds = new Map(
    ((await moduleRegistry?.getHeartbeatRuleKindDefinitions()) ?? []).map((definition) => [
      definition.kind,
      { schema: definition.schema, nextFireAt: definition.nextFireAt },
    ]),
  );
  const heartbeats = heartbeatRows.map((h) => ({
    id: h.id,
    name: h.name,
    actionId: h.action_id,
    rule: parseHeartbeatRule(h.rule, ruleKinds),
  }));

  const { rows: projectRows } = await client.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM items WHERE id = $1 AND database_id = ANY($2::uuid[])`,
    [projectItemId, await visibleDatabaseIds(client)],
  );
  const projectProperties = projectRows[0]?.properties ?? {};
  const capabilities: ManifestCapabilities = {
    email: { send: { autonomous: projectProperties.emailSendAutonomous === true } },
  };

  const agentTools = await getGrantedMcpAgentTools(client, projectItemId);

  const grantedModuleCapabilities = moduleRegistry
    ? new Set(await moduleRegistry.getCapabilities())
    : new Set<string>();
  const grantedCapabilities: string[] = CAPABILITY_IDS.filter(
    (id) => id !== "core.page.read" && id !== "core.page.write" && grantedModuleCapabilities.has(id),
  );
  if (moduleRegistry) {
    const visible = new Set(await visibleDatabaseIds(client));
    const core = new Set<string>(CAPABILITY_IDS);
    const ownership = new Map<string, boolean>();
    for (const declaration of await moduleRegistry.getModuleCapabilityDeclarations()) {
      const owned =
        declaration.databaseKeys.length > 0 &&
        declaration.databaseKeys.every((key) => {
          const row = databaseRows.find(
            (candidate) => candidate.key === key || (candidate.key === null && candidate.owner_module_id === key),
          );
          return (
            row !== undefined &&
            visible.has(row.id) &&
            !(row.owner_module_id && SEMPREC_READ_ONLY_MODULE_IDS.includes(row.owner_module_id))
          );
        });
      for (const capability of declaration.capabilities) {
        if (!core.has(capability)) ownership.set(capability, (ownership.get(capability) ?? true) && owned);
      }
    }
    for (const [capability, owned] of ownership) if (owned) grantedCapabilities.push(capability);
  }

  return { projectItemId, databases, heartbeats, capabilities, agentTools, grantedCapabilities };
}
