import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { heartbeatRuleSchema, type HeartbeatRule } from "../scheduler/rule.js";
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
  /** Resolved select/multi_select option labels (issue #147) — absent for every other property type. */
  options?: ManifestPropertyOption[];
}

export interface ManifestDatabase {
  databaseId: string;
  name: string;
  schemaLocked: boolean;
  /**
   * Whether an agent run against this project may create/update items here at all
   * (issue #105's grant separation) — `false` for Inbox and Inbox item types, which the
   * Semprec project also owns but which are user-managed content the agent only ever
   * reads (via `semprec.tick`'s own code path, not this manifest) to compute a proposal.
   * The agent's one write surface is Processing proposals; a target database/page is
   * never included in any project's grant at all — see `generatePermissionManifest`'s
   * `owner_project_item_id` scoping, which already excludes the ten hardcoded databases
   * (they carry no project owner) — so this only needs to additionally narrow Semprec's
   * own three owned databases down to the one the agent may actually write.
   */
  writable: boolean;
  properties: ManifestProperty[];
}

export interface ManifestHeartbeat {
  id: string;
  name: string;
  actionId: string;
  rule: HeartbeatRule;
}

/**
 * Explicit, whole-project autonomy grants — checked at call time by the relevant choke point
 * (currently only `email.send`, mail/send.ts), never by the agent itself. `autonomous: false`
 * is the default for every project unless a human has directly set `emailSendAutonomous: true`
 * on that project item's raw properties (issue #95) via direct DB access — deliberately *not* a
 * property declared in Projects' schema (seed/seedTenDatabases.ts), so this stays specific to
 * the one project (Email) that actually uses it instead of adding an unused field to every
 * other project's row; and deliberately with no declared writer anywhere in this codebase, so
 * granting it can never become reachable through the generic (agent-reachable) item-update
 * path no matter what a future property declaration might otherwise allow.
 */
export interface ManifestCapabilities {
  email: { send: { autonomous: boolean } };
}

export interface PermissionManifest {
  projectItemId: string;
  databases: ManifestDatabase[];
  heartbeats: ManifestHeartbeat[];
  capabilities: ManifestCapabilities;
  /** A project run's granted MCP tools (issue #126) — the manifest's fourth source, alongside databases/heartbeats/capabilities. */
  agentTools: McpAgentToolProjection[];
}

export interface GeneratePermissionManifestOptions {
  /**
   * Supplies the `cs`/`en` catalogs a database/property/option resolves its display label
   * against (issue #147). Omitted for callers with no natural per-user locale (e.g. the
   * drift-check heartbeat, which validates resolvability rather than rendering to a person) —
   * in that case every name/label falls back to the pre-#147 raw-key placeholder below,
   * exactly as before this option existed.
   */
  moduleRegistry?: ModuleRegistry;
  /** Ignored unless `moduleRegistry` is also given. Defaults to `"en"`, the reference locale. */
  locale?: ManifestLocale;
}

/**
 * Computed synchronously from current schema state, scoped to one project (small,
 * indexed queries — not a scan of the whole system). Never persistently cached: this
 * is called fresh at the start of every agent_run.
 */
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
    const manifestProperties: ManifestProperty[] = properties.map((p) => resolveProperty(p, db.key, catalogs, locale));

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
  const heartbeats = heartbeatRows.map((h) => ({
    id: h.id,
    name: h.name,
    actionId: h.action_id,
    rule: heartbeatRuleSchema.parse(h.rule),
  }));

  const { rows: projectRows } = await client.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM items WHERE id = $1`,
    [projectItemId],
  );
  const projectProperties = projectRows[0]?.properties ?? {};
  const capabilities: ManifestCapabilities = {
    email: { send: { autonomous: projectProperties.emailSendAutonomous === true } },
  };

  const agentTools = await getGrantedMcpAgentTools(client, projectItemId);

  return { projectItemId, databases, heartbeats, capabilities, agentTools };
}
