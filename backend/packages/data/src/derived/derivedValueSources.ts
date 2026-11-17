import {
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  JOURNAL_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";

export const DERIVED_VALUE_SOURCES = [
  { databaseKey: TASKS_MODULE_ID, projectPropertyKey: "project" },
  { databaseKey: EVENTS_MODULE_ID, projectPropertyKey: "project" },
  { databaseKey: FILES_MODULE_ID, projectPropertyKey: "projects" },
  { databaseKey: HEALTH_RECORDS_MODULE_ID, projectPropertyKey: "projects" },
  { databaseKey: JOURNAL_MODULE_ID, projectPropertyKey: "project" },
] as const;

export const GUARDED_DERIVED_VALUE_SOURCES = [
  { databaseKey: FILES_MODULE_ID, propertyKey: "area", projectPropertyKey: "projects" },
  { databaseKey: HEALTH_RECORDS_MODULE_ID, propertyKey: "area", projectPropertyKey: "projects" },
  { databaseKey: EVENTS_MODULE_ID, propertyKey: "area", projectPropertyKey: "project" },
  { databaseKey: EVENTS_MODULE_ID, propertyKey: "company", projectPropertyKey: "project" },
  { databaseKey: JOURNAL_MODULE_ID, propertyKey: "area", projectPropertyKey: "project" },
] as const;
