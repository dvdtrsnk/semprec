import type { ModuleManifest } from "@semprec/module-registry";
import { CAPABILITY_IDS } from "@semprec/shared";
import type { Pool } from "pg";
import { createHeartbeatTriggerTool } from "../scheduler/heartbeatAgentTools.js";
import type { HeartbeatRuleKindRegistry } from "../scheduler/rule.js";

export function createGuardedHeartbeatTriggerTool(pool: Pool, ruleKinds: HeartbeatRuleKindRegistry) {
  return createHeartbeatTriggerTool(pool, ruleKinds, { refuseWhileActive: true });
}

export {
  createHeartbeatListTool,
  createHeartbeatHistoryTool,
  createHeartbeatTriggerTool,
  heartbeatListArgsSchema,
  heartbeatHistoryArgsSchema,
  heartbeatTriggerArgsSchema,
} from "../scheduler/heartbeatAgentTools.js";
export {
  createRegisterPushSubscriptionRouteHandler,
  createRevokePushSubscriptionRouteHandler,
} from "../push/pushRouteHandlers.js";
export { createAiUsageRouteHandler, createAiUsageSummaryRouteHandler } from "../aiGateway/aiUsageRouteHandler.js";
export { createSystemHealthRouteHandler } from "../observability/systemHealthRouteHandler.js";
export { createSempStatusRouteHandler, createSempStatusSummaryRouteHandler } from "../semp/sempStatusRouteHandler.js";
export {
  createGetNotificationPreferencesRouteHandler,
  createPatchNotificationPreferencesRouteHandler,
} from "../notifications/notificationPreferencesRoutes.js";
export { createTriggerHeartbeatRouteHandler } from "../scheduler/triggerHeartbeatRoute.js";
export { createSetHeartbeatEnabledRouteHandler } from "../scheduler/setHeartbeatEnabledRoute.js";

/**
 * Retrofit manifest (module-contract issue #226) for the schema/data core: the choke point
 * (this directory) plus the system tables it writes through (`0001_core_schema.sql` — users,
 * databases, properties, relation_definitions, items, item_relations, project_heartbeats,
 * agent_runs, rollup_dependencies, notifications, idempotency_keys). This is
 * the generic engine every other module builds on, not a business database of its own — it
 * declares no `databases` entries. Authoring this manifest changes no behavior: the choke point
 * continues to be called directly everywhere it already is, this only makes its existence
 * loadable and structurally checkable through `ModuleRegistry`.
 *
 * `heartbeat.list`/`heartbeat.history` (issue #135) are its first two agent tools: read-only
 * introspection over `project_heartbeats`/`agent_runs`. They derive their scope from the persisted run
 * (its own project, or the whole tenant for a run of a Semp chat thread minus the projects the
 * sensitive-grant exclusion leaves out, issue #2018), so neither declares a `capability` gate
 * (see `heartbeatAgentTools.ts`). `heartbeat.trigger` (issue #136) joins them on the same terms —
 * availability only, no `capability` gate and no approval requirement beyond that — but stays
 * limited to the calling run's own project.
 *
 * `capabilities` registers the generic-operation capability ids from
 * `CAPABILITY_IDS` (issue #220) — the same `OPERATION_METADATA.requiresCapability` values
 * generic operations are keyed against. The permission manifest excludes page capabilities
 * from automatic project-agent grants; human MCP registration retains the full list.
 * A project's granted subset is what `packages/application`'s `genericOperationGateway.ts` filters AgentTool/MCP
 * discovery and invocation by.
 */
