import type { Pool } from "pg";
import {
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
  DRIFT_CHECK_ACTION_ID,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  KNOWN_HEARTBEAT_ACTION_IDS,
  KNOWN_OWNER_PROCESS_IDS,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
  MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
  createActionRegistry,
  createDriftCheckAction,
  createFilesTranscriptionTriggerAction,
  createLibraryMetadataRetrySweepAction,
  createLibraryMetadataTriggerAction,
  createLinkEmailToPeopleAction,
  createModuleRegistryDriftCheckAction,
  createPersonEmailReindexAction,
  createTranscriptionRequeueSweepAction,
  type ActionRegistry,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createAgentGuidanceDriftActionForApi } from "./projectAgentGuidanceComposition.js";

/**
 * The api runtime's heartbeat `ActionRegistry` (issue #641): every seeded action id that
 * `resolveHeartbeatFireTaskName` routes onto `heartbeatFireCore`. `core.agentRun` belongs to the
 * agents runtime (`services/semprec-agents/src/actionRegistryComposition.ts`); `semprec.tick` is
 * deliberately absent until an LLM-backed proposal computation exists to inject into it.
 *
 * Builds `core.agentGuidanceDrift` eagerly, so this throws when `AI_GATEWAY_INTERNAL_TOKEN` is
 * unset — `semprec-api` refuses to start without it.
 */
export function createApiActionRegistry(pool: Pool, moduleRegistry: ModuleRegistry): ActionRegistry {
  const agentGuidanceDrift = createAgentGuidanceDriftActionForApi(pool, moduleRegistry);

  const registry = createActionRegistry();
  registry.set(DRIFT_CHECK_ACTION_ID, createDriftCheckAction(pool, { moduleRegistry }));
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
  registry.set(AGENT_GUIDANCE_DRIFT_ACTION_ID, (_actionConfig, context) =>
    agentGuidanceDrift({ projectItemId: context.projectItemId }),
  );
  return registry;
}
