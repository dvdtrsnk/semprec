import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@alldots/module-registry";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import {
  createRelationPropertyWithClient,
  type CreateRelationPropertyInput,
} from "../chokePoint/relationPropertyOps.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { registerTemporalSwitcherViewType } from "../views/temporalSwitcherViewType.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalStore.js";
import { JOURNAL_EVENT_LINKS_OWNER_PROCESS } from "../journal/journalOwnerProcesses.js";
import type { DatabaseRow } from "../types.js";
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
  type CoreDatabaseModuleId,
} from "./tenDatabaseKeys.js";
import { SENSITIVE_DATABASE_KEYS } from "./sensitiveDatabaseKeys.js";
import { PROJECTS_OWNER_PROCESS } from "../projects/projectWriteTransform.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { createTasksTodayView } from "../tasks/todayView.js";
import { CALENDAR_MODULE_ID } from "../calendar/calendarModuleId.js";
import { EVENT_OCCURRENCE_DATE_PROPERTY_KEY, EVENT_SERIES_ID_PROPERTY_KEY } from "../calendar/eventOccurrenceId.js";
import {
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_ID_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_TIME_ZONE_PROPERTY_KEY,
} from "../calendar/syncedEventKeys.js";
import { createProps, selectConfig, type PropSpec } from "./propSpecs.js";

export type TenDatabases = Record<CoreDatabaseModuleId, DatabaseRow>;

/** `name` is the canonical label as documentation only: every property here is stored with a null name. */
function createBuiltInProps(
  client: PoolClient,
  databaseId: string,
  specs: readonly (PropSpec & { name: string | null })[],
): Promise<void> {
  return createProps(
    client,
    databaseId,
    specs.map((spec) => ({ ...spec, name: null })),
  );
}

/** `key` is both `databases.key` and `owner_module_id`; the `name` of a system database is null (labels come from the catalog). */
async function createDb(client: PoolClient, key: CoreDatabaseModuleId): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, {
    name: null,
    key,
    system: true,
    ownerModuleId: key,
    sensitive: SENSITIVE_DATABASE_KEYS.includes(key),
  });
}

/**
 * Creates the hardcoded core databases, their properties, relations and default views in the caller's
 * transaction: unlocked, own properties then relations, locked once complete. Not idempotent.
 */
