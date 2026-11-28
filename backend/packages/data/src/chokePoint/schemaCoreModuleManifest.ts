import type { ModuleManifest } from "@alldots/module-registry";
import { CAPABILITY_IDS } from "@alldots/shared";
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
  createHeartbeatCreateTool,
  createHeartbeatUpdateTool,
  createHeartbeatSetEnabledTool,
  createHeartbeatCreateSnapshot,
  createHeartbeatUpdateSnapshot,
  createHeartbeatSetEnabledSnapshot,
  heartbeatCreateArgsSchema,
  heartbeatUpdateArgsSchema,
  heartbeatSetEnabledArgsSchema,
} from "../scheduler/heartbeatWriteAgentTools.js";
export {
  createRegisterPushSubscriptionRouteHandler,
  createRevokePushSubscriptionRouteHandler,
} from "../push/pushRouteHandlers.js";
export { createAiUsageRouteHandler, createAiUsageSummaryRouteHandler } from "../aiGateway/aiUsageRouteHandler.js";
export { createSystemHealthRouteHandler } from "../observability/systemHealthRouteHandler.js";
export { createOverviewRouteHandler } from "../overview/overviewRouteHandler.js";
export { createSempStatusRouteHandler, createSempStatusSummaryRouteHandler } from "../semp/sempStatusRouteHandler.js";
export {
  createGetNotificationPreferencesRouteHandler,
  createPatchNotificationPreferencesRouteHandler,
} from "../notifications/notificationPreferencesRoutes.js";
export { createBadgeCountsRouteHandler } from "../notifications/badgeCountsRoute.js";
export { createTriggerHeartbeatRouteHandler } from "../scheduler/triggerHeartbeatRoute.js";
export { createSetHeartbeatEnabledRouteHandler } from "../scheduler/setHeartbeatEnabledRoute.js";
export { createProjectHeartbeatsRouteHandler } from "../scheduler/projectHeartbeatsRoute.js";
export {
  createListAgentDatabaseGrantsRouteHandler,
  createPatchAgentDatabaseGrantRouteHandler,
} from "../agentGrants/agentDatabaseGrantsRouteHandlers.js";
export {
  createTrashDatabasesRouteHandler,
  createTrashItemsRouteHandler,
  createTrashRestoreRouteHandler,
} from "../trash/trashRouteHandlers.js";
export { createListAgentRunsRouteHandler } from "../agentRuns/agentRunsListRouteHandler.js";
export { createProjectAgentSummaryRouteHandler } from "../mcp/projectAgentSummaryRouteHandler.js";

