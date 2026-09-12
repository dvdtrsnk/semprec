export { createPool, withTransaction, withClient, requireAffectedRows, type Queryable } from "./db/pool.js";
export { runMigrations } from "./db/migrate.js";
export * from "./errors.js";
export * from "./types.js";

export { createChokePoint, createItemWithClient, type ChokePoint, type Actor } from "./chokePoint/chokePoint.js";
export type { CreateItemInput } from "./chokePoint/chokePoint.js";
export type { CreateDatabaseInput } from "./chokePoint/databasesStore.js";
export { getDatabaseByModuleId } from "./chokePoint/databasesStore.js";
export type { CreatePropertyInput } from "./chokePoint/propertiesStore.js";
export type { ListItemsOptions } from "./chokePoint/itemsStore.js";
export { getItemsByIds } from "./chokePoint/itemsStore.js";
export type { CreateViewInput, PatchViewInput } from "./chokePoint/viewsStore.js";
export * from "./chokePoint/viewTypeRegistry.js";
export { manifest as schemaCoreModuleManifest } from "./chokePoint/schemaCoreModuleManifest.js";

export * from "./views/filterTree.js";
export { compileFilterNode } from "./views/filterCompiler.js";
export * from "./views/sortSpec.js";
export { compileSort } from "./views/sortCompiler.js";
export * from "./views/viewConfig.js";
export * from "./views/mailboxClientViewType.js";
export type { FilterProperty, FilterProperties } from "./views/filterCompiler.js";
export { buildFilterProperties } from "./views/filterProperties.js";
export type { QueryViewOptions, QueryViewResult } from "./views/viewQuery.js";
export { manifest as viewsModuleManifest } from "./views/viewsModuleManifest.js";

export * from "./scheduler/rule.js";
export { computeNextFireAt } from "./scheduler/nextFireAt.js";
export * from "./scheduler/schedulerStore.js";
export * from "./scheduler/actions.js";
export * from "./scheduler/heartbeatAgentTools.js";
export { handleHeartbeatSweepTask, createHeartbeatFireTask } from "./scheduler/sweep.js";

export * from "./rollup/config.js";
export * from "./rollup/dependencies.js";
export {
  enqueueRollupRecompute,
  enqueueRollupBackfill,
  recomputeRollupCell,
  backfillRollup,
  handleRollupRecomputeTask,
  handleRollupRecomputeFullTask,
} from "./rollup/recompute.js";
export { assertRelationDeletable, assertSourceRetypeAllowed } from "./rollup/mirror.js";

export {
  isConversionSupported,
  enqueuePropertyTypeMigration,
  runPropertyTypeMigrationJob,
  handlePropertyTypeMigrationTask,
} from "./migrationJob/propertyTypeMigration.js";
export { runModuleDataMigration, runModuleDataMigrations } from "./migrationJob/moduleDataMigration.js";

export * from "./manifest/permissionManifest.js";
export * from "./manifest/driftCheck.js";
export * from "./manifest/moduleRegistryDriftCheck.js";
export * from "./manifest/knownActionIds.js";
export {
  createCatalogResolver,
  resolveDatabaseName,
  resolveProperty,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
  type ResolvedOption,
  type ResolvedProperty,
} from "./manifest/catalogResolution.js";
export * from "./manifest/schemaProjection.js";
export * from "./manifest/fullModuleRegistry.js";
export * from "./notifications/findings.js";
export * from "./notifications/notificationKinds.js";
export * from "./notifications/notify.js";
export * from "./notifications/notificationsStore.js";
export * from "./notifications/notificationFanoutJob.js";

