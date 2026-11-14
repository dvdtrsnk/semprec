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
  CALENDAR_INGEST_INVITATION_ACTION_ID,
  LocalFsBlobStorageWriter,
  resolveBlobStorageDir,
  NEXT_OCCURRENCE_REFRESH_ACTION_ID,
  type ActionRegistry,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  createAgentGuidanceDriftActionForApi,
  createAiGatewayClientForApi,
} from "./projectAgentGuidanceComposition.js";
import { createProposalComputation } from "./proposalComputation.js";

/**
 * The api runtime's heartbeat `ActionRegistry` (issue #641): every seeded action id that
 * `resolveHeartbeatFireTaskName` routes onto `heartbeatFireCore`. `core.agentRun` and
 * `core.journalWeeklyCleanup` belong to the agents runtime
 * (`services/semprec-agents/src/actionRegistryComposition.ts`); `semprec.tick`
 * (issue #1434) is a system process of this runtime, backed by the gateway's `inbox_proposal`
 * operation, and is not registered in the agents runtime.
 *
 * Builds the gateway client eagerly, so this throws when `AI_GATEWAY_INTERNAL_TOKEN` is
 * unset — `semprec-api` refuses to start without it.
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
  registry.set(
    CALENDAR_INGEST_INVITATION_ACTION_ID,
    createInvitationIngestAction(pool, {
      storage: new LocalFsBlobStorageWriter(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")),
    }),
  );
  registry.set(SEMPREC_TICK_ACTION_ID, createSemprecTickAction(pool, createProposalComputation({ pool, gateway })));
  registry.set(AGENT_GUIDANCE_DRIFT_ACTION_ID, (_actionConfig, context) =>
    agentGuidanceDrift({ projectItemId: context.projectItemId }),
  );
  return registry;
}
