import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { DRIFT_CHECK_ACTION_ID } from "./driftCheck.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { CALENDAR_INGEST_INVITATION_ACTION_ID } from "../calendar/invitationIngestAction.js";
import { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID } from "../calendar/invitationReplyAction.js";
import { NEXT_OCCURRENCE_REFRESH_ACTION_ID } from "../calendar/nextOccurrenceRefreshAction.js";
import { ALLDOTS_TICK_ACTION_ID } from "../inbox/inboxTickAction.js";
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
import { PROJECTS_OWNER_PROCESS } from "../projects/projectWriteTransform.js";
import { PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { JOURNAL_EVENT_LINKS_OWNER_PROCESS } from "../journal/journalOwnerProcesses.js";
import { TASKS_DAY_ROLLOVER_ACTION_ID } from "../tasks/tasksDayRolloverAction.js";
import { JOURNAL_WEEKLY_CLEANUP_ACTION_ID } from "../journal/journalWeeklyCleanupKeys.js";

/**
 * Hand-maintained list of every `*_ACTION_ID`, the default `moduleRegistry.checkDrift` diffs live
 * `project_heartbeats.action_id` values against. Should eventually come from the registry.
 */
export const KNOWN_HEARTBEAT_ACTION_IDS: ReadonlySet<string> = new Set([
  CORE_AGENT_RUN_ACTION_ID,
  DRIFT_CHECK_ACTION_ID,
  MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID,
  ALLDOTS_TICK_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
  TASKS_DAY_ROLLOVER_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  NEXT_OCCURRENCE_REFRESH_ACTION_ID,
  CALENDAR_INGEST_INVITATION_ACTION_ID,
  CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
]);

/** Hand-maintained like the list above: every `owner_process` the seeds write for system-owned properties. */
export const KNOWN_OWNER_PROCESS_IDS: ReadonlySet<string> = new Set([
  CALENDAR_MODULE_ID,
  EMAILS_MODULE_ID,
  FOLDERS_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
  TRANSCRIPTION_OWNER_PROCESS,
  TASKS_MODULE_ID,
  PROJECTS_OWNER_PROCESS,
  JOURNAL_EVENT_LINKS_OWNER_PROCESS,
  // People's derived `lastContact`, written only by people/lastContact.ts's recompute.
  PEOPLE_MODULE_ID,
]);
