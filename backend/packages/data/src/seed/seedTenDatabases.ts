import type { PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { createRelationPropertyWithClient, type CreateRelationPropertyInput } from "../chokePoint/chokePoint.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { registerTemporalSwitcherViewType } from "../views/temporalSwitcherViewType.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalStore.js";
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

export type TenDatabases = Record<TenDatabaseModuleId, DatabaseRow>;

function selectConfig(options: string[]): Record<string, unknown> {
  return { options };
}

interface PropSpec {
  key: string;
  /**
   * Kept only as inline documentation of the canonical label (useful once issue #146 ships a
   * translation catalog); a built-in property of a system database is stored with a null
   * `name` (issue #235) — `createProps` below never writes this string to the column.
   */
  name: string;
  type: PropertyType;
  owner?: PropertyOwner;
  locked?: boolean;
  config?: Record<string, unknown>;
}

/** `key` doubles as `databases.key` (issue #235) and `owner_module_id` — a system database's built-in `name` is always null; its display label comes from the future translation catalog (#146/#147). */
async function createDb(client: PoolClient, key: TenDatabaseModuleId): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, { name: null, key, system: true, ownerModuleId: key });
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
  const relate = (input: CreateRelationPropertyInput): Promise<{ property: unknown; inverseProperty: unknown }> =>
    createRelationPropertyWithClient(
      client,
      { ...input, name: null, inverse: input.inverse ? { ...input.inverse, name: null } : undefined },
      undefined,
      computedKeyRegistry,
    );

  // ---- phase 1: create each database and its own (non-relation) properties ----
  const areas = await createDb(client, AREAS_MODULE_ID);
  await createProps(client, areas.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "active", name: "Active", type: "checkbox", owner: "user" },
    { key: "note", name: "Note", type: "text", owner: "user" },
  ]);

  const projects = await createDb(client, PROJECTS_MODULE_ID);
  await createProps(client, projects.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "pinned", name: "Pinned", type: "checkbox", owner: "user" },
    {
      key: "status",
      name: "Status",
      type: "select",
      owner: "user",
      config: selectConfig(["inProgress", "done", "archived", "longTerm"]),
    },
    { key: "date", name: "Date", type: "date", owner: "user" },
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
      config: selectConfig(["notDone", "done", "wontDo"]),
    },
    { key: "date", name: "Date", type: "date", owner: "user" },
    { key: "timeFrom", name: "Time from", type: "time", owner: "user" },
    { key: "timeTo", name: "Time to", type: "time", owner: "user" },
    // Derived from timeFrom/timeTo; not directly editable — see the issue's "the generic
    // update path refuses this field" pattern (assertWritableProperties on owner:'system').
    { key: "time", name: "Time", type: "time", owner: "system", locked: true },
    { key: "notifications", name: "Notifications", type: "checkbox", owner: "user" },
    { key: "persistent", name: "Persistent", type: "checkbox", owner: "user" },
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
      config: selectConfig(["parent", "therapist", "closeFriend", "girlfriend", "client", "neighbor"]),
    },
    // Canonical values stay plain English camelCase per the canonical-keys skill; the
    // mock's emoji (📞/✉️) is presentational and belongs to the not-yet-built i18n/UI layer.
    { key: "contact", name: "Contact", type: "select", owner: "user", config: selectConfig(["phone", "email"]) },
  ]);

  const files = await createDb(client, FILES_MODULE_ID);
  await createProps(client, files.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "type", name: "Type", type: "select", owner: "user", config: selectConfig(["pdf", "xlsx", "docx", "jpg"]) },
    { key: "date", name: "Date", type: "date", owner: "user" },
    // { blobId } over the shared `blobs` table (0004_ten_databases.sql).
    { key: "file", name: "File", type: "file", owner: "user" },
  ]);

  const events = await createDb(client, EVENTS_MODULE_ID);
  await createProps(client, events.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "type", name: "Type", type: "select", owner: "user", config: selectConfig(["event", "standup", "meeting"]) },
    { key: "date", name: "Date", type: "date", owner: "user", config: { includeTime: true } },
  ]);

  const healthRecords = await createDb(client, HEALTH_RECORDS_MODULE_ID);
  await createProps(client, healthRecords.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "date", name: "Date", type: "date", owner: "user" },
    { key: "status", name: "Status", type: "select", owner: "user", config: selectConfig(["resolved", "monitoring"]) },
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
      config: selectConfig(["bloodTests", "medication", "epilepsy", "dentalHygiene"]),
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
      config: selectConfig(["recording", "processing", "done", "error"]),
    },
    // The recording time, not user input.
    { key: "date", name: "Date", type: "date", owner: "system", config: { includeTime: true } },
    { key: "notes", name: "Notes", type: "longText", owner: "user" },
    { key: "link", name: "Link", type: "url", owner: "system" },
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
  // Areas <-> Companies: explicit bidirectional, 1:1 per the issue.
  await relate({
    sourceDatabaseId: areas.id,
    key: "company",
    name: "Company",
    targetDatabaseId: companies.id,
    cardinality: "one_to_one",
    inverse: { key: "area", name: "Area" },
  });
  // Fix: Areas <-> Health records was one-directional (from Areas) in the mock; unified to bidirectional.
  await relate({
    sourceDatabaseId: areas.id,
    key: "healthRecord",
    name: "Health record",
    targetDatabaseId: healthRecords.id,
    cardinality: "one_to_one",
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
  // Events -> People: one-directional only (People's own relation list doesn't name Events).
  await relate({
    sourceDatabaseId: events.id,
    key: "people",
    name: "People",
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
  });
  // Events <-> Transcripts: explicit bidirectional 1:1.
  await relate({
    sourceDatabaseId: events.id,
    key: "transcript",
    name: "Transcript",
    targetDatabaseId: transcripts.id,
    cardinality: "one_to_one",
    inverse: { key: "event", name: "Event" },
  });
  // Events -> Tasks (action items from a meeting): one-directional only (Tasks' own relation list doesn't name Events).
  await relate({
    sourceDatabaseId: events.id,
    key: "actionItems",
    name: "Action items",
    targetDatabaseId: tasks.id,
    cardinality: "many_to_many",
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
  // Transcripts -> People ("speakers"): one-directional; edges carry { speaker } metadata,
  // written by the transcription pipeline (a later issue), not here.
  await relate({
    sourceDatabaseId: transcripts.id,
    key: "speakers",
    name: "Speakers",
    targetDatabaseId: people.id,
    cardinality: "many_to_many",
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

  return all;
}
