import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

export const DERIVED_VALUE_SOURCES = [{ databaseKey: EVENTS_MODULE_ID, projectPropertyKey: "project" }] as const;

export const GUARDED_DERIVED_VALUE_SOURCES = [
  { databaseKey: EVENTS_MODULE_ID, propertyKey: "company", projectPropertyKey: "project" },
] as const;
