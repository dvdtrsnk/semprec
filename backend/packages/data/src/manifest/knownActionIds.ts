import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { DRIFT_CHECK_ACTION_ID } from "./driftCheck.js";
import { SEMPREC_TICK_ACTION_ID } from "../inbox/inboxTickAction.js";
import {
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
} from "../mail/personLinkingActions.js";
import {
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
} from "../library/libraryMetadataActions.js";
import { MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID } from "./moduleRegistryDriftCheck.js";
import { AGENT_GUIDANCE_DRIFT_ACTION_ID } from "../guidanceDrift/guidanceDriftHeartbeatStore.js";
import {
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
} from "../transcription/transcriptionActions.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";

/**
 * A temporary stand-in for the full module registry (issue #29, same caveat as
 * `ActionRegistry` in scheduler/actions.ts): every `*_ACTION_ID` constant this codebase
 * currently defines, gathered so `moduleRegistry.checkDrift` (issue #112) has a real
 * default to diff live `project_heartbeats.action_id` values against. Once #29 lands, this
 * list should come from the registry itself instead of being hand-maintained here.
 */
export const KNOWN_HEARTBEAT_ACTION_IDS: ReadonlySet<string> = new Set([
  CORE_AGENT_RUN_ACTION_ID,
  DRIFT_CHECK_ACTION_ID,
  MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID,
  SEMPREC_TICK_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
]);

/**
 * Same hand-maintained stand-in as `KNOWN_HEARTBEAT_ACTION_IDS` above, until the module registry
 * (issue #29) owns it: every `properties.owner_process` value the seeds and migrations write for a
 * system-owned property, so `moduleRegistry.checkDrift` has a real default to diff live
 * `owner_process` values against. The ten-database specs (seed/seedTenDatabases.ts) declare only
 * `TRANSCRIPTION_OWNER_PROCESS`.
 */
export const KNOWN_OWNER_PROCESS_IDS: ReadonlySet<string> = new Set([
  EMAILS_MODULE_ID,
  FOLDERS_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
  TRANSCRIPTION_OWNER_PROCESS,
]);
