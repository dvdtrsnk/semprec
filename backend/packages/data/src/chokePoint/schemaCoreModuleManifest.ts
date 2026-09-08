import type { ModuleManifest } from "@semprec/module-registry";

export { createHeartbeatListTool, createHeartbeatHistoryTool } from "../scheduler/heartbeatAgentTools.js";

/**
 * Retrofit manifest (module-contract issue #226) for the schema/data core: the choke point
 * (this directory) plus the system tables it writes through (`0001_core_schema.sql` — users,
 * databases, properties, relation_definitions, items, item_relations, project_heartbeats,
 * agent_runs, resource_grants, rollup_dependencies, notifications, idempotency_keys). This is
 * the generic engine every other module builds on, not a business database of its own — it
 * declares no `databases` entries and no capabilities. Authoring this manifest changes no
 * behavior: the choke point continues to be called directly everywhere it already is, this
 * only makes its existence loadable and structurally checkable through `ModuleRegistry`.
 *
 * `heartbeat.list`/`heartbeat.history` (issue #135) are its first two agent tools: read-only
 * introspection over `project_heartbeats`/`agent_runs`, scoped exclusively to the calling
 * run's own project, so neither declares a `capability` gate (see `heartbeatAgentTools.ts`).
 */
export const manifest: ModuleManifest = {
  id: "schemaCore",
  version: "1.0.0",
  name: "Schema Core",
  removable: false,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [
    { name: "heartbeat.list", handlerExport: "createHeartbeatListTool" },
    { name: "heartbeat.history", handlerExport: "createHeartbeatHistoryTool" },
  ],
  migrations: ["0001_core_schema.sql"],
};
