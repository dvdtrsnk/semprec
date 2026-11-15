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
 * The targets that belong to a module a tenant may not have (issue #1973). Each is an option of the `targetDatabase`
 * select that a populated tenant gains from `inboxTypeTargetOptionsCutoverMigration.ts`, and a write that names one is
 * accepted only when the tenant has that database (`inboxTypeWriteHook.ts`). `recipes` (issue gh-1974) is the target the
 * recipe proposal writer serves (`recipeExtraction.ts`). A module added later that ships its own database is appended
 * here.
 */
export const INBOX_TYPE_MODULE_TARGET_DATABASES = [MCP_SERVERS_MODULE_ID, RECIPES_MODULE_ID] as const;

/**
 * The system databases an Inbox item type with `processingMethod: 'database'` may target (issues #1436 and #1973).
 * An explicit list, not the module registry: `journal` and `transcripts` are not processing targets here.
 * A journal entry has its own processing method, `journal` (issue gh-1975), and a recording will be a card the tick
 * makes for an audio attachment in issue #1978. The eight hardcoded databases come first, the databases of
 * `INBOX_TYPE_MODULE_TARGET_DATABASES` after them, in the order of the select options.
 *
 * This lives in its own module with no store imports so `inboxRecognition.ts`, which `inboxTypesStore.ts` reaches
 * through `inboxSourceGuard.ts`, can use the one list instead of keeping a copy (issue #1973).
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