export * from "./agentRuns/agentRunsStore.js";
export * from "./agentRuns/agentRunEventsStore.js";
export * from "./aiGateway/aiGatewayCallsStore.js";
export * from "./aiGateway/aiUsageReport.js";
export { seedSystem } from "./seed/seedSystem.js";
export * from "./seed/tenDatabaseKeys.js";
export { seedTenDatabasesInTransaction, type TenDatabases } from "./seed/seedTenDatabases.js";
export { manifest as systemDatabasesModuleManifest } from "./seed/systemDatabasesModuleManifest.js";
export * from "./systemSettings.js";
export { createCoreTaskList, CORE_CRONTAB } from "./worker.js";
export { mergeModuleTaskList, CORE_TASK_NAME_SET } from "./moduleTasks.js";
export {
  deriveDesiredWorkerInstances,
  createModuleWorkerInstanceReconciler,
  workerInstanceId,
  type DesiredWorkerInstance,
  type WorkerInstanceIdentity,
  type WorkerActiveRowIdsSource,
  type WorkerSupervisorPort,
  type ModuleWorkerInstanceReconciler,
} from "./moduleWorkers.js";
export { manifest as libraryModuleManifest } from "./library/libraryModuleManifest.js";
export {
  createMailLiveSyncRoot,
  createNoopMailLiveSyncLifecycleFactory,
  type MailAccountLifecycle,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
  type MailLiveSyncRoot,
  type MailLiveSyncRootOptions,
} from "./mail/mailLiveSyncRoot.js";
export { manifest as mailModuleManifest } from "./mail/mailModuleManifest.js";
export * from "./realtimeHook.js";

export { createDocStore, type DocStore, type DocVersion } from "./docs/docStore.js";
export type { BlockInput, BlockData } from "./docs/blocks.js";
export {
  CANVAS_ELEMENT_TYPES,
  type CanvasElementType,
  type CanvasElementInput,
  type CanvasElementData,
} from "./docs/canvas.js";
export {
  loadDoc as loadYDoc,
  mutateDoc as mutateYDoc,
  DEFAULT_COMPACTION_THRESHOLD,
  runCompactionSweep,
  handleDocCompactionSweepTask,
} from "./docs/docPersistence.js";
export {
  cleanupExpiredDocHistory,
  rebaselineDocHistory,
  runDocHistoryRetentionSweep,
  handleDocHistoryCleanupTask,
  openDocVersionAt,
} from "./docs/docHistory.js";
export {
  DEFAULT_DOC_HISTORY_RETENTION_DAYS,
  resolveDocHistoryRetentionDays,
  retentionHours,
} from "./docs/docHistoryConfig.js";
export { runDocHistoryCutoverMigration } from "./docs/docHistoryCutoverMigration.js";
export { manifest as docsModuleManifest } from "./docs/docsModuleManifest.js";

export * from "./blobs/blobsStore.js";

export * from "./tasks/taskRecurrenceRule.js";
export { computeNextDueDate } from "./tasks/nextDueDate.js";
export * from "./tasks/taskRecurrenceStore.js";
export { advanceTaskRecurrence, type AdvanceTaskRecurrenceInput } from "./tasks/advanceTaskRecurrence.js";

export * from "./journal/journalStore.js";
export * from "./views/temporalSwitcherViewType.js";

export * from "./inbox/inboxTickAction.js";
export { manifest as inboxPipelineModuleManifest } from "./inbox/inboxModuleManifest.js";

export * from "./auth/types.js";
export * from "./auth/passwordHash.js";
export * from "./auth/token.js";
export * from "./auth/usersStore.js";
export * from "./auth/sessionsStore.js";
export * from "./auth/loginAttemptsStore.js";
export * from "./auth/emailNormalization.js";
export * from "./auth/loginLockout.js";
export * from "./auth/authActions.js";
export * from "./auth/nativeBridge.js";
export * from "./auth/passwordResetStore.js";
export * from "./auth/passwordResetMail.js";
export * from "./auth/passwordResetActions.js";

export * from "./push/types.js";
export * from "./push/pushSubscriptionsStore.js";
export * from "./push/pushSubscriptionActions.js";

