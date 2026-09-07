import type { ModuleManifest } from "@semprec/module-registry";

/**
 * Retrofit manifest (module-contract issue #226) for the schema/data core: the choke point
 * (this directory) plus the system tables it writes through (`0001_core_schema.sql` — users,
 * databases, properties, relation_definitions, items, item_relations, project_heartbeats,
 * agent_runs, resource_grants, rollup_dependencies, notifications, idempotency_keys). This is
 * the generic engine every other module builds on, not a business database of its own — it
 * declares no `databases` entries, no agent tools, and no capabilities. Authoring this
 * manifest changes no behavior: the choke point continues to be called directly everywhere
 * it already is, this only makes its existence loadable and structurally checkable through
 * `ModuleRegistry`.
 */
export const manifest: ModuleManifest = {
  id: "schemaCore",
  version: "1.0.0",
  name: "Schema Core",
  removable: false,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  migrations: ["0001_core_schema.sql"],
};