export async function seedTenDatabasesInTransaction(
  client: PoolClient,
  viewTypeRegistry: ViewTypeRegistry,
  computedKeyRegistry: ComputedKeyRegistry,
  moduleRegistry: ModuleRegistry,
): Promise<TenDatabases> {
  // Relation property names are forced to null like other built-in properties; call sites spell out the
  // label as documentation.
  const relate = (
    input: CreateRelationPropertyInput,
    context?: SystemRelationWriteContext,
  ): Promise<{ property: unknown; inverseProperty: unknown }> =>
    createRelationPropertyWithClient(
      client,
      { ...input, name: null, inverse: input.inverse ? { ...input.inverse, name: null } : undefined },
      context,
      computedKeyRegistry,
    );

  // ---- phase 1: each database and its own (non-relation) properties ----
  const projects = await createDb(client, PROJECTS_MODULE_ID);
  await createBuiltInProps(client, projects.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "pinned", name: "Pinned", type: "checkbox", owner: "user" },
    { key: "pinnedOrder", name: null, type: "number", owner: "user" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "user",
      config: {
        ...selectConfig(["inProgress", "longTerm", "done", "archived"], {
          inProgress: "#007AFF",
          longTerm: "#AF52DE",
          done: "#34C759",
          archived: "#8E8E93",
        }),
        default: "inProgress",
      },
    },
    { key: "date", name: "Date", type: "date", owner: "user" },
    { key: "completedAt", name: null, type: "date", owner: "system", ownerProcess: PROJECTS_OWNER_PROCESS },
    { key: "color", name: "Color", type: "color", owner: "user" },
    // No shipped options: a person adds each tag through the option operations.
    { key: "tags", name: "Tags", type: "multi_select", owner: "user", config: selectConfig([]) },
    // An AGENT.md equivalent; `sections` names the fixed structure a client renders as fields within one
    // longText value.
    {
      key: "agents",
      name: "AGENT.md",
      type: "longText",
      owner: "user",
      locked: true,
      config: { sections: ["purpose", "allowed", "notAllowed", "generalInstructions"] },
    },
    // Only set for system-module projects, which can be deactivated but never deleted.
    { key: "systemActive", name: "System active", type: "checkbox", owner: "user", locked: true },
  ]);

  const tasks = await createDb(client, TASKS_MODULE_ID);
  await createBuiltInProps(client, tasks.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "user",
      config: { ...selectConfig(["notDone", "done", "wontDo", "missed"]), default: "notDone" },
    },
    { key: "date", name: "Date", type: "date", owner: "user" },
    { key: "timeFrom", name: "Time from", type: "time", owner: "user" },
    { key: "timeTo", name: "Time to", type: "time", owner: "user" },
    // Derived from timeFrom/timeTo; the generic update path refuses it (system-owned).
    { key: "time", name: "Time", type: "time", owner: "system", ownerProcess: TASKS_MODULE_ID, locked: true },
    { key: "flagged", name: null, type: "checkbox", owner: "user" },
    { key: "description", name: null, type: "longText", owner: "user" },
    { key: "since", name: null, type: "date", owner: "system", ownerProcess: TASKS_MODULE_ID },
    { key: "sinceTime", name: null, type: "json", owner: "system", ownerProcess: TASKS_MODULE_ID },
    { key: "completedOn", name: null, type: "date", owner: "user" },
    {
      key: "completedAt",
      name: null,
      type: "date",
      owner: "system",
      ownerProcess: TASKS_MODULE_ID,
      config: { includeTime: true },
    },
    {
      key: "hiddenUntil",
      name: null,
      type: "date",
      owner: "system",
      ownerProcess: TASKS_MODULE_ID,
      config: { includeTime: true },
    },
    { key: "effectiveDate", name: null, type: "date", owner: "system", ownerProcess: TASKS_MODULE_ID },
    { key: "seriesId", name: null, type: "text", owner: "system", ownerProcess: TASKS_MODULE_ID },
    { key: "occurrenceDate", name: null, type: "date", owner: "system", ownerProcess: TASKS_MODULE_ID },
    { key: "recurrence", name: null, type: "json", owner: "system", ownerProcess: TASKS_MODULE_ID },
    { key: "notifications", name: "Notifications", type: "checkbox", owner: "user" },
  ]);

  const people = await createDb(client, PEOPLE_MODULE_ID);
  await createBuiltInProps(client, people.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // A closed but extensible list, not free text.
    {
      key: "relationship",
      name: "Relationship",
      type: "select",
      owner: "user",
      config: selectConfig(
        ["client", "closeFriend", "parent", "girlfriend", "therapist", "neighbor", "colleague", "craftsman", "doctor"],
        {
          client: "#007AFF",
          closeFriend: "#AF52DE",
          parent: "#FF9500",
          girlfriend: "#FF2D55",
          therapist: "#34C759",
          neighbor: "#8E8E93",
          colleague: "#8E8E93",
          craftsman: "#8E8E93",
          doctor: "#8E8E93",
        },
      ),
    },
    // Canonical values stay English camelCase; any icon is presentational.
    { key: "contact", name: "Contact", type: "select", owner: "user", config: selectConfig(["phone", "email"]) },
    { key: "phones", name: "Phones", type: "longText", owner: "user" },
    // Derived from the person's past Events, Emails and Transcripts; written only by `people/lastContact.ts`.
    { key: "lastContact", name: "Last contact", type: "date", owner: "system", ownerProcess: PEOPLE_MODULE_ID },
    // The calendar's birthday source reads month and day; an unknown year stores a placeholder leap year with
    // `birthdayYearKnown` false.
    { key: "birthday", name: "Birthday", type: "date", owner: "user" },
    { key: "birthdayYearKnown", name: "Year known", type: "checkbox", owner: "user" },
  ]);

  const files = await createDb(client, FILES_MODULE_ID);
  await createBuiltInProps(client, files.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    {
      key: "type",
      name: "Type",
      type: "select",
      owner: "user",
      config: selectConfig(["pdf", "xlsx", "docx", "jpg", "png", "heic", "audio"], {
        pdf: "#FF3B30",
        xlsx: "#34C759",
        docx: "#007AFF",
        jpg: "#FF9500",
      }),
    },
    { key: "date", name: "Date", type: "date", owner: "user", config: { default: "today" } },
    // { blobId } over the shared `blobs` table.
    { key: "file", name: "File", type: "file", owner: "user" },
  ]);

  const events = await createDb(client, EVENTS_MODULE_ID);
  await createBuiltInProps(client, events.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    {
      key: "type",
      name: "Type",
      type: "select",
      owner: "user",
      config: selectConfig(["meeting", "standup", "event"], {
        meeting: "#AF52DE",
        standup: "#007AFF",
        event: "#FF3B30",
      }),
    },
    { key: "date", name: "Date", type: "date", owner: "user" },
    // Calendar time model (wall-clock values in the tenant time zone); no `timeFrom` means all-day.
    { key: "endDate", name: "End date", type: "date", owner: "user" },
    { key: "timeFrom", name: "Time from", type: "time", owner: "user" },
    { key: "timeTo", name: "Time to", type: "time", owner: "user" },
    { key: "time", name: "Time", type: "time", owner: "system", locked: true },
    { key: "place", name: "Place", type: "text", owner: "user" },
    { key: "url", name: "URL", type: "url", owner: "user" },
    { key: "description", name: "Description", type: "longText", owner: "user" },
    { key: "alertMinutes", name: "Alert minutes", type: "number", owner: "user" },
    { key: "travelMinutes", name: "Travel minutes", type: "number", owner: "user" },
    // Computed by `calendar/eventIcalIdentityTransform.ts`.
    { key: "icalUid", name: "iCalendar UID", type: "text", owner: "system", locked: true },
    { key: "icalSequence", name: "iCalendar sequence", type: "number", owner: "system", locked: true },
    // Validated by `calendar/eventRecurrenceHook.ts`.
    { key: "recurrence", name: "Recurrence", type: "json", owner: "user" },
    // Nearest occurrence from today (tenant zone), refreshed daily, so generic sort/group/filter work on recurring Events.
    { key: "nextOccurrenceDate", name: "Next occurrence date", type: "date", owner: "system", locked: true },
    // Identity of a materialized occurrence of a recurring Event; written only by
    // `calendar/materializeEventOccurrence.ts`.
    {
      key: EVENT_SERIES_ID_PROPERTY_KEY,
      name: "Series ID",
      type: "text",
      owner: "system",
      ownerProcess: CALENDAR_MODULE_ID,
    },
    {
      key: EVENT_OCCURRENCE_DATE_PROPERTY_KEY,
      name: "Occurrence date",
      type: "date",
      owner: "system",
      ownerProcess: CALENDAR_MODULE_ID,
    },
    // A synced Event's provider fields, written by the calendar sync (`calendar/syncedEventFields.ts` admits that
    // writer only, plus the calendar module's own clearing and override copies). No owner process: the sync writes
    // them together with `seriesId`, and the Events pre-write transform clears the raw rule.
    // IANA zone of `date`/`timeFrom`/`endDate`/`timeTo`; none means the tenant's zone.
    { key: EVENT_TIME_ZONE_PROPERTY_KEY, name: "Time zone", type: "text", owner: "system" },
    // Raw RRULE of a series, instead of `recurrence`.
    { key: EVENT_RECURRENCE_RULE_PROPERTY_KEY, name: "Recurrence rule", type: "text", owner: "system" },
    // Starts the raw rule excludes: days or `YYYY-MM-DDTHH:MM` in the Event's zone.
    { key: EVENT_EXCEPTION_DATES_PROPERTY_KEY, name: "Exception dates", type: "json", owner: "system" },
    // On an override (an occurrence item of a synced series): the original start it replaces, as above.
    { key: EVENT_RECURRENCE_ID_PROPERTY_KEY, name: "Recurrence ID", type: "text", owner: "system" },
  ]);

  const healthRecords = await createDb(client, HEALTH_RECORDS_MODULE_ID);
  await createBuiltInProps(client, healthRecords.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "date", name: "Date", type: "date", owner: "user" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "user",
      config: selectConfig(["monitoring", "resolved"], { monitoring: "#FF9500", resolved: "#34C759" }),
    },
    // Text, not a relation to People: it also covers pets.
    { key: "subject", name: "Subject", type: "text", owner: "user" },
    {
      key: "type",
      name: "Type",
      type: "select",
      owner: "user",
      config: selectConfig(["health", "condition", "symptom"]),
    },
    {
      key: "tags",
      name: "Tags",
      type: "multi_select",
      owner: "user",
      config: selectConfig(["bloodTests", "medication", "epilepsy", "dentalHygiene", "bloodPressure", "prevention"], {
        bloodTests: "#FF9500",
        medication: "#AF52DE",
        bloodPressure: "#FF2D55",
        prevention: "#34C759",
      }),
    },
  ]);

  const companies = await createDb(client, COMPANIES_MODULE_ID);
  await createBuiltInProps(client, companies.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // Deliberate exception to English keys: the Czech IČO company id has no honest English name.
    { key: "ico", name: "ICO", type: "text", owner: "user" },
    { key: "web", name: "Web", type: "url", owner: "user" },
  ]);

  const transcripts = await createDb(client, TRANSCRIPTS_MODULE_ID);
  await createBuiltInProps(client, transcripts.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // A pipeline status written only by the transcription process; not user-editable.
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "system",
      ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
      config: selectConfig(["recording", "processing", "done", "error"]),
    },
    // The recording time, not user input.
    {
      key: "date",
      name: "Date",
      type: "date",
      owner: "system",
      ownerProcess: TRANSCRIPTION_OWNER_PROCESS,
      config: { includeTime: true },
    },
    { key: "notes", name: "Notes", type: "longText", owner: "user" },
    { key: "link", name: "Link", type: "url", owner: "system", ownerProcess: TRANSCRIPTION_OWNER_PROCESS },
    // `segments`/`summaryByInstruction` live in items.computed, not as properties.
  ]);

  const journal = await createDb(client, JOURNAL_MODULE_ID);
  await createBuiltInProps(client, journal.id, [
    { key: "name", name: "Name", type: "title", owner: "system" },
    { key: "type", name: "Type", type: "select", owner: "system", config: selectConfig([...JOURNAL_PERIOD_TYPES]) },
    { key: "period", name: "Period", type: "text", owner: "system" },
  ]);

  // ---- phase 2: relations (every target exists, so order does not matter) ----

  await relate({
    sourceDatabaseId: tasks.id,
    key: "people",
    name: null,
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
    inverse: { key: "tasks", name: null },
  });
  await relate({
    sourceDatabaseId: tasks.id,
    key: "files",
    name: null,
    targetDatabaseId: files.id,
    cardinality: "many_to_many",
    inverse: { key: "tasks", name: null },
  });
  await relate(
    {
      sourceDatabaseId: tasks.id,
      key: "hostEvents",
      name: null,
      targetDatabaseId: events.id,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: TASKS_MODULE_ID,
      inverse: { key: "hostedTasks", name: null, owner: "system", ownerProcess: TASKS_MODULE_ID },
    },
    { ownerProcess: TASKS_MODULE_ID },
  );
  await relate(
    {
      sourceDatabaseId: events.id,
      key: "completedTasks",
      name: null,
      targetDatabaseId: tasks.id,
      cardinality: "one_to_many",
      owner: "system",
      ownerProcess: TASKS_MODULE_ID,
      inverse: { key: "completedInEvent", name: null, owner: "system", ownerProcess: TASKS_MODULE_ID },
    },
    { ownerProcess: TASKS_MODULE_ID },
  );

  // Projects <-> Companies (N:1): Companies.projects is property A; Projects.company is single-valued.
  await relate({
    sourceDatabaseId: companies.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "one_to_many",
    inverse: { key: "company", name: "Company" },
  });
  // Tasks -> Projects (hub backlink), optional (relations carry no NOT NULL). Projects.tasks is property A;
  // Tasks.project is single-valued.
  await relate({
    sourceDatabaseId: projects.id,
    key: "tasks",
    name: "Tasks",
    targetDatabaseId: tasks.id,
    cardinality: "one_to_many",
    inverse: { key: "project", name: "Project" },
  });
  // People -> Projects (hub backlink).
  await relate({
    sourceDatabaseId: people.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
    inverse: { key: "people", name: "People" },
  });
  // People <-> Companies: N:N, so a person keeps both current and former company links.
  await relate({
    sourceDatabaseId: people.id,
    key: "companies",
    name: "Companies",
    targetDatabaseId: companies.id,
    cardinality: "many_to_many",
    inverse: { key: "people", name: "People" },
  });
  // Files -> Projects (hub backlink).
  await relate({
    sourceDatabaseId: files.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
    inverse: { key: "files", name: "Files" },
  });
  // Files <-> Health records: explicit bidirectional attachments.
  await relate({
    sourceDatabaseId: files.id,
    key: "healthRecords",
    name: "Health records",
    targetDatabaseId: healthRecords.id,
    cardinality: "many_to_many",
    inverse: { key: "files", name: "Files" },
  });
  // Files <-> Companies: explicit bidirectional attachments.
  await relate({
    sourceDatabaseId: files.id,
    key: "companies",
    name: "Companies",
    targetDatabaseId: companies.id,
    cardinality: "many_to_many",
    inverse: { key: "files", name: "Files" },
  });
  // Events -> Projects (hub backlink): Projects.events is property A; Events.project is single-valued.
  await relate({
    sourceDatabaseId: projects.id,
    key: "events",
    name: "Events",
    targetDatabaseId: events.id,
    cardinality: "one_to_many",
    inverse: { key: "project", name: "Project" },
  });
  // Events <-> Files: files attached to an event.
  await relate({
    sourceDatabaseId: events.id,
    key: "files",
    name: "Files",
    targetDatabaseId: files.id,
    cardinality: "many_to_many",
    owner: "user",
    inverse: { key: "events", name: "Events", owner: "user" },
  });
  // Events <-> People: an Event's participants (`People.events`).
  await relate({
    sourceDatabaseId: events.id,
    key: "people",
    name: "People",
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
    inverse: { key: "events", name: "Events" },
  });
  // Events <-> Transcripts: one Event, many transcripts (the parts of one meeting). Events.transcript is
  // property A, so `enforce_relation_cardinality` guards only the transcript side.
  await relate({
    sourceDatabaseId: events.id,
    key: "transcript",
    name: "Transcript",
    targetDatabaseId: transcripts.id,
    cardinality: "one_to_many",
    inverse: { key: "event", name: "Event" },
  });
  // Events <-> Tasks: action items and their source events.
  await relate({
    sourceDatabaseId: events.id,
    key: "actionItems",
    name: "Action items",
    targetDatabaseId: tasks.id,
    cardinality: "many_to_many",
    inverse: { key: "sourceEvents", name: null },
  });
  // Events <-> Companies ("meetings").
  await relate({
    sourceDatabaseId: events.id,
    key: "company",
    name: "Company",
    targetDatabaseId: companies.id,
    cardinality: "many_to_many",
    inverse: { key: "meetings", name: "Meetings" },
  });
  // Health records -> Projects (hub backlink).
  await relate({
    sourceDatabaseId: healthRecords.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
    inverse: { key: "healthRecords", name: "Health records" },
  });
  // Tasks <-> Health records: a follow-up task and its records.
  await relate({
    sourceDatabaseId: tasks.id,
    key: "healthRecords",
    name: "Health records",
    targetDatabaseId: healthRecords.id,
    cardinality: "many_to_many",
    owner: "user",
    inverse: { key: "tasks", name: "Tasks", owner: "user" },
  });
  // Transcripts -> People ("speakers"): one-directional; each edge maps a diarization speaker key to a
  // person via { speaker } metadata, validated by `assertSpeakerEdgeWritable`.
  await relate({
    sourceDatabaseId: transcripts.id,
    key: "speakers",
    name: "Speakers",
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
  });
  // Transcripts <-> Projects / Companies: a transcript has at most one of each, so the "many"
  // side (`Projects.transcripts`, `Companies.transcripts`) is property A of `one_to_many`.
  await relate({
    sourceDatabaseId: projects.id,
    key: "transcripts",
    name: "Transcripts",
    targetDatabaseId: transcripts.id,
    cardinality: "one_to_many",
    inverse: { key: "project", name: "Project" },
  });
  await relate({
    sourceDatabaseId: companies.id,
    key: "transcripts",
    name: "Transcripts",
    targetDatabaseId: transcripts.id,
    cardinality: "one_to_many",
    inverse: { key: "company", name: "Company" },
  });
  // Transcripts <-> People ("people"): the recording's participants, separate from the mapped `speakers`.
  await relate({
    sourceDatabaseId: transcripts.id,
    key: "people",
    name: "People",
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
    inverse: { key: "transcripts", name: "Transcripts" },
  });
  await relate({
    sourceDatabaseId: journal.id,
    key: "project",
    name: null,
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
  });
  // Journal -> Events: derived from the event links in the entry's page, so system-owned by that sync's
  // process; one-directional.
  await relate(
    {
      sourceDatabaseId: journal.id,
      key: "events",
      name: null,
      targetDatabaseId: events.id,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: JOURNAL_EVENT_LINKS_OWNER_PROCESS,
    },
    { ownerProcess: JOURNAL_EVENT_LINKS_OWNER_PROCESS },
  );

  // ---- phase 3: lock every schema (system DBs are not user-editable) ----
  const all: TenDatabases = {
    [PROJECTS_MODULE_ID]: projects,
    [TASKS_MODULE_ID]: tasks,
    [PEOPLE_MODULE_ID]: people,
    [FILES_MODULE_ID]: files,
    [EVENTS_MODULE_ID]: events,
    [HEALTH_RECORDS_MODULE_ID]: healthRecords,
    [COMPANIES_MODULE_ID]: companies,
    [TRANSCRIPTS_MODULE_ID]: transcripts,
    [JOURNAL_MODULE_ID]: journal,
  };
  for (const database of Object.values(all)) {
    await client.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [database.id]);
  }

  // ---- phase 4: seed default views (created_by: 'system') ----
  registerTemporalSwitcherViewType(viewTypeRegistry);
  // `databases.name` is null for these, so the view's required `name` comes from the manifest label.
  const manifestDatabaseByKey = new Map((await moduleRegistry.getDatabases()).map((db) => [db.key, db]));
  for (const [moduleId, database] of Object.entries(all) as [CoreDatabaseModuleId, DatabaseRow][]) {
    const manifestDatabase = manifestDatabaseByKey.get(moduleId);
    const type = manifestDatabase?.defaultViewType ?? "table";
    await viewsStore.createView(
      client,
      { databaseId: database.id, type, name: manifestDatabase?.name ?? moduleId, isDefault: true, createdBy: "system" },
      viewTypeRegistry,
    );
  }
  // The Today system view, once the properties and relations its filter names exist.
  await createTasksTodayView(client, tasks.id, viewTypeRegistry);

  return all;
}
