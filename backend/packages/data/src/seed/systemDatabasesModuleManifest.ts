import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import type { AreaFilterTemplate, ModuleManifest } from "@semprec/module-registry";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import {
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
} from "../transcription/transcriptionActions.js";
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
export {
  createJournalPeriodReadRouteHandler,
  createJournalPeriodEnsureRouteHandler,
} from "../journal/journalRouteHandlers.js";
export { backfillTaskTimeProperties } from "../tasks/deriveTaskTime.js";
export {
  createProjectAgentGuidanceReadRouteHandler,
  createProjectAgentGuidanceSaveRouteHandler,
} from "../projectAgentGuidance/projectAgentGuidanceRouteHandlers.js";
export { createProjectGuidanceDriftReadRouteHandler } from "../guidanceDrift/guidanceDriftFindingsRouteHandlers.js";

export {
  createCreateTranscriptionRouteHandler,
  createRerunTranscriptionRouteHandler,
  createTranscriptSpeakersRouteHandler,
  createTranscriptDetailRouteHandler,
  createTranscriptListRouteHandler,
} from "../transcription/transcriptionRouteHandlers.js";

const AREA_VALUE = { areaValue: true } as const;

/** Items with their own `area` relation pointing at the area (issue #1597). */
const OWN_AREA_FILTER: AreaFilterTemplate = { type: "relation_contains", property: "area", value: AREA_VALUE };

/**
 * Items whose project is in the area, and, when they have no live project, items whose own area is it
 * (issue #1597). `projectKey` is the database's relation to Projects.
 */
