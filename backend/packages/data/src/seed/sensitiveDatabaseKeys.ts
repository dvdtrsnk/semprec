import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "./sleepModuleKeys.js";
import { INBOX_MODULE_ID } from "./inboxPipelineKeys.js";
import { FILES_MODULE_ID, HEALTH_RECORDS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "./tenDatabaseKeys.js";

/**
 * The keys of the system databases that are marked `sensitive` (issue #1808): the Health records and the
 * three sleep databases. The seeds create these databases with the flag and
 * `runSensitiveDatabasesCutoverMigration` sets it for the tenants that already had them.
 */
export const SENSITIVE_DATABASE_KEYS: readonly string[] = [
  HEALTH_RECORDS_MODULE_ID,
  SLEEP_SETTINGS_MODULE_ID,
  SLEEP_PLANS_MODULE_ID,
  SLEEP_NIGHTS_MODULE_ID,
];

/**
 * The `databases.owner_module_id` values of the system databases whose items inherit sensitivity (issue #1999): an
 * item of the Files, Transcripts or Inbox database that has a live relation edge to an item of a sensitive database
 * is treated as sensitive for an agent (`agentGrants/inheritedSensitivity.ts`). The items of these databases are not
 * classified by their content.
 */
export const SENSITIVITY_INHERITING_MODULE_IDS: readonly string[] = [
  FILES_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
  INBOX_MODULE_ID,
];
