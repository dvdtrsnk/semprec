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
export { searchItemGroups, type SearchItemGroupsInput } from "./search/searchItemsQuery.js";
export { enqueueMailGmailPseudoFolderCleanup } from "./mail/gmailPseudoFolderCleanupJob.js";
export { enqueueMailMessagePreviewBackfill } from "./mail/mailMessagePreviewBackfillJob.js";
export { enqueueMailThreadBackfill } from "./mail/mailThreadBackfillJob.js";

export { createChokePoint, type ChokePoint } from "./chokePoint/chokePoint.js";
export type { Actor } from "./chokePoint/authorization.js";
export { changeValueLinkWithClient, createValueLinkOps, type ValueLinkWriter } from "./chokePoint/valueLinkOps.js";
export type { BreakingValueLinks } from "./chokePoint/valueLinkApproval.js";
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
export { computeDeleteImpact, type DeleteImpact } from "./trash/deleteImpact.js";
export { itemDeleteWithClient } from "./chokePoint/itemTrash.js";
export { SYSTEM_WRITER, type WriterIdentity, type WriterKind } from "./chokePoint/writerKind.js";
export {
  assertAgentDatabaseAccess,
  readerOfWriter,
  listUnreadableDatabaseIds,
  type AssertAgentDatabaseAccessInput,
  type DatabaseReader,
  type ExternalClientReader,
  type RequiredAgentDatabaseAccess,
} from "./agentGrants/agentDatabaseAccess.js";
export { sensitiveSourceDatabaseIdsByItem } from "./agentGrants/inheritedSensitivity.js";
export type { AgentDatabaseAccess } from "./agentGrants/agentDatabaseGrantsStore.js";
export { allowItemsForTurn, clearForRun } from "./agentGrants/agentRunReadAllowancesStore.js";
export { setAgentDatabaseGrantForProjectSettings } from "./agentGrants/agentDatabaseGrantsForProject.js";
export { requireApprovalForWrite } from "./chokePoint/writeApproval.js";
export { postApprovalOutcomeMessage } from "./mcp/approvalOutcomeMessage.js";
export { getDatabaseByModuleId, type CreateDatabaseInput } from "./chokePoint/databasesStore.js";
export { type CreatePropertyInput, listPropertiesByDatabase } from "./chokePoint/propertiesStore.js";
export { findIdempotentReplay, getItemById, getItemsByIds, lockItemById } from "./chokePoint/itemsStore.js";
export { type ListItemsOptions, writeComputed } from "./chokePoint/itemsStore.js";
export type { CreateViewInput, PatchViewInput } from "./chokePoint/viewsStore.js";
export * from "./chokePoint/viewTypeRegistry.js";
export { manifest as schemaCoreModuleManifest } from "./chokePoint/schemaCoreModuleManifest.js";
export { createProjectHeartbeatsRouteHandler } from "./scheduler/projectHeartbeatsRoute.js";
export { createSetHeartbeatEnabledRouteHandler } from "./scheduler/setHeartbeatEnabledRoute.js";
export { createSempStatusRouteHandler, createSempStatusSummaryRouteHandler } from "./semp/sempStatusRouteHandler.js";
export {
  publishSempStatusInvalidationAndWait,
  publishSempStatusInvalidationNow,
} from "./sempStatus/sempStatusInvalidation.js";

export * from "./views/filterTree.js";
export { compileFilterNode, type FilterProperty, type FilterProperties } from "./views/filterCompiler.js";
export * from "./views/sortSpec.js";
export { compileSort } from "./views/sortCompiler.js";
export { expandAreaFilter, resolveDatabaseAreaFilters } from "./views/areaFilter.js";
export * from "./views/viewConfig.js";
export * from "./views/mailboxClientViewType.js";
export { buildFilterProperties } from "./views/filterProperties.js";
export type { QueryViewOptions, QueryViewResult, DatabaseQueryInput, ViewQueryInput } from "./views/viewQuery.js";
export { manifest as viewsModuleManifest } from "./views/viewsModuleManifest.js";

export * from "./scheduler/rule.js";
export { computeNextFireAt } from "./scheduler/nextFireAt.js";
export * from "./scheduler/schedulerStore.js";
export * from "./scheduler/actions.js";
export * from "./scheduler/heartbeatAgentTools.js";
export * from "./scheduler/heartbeatWriteAgentTools.js";
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
export { approvalNotificationLinkHref } from "./notifications/approvalNotificationLink.js";

