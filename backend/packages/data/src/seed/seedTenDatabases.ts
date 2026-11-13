import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
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
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
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
  type TenDatabaseModuleId,
} from "./tenDatabaseKeys.js";
import { ensureUnplannedArea } from "./seedUnplannedArea.js";
import { SENSITIVE_DATABASE_KEYS } from "./sensitiveDatabaseKeys.js";
import { PROJECTS_OWNER_PROCESS } from "../projects/projectWriteTransform.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { createTasksTodayView } from "../tasks/todayView.js";

export type TenDatabases = Record<TenDatabaseModuleId, DatabaseRow>;

// Issue #145: every shipped catalog option `s` becomes `{ key: s }` — no `label`, since a
// shipped option's display text is not an override (see SelectOption's doc comment).
function selectConfig(options: string[], colors: Record<string, string> = {}): Record<string, unknown> {
  return { options: options.map((key) => ({ key, ...(colors[key] ? { color: colors[key] } : {}) })) };
}

interface PropSpec {
  key: string;
  /**
   * Kept only as inline documentation of the canonical label (useful once issue #146 ships a
   * translation catalog); a built-in property of a system database is stored with a null
   * `name` (issue #235) — `createProps` below never writes this string to the column.
   */
  name: string | null;
  type: PropertyType;
  owner?: PropertyOwner;
  ownerProcess?: string;
  locked?: boolean;
  config?: Record<string, unknown>;
}

/** `key` doubles as `databases.key` (issue #235) and `owner_module_id` — a system database's built-in `name` is always null; its display label comes from the future translation catalog (#146/#147). */
async function createDb(client: PoolClient, key: TenDatabaseModuleId): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, {
    name: null,
    key,
    system: true,
    ownerModuleId: key,
    sensitive: SENSITIVE_DATABASE_KEYS.includes(key),
  });
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, {
      databaseId,
      key: spec.key,
      // Null, not spec.name — see PropSpec.name's doc comment.
      name: null,
      type: spec.type,
      owner: spec.owner,
      ownerProcess: spec.ownerProcess,
      locked: spec.locked,
      config: spec.config,
    });
  }
}

/**
 * Creates the ten hardcoded databases (issue #24), their fixed properties, the real
 * relations between them (including the bidirectional ones and the three mock-inconsistency
 * fixes), and a default `created_by: 'system'` view for each — all against an already-open
 * `client`/transaction, so the caller (seed/seedSystem.ts) can compose this with the rest of
 * system bootstrapping atomically. Every database is created unlocked, built up across two
 * passes (own properties, then relations — so every relation's target database already
 * exists regardless of declaration order), and locked only once its full schema is in place,
 * mirroring seedSystem.ts's existing Projects/System settings pattern.
 *
 * Not idempotent on its own — the caller is responsible for the idempotency check (see
 * seedSystem.ts), same as the rest of that seed.
 */
