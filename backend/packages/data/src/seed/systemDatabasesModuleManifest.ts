import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import type { AreaFilterTemplate, ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
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
export { normalizeTaskDatesAndTimes } from "../tasks/normalizeTaskDatesAndTimes.js";
export {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "../tasks/taskRecurrenceRoutes.js";
export { createTaskSeriesPatchRouteHandler } from "../tasks/taskSeriesRoutes.js";
export {
  createProjectAgentGuidanceReadRouteHandler,
  createProjectAgentGuidanceSaveRouteHandler,
} from "../projectAgentGuidance/projectAgentGuidanceRouteHandlers.js";
export { createProjectGuidanceDriftReadRouteHandler } from "../guidanceDrift/guidanceDriftFindingsRouteHandlers.js";

export {
  createCreateTranscriptionRouteHandler,
  createRerunTranscriptionRouteHandler,
  createTranscriptSpeakersRouteHandler,
  createTranscriptDeleteRouteHandler,
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

type QuickFilters = NonNullable<ModuleDatabaseDescriptor["quickFilters"]>;

/** `in <property> [values]` — a select or multi-select key among `values` (issue #1647). */
function inValues(property: string, values: string[]): Record<string, unknown> {
  return { type: "in", property, value: values };
}

/** A chip per value list, labelled `quickFilter.<database>.<key>`, after an "All" chip without a filter. */
function chipsWithAll(database: string, chips: [key: string, filter: Record<string, unknown>][]): QuickFilters {
  return [
    { key: "all", labelKey: `quickFilter.${database}.all` },
    ...chips.map(([key, filter]) => ({ key, labelKey: `quickFilter.${database}.${key}`, filter })),
  ];
}

/** A relative-date chip on Events `date`, evaluated in the tenant zone at query time (issue #1522). */
function eventsDateChip(key: string, preset: string): QuickFilters[number] {
  return {
    key,
    labelKey: `quickFilter.events.${key}`,
    filter: { type: "date_relative", property: "date", preset },
  };
}

/**
 * The user's own projects: system-module projects carry `systemActive` (true, or false once deactivated)
 * and user projects have no such key (issue #1647).
 */
const USER_PROJECTS_FILTER = { type: "is_empty", property: "systemActive" };

const PROJECTS_QUICK_FILTERS: QuickFilters = [
  {
    key: "active",
    labelKey: "quickFilter.projects.active",
    filter: inValues("status", ["inProgress", "longTerm"]),
    isDefault: true,
  },
  { key: "done", labelKey: "quickFilter.projects.done", filter: inValues("status", ["done"]) },
  { key: "archived", labelKey: "quickFilter.projects.archived", filter: inValues("status", ["archived"]) },
  { key: "all", labelKey: "quickFilter.projects.all" },
];

/**
 * The one project picker's default (issue #1647): user projects that are neither done nor archived. `in`
 * compiles to `= ANY(...)`, which is NULL for a project without a status, so such a project is kept by its
 * own `is_empty` branch. A read hint only: a done project stays a valid relation target.
 */
const PROJECTS_PICKER_FILTER = {
  type: "and",
  nodes: [
    USER_PROJECTS_FILTER,
    {
      type: "or",
      nodes: [
        { type: "is_empty", property: "status" },
        { type: "not", node: inValues("status", ["done", "archived"]) },
      ],
    },
  ],
};

const EVENTS_QUICK_FILTERS: QuickFilters = [
  { ...eventsDateChip("upcoming", "upcoming"), sort: [{ property: "date", direction: "asc" }], isDefault: true },
  eventsDateChip("today", "today"),
  eventsDateChip("thisWeek", "thisWeek"),
  eventsDateChip("nextWeek", "nextWeek"),
  { ...eventsDateChip("past", "past"), sort: [{ property: "date", direction: "desc" }] },
  { key: "all", labelKey: "quickFilter.events.all" },
];

const DATE_ASCENDING = { property: "date", direction: "asc" } as const;

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
      quickFilters: PROJECTS_QUICK_FILTERS,
      dateLabels: { pastLabelKey: "dateLabel.projects.past", noDateLabelKey: "dateLabel.projects.noDate" },
      collectionFilter: USER_PROJECTS_FILTER,
      pickerFilter: PROJECTS_PICKER_FILTER,
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
      defaultSort: DATE_ASCENDING,
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
      quickFilters: chipsWithAll("people", [
        ["clients", inValues("relationship", ["client"])],
        ["close", inValues("relationship", ["closeFriend", "parent", "girlfriend"])],
        ["others", inValues("relationship", ["therapist", "neighbor"])],
      ]),
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
      quickFilters: chipsWithAll("files", [
        // "Recent" is the last 30 days as everywhere: `last30`, D-30 through today inclusive (issue #1522).
        ["recent", { type: "date_relative", property: "date", preset: "last30" }],
        ["pdf", inValues("type", ["pdf"])],
        ["images", inValues("type", ["jpg"])],
        ["spreadsheets", inValues("type", ["xlsx"])],
        ["documents", inValues("type", ["docx"])],
      ]),
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
      quickFilters: EVENTS_QUICK_FILTERS,
      defaultSort: DATE_ASCENDING,
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
      quickFilters: chipsWithAll("healthRecords", [
        ["monitoring", inValues("status", ["monitoring"])],
        ["resolved", inValues("status", ["resolved"])],
      ]),
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
    // Issue #1657: repairs dates and times stored before the Tasks write rules existed. The manifest `version`
    // above was already past 1.2.0 when this transition was added and is not lowered for it.
    {
      databaseKey: TASKS_MODULE_ID,
      fromVersion: "1.1.0",
      toVersion: "1.2.0",
      converterExport: "normalizeTaskDatesAndTimes",
    },
  ],
  linkRules: [
    // A file's companies are the union of its projects' companies (issue #1653).
    {
      key: "fileCompaniesFromProjects",
      source: { databaseKey: PROJECTS_MODULE_ID, propertyKey: "company" },
      target: { databaseKey: FILES_MODULE_ID, propertyKey: "companies" },
      via: { databaseKey: FILES_MODULE_ID, relationKey: "projects" },
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
      name: "setTaskRecurrence",
      method: "PUT",
      path: "/api/tasks/:id/recurrence",
      handlerExport: "createTaskRecurrenceSetRouteHandler",
      // The task's series row and its series properties change together under the task and series locks (issue #1665).
      justification: "transactional-semantics",
    },
    {
      name: "clearTaskRecurrence",
      method: "DELETE",
      path: "/api/tasks/:id/recurrence",
      handlerExport: "createTaskRecurrenceClearRouteHandler",
      // Deactivating the series and clearing the task's series properties commit together (issue #1665).
      justification: "transactional-semantics",
    },
    {
      name: "editTaskSeries",
      method: "PATCH",
      path: "/api/tasks/series/:seriesId",
      handlerExport: "createTaskSeriesPatchRouteHandler",
      // The series template and its open occurrences change together under the occurrence and series locks (issue #1667).
      justification: "transactional-semantics",
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
      name: "deleteTranscript",
      method: "DELETE",
      path: "/api/transcripts/:id",
      handlerExport: "createTranscriptDeleteRouteHandler",
      // The transcript, its source Files item and its open cards change together in one
      // transaction (issue #1642), a shape the generic item delete cannot express.
      justification: "transactional-semantics",
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
