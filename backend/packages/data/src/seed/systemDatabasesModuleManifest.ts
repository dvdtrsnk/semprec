import { EMAILS_MODULE_ID } from "./emailModuleKeys.js";
import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { SYSTEM_DATABASES_EDITOR_SCHEMAS } from "./systemDatabasesEditorSchemas.js";
import { TASKS_DAY_ROLLOVER_ACTION_ID } from "../tasks/tasksDayRolloverAction.js";
import { JOURNAL_WEEKLY_CLEANUP_ACTION_ID } from "../journal/journalWeeklyCleanupKeys.js";
import {
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
} from "../transcription/transcriptionActions.js";
import {
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
export {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "../tasks/taskRecurrenceRoutes.js";
export { createTaskSeriesPatchRouteHandler } from "../tasks/taskSeriesRoutes.js";
export { createTaskOccurrenceMaterializeRouteHandler } from "../tasks/taskOccurrenceRoutes.js";
export {
  createTaskHostEventPutRouteHandler,
  createTaskCompleteInEventRouteHandler,
  createTaskHostEventRemoveRouteHandler,
  createTaskHostEventsClearRouteHandler,
} from "../tasks/taskHostEventRouteHandlers.js";
export { createEventTasksRouteHandler } from "../tasks/eventTasksRouteHandler.js";
export {
  createTranscriptGetTool,
  createTranscriptSegmentGetTool,
  transcriptGetArgsSchema,
  transcriptSegmentGetArgsSchema,
} from "../transcription/transcriptAgentTools.js";
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
export {
  createInviteEventPersonRouteHandler,
  createListEventPeopleRouteHandler,
  createReplaceEventPeopleRouteHandler,
} from "../calendar/eventParticipantsRouteHandlers.js";
export { createDuplicateCalendarItemRouteHandler } from "../calendar/duplicateCalendarItemRouteHandler.js";
export { createMaterializeEventOccurrenceRouteHandler } from "../calendar/eventOccurrenceRouteHandlers.js";
export { createRemindersFeedRouteHandler } from "../calendar/remindersFeedRouteHandler.js";

type QuickFilters = NonNullable<ModuleDatabaseDescriptor["quickFilters"]>;

/** `in <property> [values]` for a select or multi-select key. */
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

/** Relative-date chip on Events `date`, evaluated in the tenant zone at query time. */
function eventsDateChip(key: string, preset: string): QuickFilters[number] {
  return {
    key,
    labelKey: `quickFilter.events.${key}`,
    filter: { type: "date_relative", property: "date", preset },
  };
}

/** System-module projects carry `systemActive` (true or false); user projects have no such key. */
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

/** User projects neither done nor archived; `is_empty` keeps status-less ones (`in` is NULL for them). A read hint only. */
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
 * Describes the hardcoded core databases `seedTenDatabases.ts` creates (plus `task_recurrence` and `blobs`);
 * loading it creates nothing. Journal's `defaultViewType` is read by the seed; others default to `"table"`.
 */
export const manifest: ModuleManifest = {
  id: "systemDatabases",
  version: "1.5.0",
  name: "System Databases",
  removable: false,
  systemProject: true,
  databases: [
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
      searchFields: ["name", "status", "tags", "agents", "company"],
      icon: "folder",
      color: "#007AFF",
      overviewOrder: 1,
      switcherOrder: 1,
      quickFilters: PROJECTS_QUICK_FILTERS,
      dateLabels: { pastLabelKey: "dateLabel.projects.past", noDateLabelKey: "dateLabel.projects.noDate" },
      collectionFilter: USER_PROJECTS_FILTER,
      pickerFilter: PROJECTS_PICKER_FILTER,
      facetBarProperty: "tags",
    },
    {
      key: TASKS_MODULE_ID,
      name: "Tasks",
      searchFields: ["name", "status", "project", "description"],
      icon: "checkmark-circle",
      color: "#34C759",
      overviewOrder: null,
      switcherOrder: 2,
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
        // The mail of a person is listed as threads (`mail/threadRelatedCount.ts`), not as the Emails collection.
        omit: [EMAILS_MODULE_ID],
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
      quickFilters: chipsWithAll("files", [
        // "Recent" is `last30` (D-30 through today inclusive), as everywhere.
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
    },
  ],
  capabilities: [],
  agentTools: [
    {
      name: "transcript.get",
      handlerExport: "createTranscriptGetTool",
      argumentSchemaExport: "transcriptGetArgsSchema",
      capability: "core.item.read",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "transcript.segment.get",
      handlerExport: "createTranscriptSegmentGetTool",
      argumentSchemaExport: "transcriptSegmentGetArgsSchema",
      capability: "core.item.read",
      approval: "none",
      riskClass: "read",
    },
  ],
  viewTypes: [TEMPORAL_SWITCHER_VIEW_TYPE],
  heartbeatActions: [
    FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
    TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
    TASKS_DAY_ROLLOVER_ACTION_ID,
    JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  ],
  linkRules: [
    // A file's companies are the union of its projects' companies.
    {
      key: "fileCompaniesFromProjects",
      source: { databaseKey: PROJECTS_MODULE_ID, propertyKey: "company" },
      target: { databaseKey: FILES_MODULE_ID, propertyKey: "companies" },
      via: { databaseKey: FILES_MODULE_ID, relationKey: "projects" },
    },
    // A file attached to an Event takes over its project (company follows); written by `valueLinks` only while the
    // value link is `on`. Removing the attachment ends the company link (`blobs/eventAttachmentLinkRelease.ts`).
    {
      key: "fileProjectsFromEvents",
      source: { databaseKey: EVENTS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: FILES_MODULE_ID, propertyKey: "projects" },
      via: { databaseKey: FILES_MODULE_ID, relationKey: "events" },
    },
    // A transcript takes over its Event's project and participants and its project's company. These stay
    // `owner: user`; `valueLinks` writes them only while the item's value link for the property is `on`.
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
    // A task from an Event's action item takes over its project and participants via `valueLinks` while linked;
    // removing `sourceEvents` detaches both (`tasks/taskSourceEventLinkDetach.ts`).
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
    // A file attached to a task takes over its project via `valueLinks` while linked; a file with its own project keeps it.
    {
      key: "fileProjectsFromTasks",
      source: { databaseKey: TASKS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: FILES_MODULE_ID, propertyKey: "projects" },
      via: { databaseKey: FILES_MODULE_ID, relationKey: "tasks" },
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
      // The AGENT page's drift cards: active findings with the guidance version they resolve against.
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
      // The series row and the task's series properties change together under the task and series locks.
      justification: "transactional-semantics",
    },
    {
      name: "clearTaskRecurrence",
      method: "DELETE",
      path: "/api/tasks/:id/recurrence",
      handlerExport: "createTaskRecurrenceClearRouteHandler",
      // Deactivating the series and clearing the task's series properties commit together.
      justification: "transactional-semantics",
    },
    {
      name: "editTaskSeries",
      method: "PATCH",
      path: "/api/tasks/series/:seriesId",
      handlerExport: "createTaskSeriesPatchRouteHandler",
      // The series template and its open occurrences change together under the occurrence and series locks.
      justification: "transactional-semantics",
    },
    {
      name: "materializeTaskOccurrence",
      method: "POST",
      path: "/api/tasks/series/:seriesId/occurrences/:date",
      handlerExport: "createTaskOccurrenceMaterializeRouteHandler",
      // Finding or creating the occurrence's item and writing it commit together under the item and series locks.
      justification: "transactional-semantics",
    },
    {
      name: "putTaskIntoEvent",
      method: "PUT",
      path: "/api/tasks/:id/host-events/:eventId",
      handlerExport: "createTaskHostEventPutRouteHandler",
      // Writes a system-owned edge with server-filled metadata (`addedAt`), which the generic relation endpoint
      // refuses and cannot fill.
      justification: "transactional-semantics",
    },
    {
      name: "completeTaskInEvent",
      method: "PUT",
      path: "/api/tasks/:id/completed-in-event/:eventId",
      handlerExport: "createTaskCompleteInEventRouteHandler",
      // Writes the system-owned `completedInEvent` edge, which the generic relation endpoint refuses, and the task's
      // status in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "removeTaskFromEvent",
      method: "DELETE",
      path: "/api/tasks/:id/host-events/:eventId",
      handlerExport: "createTaskHostEventRemoveRouteHandler",
      // Removes a system-owned edge, which the generic relation endpoint refuses.
      justification: "transactional-semantics",
    },
    {
      name: "removeTaskFromAllEvents",
      method: "DELETE",
      path: "/api/tasks/:id/host-events",
      handlerExport: "createTaskHostEventsClearRouteHandler",
      // Removes every host event edge and writes the task's new date and time in one transaction.
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
      // The existing-job check and the enqueue must commit together (dedup).
      justification: "transactional-semantics",
    },
    {
      name: "rerunTranscription",
      method: "POST",
      path: "/api/transcriptions/:id/rerun",
      handlerExport: "createRerunTranscriptionRouteHandler",
      // The `locked` check and the enqueue commit together (a locked row is never rerun); no item is written.
      justification: "transactional-semantics",
    },
    {
      name: "listTranscripts",
      method: "GET",
      path: "/api/transcripts",
      handlerExport: "createTranscriptListRouteHandler",
      // The recordings lists: joins each transcript with its event, pairing card, open speaker cards and
      // automation state in one statement.
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
      // The transcript, its source Files item and its open cards change together in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "listTranscriptSpeakers",
      method: "GET",
      path: "/api/transcripts/:id/speakers",
      handlerExport: "createTranscriptSpeakersRouteHandler",
      // A transcript's speaker labels: computed segment keys joined with `speakers` edge metadata and People names.
      justification: "single-consumer-read",
    },
    {
      name: "listTranscriptSummaries",
      method: "GET",
      path: "/api/transcript-summaries",
      handlerExport: "createTranscriptSummariesRouteHandler",
      // The journal day: counts the transcripts of each of the day's events in one statement.
      justification: "single-consumer-read",
    },
    {
      name: "setTranscriptActionItemState",
      method: "PUT",
      path: "/api/transcripts/:id/action-items/:actionItemId/state",
      handlerExport: "createTranscriptActionItemStateRouteHandler",
      // Action-item check, owner lookup and state write commit together under the transcript's row lock; the
      // state is no item property.
      justification: "transactional-semantics",
    },
    {
      name: "listEventPeople",
      method: "GET",
      path: "/api/events/:id/people",
      handlerExport: "createListEventPeopleRouteHandler",
      // An Event's participant list: `people` edges and metadata joined with each person's name, relationship
      // and addresses.
      justification: "single-consumer-read",
    },
    {
      name: "replaceEventPeople",
      method: "PUT",
      path: "/api/events/:id/people",
      handlerExport: "createReplaceEventPeopleRouteHandler",
      // The participant-edge diff and the invitation jobs commit together under the Event's row lock; the
      // invitations use the system writer kind.
      justification: "transactional-semantics",
    },
    {
      name: "inviteEventPerson",
      method: "POST",
      path: "/api/events/:id/people/:personId/invite",
      handlerExport: "createInviteEventPersonRouteHandler",
      // The pending invitation, the missing organizer edge and the `REQUEST` job commit together under the
      // Event's row lock.
      justification: "transactional-semantics",
    },
    {
      name: "listEventTasks",
      method: "GET",
      path: "/api/events/:id/tasks",
      handlerExport: "createEventTasksRouteHandler",
      // An Event's task rows: each task's state relative to the Event plus open and total counts.
      justification: "single-consumer-read",
    },
    {
      name: "duplicateCalendarItem",
      method: "POST",
      path: "/api/calendar/items/:id/duplicate",
      handlerExport: "createDuplicateCalendarItemRouteHandler",
      // The copy and its edges commit together under the source's row lock, with the request's idempotency key.
      justification: "transactional-semantics",
    },
    {
      name: "materializeEventOccurrence",
      method: "POST",
      path: "/api/events/series/:seriesId/occurrences/:date",
      handlerExport: "createMaterializeEventOccurrenceRouteHandler",
      // The existence check, the copy of the series Event and its edges commit together under the occurrence's
      // advisory lock.
      justification: "transactional-semantics",
    },
    {
      name: "createTranscriptActionItemTask",
      method: "POST",
      path: "/api/transcripts/:id/action-items/:actionItemId/task",
      handlerExport: "createTranscriptActionItemTaskRouteHandler",
      // The live-task check, the task with its `sourceEvents` edge and the `added` state commit together under
      // the transcript's row lock.
      justification: "transactional-semantics",
    },
    {
      name: "removeTranscriptActionItemTask",
      method: "DELETE",
      path: "/api/transcripts/:id/action-items/:actionItemId/task",
      handlerExport: "createTranscriptActionItemTaskRemoveRouteHandler",
      // Trashing the task and removing the `added` state commit together under the transcript's row lock.
      justification: "transactional-semantics",
    },
    {
      name: "listEventTranscriptActionItems",
      method: "GET",
      path: "/api/events/:id/transcript-action-items",
      handlerExport: "createEventTranscriptActionItemsRouteHandler",
      // An Event's task proposals: every transcript's rendered action items with their states and the tenant's
      // own person.
      justification: "single-consumer-read",
    },
    {
      name: "assignTranscriptSpeaker",
      method: "PUT",
      path: "/api/transcripts/:id/speakers/:speaker",
      handlerExport: "createTranscriptSpeakerAssignRouteHandler",
      // Removing the key's old edge, the new edge, the Event participant edge and settling the speaker's card
      // commit together under the transcript's row lock.
      justification: "transactional-semantics",
    },
    {
      name: "listTranscriptSpeakerCandidates",
      method: "GET",
      path: "/api/transcripts/:id/speaker-candidates",
      handlerExport: "createTranscriptSpeakerCandidatesRouteHandler",
      // The speaker picker: the Event's participants with invitation state, mapped speaker and the tenant's own person.
      justification: "single-consumer-read",
    },
    {
      name: "upcomingReminders",
      method: "GET",
      path: "/api/calendar/reminders",
      handlerExport: "createRemindersFeedRouteHandler",
      // The phone's local scheduler: what fires in the next hours, from each Event's and Task's calendar `notify`.
      justification: "single-consumer-read",
    },
  ],
  editorSchemas: SYSTEM_DATABASES_EDITOR_SCHEMAS,
};