function projectOrOwnAreaFilter(projectKey: string): AreaFilterTemplate {
  return {
    type: "or",
    nodes: [
      { type: "relation_path_contains", path: [projectKey, "area"], value: AREA_VALUE },
      { type: "and", nodes: [{ type: "relation_is_empty", property: projectKey }, OWN_AREA_FILTER] },
    ],
  };
}

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
  version: "1.5.0",
  name: "System Databases",
  removable: false,
  systemProject: true,
  databases: [
    {
      key: AREAS_MODULE_ID,
      relatedOrder: {
        order: [
          PROJECTS_MODULE_ID,
          TASKS_MODULE_ID,
          EVENTS_MODULE_ID,
          FILES_MODULE_ID,
          "threads",
          HEALTH_RECORDS_MODULE_ID,
          COMPANIES_MODULE_ID,
          PEOPLE_MODULE_ID,
          BOOKS_MODULE_ID,
          MOVIES_MODULE_ID,
        ],
        omit: [JOURNAL_MODULE_ID],
      },
      name: "Areas",
      searchFields: ["name", "note"],
      icon: "compass",
      color: "#30B0C7",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    },
    {
      key: PROJECTS_MODULE_ID,
      relatedOrder: {
        order: [
          PROJECTS_MODULE_ID,
          EVENTS_MODULE_ID,
          FILES_MODULE_ID,
          "threads",
          TRANSCRIPTS_MODULE_ID,
          COMPANIES_MODULE_ID,
          PEOPLE_MODULE_ID,
          JOURNAL_MODULE_ID,
        ],
        omit: [TASKS_MODULE_ID],
      },
      name: "Projects",
      searchFields: ["name", "status", "agents", "area", "company"],
      icon: "folder",
      color: "#007AFF",
      overviewOrder: 1,
      switcherOrder: 1,
      areaFilter: OWN_AREA_FILTER,
    },
    {
      key: TASKS_MODULE_ID,
      name: "Tasks",
      searchFields: ["name", "status", "project", "description"],
      icon: "checkmark-circle",
      color: "#34C759",
      overviewOrder: null,
      switcherOrder: 2,
      // A task has no area of its own: only its project's area counts, so a task without a project never matches.
      areaFilter: { type: "relation_path_contains", path: ["project", "area"], value: AREA_VALUE },
    },
    {
      key: PEOPLE_MODULE_ID,
      relatedOrder: {
        order: [
          PROJECTS_MODULE_ID,
          TASKS_MODULE_ID,
          EVENTS_MODULE_ID,
          FILES_MODULE_ID,
          "threads",
          TRANSCRIPTS_MODULE_ID,
          COMPANIES_MODULE_ID,
          PEOPLE_MODULE_ID,
          JOURNAL_MODULE_ID,
        ],
      },
      name: "People",
      searchFields: ["name", "relationship", "contact", "emails", "phones", "companies"],
      icon: "person",
      color: "#5856D6",
      overviewOrder: 3,
      switcherOrder: 5,
    },
    {
      key: FILES_MODULE_ID,
      name: "Files",
      searchFields: ["name", "type", "projects", "healthRecords", "companies"],
      icon: "document",
      color: "#8E8E93",
      overviewOrder: 5,
      switcherOrder: 7,
      areaFilter: projectOrOwnAreaFilter("projects"),
    },
    {
      key: EVENTS_MODULE_ID,
      name: "Events",
      searchFields: ["name", "type", "project", "people", "description", "url"],
      icon: "calendar",
      color: "#FF3B30",
      overviewOrder: 2,
      switcherOrder: 3,
      areaFilter: projectOrOwnAreaFilter("project"),
    },
    {
      key: HEALTH_RECORDS_MODULE_ID,
      name: "Health records",
      searchFields: ["name", "subject", "status", "type", "tags", "projects"],
      icon: "heart",
      color: "#FF2D55",
      overviewOrder: 6,
      switcherOrder: 8,
      areaFilter: projectOrOwnAreaFilter("projects"),
    },
    {
      key: COMPANIES_MODULE_ID,
      name: "Companies",
      searchFields: ["name", "ico", "web"],
      icon: "building",
      color: "#5AC8FA",
      overviewOrder: 4,
      switcherOrder: 6,
      areaFilter: OWN_AREA_FILTER,
    },
    {
      key: TRANSCRIPTS_MODULE_ID,
      name: "Transcripts",
      searchFields: ["name", "status", "notes", "link"],
      icon: "waveform",
      color: "#8E8E93",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    },
    {
      key: JOURNAL_MODULE_ID,
      name: "Journal",
      defaultViewType: TEMPORAL_SWITCHER_VIEW_TYPE,
      searchFields: ["name", "type", "period"],
      icon: "book",
      color: "#AF52DE",
      overviewOrder: null,
      switcherOrder: 4,
      areaFilter: OWN_AREA_FILTER,
    },
  ],
  capabilities: [],
  agentTools: [],
  viewTypes: [TEMPORAL_SWITCHER_VIEW_TYPE],
  heartbeatActions: [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID, TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID],
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
      name: "readProjectAgentGuidance",
      method: "GET",
      path: "/api/projects/:id/agent-guidance",
      handlerExport: "createProjectAgentGuidanceReadRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "saveProjectAgentGuidance",
      method: "PUT",
      path: "/api/projects/:id/agent-guidance",
      handlerExport: "createProjectAgentGuidanceSaveRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "listProjectGuidanceDrift",
      method: "GET",
      path: "/api/projects/:id/agent-guidance/drift",
      handlerExport: "createProjectGuidanceDriftReadRouteHandler",
      // Serves the AGENT page's drift cards: the project's active findings together with the
      // guidance version they are resolved against, which no generic item read returns.
      justification: "single-consumer-read",
    },
    {
      name: "ensureJournalPeriodDoc",
      method: "PUT",
      path: "/api/journal/periods/:type/:period/doc",
      handlerExport: "createJournalPeriodEnsureRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "readJournalPeriod",
      method: "GET",
      path: "/api/journal/periods/:type/:period",
      handlerExport: "createJournalPeriodReadRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "createTranscription",
      method: "POST",
      path: "/api/transcriptions",
      handlerExport: "createCreateTranscriptionRouteHandler",
      // The existing-job check and the enqueue must commit together (issue #180's dedup
      // guarantee), a shape the generic item-write endpoint can't express.
      justification: "transactional-semantics",
    },
    {
      name: "rerunTranscription",
      method: "POST",
      path: "/api/transcriptions/:id/rerun",
      handlerExport: "createRerunTranscriptionRouteHandler",
      // The `locked` check and the enqueue must commit together (issue #186: a locked row is never
      // rerun), and the route writes no item, so the generic item-write endpoint can't express it.
      justification: "transactional-semantics",
    },
    {
      name: "listTranscripts",
      method: "GET",
      path: "/api/transcripts",
      handlerExport: "createTranscriptListRouteHandler",
      // Shaped for exactly one consumer, the recordings lists: one statement joins each transcript with
      // its event, pairing card, open speaker cards and automation state, which the generic query cannot.
      justification: "single-consumer-read",
    },
    {
      name: "getTranscript",
      method: "GET",
      path: "/api/transcripts/:id",
      handlerExport: "createTranscriptDetailRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "listTranscriptSpeakers",
      method: "GET",
      path: "/api/transcripts/:id/speakers",
      handlerExport: "createTranscriptSpeakersRouteHandler",
      // Shaped for exactly one consumer, a transcript's speaker labels: it joins the transcript's
      // computed segment keys with its `speakers` edge metadata and the mapped People's names,
      // which no generic item read returns together.
      justification: "single-consumer-read",
    },
  ],
};
