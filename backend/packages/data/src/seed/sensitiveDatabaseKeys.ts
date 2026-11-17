import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "./sleepModuleKeys.js";
import { INBOX_MODULE_ID } from "./inboxPipelineKeys.js";
import { FILES_MODULE_ID, HEALTH_RECORDS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "./tenDatabaseKeys.js";

/** System databases seeded with the `sensitive` flag: Health records and the three sleep databases. */
export const SENSITIVE_DATABASE_KEYS: readonly string[] = [
  HEALTH_RECORDS_MODULE_ID,
  SLEEP_SETTINGS_MODULE_ID,
  SLEEP_PLANS_MODULE_ID,
  SLEEP_NIGHTS_MODULE_ID,
];

/**
 * Databases whose items inherit sensitivity: a Files, Transcripts or Inbox item with a live relation
 * edge to a sensitive item is sensitive for an agent (`agentGrants/inheritedSensitivity.ts`). Content is
 * not classified.
 */
export const SENSITIVITY_INHERITING_MODULE_IDS: readonly string[] = [
  FILES_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
  INBOX_MODULE_ID,
];