export * from "./agentRuns/agentRunsStore.js";
export * from "./agentRuns/agentRunDetail.js";
export { createListAgentRunsRouteHandler } from "./agentRuns/agentRunsListRouteHandler.js";
export { agentRunErrorFields, agentRunErrorSummary } from "./agentRuns/agentRunErrorSummary.js";
export { deriveReplyOutcome, REPLY_INCOMPLETE_REASONS, type ReplyOutcome } from "./agentRuns/replyOutcome.js";
export { deriveRunDisplayStatus, type AgentRunDisplayStatus } from "./agentRuns/agentRunDisplayStatus.js";
export { AgentRunError, AiBudgetExceededError, agentRunErrorCodeOf } from "./agentRuns/agentRunErrorCodes.js";
export * from "./agentRuns/agentRunEventsStore.js";
export {
  AGENT_RUN_STEP_DEFAULT_LIMIT,
  AGENT_RUN_STEP_MAX_LIMIT,
  buildAgentRunStepPage,
  isAgentRunStepReadSettled,
} from "./agentRuns/agentRunStepPages.js";
export { projectAgentRunStepPage } from "./agentRuns/agentRunStepProjection.js";
export { stepSummary, stepTitle } from "./agentRuns/agentStepCatalog.js";
export * from "./agentRuns/agentRunEventsRetention.js";
export * from "./aiGateway/agentRunUsage.js";
export { enqueueAiBudgetReset } from "./aiGateway/aiBudgetResetJob.js";
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
export { SENSITIVE_DATABASE_KEYS } from "./seed/sensitiveDatabaseKeys.js";
export {
  enqueueTranscriptionJob,
  transcriptionJobPayloadSchema,
  transcriptionSourceLink,
  TRANSCRIPTION_OWNER_PROCESS,
  type TranscriptionJobPayload,
} from "./transcription/transcriptionJob.js";
export * from "./transcription/transcriptionComputedKeys.js";
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
  createTranscriptSummariesRouteHandler,
} from "./transcription/transcriptionRouteHandlers.js";
export {
  createTranscriptEventCard,
  matchTranscriptToEvent,
  readEventRecommendationContext,
  type AmbiguousTranscriptEventMatch,
  type EventRecommendation,
  type EventRecommendationContext,
  type TranscriptEventCandidate,
} from "./transcription/transcriptEventMatch.js";
export { resolveTranscriptDisplayName, resolveTranscriptSuggestedName } from "./transcription/transcriptDisplayName.js";
export {
  expandTranscriptSegmentRef,
  labelTranscriptSegmentRefs,
  validateTranscriptSegmentRef,
  validateTranscriptSegmentRefs,
} from "./transcription/transcriptSegmentRef.js";
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
export { createLibraryAutomationRetryRouteHandler } from "./library/libraryAutomationRouteHandlers.js";
export {
  createLibraryCoverCandidateSelectRouteHandler,
  createLibraryCoverCandidatesListRouteHandler,
  createLibraryCoverCandidatesRefreshRouteHandler,
} from "./library/libraryCoverCandidateRouteHandlers.js";
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
export { removeMailbox, type RemoveMailboxOptions } from "./mail/mailboxRemoval.js";
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
export { collectSubpageTree } from "./docs/pageTrash.js";
export {
  docEtag,
  PageVersionConflictError,
  readPageMarkdown,
  replacePageMarkdown,
  type PageMarkdownRead,
  type ReplacePageMarkdownInput,
  type ReplacePageMarkdownResult,
} from "./docs/pageMarkdown.js";
export { readProjectNotes } from "./docs/projectNotesRead.js";
export { listPageChanges, type PageChange, type PageChangeKind } from "./docs/pageChanges.js";
export { resolvePageOwnerDatabase } from "./docs/pageOwnerDatabase.js";
export { computePageReplaceProjection, type PageReplaceCheck } from "./docs/pageReplaceApproval.js";
export { convertPageToBlockWithClient } from "./docs/pageOperations.js";
export { computePageConvertProjection, type PageConvertCheck } from "./docs/pageConvertApproval.js";
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
export * from "./blobs/openBlobFromRoots.js";
export { loadBlobMetadataForItems, type BlobMetadata, type ItemBlobMetadata } from "./blobs/blobMetadata.js";
export { detectFileType, type DetectedFile, type DetectedFileType } from "./blobs/fileTypeDetection.js";
export { recomputePersonLastContact } from "./people/lastContact.js";
export { findFileItemByBlobId } from "./chokePoint/itemsStore.js";
export type { BlobStorageWriter, WriteStreamOptions } from "./mail/blobStorage.js";
export { LocalFsBlobStorageWriter, MaxBytesExceededError, resolveBlobStorageDir } from "./mail/blobStorage.js";
export { extractAttachmentText, isTextExtractableContentType } from "./mail/attachmentTextExtraction.js";

