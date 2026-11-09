export { enqueueMailSearchTextReindex } from "./mail/mailSearchTextReindexJob.js";
import "./domainWriteHooks.js";

export {
  createPool,
  withTransaction,
  withClient,
  requireAffectedRows,
  requireManagedTransaction,
  markManagedTransactionRollbackOnly,
  type Queryable,
} from "./db/pool.js";
export { readItemPatchChangeMetadata } from "./chokePoint/itemPatchChangeMetadata.js";
export { assertRuntimeRole, RuntimeRoleAssertionError } from "./db/runtimeRoleAssertion.js";
export { assertNotDerivedValueWrite } from "./chokePoint/derivedValueGuard.js";
export { runMigrations } from "./db/migrate.js";
export * from "./errors.js";
export * from "./types.js";
export { normalizeWallClockTime } from "./timezone.js";
export { buildItemSearchQuery } from "./search/itemSearchQuery.js";
export { indexItem } from "./search/itemSearchIndexer.js";
export { enqueueItemSearchBackfill, type ItemSearchBackfillOptions } from "./search/itemSearchBackfill.js";
export { enqueueTenantSearchReindex } from "./search/itemSearchFanout.js";
export { enqueueMailGmailPseudoFolderCleanup } from "./mail/gmailPseudoFolderCleanupJob.js";
export { enqueueMailMessagePreviewBackfill } from "./mail/mailMessagePreviewBackfillJob.js";
export { enqueueMailThreadBackfill } from "./mail/mailThreadBackfillJob.js";

export { createChokePoint, type ChokePoint } from "./chokePoint/chokePoint.js";
export type { Actor } from "./chokePoint/authorization.js";
export { createValueLinkOps } from "./chokePoint/valueLinkOps.js";
export { VALUE_LINKS_OWNER_PROCESS } from "./chokePoint/valueLinkWrites.js";
export { insertValueLink, type InsertValueLinkInput } from "./chokePoint/valueLinksStore.js";
export type { ItemValueLinks, ValueLinkEntry, ValueLinkSource } from "./chokePoint/valueLinkReads.js";
export { DERIVED_VALUE_SOURCES } from "./derived/derivedValueSources.js";
export { getDerivedValuesForItems } from "./derived/derivedValueReads.js";
export {
  createItemWithClient,
  updateItemWithClient,
  writeComputedAndAnnounce,
  type CreateItemInput,
  type UpdateItemInput,
  type UpdateItemWithClientOptions,
} from "./chokePoint/itemWrites.js";
export { createItemWithRelationsWithClient, type InitialItemRelation } from "./chokePoint/itemCreateWithRelations.js";
export {
  deleteRelationWithClient,
  createRelationWithClient,
  setRelationWithClient,
  type SetRelationInput,
  type CreateRelationInput,
  type UpdateRelationInput,
  type DeleteRelationInput,
  type RelationEdge,
} from "./chokePoint/relationOps.js";
export {
  computeDestructiveResourceProjection,
  type ResourceSnapshot,
  type ResourceSnapshotKind,
  type DestructiveResourceProjection,
  type DestructiveOperationCheck,
} from "./chokePoint/destructiveProjection.js";
export { databaseArchiveWithClient } from "./chokePoint/databaseOps.js";
export { propertyDeleteWithClient } from "./chokePoint/propertyOps.js";
export { viewDeleteWithClient } from "./chokePoint/viewOps.js";
export { itemDeleteWithClient } from "./chokePoint/itemTrash.js";
export { SYSTEM_WRITER, type WriterIdentity, type WriterKind } from "./chokePoint/writerKind.js";
export { requireApprovalForWrite } from "./chokePoint/writeApproval.js";
export { postApprovalOutcomeMessage } from "./mcp/approvalOutcomeMessage.js";
export type { CreateDatabaseInput } from "./chokePoint/databasesStore.js";
export { getDatabaseByModuleId } from "./chokePoint/databasesStore.js";
export type { CreatePropertyInput } from "./chokePoint/propertiesStore.js";
export type { ListItemsOptions } from "./chokePoint/itemsStore.js";
export { findIdempotentReplay, getItemById, getItemsByIds, lockItemById } from "./chokePoint/itemsStore.js";
export { listPropertiesByDatabase } from "./chokePoint/propertiesStore.js";
export { writeComputed } from "./chokePoint/itemsStore.js";
export type { CreateViewInput, PatchViewInput } from "./chokePoint/viewsStore.js";
export * from "./chokePoint/viewTypeRegistry.js";
export { manifest as schemaCoreModuleManifest } from "./chokePoint/schemaCoreModuleManifest.js";
export { createSetHeartbeatEnabledRouteHandler } from "./scheduler/setHeartbeatEnabledRoute.js";
export { createSempStatusRouteHandler, createSempStatusSummaryRouteHandler } from "./semp/sempStatusRouteHandler.js";

