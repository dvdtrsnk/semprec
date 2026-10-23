/** Canonical `databases.owner_module_id` values for the ten hardcoded databases (issue #24) — see the `canonical-keys` skill's established vocabulary. */
export const AREAS_MODULE_ID = "areas";
export const PROJECTS_MODULE_ID = "projects";
export const TASKS_MODULE_ID = "tasks";
export const PEOPLE_MODULE_ID = "people";
export const FILES_MODULE_ID = "files";
export const EVENTS_MODULE_ID = "events";
export const HEALTH_RECORDS_MODULE_ID = "healthRecords";
export const COMPANIES_MODULE_ID = "companies";
export const TRANSCRIPTS_MODULE_ID = "transcripts";
export const JOURNAL_MODULE_ID = "journal";

export const TEN_DATABASE_MODULE_IDS = [
  AREAS_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
  PEOPLE_MODULE_ID,
  FILES_MODULE_ID,
  EVENTS_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  COMPANIES_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
  JOURNAL_MODULE_ID,
] as const;
export type TenDatabaseModuleId = (typeof TEN_DATABASE_MODULE_IDS)[number];