export async function seedTenDatabasesInTransaction(
  client: PoolClient,
  viewTypeRegistry: ViewTypeRegistry,
  computedKeyRegistry: ComputedKeyRegistry,
  moduleRegistry: ModuleRegistry,
): Promise<TenDatabases> {
  // `input.name`/`input.inverse.name` below are always overridden to null: a relation property
  // of one of these ten databases is as much a built-in property as the plain ones `createProps`
  // creates, so it gets the same null-name treatment (issue #235). Each call site below still
  // spells out its intended label as documentation for the future translation catalog (#146).
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

  // ---- phase 1: create each database and its own (non-relation) properties ----
  const areas = await createDb(client, AREAS_MODULE_ID);
  await createProps(client, areas.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "active", name: "Active", type: "checkbox", owner: "user", config: { default: true } },
    { key: "systemActive", name: null, type: "checkbox", owner: "user", locked: true },
    { key: "note", name: "Note", type: "text", owner: "user" },
    { key: "icon", name: null, type: "text", owner: "user" },
    { key: "color", name: null, type: "color", owner: "user" },
    { key: "position", name: null, type: "number", owner: "user" },
  ]);

  await ensureUnplannedArea(client, areas.id);

  const projects = await createDb(client, PROJECTS_MODULE_ID);
  await createProps(client, projects.id, [
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
    // A 4-section equivalent of an AGENT.md; `sections` names the fixed structure a client
    // renders as separate fields within this one longText value, not four separate columns.
    {
      key: "agents",
      name: "AGENT.md",
      type: "longText",
      owner: "user",
      locked: true,
      config: { sections: ["purpose", "allowed", "notAllowed", "generalInstructions"] },
    },
    // Present in the schema for every project; only ever set for system-module projects
    // (Email, Personal finance, ...), which can be deactivated but never deleted.
    { key: "systemActive", name: "System active", type: "checkbox", owner: "user", locked: true },
  ]);

  const tasks = await createDb(client, TASKS_MODULE_ID);
  await createProps(client, tasks.id, [
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
    // Derived from timeFrom/timeTo; not directly editable — see the issue's "the generic
    // update path refuses this field" pattern (assertWritableProperties on owner:'system').
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
  await createProps(client, people.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // A closed but extensible list, not free text — starting values taken from the mock.
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
    // Canonical values stay plain English camelCase per the canonical-keys skill; the
    // mock's emoji (📞/✉️) is presentational and belongs to the not-yet-built i18n/UI layer.
    { key: "contact", name: "Contact", type: "select", owner: "user", config: selectConfig(["phone", "email"]) },
    { key: "phones", name: "Phones", type: "longText", owner: "user" },
    // Issue #1660: derived from the person's past Events, Emails and Transcripts, written only by
    // `people/lastContact.ts`'s recompute; populated installs get it from the People lastContact cutover.
    { key: "lastContact", name: "Last contact", type: "date", owner: "system", ownerProcess: PEOPLE_MODULE_ID },
    // Issue #1795: the calendar's birthday source reads the month and day. A person whose year is unknown stores
    // a placeholder leap year with `birthdayYearKnown` false; populated installs get both from the People
    // birthday cutover.
    { key: "birthday", name: "Birthday", type: "date", owner: "user" },
    { key: "birthdayYearKnown", name: "Year known", type: "checkbox", owner: "user" },
  ]);

  const files = await createDb(client, FILES_MODULE_ID);
  await createProps(client, files.id, [
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
    // { blobId } over the shared `blobs` table (0004_ten_databases.sql).
    { key: "file", name: "File", type: "file", owner: "user" },
  ]);

  const events = await createDb(client, EVENTS_MODULE_ID);
  await createProps(client, events.id, [
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
    { key: "date", name: "Date", type: "date", owner: "user", config: { includeTime: true } },
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
    // The iCalendar identity of an Event (issue #1599), computed by `calendar/eventIcalIdentityTransform.ts`;
    // a populated tenant gets the same two definitions from `calendar/eventsIcalIdentityCutoverMigration.ts`.
    { key: "icalUid", name: "iCalendar UID", type: "text", owner: "system", locked: true },
    { key: "icalSequence", name: "iCalendar sequence", type: "number", owner: "system", locked: true },
    // The fixed recurrence rule of an Event (issue gh-1817), judged by `calendar/eventRecurrenceHook.ts`; a populated
    // tenant gets the same definition from `calendar/eventsRecurrenceCutoverMigration.ts`.
    { key: "recurrence", name: "Recurrence", type: "json", owner: "user" },
  ]);

  const healthRecords = await createDb(client, HEALTH_RECORDS_MODULE_ID);
  await createProps(client, healthRecords.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "date", name: "Date", type: "date", owner: "user" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "user",
      config: selectConfig(["monitoring", "resolved"], { monitoring: "#FF9500", resolved: "#34C759" }),
    },
    // Stays text, not a relation to People: also covers pets, which don't and shouldn't
    // exist in the People database.
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
  await createProps(client, companies.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // Deliberate exception (canonical-keys skill): the Czech IČO company-registration id,
    // a domain term with no honest English name, already ASCII.
    { key: "ico", name: "ICO", type: "text", owner: "user" },
    { key: "web", name: "Web", type: "url", owner: "user" },
  ]);

  const transcripts = await createDb(client, TRANSCRIPTS_MODULE_ID);
  await createProps(client, transcripts.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    // Fix: purely a pipeline status: owner is 'system', written only by the transcription
    // process, not freely editable as in the mock. 'error' is a 4th value added on top of
    // the mock's three.
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
    // `segments`/`summaryByInstruction` deliberately live in items.computed (issue #21's
    // cache), not here — see the issue's "non-generic" note; not properties at all.
  ]);

  const journal = await createDb(client, JOURNAL_MODULE_ID);
  await createProps(client, journal.id, [
    { key: "name", name: "Name", type: "title", owner: "system" },
    { key: "type", name: "Type", type: "select", owner: "system", config: selectConfig([...JOURNAL_PERIOD_TYPES]) },
    { key: "period", name: "Period", type: "text", owner: "system" },
  ]);

  // ---- phase 2: relations — every target database above already exists, so declaration order doesn't matter here ----

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

  // Areas <-> Projects ("Hub"): one area has many projects. `property_id_a` is Areas.projects
  // (the "one" side, issue #82's cardinality contract), Projects.area/"Hub" is the inverse —
  // a project's own "Hub" field is single-valued and must be the side the enforced
  // `one_to_many` constraint lands on.
  await relate({
    sourceDatabaseId: areas.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "one_to_many",
    inverse: { key: "area", name: "Hub" },
  });
  await relate({
    sourceDatabaseId: areas.id,
    key: "events",
    name: "Events",
    targetDatabaseId: events.id,
    cardinality: "one_to_many",
    inverse: { key: "area", name: "Area" },
  });
  // Areas <-> Companies: an area can contain several companies.
  await relate({
    sourceDatabaseId: areas.id,
    key: "company",
    name: "Company",
    targetDatabaseId: companies.id,
    cardinality: "one_to_many",
    inverse: { key: "area", name: "Area" },
  });
  // Fix: Areas <-> Health records was one-directional (from Areas) in the mock; unified to bidirectional.
  await relate({
    sourceDatabaseId: areas.id,
    key: "healthRecord",
    name: "Health record",
    targetDatabaseId: healthRecords.id,
    cardinality: "one_to_many",
    inverse: { key: "area", name: "Area" },
  });
  // Fix: Projects <-> Companies was a free-form select ("Osobní"/"MeguMethod") in the mock;
  // unified with the existing Companies -> Projects relation into a real N:1 relation.
  // `property_id_a` is Companies.projects (the "one" side) — Projects.company is single-valued
  // and must be the inverse for the same reason as the Areas/Projects Hub above.
  await relate({
    sourceDatabaseId: companies.id,
    key: "projects",
    name: "Projects",
    targetDatabaseId: projects.id,
    cardinality: "one_to_many",
    inverse: { key: "company", name: "Company" },
  });
  // Tasks -> Projects (hub backlink), optional at the item level (relations carry no NOT NULL
  // in this engine). `property_id_a` is Projects.tasks (the "one" side) — Tasks.project is
  // single-valued and must be the inverse, same reasoning as above.
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
  // People <-> Companies: explicit bidirectional N:N — a person keeps both a current and a former company link.
  await relate({
    sourceDatabaseId: people.id,
    key: "companies",
    name: "Companies",
    targetDatabaseId: companies.id,
    cardinality: "many_to_many",
    inverse: { key: "people", name: "People" },
  });
  // Files -> Areas: one-directional only (neither side's relation list names the other beyond
  // this). `many_to_many`, not `one_to_many` (issue #82): Files.area is single-valued, so
  // `one_to_many`'s "item_b gets at most one edge" would wrongly cap each Area to one File,
  // and there's no inverse to swap this source/target pairing onto — same reasoning as
  // Emails.attachments/Inbox.type.
  await relate({
    sourceDatabaseId: files.id,
    key: "area",
    name: "Area",
    targetDatabaseId: areas.id,
    cardinality: "many_to_many",
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
  // Events -> Projects (hub backlink). `property_id_a` is Projects.events (the "one" side) —
  // Events.project is single-valued and must be the inverse, same reasoning as the other hub
  // backlinks above.
  await relate({
    sourceDatabaseId: projects.id,
    key: "events",
    name: "Events",
    targetDatabaseId: events.id,
    cardinality: "one_to_many",
    inverse: { key: "project", name: "Project" },
  });
  // Events <-> Files: files attached to an event (issue #1588). Populated installs get the same pair from
  // `blobs/eventsFilesRelationCutoverMigration.ts`.
  await relate({
    sourceDatabaseId: events.id,
    key: "files",
    name: "Files",
    targetDatabaseId: files.id,
    cardinality: "many_to_many",
    owner: "user",
    inverse: { key: "events", name: "Events", owner: "user" },
  });
  // Events <-> People: an Event's participants, read from the person as `People.events` (issue #1664). Populated
  // installs get the inverse from `calendar/peopleEventsInverseCutoverMigration.ts`.
  await relate({
    sourceDatabaseId: events.id,
    key: "people",
    name: "People",
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
    inverse: { key: "events", name: "Events" },
  });
  // Events <-> Transcripts: explicit bidirectional. One Event has many transcripts (the parts of one
  // meeting, each with its own summary); a transcript has at most one Event. `property_id_a` is
  // Events.transcript (the "one" side), so the trigger from 0013 guards only `item_b`, the transcript.
  // Populated installs seeded with the earlier `one_to_one` are cut over by
  // `transcription/eventTranscriptCardinalityCutoverMigration.ts`.
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
  // Fix: Events <-> Companies ("firma") was a free-form multiSelect in the mock, the same
  // inconsistency as Projects'; unified with the existing Companies -> Events ("meetings") relation.
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
  // Tasks <-> Health records: a follow-up task and the records it belongs to (issue #1836). Populated installs get
  // the same pair from `seed/healthRecordTasksCutoverMigration.ts`.
  await relate({
    sourceDatabaseId: tasks.id,
    key: "healthRecords",
    name: "Health records",
    targetDatabaseId: healthRecords.id,
    cardinality: "many_to_many",
    owner: "user",
    inverse: { key: "tasks", name: "Tasks", owner: "user" },
  });
  // Transcripts -> People ("speakers"): one-directional; each edge maps one diarization speaker
  // key to a person through its { speaker } metadata, which the choke point's relation write
  // validates (`transcription/transcriptionSpeakerEdges.ts`'s `assertSpeakerEdgeWritable`).
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
  // Journal -> Areas: optional, nullable, one-directional; no default value (issue's fix — the
  // mock hardwired every entry to a single "Osobní" area, which this issue explicitly rejects).
  // `many_to_many`, not `one_to_many` (issue #82) — same reasoning as Files.area above.
  await relate({
    sourceDatabaseId: journal.id,
    key: "area",
    name: "Area",
    targetDatabaseId: areas.id,
    cardinality: "many_to_many",
  });

  await relate({
    sourceDatabaseId: journal.id,
    key: "project",
    name: null,
    targetDatabaseId: projects.id,
    cardinality: "many_to_many",
  });
  // Journal -> Events (issue #1609): derived from the event links in the entry's page (#2016), so it is system-owned
  // by that sync's process; one-directional, with no inverse on Events.
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

  // ---- phase 3: lock every schema now that it's fully built (system DBs are not user-editable) ----
  const all: TenDatabases = {
    [AREAS_MODULE_ID]: areas,
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
  // `databases.name` is null for these ten (issue #235), so the view's own (still required,
  // unrelated) `name` column is sourced from the manifest's label instead.
  const manifestDatabaseByKey = new Map((await moduleRegistry.getDatabases()).map((db) => [db.key, db]));
  for (const [moduleId, database] of Object.entries(all) as [TenDatabaseModuleId, DatabaseRow][]) {
    const manifestDatabase = manifestDatabaseByKey.get(moduleId);
    const type = manifestDatabase?.defaultViewType ?? "table";
    await viewsStore.createView(
      client,
      { databaseId: database.id, type, name: manifestDatabase?.name ?? moduleId, isDefault: true, createdBy: "system" },
      viewTypeRegistry,
    );
  }
  // Issue #1798: the Today system view, after the properties and relations its filter names exist (phases 1 and 2).
  await createTasksTodayView(client, tasks.id, viewTypeRegistry);

  return all;
}
