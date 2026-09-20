import type { ModuleManifest } from "@semprec/module-registry";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { FILES_TRANSCRIPTION_TRIGGER_ACTION_ID } from "../transcription/transcriptionActions.js";
import {
  AREAS_MODULE_ID,
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  JOURNAL_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
} from "./tenDatabaseKeys.js";
export { backfillTaskTimeProperties } from "../tasks/deriveTaskTime.js";

export { createCreateTranscriptionRouteHandler } from "../transcription/transcriptionRouteHandlers.js";

/**
 * Retrofit manifest (module-contract issue #226) for the ten hardcoded system databases
 * (issue #24): `0004_ten_databases.sql` (the `task_recurrence` and `blobs` tables backing
 * Tasks recurrence and generic blob storage) plus `seedTenDatabases.ts`, which actually
 * creates the ten databases below. Each `databases[].key` reuses the database's existing
 * `owner_module_id` (`tenDatabaseKeys.ts`) and `.name` reuses its existing display name
 * (`seedTenDatabases.ts`), so this manifest is a pure structural description of what already
 * exists — loading it creates nothing and changes no stored data. `temporal-switcher` is
 * declared here, not in the views module's manifest, because it is Journal-specific
 * (`temporalSwitcherViewType.ts`), not part of the generic views mechanism. Journal's
 * `defaultViewType` below (module-contract issue #115) is what `seedTenDatabasesInTransaction`
 * reads through `ModuleRegistry.getDatabases()` instead of a hardcoded `moduleId === JOURNAL_MODULE_ID`
 * branch — every other database here defaults to `"table"` by leaving the field unset.
 */
export const manifest: ModuleManifest = {
  id: "systemDatabases",
  version: "1.1.0",
  name: "System Databases",
  removable: false,
  systemProject: true,
  databases: [
    { key: AREAS_MODULE_ID, name: "Areas" },
    { key: PROJECTS_MODULE_ID, name: "Projects" },
    { key: TASKS_MODULE_ID, name: "Tasks" },
    { key: PEOPLE_MODULE_ID, name: "People" },
    { key: FILES_MODULE_ID, name: "Files" },
    { key: EVENTS_MODULE_ID, name: "Events" },
    { key: HEALTH_RECORDS_MODULE_ID, name: "Health records" },
    { key: COMPANIES_MODULE_ID, name: "Companies" },
    { key: TRANSCRIPTS_MODULE_ID, name: "Transcripts" },
    { key: JOURNAL_MODULE_ID, name: "Journal", defaultViewType: TEMPORAL_SWITCHER_VIEW_TYPE },
  ],
  capabilities: [],
  agentTools: [],
  viewTypes: [TEMPORAL_SWITCHER_VIEW_TYPE],
  heartbeatActions: [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
  migrations: ["0004_ten_databases.sql"],
  dataMigrations: [
    {
      databaseKey: TASKS_MODULE_ID,
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      converterExport: "backfillTaskTimeProperties",
    },
  ],
  customRoutes: [
    {
      name: "createTranscription",
      method: "POST",
      path: "/api/transcriptions",
      handlerExport: "createCreateTranscriptionRouteHandler",
      // The existing-job check and the enqueue must commit together (issue #180's dedup
      // guarantee), a shape the generic item-write endpoint can't express.
      justification: "transactional-semantics",
    },
  ],
};
