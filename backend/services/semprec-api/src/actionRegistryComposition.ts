import type { Pool } from "pg";
import {
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
  DRIFT_CHECK_ACTION_ID,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  KNOWN_HEARTBEAT_ACTION_IDS,
  KNOWN_OWNER_PROCESS_IDS,
  SEMPREC_TICK_ACTION_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
  MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
  TASKS_DAY_ROLLOVER_ACTION_ID,
  createActionRegistry,
  createDriftCheckAction,
  createFilesTranscriptionTriggerAction,
  createLibraryMetadataRetrySweepAction,
  createLibraryMetadataTriggerAction,
  createLinkEmailToPeopleAction,
  createModuleRegistryDriftCheckAction,
  createPersonEmailReindexAction,
  createSemprecTickAction,
  createTranscriptionRequeueSweepAction,
  createTasksDayRolloverAction,
  createNextOccurrenceRefreshAction,
  createInvitationIngestAction,
  createInvitationReplyAction,
  CALENDAR_INGEST_INVITATION_ACTION_ID,
  CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
  LocalFsBlobStorageWriter,
  openBlobFromRoots,
  resolveBlobStorageDir,
  NEXT_OCCURRENCE_REFRESH_ACTION_ID,
  type ActionRegistry,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  createAgentGuidanceDriftActionForApi,
  createAiGatewayClientForApi,
} from "./projectAgentGuidanceComposition.js";
import { createAresHttpClient } from "./aresClient.js";
import { createProposalComputation } from "./proposalComputation.js";

/**
 * Every seeded action id `resolveHeartbeatFireTaskName` routes onto `heartbeatFireCore`.
 * `core.agentRun` and `core.journalWeeklyCleanup` belong to the agents runtime; `semprec.tick` is a
 * system process of this runtime, backed by the gateway's `inbox_proposal` operation.
 *
 * Builds the gateway client eagerly, so this throws when `AI_GATEWAY_INTERNAL_TOKEN` is unset.
 */
export function createApiActionRegistry(pool: Pool, moduleRegistry: ModuleRegistry): ActionRegistry {
  const gateway = createAiGatewayClientForApi();
  const agentGuidanceDrift = createAgentGuidanceDriftActionForApi(pool, gateway, moduleRegistry);

  const registry = createActionRegistry();
  registry.set(
    DRIFT_CHECK_ACTION_ID,
    createDriftCheckAction(pool, { moduleRegistry, activeProcessIds: KNOWN_OWNER_PROCESS_IDS }),
  );
  registry.set(
    MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID,
    createModuleRegistryDriftCheckAction(pool, {
      activeHeartbeatActionIds: KNOWN_HEARTBEAT_ACTION_IDS,
      activeProcessIds: KNOWN_OWNER_PROCESS_IDS,
    }),
  );
  registry.set(LIBRARY_METADATA_TRIGGER_ACTION_ID, createLibraryMetadataTriggerAction(pool));
  registry.set(LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, createLibraryMetadataRetrySweepAction(pool));
  registry.set(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, createPersonEmailReindexAction(pool));
  registry.set(MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, createLinkEmailToPeopleAction(pool));
  registry.set(FILES_TRANSCRIPTION_TRIGGER_ACTION_ID, createFilesTranscriptionTriggerAction(pool));
  registry.set(TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID, createTranscriptionRequeueSweepAction(pool));
  registry.set(TASKS_DAY_ROLLOVER_ACTION_ID, createTasksDayRolloverAction(pool));
  registry.set(NEXT_OCCURRENCE_REFRESH_ACTION_ID, createNextOccurrenceRefreshAction(pool));
  const mailAttachmentStorage = new LocalFsBlobStorageWriter(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR"));
  registry.set(
    CALENDAR_INGEST_INVITATION_ACTION_ID,
    createInvitationIngestAction(pool, { storage: mailAttachmentStorage }),
  );
  registry.set(
    CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
    createInvitationReplyAction(pool, { storage: mailAttachmentStorage }),
  );
  // Reduced copies of Inbox photos are written to the files root by `semprec-transcribe`; a copy
  // that duplicates an existing blob can lie in the mail attachments root.
  const filesStorage = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR"));
  registry.set(
    SEMPREC_TICK_ACTION_ID,
    createSemprecTickAction(
      pool,
      createProposalComputation({
        pool,
        gateway,
        openBlob: (storageKey) =>
          openBlobFromRoots({ primary: filesStorage, alternate: mailAttachmentStorage, storageKey }),
        aresClient: createAresHttpClient(),
        recipe: { photoStorage: filesStorage },
      }),
    ),
  );
  registry.set(AGENT_GUIDANCE_DRIFT_ACTION_ID, (_actionConfig, context) =>
    agentGuidanceDrift({ projectItemId: context.projectItemId }),
  );
  return registry;
}