/**
 * Manifest for the schema/data core: the choke point plus the system tables it writes through. The
 * generic engine every module builds on; it declares no `databases`, and this manifest only makes it
 * loadable and checkable through `ModuleRegistry`.
 *
 * The `heartbeat.list`/`heartbeat.history`/`heartbeat.trigger` agent tools derive their scope from the
 * persisted run (`heartbeatAgentTools.ts`), so they declare no `capability` gate; `trigger` stays
 * limited to the run's own project. `heartbeat.create`/`update`/`setEnabled` are `requiresApproval`:
 * the handler runs once after approval, and each `snapshotExport`'s canonical JSON is compared again
 * before it runs (`heartbeatWriteAgentTools.ts`).
 *
 * `capabilities` registers `CAPABILITY_IDS`, the values generic operations' `requiresCapability` is
 * keyed against. Page capabilities are excluded from automatic project-agent grants; human MCP
 * registration keeps the full list.
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
    {
      name: "heartbeat.create",
      handlerExport: "createHeartbeatCreateTool",
      argumentSchemaExport: "heartbeatCreateArgsSchema",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      snapshotExport: "createHeartbeatCreateSnapshot",
    },
    {
      name: "heartbeat.update",
      handlerExport: "createHeartbeatUpdateTool",
      argumentSchemaExport: "heartbeatUpdateArgsSchema",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      snapshotExport: "createHeartbeatUpdateSnapshot",
    },
    {
      name: "heartbeat.setEnabled",
      handlerExport: "createHeartbeatSetEnabledTool",
      argumentSchemaExport: "heartbeatSetEnabledArgsSchema",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      snapshotExport: "createHeartbeatSetEnabledSnapshot",
    },
  ],
  // The baseline holds the whole schema of every module that existed before the first release.
  migrations: ["0001_baseline.sql"],
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
      // Binds the new row to the caller's session in one transaction with its upsert.
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
      // An aggregate report over ai_gateway_calls/agent_runs/system settings, outside the item model.
      justification: "transactional-semantics",
    },
    {
      name: "aiUsageSummary",
      method: "GET",
      path: "/api/ai-usage/summary",
      handlerExport: "createAiUsageSummaryRouteHandler",
      // The caller's spend against its own caps: budget row, system timezone and gateway spend. No input.
      justification: "single-consumer-read",
    },
    {
      name: "systemHealthReport",
      method: "GET",
      path: "/api/system-health",
      handlerExport: "createSystemHealthRouteHandler",
      // A live snapshot of the caller's own tenant's process and job health, for the System status block
      // only. Operator data is served by GET /api/admin/health instead.
      justification: "single-consumer-read",
    },
    {
      name: "overviewSummary",
      method: "GET",
      path: "/api/overview",
      handlerExport: "createOverviewRouteHandler",
      // The Overview screen's badges and counts; each number comes from its owner's function.
      justification: "single-consumer-read",
    },
    {
      name: "getNotificationPreferences",
      method: "GET",
      path: "/api/notification-preferences",
      handlerExport: "createGetNotificationPreferencesRouteHandler",
      // The settings screen's notification section: the caller's preferences row, or the defaults.
      justification: "single-consumer-read",
    },
    {
      name: "patchNotificationPreferences",
      method: "PATCH",
      path: "/api/notification-preferences",
      handlerExport: "createPatchNotificationPreferencesRouteHandler",
      // The first change inserts the caller's row and the update commits with it in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "getBadgeCounts",
      method: "GET",
      path: "/api/badge-counts",
      handlerExport: "createBadgeCountsRouteHandler",
      // The app icon badge: three counts of what waits for the caller's decision.
      justification: "single-consumer-read",
    },
    {
      name: "triggerHeartbeat",
      method: "POST",
      path: "/api/heartbeats/:id/trigger",
      handlerExport: "createTriggerHeartbeatRouteHandler",
      // The active-run and waiting-job checks and the enqueue commit together under the heartbeat's row lock.
      justification: "transactional-semantics",
    },
    {
      name: "listAgentDatabaseGrants",
      method: "GET",
      path: "/api/projects/:id/database-grants",
      handlerExport: "createListAgentDatabaseGrantsRouteHandler",
      // The Collections list in a project's Semp settings: sensitive and user-created databases with the
      // project's access.
      justification: "single-consumer-read",
    },
    {
      name: "patchAgentDatabaseGrant",
      method: "PATCH",
      path: "/api/projects/:id/database-grants",
      handlerExport: "createPatchAgentDatabaseGrantRouteHandler",
      // The project and database locks, the removal of a default decision and the upsert of any other
      // commit together.
      justification: "transactional-semantics",
    },
    {
      name: "listTrashItems",
      method: "GET",
      path: "/api/trash/items",
      handlerExport: "createTrashItemsRouteHandler",
      // The "Recently deleted" screen's trashed cascade roots across the tenant with their purge day; the
      // generic query reads one database at a time and knows neither cascade roots nor retention.
      justification: "single-consumer-read",
    },
    {
      name: "listTrashDatabases",
      method: "GET",
      path: "/api/trash/databases",
      handlerExport: "createTrashDatabasesRouteHandler",
      // The "Recently deleted" Databases tab: archived user databases with live item counts, which no
      // generic read lists.
      justification: "single-consumer-read",
    },
    {
      name: "restoreTrash",
      method: "POST",
      path: "/api/trash/restore",
      handlerExport: "createTrashRestoreRouteHandler",
      // Each selected id restores in its own savepoint of one transaction, so a refused id rolls back
      // (announcements dropped) while the rest still restore.
      justification: "transactional-semantics",
    },
    {
      name: "listAgentRuns",
      method: "GET",
      path: "/api/agent-runs",
      handlerExport: "createListAgentRunsRouteHandler",
      // A project's agent page: recent runs the caller started with cost and display status; no generic
      // read lists agent runs.
      justification: "single-consumer-read",
    },
    {
      name: "listProjectHeartbeats",
      method: "GET",
      path: "/api/projects/:id/heartbeats",
      handlerExport: "createProjectHeartbeatsRouteHandler",
      // A project's agent screen: the person's automations with rule label, last outcome and tick thread.
      justification: "single-consumer-read",
    },
    {
      name: "projectAgentSummary",
      method: "GET",
      path: "/api/projects/:id/agent-summary",
      handlerExport: "createProjectAgentSummaryRouteHandler",
      // The project detail's "Semp in this project" row and its attention dot. Counts reuse the owners'
      // functions where they exist.
      justification: "single-consumer-read",
    },
  ],
};