export const manifest: ModuleManifest = {
  id: "schemaCore",
  version: "1.0.0",
  name: "Schema Core",
  removable: false,
  systemProject: true,
  databases: [],
  capabilities: [...CAPABILITY_IDS],
  agentTools: [
    {
      name: "heartbeat.list",
      handlerExport: "createHeartbeatListTool",
      argumentSchemaExport: "heartbeatListArgsSchema",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "heartbeat.history",
      handlerExport: "createHeartbeatHistoryTool",
      argumentSchemaExport: "heartbeatHistoryArgsSchema",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "heartbeat.trigger",
      handlerExport: "createGuardedHeartbeatTriggerTool",
      argumentSchemaExport: "heartbeatTriggerArgsSchema",
      approval: "none",
      riskClass: "write",
    },
  ],
  migrations: ["0001_core_schema.sql"],
  customRoutes: [
    {
      name: "sempStatus",
      method: "GET",
      path: "/api/semp-status",
      handlerExport: "createSempStatusRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "sempStatusSummary",
      method: "GET",
      path: "/api/semp-status/summary",
      handlerExport: "createSempStatusSummaryRouteHandler",
      // Serves the profile's problem count and the chat banner from the same report read.
      justification: "single-consumer-read",
    },
    {
      name: "setHeartbeatEnabled",
      method: "PATCH",
      path: "/api/heartbeats/:id",
      handlerExport: "createSetHeartbeatEnabledRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "registerPushSubscription",
      method: "POST",
      path: "/api/push-subscriptions",
      handlerExport: "createRegisterPushSubscriptionRouteHandler",
      // Binds the new row to the caller's own session in one transaction with its upsert —
      // issue #239's "cross-database write in one transaction" justification.
      justification: "transactional-semantics",
    },
    {
      name: "revokePushSubscription",
      method: "POST",
      path: "/api/push-subscriptions/:id/revoke",
      handlerExport: "createRevokePushSubscriptionRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "aiUsageReport",
      method: "GET",
      path: "/api/ai-usage",
      handlerExport: "createAiUsageRouteHandler",
      // An aggregate report over ai_gateway_calls/agent_runs/system settings, outside the item
      // model entirely — issue #239's "aggregate read outside the item model" justification.
      justification: "transactional-semantics",
    },
    {
      name: "aiUsageSummary",
      method: "GET",
      path: "/api/ai-usage/summary",
      handlerExport: "createAiUsageSummaryRouteHandler",
      // One read shaped for the caller's own spend against its own caps (issue gh-1456): the budget
      // row, the system timezone and the gateway's spend. The request carries no input.
      // The "single-consumer-read" justification.
      justification: "single-consumer-read",
    },
    {
      name: "systemHealthReport",
      method: "GET",
      path: "/api/system-health",
      handlerExport: "createSystemHealthRouteHandler",
      // A live snapshot of the caller's own tenant across process_heartbeats/
      // tenant_observability_checks/graphile_worker/item_automation/agent_runs/
      // mail_account_sync_state, shaped for exactly one consumer (issue #170's System status
      // block) — the "single-consumer-read" justification. Operator data is not served here
      // (issue #1038, GET /api/admin/health).
      justification: "single-consumer-read",
    },
    {
      name: "getNotificationPreferences",
      method: "GET",
      path: "/api/notification-preferences",
      handlerExport: "createGetNotificationPreferencesRouteHandler",
      // Shaped for exactly one consumer, the settings screen's notification section: the caller's
      // own preferences row, or the defaults, and no other table.
      justification: "single-consumer-read",
    },
    {
      name: "patchNotificationPreferences",
      method: "PATCH",
      path: "/api/notification-preferences",
      handlerExport: "createPatchNotificationPreferencesRouteHandler",
      // The first change inserts the caller's row and the update that sets its fields commits with
      // it in one transaction, a shape the generic item-write endpoint can't express.
      justification: "transactional-semantics",
    },
    {
      name: "triggerHeartbeat",
      method: "POST",
      path: "/api/heartbeats/:id/trigger",
      handlerExport: "createTriggerHeartbeatRouteHandler",
      // The active-run and waiting-job checks and the enqueue commit or roll back together under the
      // heartbeat's row lock (issue #1453): the transactional shape the generic item-write endpoint
      // can't express.
      justification: "transactional-semantics",
    },
  ],
};