export * from "./views/filterTree.js";
export { compileFilterNode } from "./views/filterCompiler.js";
export * from "./views/sortSpec.js";
export { compileSort } from "./views/sortCompiler.js";
export { expandAreaFilter, resolveDatabaseAreaFilters } from "./views/areaFilter.js";
export * from "./views/viewConfig.js";
export * from "./views/mailboxClientViewType.js";
export type { FilterProperty, FilterProperties } from "./views/filterCompiler.js";
export { buildFilterProperties } from "./views/filterProperties.js";
export type { QueryViewOptions, QueryViewResult, DatabaseQueryInput, ViewQueryInput } from "./views/viewQuery.js";
export { manifest as viewsModuleManifest } from "./views/viewsModuleManifest.js";

export * from "./scheduler/rule.js";
export { computeNextFireAt } from "./scheduler/nextFireAt.js";
export * from "./scheduler/schedulerStore.js";
export * from "./scheduler/actions.js";
export * from "./scheduler/heartbeatAgentTools.js";
export {
  handleHeartbeatSweepTask,
  createHeartbeatFireCoreTask,
  createHeartbeatFireAgentTask,
  resolveModuleRuleKinds,
} from "./scheduler/sweep.js";
export { runHeartbeatFireQueueSplitMigration } from "./scheduler/heartbeatFireQueueSplitMigration.js";

export {
  ROLLUP_AGGREGATIONS,
  parseRollupConfig,
  validateRollupConfig,
  assertAggregationCompatibleWithType,
  type RollupAggregation,
  type RollupConfig,
  type ValidatedRollupConfig,
} from "./rollup/config.js";
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
  resolveDatabasePlaceholderForRow,
  resolveDatabaseSearchPlaceholder,
  resolveProperty,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
  type ResolvedOption,
  type ResolvedProperty,
} from "./manifest/catalogResolution.js";
export * from "./manifest/schemaProjection.js";
export {
  compareCollections,
  createCollectionMetadataResolver,
  DEFAULT_DATABASE_COLOR,
  DEFAULT_DATABASE_ICON,
  type CollectionMetadata,
  type CollectionMetadataResolver,
  type OrderableCollection,
} from "./manifest/collectionMetadata.js";
export * from "./manifest/fullModuleRegistry.js";
export * from "./notifications/findings.js";
export * from "./notifications/notificationKinds.js";
export * from "./notifications/notify.js";
export * from "./notifications/notificationsStore.js";
export * from "./notifications/notificationPreferencesStore.js";
export * from "./notifications/notificationFanoutJob.js";
export { approvalNotificationBody } from "./notifications/approvalNotificationBody.js";