// `mcpGrantsAdminStore.ts`'s user-only grant/risk-class/approval mutations are deliberately
// NOT exported here — see that file's header comment (issue #124).
export type { McpToolRegistration, UpsertMcpToolRegistrationInput } from "./mcp/mcpToolRegistrationsStore.js";
export {
  upsertMcpToolRegistration,
  getMcpToolRegistration,
  listMcpToolRegistrationsForServer,
} from "./mcp/mcpToolRegistrationsStore.js";
export type { ProjectMcpGrant } from "./mcp/mcpProjectGrantsStore.js";
export { listProjectMcpGrants, getProjectMcpGrant } from "./mcp/mcpProjectGrantsStore.js";
export type { McpConnectionConfig } from "./mcp/mcpConnectionConfig.js";
export { assertValidMcpConnectionConfig } from "./mcp/mcpConnectionConfig.js";
export {
  McpConnectionError,
  MCP_CONNECTION_ERROR_REASONS,
  type McpConnectionErrorReason,
} from "./mcp/mcpConnectionError.js";
export type { McpClientHandle, ConnectMcpServerOptions } from "./mcp/mcpConnectionFactory.js";
export { connectMcpServer } from "./mcp/mcpConnectionFactory.js";
export type { SyncMcpServerToolsOptions, SyncMcpServerToolsResult } from "./mcp/mcpSync.js";
export { syncMcpServerTools } from "./mcp/mcpSync.js";
export type { McpAgentToolProjection } from "./mcp/mcpAgentTools.js";
export { getGrantedMcpAgentTools } from "./mcp/mcpAgentTools.js";
export type { McpToolInvocationTarget } from "./mcp/mcpToolInvocation.js";
export { resolveGrantedMcpTool } from "./mcp/mcpToolInvocation.js";
export type { McpToolGrantForProject, ReclassifyMcpToolInput } from "./mcp/mcpAgentPageGrants.js";
export {
  listMcpToolGrantsForProject,
  setProjectMcpGrantForAgentPage,
  reclassifyMcpTool,
} from "./mcp/mcpAgentPageGrants.js";
export type {
  ApprovalRequest,
  ApprovalRequestPayload,
  ApprovalRequestStatus,
  ApprovalRequestDecision,
  CreatePendingApprovalRequestInput,
} from "./mcp/approvalRequestsStore.js";
export {
  createPendingApprovalRequest,
  getApprovalRequest,
  listPendingApprovalRequests,
} from "./mcp/approvalRequestsStore.js";
export type { ApprovalRequestQueueEntry, ApprovalRequestSafeSummary } from "./mcp/approvalRequestsQueue.js";
export { listApprovalRequestsQueue } from "./mcp/approvalRequestsQueue.js";
export type { McpInvokeResult, McpInvokeArgs, McpInvokeOptions } from "./mcp/mcpToolExecution.js";
export { executeMcpInvocation } from "./mcp/mcpToolExecution.js";
// `approvalRequestsStore.ts`'s `decideApprovalRequest` is deliberately NOT exported here — see
// that file's header comment (issue #131), same convention as `mcpGrantsAdminStore.ts`. Only
// this wrapper (which also enqueues the reserved execution job in the same transaction) is
// reachable from a route handler.
export type { DecideApprovalRequestInput } from "./mcp/approvalDecisionAction.js";
export { decideAndEnqueueApprovalRequest } from "./mcp/approvalDecisionAction.js";

export {
  projectAgentGuidanceStore,
  guidanceReferenceStore,
  createPoolClientTransactionRunner,
} from "./projectAgentGuidanceStore.js";

export {
  guidanceDriftHeartbeatStore,
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
} from "./guidanceDrift/guidanceDriftHeartbeatStore.js";
export { agentGuidanceDriftFindingsStore } from "./guidanceDrift/agentGuidanceDriftFindingsStore.js";
export { createGuidanceManifestPort } from "./guidanceDrift/guidanceManifestPort.js";

export { purgeExpiredTrash, handleItemTrashPurgeSweepTask } from "./trash/purgeExpiredTrash.js";
