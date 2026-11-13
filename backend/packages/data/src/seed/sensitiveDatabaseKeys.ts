import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "./sleepModuleKeys.js";
import { HEALTH_RECORDS_MODULE_ID } from "./tenDatabaseKeys.js";

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
