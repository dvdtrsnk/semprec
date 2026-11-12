import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./libraryModuleKeys.js";
import type { AreaFilterTemplate, ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { SYSTEM_DATABASES_EDITOR_SCHEMAS } from "./systemDatabasesEditorSchemas.js";
import { TASKS_DAY_ROLLOVER_ACTION_ID } from "../tasks/tasksDayRolloverAction.js";
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
export { backfillTaskEffectiveDate } from "../tasks/backfillTaskEffectiveDate.js";
export {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "../tasks/taskRecurrenceRoutes.js";
export { createTaskSeriesPatchRouteHandler } from "../tasks/taskSeriesRoutes.js";
export { createTaskOccurrenceMaterializeRouteHandler } from "../tasks/taskOccurrenceRoutes.js";
export {
  createTaskHostEventPutRouteHandler,
  createTaskHostEventRemoveRouteHandler,
  createTaskHostEventsClearRouteHandler,
} from "../tasks/taskHostEventRouteHandlers.js";
export {
  createProjectAgentGuidanceReadRouteHandler,
  createProjectAgentGuidanceSaveRouteHandler,
} from "../projectAgentGuidance/projectAgentGuidanceRouteHandlers.js";
export {
  createProjectGuidanceDriftReadRouteHandler,
  createResolveGuidanceDriftFindingRouteHandler,
} from "../guidanceDrift/guidanceDriftFindingsRouteHandlers.js";

export {
  createCreateTranscriptionRouteHandler,
  createRerunTranscriptionRouteHandler,
  createTranscriptSpeakersRouteHandler,
  createTranscriptActionItemStateRouteHandler,
  createTranscriptActionItemTaskRouteHandler,
  createTranscriptActionItemTaskRemoveRouteHandler,
  createEventTranscriptActionItemsRouteHandler,
  createTranscriptSpeakerAssignRouteHandler,
  createTranscriptSpeakerCandidatesRouteHandler,
  createTranscriptDeleteRouteHandler,
  createTranscriptDetailRouteHandler,
  createTranscriptListRouteHandler,
  createTranscriptSummariesRouteHandler,
} from "../transcription/transcriptionRouteHandlers.js";
export { createListEventPeopleRouteHandler } from "../calendar/eventParticipantsRouteHandlers.js";
export { createAreaOverviewRouteHandler } from "../areas/areaOverviewRouteHandler.js";

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
  heartbeatActions: [
    FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
    TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
    TASKS_DAY_ROLLOVER_ACTION_ID,
  ],
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
    // Issue #1780: a task without host events has the `effectiveDate` of its `date`. The manifest `version` above was
    // already past 1.3.0 when this transition was added and is not lowered for it.
    {
      databaseKey: TASKS_MODULE_ID,
      fromVersion: "1.2.0",
      toVersion: "1.3.0",
      converterExport: "backfillTaskEffectiveDate",
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
    // A transcript takes over its Event's project and participants, and its company from its project
    // (issue #1697). Ownership handoff: `Transcripts.project`, `Transcripts.company` and `Transcripts.people`
    // stay `owner: user`, and the `valueLinks` process writes them only while the item's value link for that
    // property is `on`. See
    // docs/adr/2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge.md.
    {
      key: "transcriptProjectFromEvent",
      source: { databaseKey: EVENTS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: TRANSCRIPTS_MODULE_ID, propertyKey: "project" },
      via: { databaseKey: TRANSCRIPTS_MODULE_ID, relationKey: "event" },
    },
    // The tenant's own person (System settings `selfPerson`), the Event's organizer, is left out.
    {
      key: "transcriptPeopleFromEvent",
      source: { databaseKey: EVENTS_MODULE_ID, propertyKey: "people" },
      target: { databaseKey: TRANSCRIPTS_MODULE_ID, propertyKey: "people" },
      via: { databaseKey: TRANSCRIPTS_MODULE_ID, relationKey: "event" },
      valueFilter: { omit: { databaseKey: SYSTEM_SETTINGS_MODULE_ID, propertyKey: "selfPerson" } },
    },
    {
      key: "transcriptCompanyFromProject",
      source: { databaseKey: PROJECTS_MODULE_ID, propertyKey: "company" },
      target: { databaseKey: TRANSCRIPTS_MODULE_ID, propertyKey: "company" },
      via: { databaseKey: TRANSCRIPTS_MODULE_ID, relationKey: "project" },
    },
    // A task that came from an Event's action item takes over that Event's project and participants
    // (issue #1724). Ownership handoff: `Tasks.project` (the inverse of `Projects.tasks`) and `Tasks.people` stay
    // `owner: user`, and the `valueLinks` process writes them only while the item's value link for that property
    // is `on`. The removal of the `sourceEvents` edge detaches the Event from both links, whatever their state
    // (`tasks/taskSourceEventLinkDetach.ts`). See
    // docs/adr/2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules.md.
    {
      key: "taskProjectFromEvent",
      source: { databaseKey: EVENTS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: TASKS_MODULE_ID, propertyKey: "project" },
      via: { databaseKey: TASKS_MODULE_ID, relationKey: "sourceEvents" },
    },
    // The tenant's own person (System settings `selfPerson`) is left out, as in `transcriptPeopleFromEvent`.
    {
      key: "taskPeopleFromEvent",
      source: { databaseKey: EVENTS_MODULE_ID, propertyKey: "people" },
      target: { databaseKey: TASKS_MODULE_ID, propertyKey: "people" },
      via: { databaseKey: TASKS_MODULE_ID, relationKey: "sourceEvents" },
      valueFilter: { omit: { databaseKey: SYSTEM_SETTINGS_MODULE_ID, propertyKey: "selfPerson" } },
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
      name: "resolveGuidanceDriftFinding",
      method: "POST",
      path: "/api/agent-guidance-drift/:id/resolve",
      handlerExport: "createResolveGuidanceDriftFindingRouteHandler",
      justification: "transactional-semantics",
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
      name: "materializeTaskOccurrence",
      method: "POST",
      path: "/api/tasks/series/:seriesId/occurrences/:date",
      handlerExport: "createTaskOccurrenceMaterializeRouteHandler",
      // Finding or creating the occurrence's item and writing it commit together under the item and series locks (issue #1720).
      justification: "transactional-semantics",
    },
    {
      name: "putTaskIntoEvent",
      method: "PUT",
      path: "/api/tasks/:id/host-events/:eventId",
      handlerExport: "createTaskHostEventPutRouteHandler",
      // Writes a system-owned edge with metadata the server fills (`addedAt`), which the generic relation
      // endpoint refuses for this relation and cannot fill (issue #1764).
      justification: "transactional-semantics",
    },
    {
      name: "removeTaskFromEvent",
      method: "DELETE",
      path: "/api/tasks/:id/host-events/:eventId",
      handlerExport: "createTaskHostEventRemoveRouteHandler",
      // Removes a system-owned edge, which the generic relation endpoint refuses for this relation (issue #1764).
      justification: "transactional-semantics",
    },
    {
      name: "removeTaskFromAllEvents",
      method: "DELETE",
      path: "/api/tasks/:id/host-events",
      handlerExport: "createTaskHostEventsClearRouteHandler",
      // Every host event edge of the task is removed and the task's new date and time are written in one
      // transaction, which the generic endpoints cannot express (issue #1764).
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
    {
      name: "listTranscriptSummaries",
      method: "GET",
      path: "/api/transcript-summaries",
      handlerExport: "createTranscriptSummariesRouteHandler",
      // Shaped for exactly one consumer, the journal's day: one statement counts the transcripts of
      // each of the day's events, which the transcript list answers for one event per request.
      justification: "single-consumer-read",
    },
    {
      name: "setTranscriptActionItemState",
      method: "PUT",
      path: "/api/transcripts/:id/action-items/:actionItemId/state",
      handlerExport: "createTranscriptActionItemStateRouteHandler",
      // The existence check of the action item, the owner lookup and the state write commit together
      // under the transcript's row lock (issue #1754); the state is no item property.
      justification: "transactional-semantics",
    },
    {
      name: "listEventPeople",
      method: "GET",
      path: "/api/events/:id/people",
      handlerExport: "createListEventPeopleRouteHandler",
      // Shaped for exactly one consumer, an Event's participant list (issue #1757): it joins the Event's
      // `people` edges and their metadata with each person's name, relationship and addresses, which no
      // generic item read returns together.
      justification: "single-consumer-read",
    },
    {
      name: "areaOverview",
      method: "GET",
      path: "/api/areas/:id/overview",
      handlerExport: "createAreaOverviewRouteHandler",
      // Shaped for exactly one consumer, the head of an area's page (issue #1760): the area's project and
      // task counts and its upcoming tasks and events, reached through the area's projects and read in one
      // transaction, which no generic query returns together.
      justification: "single-consumer-read",
    },
    {
      name: "createTranscriptActionItemTask",
      method: "POST",
      path: "/api/transcripts/:id/action-items/:actionItemId/task",
      handlerExport: "createTranscriptActionItemTaskRouteHandler",
      // The check for a live task of the action item, the task with its `sourceEvents` edge and the
      // `added` state commit together under the transcript's row lock (issue #1767).
      justification: "transactional-semantics",
    },
    {
      name: "removeTranscriptActionItemTask",
      method: "DELETE",
      path: "/api/transcripts/:id/action-items/:actionItemId/task",
      handlerExport: "createTranscriptActionItemTaskRemoveRouteHandler",
      // The task's move to the Trash and the removal of the `added` state commit together under the
      // transcript's row lock (issue #1767).
      justification: "transactional-semantics",
    },
    {
      name: "listEventTranscriptActionItems",
      method: "GET",
      path: "/api/events/:id/transcript-action-items",
      handlerExport: "createEventTranscriptActionItemsRouteHandler",
      // Shaped for exactly one consumer, the task proposals of an Event (issue #1767): it joins the
      // rendered action items of every transcript of the Event with their states and the tenant's own
      // person, which no generic item read returns.
      justification: "single-consumer-read",
    },
    {
      name: "assignTranscriptSpeaker",
      method: "PUT",
      path: "/api/transcripts/:id/speakers/:speaker",
      handlerExport: "createTranscriptSpeakerAssignRouteHandler",
      // The removal of the key's old edge, the new edge, the Event participant edge and the settling of
      // the speaker's card commit together under the transcript's row lock (issue #1770).
      justification: "transactional-semantics",
    },
    {
      name: "listTranscriptSpeakerCandidates",
      method: "GET",
      path: "/api/transcripts/:id/speaker-candidates",
      handlerExport: "createTranscriptSpeakerCandidatesRouteHandler",
      // Shaped for exactly one consumer, the speaker picker (issue #1770): it joins the participants of the
      // transcript's Event with their invitation state, the speaker each is mapped to and the tenant's own
      // person, which no generic item read returns.
      justification: "single-consumer-read",
    },
  ],
  // The Inbox card editors of the system databases (issue #1825), declared in `systemDatabasesEditorSchemas.ts`.
  editorSchemas: SYSTEM_DATABASES_EDITOR_SCHEMAS,
};
