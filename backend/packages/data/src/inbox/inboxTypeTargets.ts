import {
  AREAS_MODULE_ID,
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";

/**
 * Targets owned by a module the tenant may not have; a write naming one is accepted only when the tenant has that
 * database (`inboxTypeWriteHook.ts`).
 */
export const INBOX_TYPE_MODULE_TARGET_DATABASES = [MCP_SERVERS_MODULE_ID, RECIPES_MODULE_ID] as const;

/**
 * An explicit list, not the module registry: `journal` and `transcripts` are not database targets (journal entries
 * have their own processing method). Order matches the select options. Kept free of store imports so
 * `inboxRecognition.ts` can share the one list.
 */
export const INBOX_TYPE_TARGET_DATABASES = [
  AREAS_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
  PEOPLE_MODULE_ID,
  FILES_MODULE_ID,
  EVENTS_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  COMPANIES_MODULE_ID,
  ...INBOX_TYPE_MODULE_TARGET_DATABASES,
] as const;
export type InboxTypeTargetDatabase = (typeof INBOX_TYPE_TARGET_DATABASES)[number];