export * from "./agentRuns/agentRunsStore.js";
export { AgentRunError, AiBudgetExceededError, agentRunErrorCodeOf } from "./agentRuns/agentRunErrorCodes.js";
export * from "./agentRuns/agentRunEventsStore.js";
export {
  AGENT_RUN_EVENTS_RETENTION_DAYS,
  handleAgentRunEventsRetentionTask,
} from "./agentRuns/agentRunEventsRetention.js";
export * from "./aiGateway/aiGatewayCallsStore.js";
export * from "./aiGateway/aiUsageReport.js";
export * from "./aiGateway/aiUsageSummary.js";
export * from "./aiGateway/modelDisplayNames.js";
export * from "./aiGateway/tenantAiBudgetsStore.js";
export * from "./health/processHeartbeats.js";
export * from "./observability/observabilityChecksStore.js";
export * from "./observability/observabilityCheckSystem.js";
export {
  FAILED_JOB_RETENTION_MS,
  pruneQueueFailedJobs,
  handleQueueFailedJobsPruneTask,
} from "./observability/queueFailedJobsPrune.js";
export * from "./observability/systemHealthReport.js";
export { seedSystem } from "./seed/seedSystem.js";
export * from "./seed/tenDatabaseKeys.js";
export {
  enqueueTranscriptionJob,
  transcriptionJobPayloadSchema,
  transcriptionSourceLink,
  TRANSCRIPTION_OWNER_PROCESS,
  type TranscriptionJobPayload,
} from "./transcription/transcriptionJob.js";
export {
  TRANSCRIPTION_CREATE_COMPUTED_KEY,
  TRANSCRIPTION_PREPARE_COMPUTED_KEY,
  TRANSCRIPTION_DIARIZE_COMPUTED_KEY,
  TRANSCRIPTION_ASR_COMPUTED_KEY,
  TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
  TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPT_LANGUAGE_COMPUTED_KEY,
  TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
} from "./transcription/transcriptionComputedKeys.js";
export {
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
  createFilesTranscriptionTriggerAction,
  createTranscriptionRequeueSweepAction,
  readBlobId,
} from "./transcription/transcriptionActions.js";
export * from "./library/libraryMetadataActions.js";
export * from "./mail/personLinkingActions.js";
export {
  createRerunTranscriptionRouteHandler,
  createTranscriptDeleteRouteHandler,
  createTranscriptListRouteHandler,
} from "./transcription/transcriptionRouteHandlers.js";
export { matchTranscriptToEvent } from "./transcription/transcriptEventMatch.js";
export {
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  type SpeakerMappingSuggestion,
  type SpeakerSuggestionContext,
} from "./transcription/transcriptSpeakerSuggestion.js";
export {
  ensureItemAutomation,
  getItemAutomation,
  lockItemAutomation,
  markItemAutomationDone,
  recordItemAutomationFailure,
  startItemAutomationAttempt,
  type ItemAutomationErrorCode,
} from "./library/itemAutomationStore.js";
export { seedTenDatabasesInTransaction, type TenDatabases } from "./seed/seedTenDatabases.js";
export { manifest as systemDatabasesModuleManifest } from "./seed/systemDatabasesModuleManifest.js";
export * from "./systemSettings.js";
export * from "./calendarTime.js";
export { createCoreTaskList, createApiCoreTaskList, CORE_CRONTAB } from "./worker.js";
export { createAgentTaskList, noopAgentQueueTask, type AgentQueueTaskHandler } from "./agentWorker.js";
export {
  mergeModuleTaskList,
  mergeModuleTaskListForAffinity,
  assertTaskListMatchesAffinity,
  CORE_TASK_NAME_SET,
  AGENT_TASK_NAME_SET,
  RESERVED_TASK_NAMES,
  resolveTaskAffinitySets,
  type TaskAffinitySets,
} from "./moduleTasks.js";
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
export { resolveMailModuleIds, type MailModuleIds } from "./mail/mailModuleIds.js";
// Issues #1739 and #1745: the existing Gmail watch and Graph subscription owners, hosted by semprec-api.
export {
  createGmailPubSubDispatcher,
  createGmailWatchLifecycleFactory,
  type GmailPubSubDispatcher,
  type GmailWatchTransport,
} from "./mail/gmailWatchLifecycle.js";
export { createGmailPubSubTransport } from "./mail/gmailPubSubClient.js";
export { createGraphWebhookLifecycleFactory, type GraphSubscriptionTransport } from "./mail/graphWebhookLifecycle.js";
export { createGraphSubscriptionRestClient } from "./mail/graphSubscriptionClient.js";
export { getProviderAccountAddress } from "./mail/mailAccountSyncStateStore.js";
export {
  deleteMailServerSettings,
  getMailServerSettings,
  upsertMailServerSettings,
  type MailServerEndpoint,
  type MailServerSecurity,
  type MailServerSettings,
  type MailServerSettingsInput,
} from "./mail/mailServerSettingsStore.js";
export {
  createSmtpTransporter,
  openImapConnection,
  openImapFlow,
  type MailServerConnectionOptions,
  type MailServerConnectionSettings,
  type MailServerCredential,
  type MailSmtpTransporter,
} from "./mail/mailServerConnections.js";
export {
  createBoundedImapIdleLifecycleFactory,
  type CreateBoundedImapIdleLifecycleFactoryOptions,
  type ImapIdleConnection,
  type ImapIdleFolderTarget,
  type ImapIdleTransport,
} from "./mail/imapIdleLifecycle.js";
export {
  createImapFlowIdleTransport,
  type CreateIdleTunedImapFlowClient,
  type ImapIdleFlowOptions,
} from "./mail/imapIdleClient.js";
export { imapConnectionLimitForProvider, sharedImapConnectionLimiter } from "./mail/imapConnectionLimiter.js";
export { getDecryptedCredential } from "./credentials/externalCredentialsStore.js";
export {
  MailConnectionLimitError,
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailReauthorizationRequiredError,
  MailRecipientRejectedError,
  MailSendAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "./mail/providerTypes.js";
export {
  verifyMailCredentials,
  type VerifyMailCredentialsInput,
  type VerifiedMailServerSettings,
} from "./mail/mailCredentialVerification.js";
export { isImapConnectionLimitError } from "./mail/imapFlowClient.js";
export type { ImapMailClient } from "./mail/imapReconcile.js";
export {
  createMailTransportFactory,
  type MailTransport,
  type MailTransportFactory,
  type MailTransportMessage,
  type MailTransportResult,
} from "./mail/mailTransport.js";
export {
  getMailDraft,
  insertMailDraft,
  markMailDraftSent,
  updateMailDraft,
  MailDraftThreadConflictError,
  type InsertMailDraftInput,
  type MailDraft,
  type MailDraftActor,
  type MailDraftMode,
  type MailDraftRecipient,
  type UpdateMailDraftInput,
} from "./mail/mailDraftsStore.js";
export { resolveMergedThreadId } from "./mail/mailMessageMetaStore.js";
export { manifest as mailModuleManifest } from "./mail/mailModuleManifest.js";
export { getMailboxRemovalImpact, type MailboxRemovalImpact } from "./mail/mailboxRemovalImpact.js";
export {
  refreshAndPersistAccessToken,
  type RefreshAndPersistAccessTokenInput,
  type RefreshedAccessToken,
} from "./mail/mailOAuthAccess.js";
export { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from "./mail/oauthTokenExchange.js";
export { GmailRestClient } from "./mail/gmailRestClient.js";
export { GraphRestClient } from "./mail/graphRestClient.js";
export type { MailSyncAdapterFactory } from "./mail/mailSyncJob.js";
export type { MailSendAdapterFactory } from "./mail/send.js";
export {
  createImapMailFlagWritebackAdapter,
  createGmailMailFlagWritebackAdapter,
  createGraphMailFlagWritebackAdapter,
  type MailFlagWritebackAdapter,
} from "./mail/mailFlagWriteback.js";
export {
  handleGraphChangeNotification,
  type GraphChangeNotification,
  type GraphNotificationOutcome,
} from "./mail/graphWebhookNotifications.js";
export * from "./realtimeHook.js";

export { createDocStore, type DocStore, type DocVersion } from "./docs/docStore.js";
export type { BlockInput, BlockData } from "./docs/blocks.js";
export { assertValidBlockInput } from "./docs/assertValidBlockInput.js";
export {
  CANVAS_ELEMENT_TYPES,
  type CanvasElementType,
  type CanvasElementInput,
  type CanvasElementData,
} from "./docs/canvas.js";
export {
  loadDoc as loadYDoc,
  mutateDoc as mutateYDoc,
  getDocUpdateById,
  DEFAULT_COMPACTION_THRESHOLD,
  runCompactionSweep,
  handleDocCompactionSweepTask,
} from "./docs/docPersistence.js";
export { getDocById } from "./docs/docsStore.js";
export {
  cleanupExpiredDocHistory,
  rebaselineDocHistory,
  runDocHistoryRetentionSweep,
  handleDocHistoryCleanupTask,
  openDocVersionAt,
} from "./docs/docHistory.js";
export {
  computePageRestoreProjection,
  restorePageVersionWithClient,
  type PageRestoreCheck,
} from "./docs/docPageRestore.js";
export {
  DEFAULT_DOC_HISTORY_RETENTION_DAYS,
  resolveDocHistoryRetentionDays,
  retentionHours,
} from "./docs/docHistoryConfig.js";
export { runDocHistoryCutoverMigration } from "./docs/docHistoryCutoverMigration.js";
export { manifest as docsModuleManifest } from "./docs/docsModuleManifest.js";
export { PAGES_MODULE_ID, ensurePagesDatabase } from "./docs/pagesDatabase.js";
export { docEtag, readPageMarkdown, type PageMarkdownRead } from "./docs/pageMarkdown.js";
export { listPageChanges, type PageChange, type PageChangeKind } from "./docs/pageChanges.js";
export { PAGE_TITLE_MAX_LENGTH, normalizePageTitle } from "./docs/pageTitle.js";

export {
  tenantBlobStorageKey,
  createBlob,
  getBlob,
  lockBlobById,
  getBlobByContentHash,
  findOrCreateBlob,
  deleteBlobIfUnreferenced,
  listStandaloneBlobIdsCreatedBefore,
  deleteDerivedBlob,
  type CreateBlobInput,
} from "./blobs/blobsStore.js";
export type { IngestUploadedFileInput, IngestUploadedFileResult } from "./blobs/fileUploadStore.js";
export { ingestUploadedFile, ingestUploadedFileWithTransaction, ingestUploadedBlob } from "./blobs/fileUploadStore.js";
export {
  attachUploadedFileWithClient,
  resolveUploadAttachTarget,
  type UploadAttachTarget,
} from "./blobs/uploadAttachTarget.js";
export { sweepUnreferencedBlobs, handleBlobsUnreferencedSweepTask } from "./blobs/unreferencedBlobSweep.js";
export { openBlobFromRoots, primaryRootForBlob } from "./blobs/openBlobFromRoots.js";
export type { BlobRootName, OpenBlobFromRootsInput } from "./blobs/openBlobFromRoots.js";
export { loadBlobMetadataForItems } from "./blobs/blobMetadata.js";
export type { BlobMetadata, ItemBlobMetadata } from "./blobs/blobMetadata.js";
export { detectFileType } from "./blobs/fileTypeDetection.js";
export { recomputePersonLastContact } from "./people/lastContact.js";
export type { DetectedFile, DetectedFileType } from "./blobs/fileTypeDetection.js";
export { findFileItemByBlobId } from "./chokePoint/itemsStore.js";
export type { BlobStorageWriter, WriteStreamOptions } from "./mail/blobStorage.js";
export { LocalFsBlobStorageWriter, MaxBytesExceededError, resolveBlobStorageDir } from "./mail/blobStorage.js";
export { extractAttachmentText, isTextExtractableContentType } from "./mail/attachmentTextExtraction.js";

export * from "./tasks/taskRecurrenceRule.js";
export { taskDisplayDay } from "./tasks/taskDisplayDay.js";
export { taskSinceRule } from "./tasks/taskSinceRule.js";
export { projectToolCallUsageStore } from "./guidanceDrift/projectToolCallUsageStore.js";
export { loadGuidanceSections, saveGuidanceSections } from "./projectAgentGuidance/projectAgentGuidanceSections.js";
export {
  createProjectAgentGuidanceReadRouteHandler,
  createProjectAgentGuidanceSaveRouteHandler,
} from "./projectAgentGuidance/projectAgentGuidanceRouteHandlers.js";
export { createProjectGuidanceDriftReadRouteHandler } from "./guidanceDrift/guidanceDriftFindingsRouteHandlers.js";
export {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "./tasks/taskRecurrenceRoutes.js";
export { createTaskSeriesPatchRouteHandler } from "./tasks/taskSeriesRoutes.js";
export { createTasksDayRolloverAction, TASKS_DAY_ROLLOVER_ACTION_ID } from "./tasks/tasksDayRolloverAction.js";
export { firstOccurrenceAfter, latestOccurrenceOnOrBefore } from "./tasks/nextDueDate.js";
export {
  createTaskRecurrence,
  deleteTaskRecurrence,
  getTaskRecurrence,
  getTaskRecurrenceBySeriesId,
  setTaskRecurrenceActive,
  type CreateTaskRecurrenceInput,
  type TaskRecurrence,
  type TaskRecurrenceTemplate,
} from "./tasks/taskRecurrenceStore.js";
export { advanceTaskRecurrence, type AdvanceTaskRecurrenceInput } from "./tasks/advanceTaskRecurrence.js";
export {
  projectTaskOccurrences,
  type ProjectTaskOccurrencesInput,
  type ProjectedTaskOccurrence,
} from "./tasks/projectTaskOccurrences.js";

// Explicit, not `export *`: the module's reservation re-point for the Journal restore hook (issue #1666) is internal.
export {
  computeJournalPeriodKey,
  describeJournalPeriods,
  ensureJournalPeriodDoc,
  getOrCreateJournalItem,
  JOURNAL_PERIOD_TYPES,
  parseJournalPeriodKey,
  weeksOfMonth,
  type JournalPeriodType,
} from "./journal/journalStore.js";
export * from "./journal/journalPeriods.js";
export * from "./views/temporalSwitcherViewType.js";

export * from "./inbox/inboxTickAction.js";
export {
  readProposalWorkspaceContext,
  readProposalRelationCatalog,
  type ProposalWorkspaceGroup,
  type ProposalWorkspaceEntry,
  type ProposalRelationCatalogEntry,
} from "./inbox/proposalWorkspaceContext.js";
export {
  MAX_PROPOSAL_OPERATIONS,
  listWritableProposalTargets,
  type ProposalComputationOperation,
  type WritableProposalTarget,
} from "./inbox/proposalOperations.js";
export {
  deleteInboxAttachment,
  deleteInboxAttachmentsForItem,
  getInboxAttachment,
  insertInboxAttachments,
  listInboxAttachments,
  type InboxAttachmentRow,
  type InboxAttachmentSource,
  type NewInboxAttachment,
} from "./inbox/inboxAttachmentsStore.js";
export { CALENDAR_MODULE_ID } from "./calendar/calendarModuleId.js";
export { manifest as calendarModuleManifest } from "./calendar/calendarModuleManifest.js";
export { manifest as inboxPipelineModuleManifest } from "./inbox/inboxModuleManifest.js";

export * from "./auth/types.js";
export * from "./auth/passwordHash.js";
export * from "./auth/token.js";
export * from "./auth/usersStore.js";
export * from "./auth/sessionsStore.js";
export * from "./auth/userAgentDevice.js";
export * from "./auth/loginAttemptsStore.js";
export * from "./auth/emailNormalization.js";
// Explicit so the length constant (`DISPLAY_NAME_MAX_LENGTH`) stays out of the frozen public surface
// (`publicSurface.test.ts`); the routes only need the validator.
export { normalizeDisplayName } from "./auth/displayName.js";
export * from "./auth/loginLockout.js";
export * from "./auth/authActions.js";
export * from "./auth/nativeBridge.js";
export * from "./auth/passwordResetStore.js";
export * from "./auth/passwordResetMail.js";
// Explicit so the timing-floor constant (`PASSWORD_RESET_REQUEST_MIN_DURATION_MS`) stays out of the
// frozen public surface (`publicSurface.test.ts`); only the data package's own tests need it.
export {
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
  PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS,
  PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW,
  requestPasswordReset,
  resetPassword,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
} from "./auth/passwordResetActions.js";

export * from "./push/types.js";
export * from "./push/pushSubscriptionsStore.js";
export * from "./push/pushSubscriptionActions.js";

// `mcpGrantsAdminStore.ts`'s user-only grant/risk-class/approval mutations are deliberately
// NOT exported here — see that file's header comment (issue #124).
export type {
  McpToolDisplayLabel,
  McpToolRegistration,
  UpsertMcpToolRegistrationInput,
} from "./mcp/mcpToolRegistrationsStore.js";
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
export type {
  McpToolGrantForProject,
  McpToolGrantServerState,
  ReclassifyMcpToolInput,
} from "./mcp/mcpAgentPageGrants.js";
export {
  countEffectiveMcpGrants,
  listMcpToolGrantsForProject,
  setProjectMcpGrantForAgentPage,
  reclassifyMcpTool,
} from "./mcp/mcpAgentPageGrants.js";
export type {
  ApprovalDescription,
  ApprovalRequest,
  ApprovalRequestPayload,
  McpInvokeApprovalRequestPayload,
  GenericOperationApprovalRequestPayload,
  ApprovalRequestStatus,
  ApprovalRequestDecision,
  CreatePendingApprovalRequestInput,
  ApprovalRequestOutcome,
} from "./mcp/approvalRequestsStore.js";
export {
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  createPendingApprovalRequest,
  getApprovalRequest,
  listPendingApprovalRequests,
  isGenericOperationApprovalRequestPayload,
  terminalizeApprovalRequestAsConflict,
  markApprovalRequestExecutionSucceeded,
} from "./mcp/approvalRequestsStore.js";
export type {
  ApprovalRequestQueueEntry,
  ApprovalRequestSafeSummary,
  ApprovalRequestDecisionView,
} from "./mcp/approvalRequestsQueue.js";
export { buildDestructiveApprovalDescription, buildMcpInvokeApprovalDescription } from "./mcp/approvalDescription.js";
export type { ApprovalConflictReason } from "./mcp/approvalConflictReason.js";
export { approvalConflictReason } from "./mcp/approvalConflictReason.js";
export { listApprovalRequestsQueue, toApprovalRequestDecisionView } from "./mcp/approvalRequestsQueue.js";
export type {
  McpInvokeResult,
  McpInvokeArgs,
  McpInvokeOptions,
  McpInvokeFailure,
  McpFailureKind,
} from "./mcp/mcpToolExecution.js";
export type { McpServerConnectionState } from "./mcp/mcpServerConnectionStateStore.js";
export {
  recordMcpConnectionSuccess,
  recordMcpConnectionFailure,
  getMcpConnectionStates,
} from "./mcp/mcpServerConnectionStateStore.js";
export { executeMcpInvocation, MCP_FAILURE_KINDS } from "./mcp/mcpToolExecution.js";
export type { GenericOperationApprovalReplay } from "./mcp/approvalRequestExecution.js";
// `approvalRequestsStore.ts`'s `decideApprovalRequest` is deliberately NOT exported here — see
// that file's header comment (issue #131), same convention as `mcpGrantsAdminStore.ts`. Only
// this wrapper (which also enqueues the reserved execution job in the same transaction) is
// reachable from a route handler.
export type { DecideApprovalRequestInput, DecideAndEnqueueResult } from "./mcp/approvalDecisionAction.js";
export { decideAndEnqueueApprovalRequest } from "./mcp/approvalDecisionAction.js";

// `mcpRunCredentialsStore.ts`'s raw hash-keyed lookup is deliberately NOT exported here, mirroring
// `sessionsStore.ts`'s `getActiveSessionByTokenHash`: only the action-layer wrapper that hashes the
// presented token internally (`resolveMcpRunCredential`) is reachable from a composition root.
export type { ActiveMcpRunCredential } from "./mcp/mcpRunCredentialsStore.js";
export type { MintMcpRunCredentialInput, MintMcpRunCredentialResult } from "./mcp/mcpRunCredentialAction.js";
export {
  mintMcpRunCredential,
  resolveMcpRunCredential,
  MCP_RUN_CREDENTIAL_TTL_SECONDS,
} from "./mcp/mcpRunCredentialAction.js";

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
export {
  legacyAgentsTextToSections,
  seedProjectAgentGuidanceFromLegacyText,
} from "./projectAgentGuidance/legacyAgentsConversion.js";
export { runProjectAgentGuidanceCutoverMigration } from "./projectAgentGuidance/projectAgentGuidanceCutoverMigration.js";
export { seedSystemProjectAgentGuidance } from "./projectAgentGuidance/seedSystemProjectAgentGuidance.js";

export { purgeExpiredTrash, handleItemTrashPurgeSweepTask } from "./trash/purgeExpiredTrash.js";
export { forEachActiveTenant } from "./tenancy/forEachActiveTenant.js";
export { provisionTenant } from "./tenancy/provisionTenant.js";
export { acceptInvitation } from "./tenancy/acceptInvitation.js";
export { getUserTenantBinding } from "./tenancy/tenantsStore.js";
export * from "./tenancy/accountsAdminStore.js";
export * from "./tenancy/deleteAccount.js";
export * from "./tenancy/invites.js";
export * from "./tenancy/inviteMail.js";
export * from "./tenancy/tenantStatusSignal.js";
export {
  raiseProblem,
  resolveProblem,
  type RaiseProblemInput,
  type RaiseProblemOutcome,
  type RaiseProblemResult,
  type SempProblemCategory,
  type SempProblemResolutionKind,
  type SempProblemSeverity,
} from "./semp/sempProblemsStore.js";
export { SEMP_PROBLEMS_RETENTION_DAYS, handleSempProblemsPruneTask } from "./semp/sempProblemsPrune.js";
export { createGuidanceProblemWriter } from "./semp/guidanceProblemWriter.js";
export {
  getDownloadableTenantExport,
  listTenantExports,
  requestTenantExport,
  type DownloadableTenantExport,
  type RequestedTenantExport,
  type TenantExportStatus,
  type TenantExportSummary,
} from "./tenancy/tenantExportsStore.js";

export { registerItemReadProjection, projectItemForRead, type ItemReadProjection } from "./chokePoint/hooks.js";

export { filterRecognitionCandidates, RECOGNITION_TARGETS } from "./inbox/inboxRecognition.js";

export { createMailContactsRouteHandler } from "./mail/mailContactsRoute.js";
export { createMailThreadDetailRouteHandler, createMailThreadListRouteHandler } from "./mail/mailThreadRoutes.js";

export { getSelfPersonId, setSelfPersonId } from "./selfPerson.js";
export {
  recordDesiredMailMessageMove,
  type MailMovePurpose,
  type MailMoveSource,
} from "./mail/mailMessageMoveSyncStore.js";

export { handleMailLinkPersonEmailsTask } from "./mail/linkPersonEmailsJob.js";

export type { ConfirmationResult } from "./inbox/proposalActions.js";

export {
  createSempChatThread,
  getSempMessageTurn,
  getSempThread,
  insertSempUserTurn,
  listSempThreadMessages,
  sendSempMessage,
} from "./sempThreads/sempThreadsStore.js";
export { enqueueSempMessage } from "./semp/sempMessageQueue.js";
export { validateSempMessageRefs } from "./semp/sempMessageRefs.js";
export { readSempRefContext, type SempRefContext } from "./semp/sempRefReadContext.js";
export {
  getMessageSpeech,
  getMessageSpeechSource,
  MessageSpeechCapacityError,
  messageSpeechStagedBlobExists,
  storeMessageSpeech,
  withMessageSpeechGuard,
} from "./semp/messageSpeechStore.js";
export {
  claimSempMessage,
  finishSempMessageTurn,
  getSempMessageFrontier,
  getSempMessageToken,
  getSempVoiceDelivery,
  repairInterruptedSempMessages,
  startSempMessageTurn,
} from "./semp/sempMessagesStore.js";
export { enqueueSempThreadTitleIfFirst, handleSempThreadTitle } from "./semp/sempThreadTitle.js";

export { resolveModuleAgentToolsForRun } from "./agentTools/moduleAgentTools.js";

export { createMailboxListRouteHandler, createMailboxDetailRouteHandler } from "./mail/mailboxRouteHandlers.js";

export { THREADS_MODULE_ID } from "./seed/emailModuleKeys.js";
export { runThreadsDatabaseCutoverMigration } from "./mail/threadsDatabaseCutoverMigration.js";
export { readRecordingRequest, recordRecordingIntake } from "./transcription/recordingIntake.js";

export { createLibraryMetadataFetcher } from "./library/libraryMetadataFetcher.js";

export { createInboxProposalGetTool, inboxProposalGetArgsSchema } from "./inbox/inboxAgentTools.js";