export * from "./tasks/taskRecurrenceRule.js";
export { taskDisplayDay } from "./tasks/taskDisplayDay.js";
export { taskSinceRule } from "./tasks/taskSinceRule.js";
export { computeTaskHostState, recomputeTaskHostState } from "./tasks/taskHostEventState.js";
export { eventTaskCounts, readEventTasks, taskStateInEvent } from "./tasks/taskStateInEvent.js";
export { countTasksReturningFromEvent } from "./tasks/eventHostedTasksHooks.js";
export { createEventTasksRouteHandler } from "./tasks/eventTasksRouteHandler.js";
export { projectToolCallUsageStore } from "./guidanceDrift/projectToolCallUsageStore.js";
export { loadGuidanceSections, saveGuidanceSections } from "./projectAgentGuidance/projectAgentGuidanceSections.js";
export {
  createProjectAgentGuidanceReadRouteHandler,
  createProjectAgentGuidanceSaveRouteHandler,
} from "./projectAgentGuidance/projectAgentGuidanceRouteHandlers.js";
export {
  createProjectGuidanceDriftReadRouteHandler,
  createResolveGuidanceDriftFindingRouteHandler,
} from "./guidanceDrift/guidanceDriftFindingsRouteHandlers.js";
export {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "./tasks/taskRecurrenceRoutes.js";
export { createTaskSeriesPatchRouteHandler } from "./tasks/taskSeriesRoutes.js";
export { createTaskOccurrenceMaterializeRouteHandler } from "./tasks/taskOccurrenceRoutes.js";
export {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
  createTaskHostEventsClearRouteHandler,
} from "./tasks/taskHostEventRouteHandlers.js";
export { createTasksDayRolloverAction, TASKS_DAY_ROLLOVER_ACTION_ID } from "./tasks/tasksDayRolloverAction.js";
export * from "./calendar/nextOccurrenceRefreshAction.js";
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
export { ensureJournalPeriodForWriter, type JournalPeriodSelector } from "./journal/journalPeriodForWriter.js";
export {
  mergeJournalDuplicatesForWriter,
  type ApprovedJournalPair,
  type JournalMergeOutcome,
  type JournalMergePeriod,
} from "./journal/journalMergeForWriter.js";
export {
  computeJournalMergeProjection,
  mergeApprovedJournalDuplicates,
  type JournalMergeCheck,
} from "./journal/journalMergeApproval.js";
export * from "./journal/mergeJournalDuplicates.js";
export {
  createJournalWeeklyCleanupAction,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
} from "./journal/journalWeeklyCleanupAction.js";
export type { RefusedRelationEdge } from "./chokePoint/relationOps.js";
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
export { manifest as recipesModuleManifest } from "./recipes/recipesModuleManifest.js";
export { manifest as sleepModuleManifest } from "./sleep/sleepModuleManifest.js";
export {
  resolveSleepNights,
  type ResolvedSleepNight,
  type ResolveSleepNightsInput,
  type SleepNightException,
  type SleepNightsSettings,
  type SleepPlan,
} from "./sleep/resolveSleepNights.js";
export { createCalendarTimelineRouteHandler } from "./calendar/timelineRouteHandler.js";
export { createCalendarAgendaRouteHandler } from "./calendar/agendaRouteHandler.js";
export { createRemindersFeedRouteHandler } from "./calendar/remindersFeedRouteHandler.js";
export { createCalendarCancellationImpactRouteHandler } from "./calendar/cancellationImpactRouteHandler.js";
export {
  createInviteEventPersonRouteHandler,
  createListEventPeopleRouteHandler,
  createReplaceEventPeopleRouteHandler,
} from "./calendar/eventParticipantsRouteHandlers.js";
export { duplicateCalendarItem } from "./calendar/duplicateCalendarItem.js";
export { convertEventDateToWallClock } from "./calendar/eventDateMigration.js";
export { createDuplicateCalendarItemRouteHandler } from "./calendar/duplicateCalendarItemRouteHandler.js";
export { createAreaOverviewRouteHandler } from "./areas/areaOverviewRouteHandler.js";
export { createEventInCalendar } from "./calendar/defaultCalendarCreateHook.js";
export {
  enqueueEventInvitation,
  setEventInvitationDelivery,
  type EnqueueEventInvitationInput,
  type EventInvitationDelivery,
  type EventInvitationSnapshot,
} from "./calendar/eventInvitationJob.js";
export {
  eventRecurrenceOccursOn,
  parseEventRecurrenceRule,
  type EventRecurrenceRule,
} from "./calendar/eventRecurrenceRule.js";
export { formatOccurrenceId, parseOccurrenceId } from "./calendar/eventOccurrenceId.js";
export { expandEventOccurrences } from "./calendar/eventOccurrences.js";
export { createMaterializeEventOccurrenceRouteHandler } from "./calendar/eventOccurrenceRouteHandlers.js";
export {
  materializeEventOccurrence,
  type MaterializeEventOccurrenceInput,
  type MaterializeEventOccurrenceOptions,
  type MaterializeEventOccurrenceResult,
} from "./calendar/materializeEventOccurrence.js";
export { manifest as inboxPipelineModuleManifest } from "./inbox/inboxModuleManifest.js";

export * from "./auth/types.js";
export * from "./auth/passwordHash.js";
export * from "./auth/token.js";
export * from "./auth/locales.js";
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
export * from "./auth/passwordChangeActions.js";

export * from "./push/types.js";
export * from "./push/pushSubscriptionsStore.js";
export * from "./push/pushSubscriptionActions.js";
export { handlePushDismissTask } from "./push/pushDismissJob.js";

// `mcpGrantsAdminStore.ts`'s user-only grant/risk-class/approval mutations are deliberately
// NOT exported here — see that file's header comment (issue #124).
export {
  type McpToolDisplayLabel,
  type McpToolRegistration,
  type UpsertMcpToolRegistrationInput,
  upsertMcpToolRegistration,
  getMcpToolRegistration,
  listMcpToolRegistrationsForServer,
} from "./mcp/mcpToolRegistrationsStore.js";
export { type ProjectMcpGrant, listProjectMcpGrants, getProjectMcpGrant } from "./mcp/mcpProjectGrantsStore.js";
export { assertValidMcpConnectionConfig, type McpConnectionConfig } from "./mcp/mcpConnectionConfig.js";
export {
  McpConnectionError,
  MCP_CONNECTION_ERROR_REASONS,
  type McpConnectionErrorReason,
} from "./mcp/mcpConnectionError.js";
export { type McpClientHandle, type ConnectMcpServerOptions, connectMcpServer } from "./mcp/mcpConnectionFactory.js";
export { syncMcpServerTools, type SyncMcpServerToolsOptions, type SyncMcpServerToolsResult } from "./mcp/mcpSync.js";
export { getGrantedMcpAgentTools, type McpAgentToolProjection } from "./mcp/mcpAgentTools.js";
export { resolveGrantedMcpTool, type McpToolInvocationTarget } from "./mcp/mcpToolInvocation.js";
export {
  type McpToolGrantForProject,
  type McpToolGrantServerState,
  type ReclassifyMcpToolInput,
  countEffectiveMcpGrants,
  listMcpToolGrantsForProject,
  setProjectMcpGrantForAgentPage,
  reclassifyMcpTool,
} from "./mcp/mcpAgentPageGrants.js";
export {
  type ApprovalDescription,
  type BreaksLinkEntry,
  type EndsInheritanceEntry,
  type ApprovalRequest,
  type ApprovalRequestPayload,
  type McpInvokeApprovalRequestPayload,
  type ModuleToolApprovalRequestPayload,
  type GenericOperationApprovalRequestPayload,
  type ApprovalRequestStatus,
  type ApprovalRequestDecision,
  type ApprovalRequestSourceKind,
  type CreatePendingApprovalRequestInput,
  type ApprovalRequestOutcome,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  APPROVAL_REQUEST_SOURCE_KINDS,
  countPendingApprovalRequests,
  createPendingApprovalRequest,
  getApprovalRequest,
  getApprovalRequestForOwner,
  listPendingApprovalRequests,
  isGenericOperationApprovalRequestPayload,
  isMcpInvokeApprovalRequestPayload,
  parseApprovalRequestListCursor,
  terminalizeApprovalRequestAsConflict,
  markApprovalRequestExecutionSucceeded,
  recordApprovalRequestOutcome,
} from "./mcp/approvalRequestsStore.js";
export { toApprovalRequestArgumentValues, type ApprovalRequestArgumentValues } from "./mcp/approvalRequestArguments.js";
export { buildDestructiveApprovalDescription, buildMcpInvokeApprovalDescription } from "./mcp/approvalDescription.js";
export { approvalConflictReason, type ApprovalConflictReason } from "./mcp/approvalConflictReason.js";
export {
  attachLiveStepApprovals,
  getApprovalRequestSourceKind,
  listApprovalRequestsQueue,
  listApprovalRequestsQueuePage,
  toApprovalRequestDecisionView,
  type ApprovalRequestQueueEntry,
  type ApprovalRequestSafeSummary,
  type ApprovalRequestDecisionView,
  type ApprovalRequestSource,
  type DecidedApprovalRequestQueueEntry,
} from "./mcp/approvalRequestsQueue.js";
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
export * from "./mcp/approvalDecisionAction.js";
export { createPendingApprovalRequestAndPublish, publishApprovalRequestChange } from "./mcp/approvalRequestRealtime.js";
// The module exports exactly CreateModuleToolApprovalRequestInput and createModuleToolApprovalRequest.
export * from "./mcp/moduleToolApprovalRequest.js";

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

export { RETENTION_DAYS, purgeExpiredTrash, handleItemTrashPurgeSweepTask } from "./trash/purgeExpiredTrash.js";
export { purgeExpiredArchivedDatabases } from "./trash/purgeArchivedDatabases.js";
export { forEachActiveTenant } from "./tenancy/forEachActiveTenant.js";
export { provisionTenant } from "./tenancy/provisionTenant.js";
export { acceptInvitation } from "./tenancy/acceptInvitation.js";
export { getUserTenantBinding } from "./tenancy/tenantsStore.js";
export * from "./tenancy/accountsAdminStore.js";
export * from "./tenancy/deleteAccount.js";
export * from "./tenancy/profileAccountSummary.js";
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
export { MailAttachmentTooLargeError, MailDraftAlreadySentError, MailDraftNotEditableError } from "./mail/draft.js";
export * from "./mail/mailDraftRouteHandlers.js";
export {
  createMailThreadDetailRouteHandler,
  createMailThreadListRouteHandler,
  createMailThreadReadRouteHandler,
} from "./mail/mailThreadRoutes.js";

export { getSelfPersonId, setSelfPersonId } from "./selfPerson.js";
export {
  recordDesiredMailMessageMove,
  type MailMovePurpose,
  type MailMoveSource,
} from "./mail/mailMessageMoveSyncStore.js";

export { handleMailLinkPersonEmailsTask } from "./mail/linkPersonEmailsJob.js";

export type { ConfirmationResult, ProposalWarning } from "./inbox/proposalActions.js";

export {
  createSempChatThread,
  getSempMessageTurn,
  getSempThread,
  insertSempUserTurn,
  listSempThreadMessages,
  sendSempMessage,
} from "./sempThreads/sempThreadsStore.js";
export {
  listSempThreads,
  parseSempThreadListCursor,
  SEMP_THREAD_KINDS,
  type SempThreadKind,
} from "./semp/sempThreadsListStore.js";
export { enqueueSempMessage } from "./semp/sempMessageQueue.js";
export * from "./semp/sempTurnCancellation.js";
export { reindexSempMessageSearch, type SempMessageSearchReindexOptions } from "./semp/sempMessageSearch.js";
export { validateSempMessageRefs } from "./semp/sempMessageRefs.js";
export { readSempRefContext, type SempRefContext, type SempRefReadOptions } from "./semp/sempRefReadContext.js";
export { listSleepNightReadItemIds } from "./semp/sempSleepNightContext.js";
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
export { buildSempReplySummary, type SempReplySummary } from "./semp/sempReplySummary.js";
export { projectSempReplySteps, type SempReplyStep } from "./semp/sempReplySteps.js";
export { classifySempTurnFailure, renderSempReplyFailure } from "./semp/sempReplyErrors.js";
export { projectSempReplyChanges, type SempReplyChange } from "./semp/sempReplyChanges.js";

export { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "./agentTools/moduleAgentTools.js";
export { describeModuleToolFailure } from "./agentTools/describeModuleToolFailure.js";

export { createMailboxListRouteHandler, createMailboxDetailRouteHandler } from "./mail/mailboxRouteHandlers.js";
export {
  createMailOauthCompleteRouteHandler,
  createMailOauthStartRouteHandler,
} from "./mail/mailOauthRouteHandlers.js";
export { createMailboxPasswordConnectRouteHandler } from "./mail/mailboxPasswordRouteHandlers.js";
export { createMailSummaryRouteHandler } from "./mail/mailSummary.js";
export { createMailFolderListRouteHandler } from "./mail/mailFolderList.js";

export { THREADS_MODULE_ID } from "./seed/emailModuleKeys.js";
export { runThreadsDatabaseCutoverMigration } from "./mail/threadsDatabaseCutoverMigration.js";
export { readRecordingRequest, recordRecordingIntake } from "./transcription/recordingIntake.js";

export { createLibraryMetadataFetcher } from "./library/libraryMetadataFetcher.js";

export * from "./inbox/inboxAgentTools.js";
