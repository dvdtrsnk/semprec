import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { relatedRowContributorsFor, type RelatedCollectionRow } from "../chokePoint/relatedContributors.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { createMailThread } from "../mail/mailMessageMetaStore.js";
import { personMailThreadsRelatedRow } from "../mail/threadRelatedCount.js";
import { createCollectionMetadataResolver, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { registerRelatedRowContributor } from "../index.js";
import type { DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow } from "../types.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let resolver: CollectionMetadataResolver;
const databases = new Map<string, DatabaseRow>();

function inTenant<T>(work: () => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, work);
}

function database(key: string): DatabaseRow {
  const found = databases.get(key);
  if (!found) throw new Error(`Missing seeded database '${key}'`);
  return found;
}

function make(key: string, properties: Record<string, unknown> = {}): Promise<ItemRow> {
  return inTenant(() => cp.createItem({ databaseId: database(key).id, properties: { name: key, ...properties } }));
}

function makeEvent(properties: Record<string, unknown> = {}): Promise<ItemRow> {
  return make("events", { date: "2026-10-16", ...properties });
}

/** Links `from` to `to` through the relation property `key` of the database `from` belongs to, as a user write does. */
async function link(from: Pick<ItemRow, "id" | "databaseId">, key: string, to: Pick<ItemRow, "id">): Promise<void> {
  await inTenant(async () => {
    const property = (await cp.listProperties(from.databaseId)).find((candidate) => candidate.key === key);
    if (!property) throw new Error(`Missing relation property '${key}'`);
    await cp.createRelation({ relationPropertyId: property.id, callerItemId: from.id, targetItemId: to.id });
  });
}

function related(itemId: string, withResolver: CollectionMetadataResolver = resolver, reader?: DatabaseReader) {
  return inTenant(() => cp.listRelatedCollections(itemId, withResolver, reader));
}

async function relatedRows(itemId: string, withResolver: CollectionMetadataResolver = resolver) {
  const rows = await related(itemId, withResolver);
  if (rows === null) throw new Error(`Item ${itemId} is not found`);
  return rows;
}

function rowOf(rows: readonly RelatedCollectionRow[], databaseId: string): RelatedCollectionRow {
  const row = rows.find((candidate) => candidate.databaseId === databaseId);
  if (!row) throw new Error(`No row for database ${databaseId}`);
  return row;
}

function keysOf(rows: readonly RelatedCollectionRow[]): Array<string | null> {
  return rows.map((row) => row.databaseKey);
}

/** The ids a query of the row's database selects with the row's filter. */
async function selectedIds(row: RelatedCollectionRow): Promise<string[]> {
  if (row.filter === null) throw new Error("The row has no filter");
  const page = await inTenant(() => cp.queryDatabaseItems(row.databaseId, { filter: row.filter, limit: 200 }));
  return page.items.map((item) => item.id).sort();
}

/** Every row with a filter counts exactly the records its filter selects. */
async function expectCountsMatchFilters(rows: readonly RelatedCollectionRow[]): Promise<void> {
  for (const row of rows) {
    if (row.filter === null) continue;
    expect((await selectedIds(row)).length, `the filter of '${row.databaseKey}'`).toBe(row.count);
  }
}

/** The Journal entry of a day, through the lazy create. */
function journalEntry(): Promise<ItemRow> {
  return inTenant(() =>
    withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, database("journal").id, "day", new Date("2026-10-16T12:00:00Z"), "Europe/Prague"),
    ),
  );
}

function withClientVisible(base: CollectionMetadataResolver, hidden: ReadonlySet<string>): CollectionMetadataResolver {
  return {
    ...base,
    resolve: (database) => ({ ...base.resolve(database), clientVisible: !hidden.has(database.key ?? "") }),
  };
}

/** A user-created database; its items are created without properties. */
function userDatabase(name: string): Promise<DatabaseRow> {
  return inTenant(() => cp.createDatabase({ name }));
}

function userItem(db: DatabaseRow): Promise<ItemRow> {
  return inTenant(() => cp.createItem({ databaseId: db.id, properties: {} }));
}

/** A relation property of `source` that points at `target`, with or without an inverse property on `target`. */
async function relationBetween(source: DatabaseRow, target: DatabaseRow, key: string, inverseKey?: string) {
  await inTenant(() =>
    cp.createRelationProperty({
      sourceDatabaseId: source.id,
      key,
      name: key,
      targetDatabaseId: target.id,
      ...(inverseKey === undefined ? {} : { inverse: { key: inverseKey, name: inverseKey } }),
    }),
  );
}

describe("relation.related (issue #1839)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool));
    databases.clear();
    for (const db of await inTenant(() => cp.listDatabases())) if (db.key !== null) databases.set(db.key, db);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool.end();
  });

  describe("a project", () => {
    it("returns only the non-empty collections in the declared order and never Tasks", async () => {
      const project = await make("projects");
      const person = await make("people");
      const company = await make("companies");
      const file = await make("files");
      const event = await makeEvent();
      const task = await make("tasks");
      const healthRecord = await make("healthRecords");
      await make("events", { date: "2026-10-17" });
      await link(person, "projects", project);
      await link(company, "projects", project);
      await link(file, "projects", project);
      await link(event, "project", project);
      await link(task, "project", project);
      await link(healthRecord, "projects", project);

      const rows = await relatedRows(project.id);

      // Projects order: projects, events, files, threads, transcripts, companies, people, journal; Tasks is omitted and
      // Health records, which the declaration does not list, follows the listed collections.
      expect(keysOf(rows)).toEqual(["events", "files", "companies", "people", "healthRecords"]);
      expect(rows.map((row) => row.count)).toEqual([1, 1, 1, 1, 1]);
      expect(rows.every((row) => row.via === "direct")).toBe(true);
      expect(rowOf(rows, database("events").id).filter).toEqual({
        type: "relation_contains",
        property: "project",
        value: project.id,
      });
      expect(await selectedIds(rowOf(rows, database("events").id))).toEqual([event.id]);
      await expectCountsMatchFilters(rows);
    });

    it("counts the recordings of a project set on it and those of its events once", async () => {
      const project = await make("projects");
      const event = await makeEvent();
      await link(event, "project", project);
      const ownTranscript = await make("transcripts");
      const eventTranscript = await make("transcripts");
      const both = await make("transcripts");
      const unrelated = await make("transcripts");
      await link(ownTranscript, "project", project);
      await link(eventTranscript, "event", event);
      await link(both, "project", project);
      await link(both, "event", event);

      const rows = await relatedRows(project.id);

      const transcripts = rowOf(rows, database("transcripts").id);
      expect(transcripts).toMatchObject({ databaseKey: "transcripts", count: 3, via: "direct" });
      expect(await selectedIds(transcripts)).toEqual([ownTranscript.id, eventTranscript.id, both.id].sort());
      expect(await selectedIds(transcripts)).not.toContain(unrelated.id);
    });
  });

  describe("an area", () => {
    it("returns Projects including finished ones, and Tasks and Events through projects, and not Journal or People", async () => {
      const area = await make("areas");
      const otherArea = await make("areas");
      const active = await make("projects", { status: "inProgress" });
      const finished = await make("projects", { status: "done" });
      const elsewhere = await make("projects", { status: "inProgress" });
      await link(active, "area", area);
      await link(finished, "area", area);
      await link(elsewhere, "area", otherArea);
      const task = await make("tasks");
      const elsewhereTask = await make("tasks");
      await link(task, "project", finished);
      await link(elsewhereTask, "project", elsewhere);
      const projectEvent = await makeEvent();
      const ownEvent = await makeEvent();
      const otherEvent = await makeEvent();
      await link(projectEvent, "project", active);
      await link(ownEvent, "area", area);
      await link(otherEvent, "project", elsewhere);
      await link(await journalEntry(), "area", area);
      const person = await make("people");
      await link(person, "projects", active);

      const rows = await relatedRows(area.id);

      // Areas order: projects, tasks, events, files, threads, healthRecords, companies, people, books, movies.
      expect(keysOf(rows)).toEqual(["projects", "tasks", "events"]);
      expect(rows.map((row) => [row.count, row.via])).toEqual([
        [2, "direct"],
        [1, "project"],
        [2, "project"],
      ]);
      expect(await selectedIds(rowOf(rows, database("projects").id))).toEqual([active.id, finished.id].sort());
      expect(await selectedIds(rowOf(rows, database("tasks").id))).toEqual([task.id]);
      expect(await selectedIds(rowOf(rows, database("events").id))).toEqual([projectEvent.id, ownEvent.id].sort());
      expect(rows.some((row) => row.databaseKey === "journal" || row.databaseKey === "people")).toBe(false);
      await expectCountsMatchFilters(rows);
    });

    it("counts a file that has its own area and a project of that area once, and none whose project is in another area", async () => {
      const area = await make("areas");
      const otherArea = await make("areas");
      const project = await make("projects");
      const otherProject = await make("projects");
      await link(project, "area", area);
      await link(otherProject, "area", otherArea);
      const both = await make("files");
      const ownAreaOnly = await make("files");
      const projectOnly = await make("files");
      const otherProjectOwnArea = await make("files");
      await link(both, "area", area);
      await link(both, "projects", project);
      await link(ownAreaOnly, "area", area);
      await link(projectOnly, "projects", project);
      await link(otherProjectOwnArea, "area", area);
      await link(otherProjectOwnArea, "projects", otherProject);

      const files = rowOf(await relatedRows(area.id), database("files").id);

      expect(files).toMatchObject({ databaseKey: "files", count: 3, via: "project" });
      expect(await selectedIds(files)).toEqual([both.id, ownAreaOnly.id, projectOnly.id].sort());
    });

    it("drops a collection whose own-area records all belong to a project of another area", async () => {
      const area = await make("areas");
      const otherArea = await make("areas");
      const otherProject = await make("projects");
      await link(otherProject, "area", otherArea);
      const file = await make("files");
      await link(file, "area", area);
      await link(file, "projects", otherProject);

      const rows = await relatedRows(area.id);

      expect(keysOf(rows)).not.toContain("files");
    });

    it("stops counting a soft-deleted file and counts it again after the restore", async () => {
      const area = await make("areas");
      const project = await make("projects");
      await link(project, "area", area);
      const file = await make("files");
      await link(file, "area", area);
      await link(file, "projects", project);
      const filesId = database("files").id;
      expect(rowOf(await relatedRows(area.id), filesId).count).toBe(1);

      await inTenant(() => cp.softDeleteItem(filesId, file.id));
      expect(keysOf(await relatedRows(area.id))).not.toContain("files");

      await inTenant(() => cp.restoreItem(filesId, file.id));
      expect(rowOf(await relatedRows(area.id), filesId).count).toBe(1);
    });

    it("counts the companies of an area by their own area", async () => {
      const area = await make("areas");
      const company = await make("companies");
      await link(company, "area", area);
      await make("companies");

      const rows = await relatedRows(area.id);

      expect(rows).toEqual([
        {
          databaseKey: "companies",
          databaseId: database("companies").id,
          count: 1,
          via: "direct",
          filter: { type: "relation_contains", property: "area", value: area.id },
        },
      ]);
    });
  });

  describe("a company", () => {
    it("counts events of its projects through the project, and a company set on an event only without a project", async () => {
      const company = await make("companies");
      const otherCompany = await make("companies");
      const project = await make("projects");
      const otherProject = await make("projects");
      await link(company, "projects", project);
      await link(otherCompany, "projects", otherProject);
      const projectEvent = await makeEvent();
      const manualEvent = await makeEvent();
      const manualEventOfOtherProject = await makeEvent();
      await link(projectEvent, "project", project);
      await link(manualEvent, "company", company);
      await link(manualEventOfOtherProject, "company", company);
      await link(manualEventOfOtherProject, "project", otherProject);

      const events = rowOf(await relatedRows(company.id), database("events").id);

      expect(events).toMatchObject({ databaseKey: "events", count: 2, via: "project" });
      expect(await selectedIds(events)).toEqual([projectEvent.id, manualEvent.id].sort());
    });

    it("counts tasks, files and health records through its projects, and a file's own company only without a project", async () => {
      const company = await make("companies");
      const project = await make("projects");
      await link(company, "projects", project);
      const otherProject = await make("projects");
      const task = await make("tasks");
      const healthRecord = await make("healthRecords");
      const projectFile = await make("files");
      const ownCompanyFile = await make("files");
      const ownCompanyOfOtherProjectFile = await make("files");
      await link(task, "project", project);
      await link(healthRecord, "projects", project);
      await link(projectFile, "projects", project);
      await link(ownCompanyFile, "companies", company);
      await link(ownCompanyOfOtherProjectFile, "companies", company);
      await link(ownCompanyOfOtherProjectFile, "projects", otherProject);

      const rows = await relatedRows(company.id);

      expect(rows.map((row) => [row.databaseKey, row.count, row.via])).toEqual([
        ["projects", 1, "direct"],
        ["tasks", 1, "project"],
        ["files", 2, "project"],
        ["healthRecords", 1, "project"],
      ]);
      expect(await selectedIds(rowOf(rows, database("files").id))).toEqual([projectFile.id, ownCompanyFile.id].sort());
      await expectCountsMatchFilters(rows);
    });
  });

  describe("one-way relations", () => {
    it("counts a person's events and, from the target side, a one-directional relation without an inverse property", async () => {
      const person = await make("people");
      const event = await makeEvent();
      await link(event, "people", person);
      const notes = await userDatabase("Notes");
      await relationBetween(notes, database("people"), "mentions");
      const note = await userItem(notes);
      await inTenant(async () => {
        const property = (await cp.listProperties(notes.id)).find((candidate) => candidate.key === "mentions");
        await cp.createRelation({ relationPropertyId: property!.id, callerItemId: note.id, targetItemId: person.id });
      });

      const rows = await relatedRows(person.id);

      expect(rowOf(rows, database("events").id)).toMatchObject({ count: 1, via: "direct" });
      const notesRow = rowOf(rows, notes.id);
      expect(notesRow).toEqual({
        databaseKey: null,
        databaseId: notes.id,
        count: 1,
        via: "direct",
        filter: { type: "relation_contains", property: "mentions", value: person.id },
      });
      expect(await selectedIds(notesRow)).toEqual([note.id]);
    });

    it("reads a one-directional relation from its target side only, and gives no row for its origin side", async () => {
      const notes = await userDatabase("Notes");
      const topics = await userDatabase("Topics");
      await relationBetween(notes, topics, "topic");
      const note = await userItem(notes);
      const topic = await userItem(topics);
      await inTenant(async () => {
        const property = (await cp.listProperties(notes.id)).find((candidate) => candidate.key === "topic");
        await cp.createRelation({ relationPropertyId: property!.id, callerItemId: note.id, targetItemId: topic.id });
      });

      expect((await relatedRows(topic.id)).map((row) => row.databaseId)).toEqual([notes.id]);
      // Topics holds no property that points at Notes, so no filter of Topics could select the topic of a note.
      expect(await relatedRows(note.id)).toEqual([]);
    });

    it("counts the records of a database once whichever relation property connects them", async () => {
      const notes = await userDatabase("Notes");
      const topics = await userDatabase("Topics");
      await relationBetween(notes, topics, "main");
      await relationBetween(notes, topics, "side");
      const both = await userItem(notes);
      const sideOnly = await userItem(notes);
      const topic = await userItem(topics);
      await inTenant(async () => {
        const properties = await cp.listProperties(notes.id);
        for (const [key, note] of [
          ["main", both],
          ["side", both],
          ["side", sideOnly],
        ] as const) {
          const property = properties.find((candidate) => candidate.key === key);
          await cp.createRelation({ relationPropertyId: property!.id, callerItemId: note.id, targetItemId: topic.id });
        }
      });

      const [row] = await relatedRows(topic.id);

      expect(row).toMatchObject({
        count: 2,
        filter: {
          type: "or",
          nodes: [
            { type: "relation_contains", property: "main", value: topic.id },
            { type: "relation_contains", property: "side", value: topic.id },
          ],
        },
      });
      await expectCountsMatchFilters([row!]);
    });

    it("counts a self-relation from both of its sides", async () => {
      const pages = await userDatabase("Pages");
      await relationBetween(pages, pages, "children", "parent");
      const parent = await userItem(pages);
      const child = await userItem(pages);
      const grandparent = await userItem(pages);
      await inTenant(async () => {
        const property = (await cp.listProperties(pages.id)).find((candidate) => candidate.key === "children");
        await cp.createRelation({ relationPropertyId: property!.id, callerItemId: parent.id, targetItemId: child.id });
        await cp.createRelation({
          relationPropertyId: property!.id,
          callerItemId: grandparent.id,
          targetItemId: parent.id,
        });
      });

      const [row] = await relatedRows(parent.id);

      expect(row).toMatchObject({ databaseId: pages.id, count: 2 });
      expect(await selectedIds(row!)).toEqual([child.id, grandparent.id].sort());
    });
  });

  describe("which collections are listed", () => {
    it("leaves out an archived database and lists it again once restored", async () => {
      const notes = await userDatabase("Notes");
      const topics = await userDatabase("Topics");
      await relationBetween(notes, topics, "topic", "notes");
      const topic = await userItem(topics);
      const note = await userItem(notes);
      await link(note, "topic", topic);
      expect((await relatedRows(topic.id)).map((row) => row.databaseId)).toEqual([notes.id]);

      await inTenant(() => cp.archiveDatabase(notes.id));
      expect(await relatedRows(topic.id)).toEqual([]);

      await inTenant(() => cp.restoreDatabase(notes.id));
      expect((await relatedRows(topic.id)).map((row) => row.databaseId)).toEqual([notes.id]);
    });

    it("lists the collections of a record whose own database is archived", async () => {
      const notes = await userDatabase("Notes");
      const topics = await userDatabase("Topics");
      await relationBetween(notes, topics, "topic", "notes");
      const topic = await userItem(topics);
      const note = await userItem(notes);
      await link(note, "topic", topic);

      await inTenant(() => cp.archiveDatabase(topics.id));

      expect((await relatedRows(topic.id)).map((row) => row.databaseId)).toEqual([notes.id]);
    });

    it("skips the route of a database that is not listed", async () => {
      const company = await make("companies");
      const project = await make("projects");
      await link(company, "projects", project);
      const task = await make("tasks");
      await link(task, "project", project);
      expect(keysOf(await relatedRows(company.id))).toEqual(["projects", "tasks"]);

      // The API refuses to archive a system database; this is the state of a tenant whose Tasks database is not listed.
      await admin.query("UPDATE databases SET archived_at = now() WHERE id = $1", [database("tasks").id]);

      expect(keysOf(await relatedRows(company.id))).toEqual(["projects"]);
    });

    it("leaves out a collection that is empty because its only connected record is in the Trash", async () => {
      const notes = await userDatabase("Notes");
      const topics = await userDatabase("Topics");
      await relationBetween(notes, topics, "topic", "notes");
      const topic = await userItem(topics);
      const note = await userItem(notes);
      await link(note, "topic", topic);
      await inTenant(() => cp.softDeleteItem(notes.id, note.id));

      expect(await relatedRows(topic.id)).toEqual([]);
    });

    it("leaves out a system database that is not client-visible and keeps the others", async () => {
      const project = await make("projects");
      const event = await makeEvent();
      const file = await make("files");
      await link(event, "project", project);
      await link(file, "projects", project);

      const rows = await relatedRows(project.id, withClientVisible(resolver, new Set(["events"])));

      expect(keysOf(rows)).toEqual(["files"]);
    });

    it("orders collections the declaration does not list by display order, then user-created ones by name", async () => {
      const project = await make("projects");
      const healthRecord = await make("healthRecords");
      await link(healthRecord, "projects", project);
      const event = await makeEvent();
      await link(event, "project", project);
      const zeta = await userDatabase("Zeta");
      const alpha = await userDatabase("Alpha");
      for (const custom of [zeta, alpha]) {
        await relationBetween(custom, database("projects"), "project");
        const item = await userItem(custom);
        await link(item, "project", project);
      }

      const rows = await relatedRows(project.id);

      expect(rows.map((row) => row.databaseKey ?? row.databaseId)).toEqual([
        "events",
        "healthRecords",
        alpha.id,
        zeta.id,
      ]);
    });

    it("lists by display order alone when the resolver declares no related order or area filter", async () => {
      const area = await make("areas");
      const project = await make("projects");
      await link(project, "area", area);
      const file = await make("files");
      await link(file, "area", area);
      const bare: CollectionMetadataResolver = {
        resolve: (db) => resolver.resolve(db),
        overviewHideable: (db) => resolver.overviewHideable(db),
        collectionFilter: (db) => resolver.collectionFilter(db),
      };

      const rows = await relatedRows(area.id, bare);

      // Files has no route without a declared area filter, so it counts the file connected through Files.area.
      expect(rows.map((row) => [row.databaseKey, row.via])).toEqual([
        ["projects", "direct"],
        ["files", "direct"],
      ]);
      expect(rowOf(rows, database("files").id).filter).toEqual({
        type: "relation_contains",
        property: "area",
        value: area.id,
      });
    });
  });

  describe("authorization", () => {
    it("answers an unknown id, a trashed item and another tenant's id with null", async () => {
      const project = await make("projects");
      const trashed = await make("projects");
      await inTenant(() => cp.softDeleteItem(database("projects").id, trashed.id));
      const otherTenant = await createTestTenant(admin);
      await inTenant(() => seedSystem(pool), otherTenant);

      expect(await related(randomUUID())).toBeNull();
      expect(await related(trashed.id)).toBeNull();
      // The same id asked from the other tenant's scope is as unknown as a random one.
      expect(await inTenant(() => cp.listRelatedCollections(project.id, resolver), otherTenant)).toBeNull();
      expect(await related(project.id)).toEqual([]);
    });

    it("counts only the asking tenant's records", async () => {
      const otherTenant = await createTestTenant(admin);
      await inTenant(() => seedSystem(pool), otherTenant);
      const otherDatabases = await inTenant(() => cp.listDatabases(), otherTenant);
      const idOf = (key: string) => otherDatabases.find((candidate) => candidate.key === key)!.id;
      const otherProject = await inTenant(
        () => cp.createItem({ databaseId: idOf("projects"), properties: { name: "Other" } }),
        otherTenant,
      );
      const otherEvent = await inTenant(
        () => cp.createItem({ databaseId: idOf("events"), properties: { name: "Other", date: "2026-10-16" } }),
        otherTenant,
      );
      await inTenant(async () => {
        const property = (await cp.listProperties(idOf("events"))).find((candidate) => candidate.key === "project");
        await cp.createRelation({
          relationPropertyId: property!.id,
          callerItemId: otherEvent.id,
          targetItemId: otherProject.id,
        });
      }, otherTenant);
      const project = await make("projects");

      expect(await relatedRows(project.id)).toEqual([]);
      expect(await inTenant(() => cp.listRelatedCollections(otherProject.id, resolver), otherTenant)).toHaveLength(1);
    });

    describe("an external client (issue #1998)", () => {
      const externalClient: DatabaseReader = { externalClient: true };

      it("gets no row for a sensitive database, and the others, while a person gets every row", async () => {
        const project = await make("projects");
        const healthRecord = await make("healthRecords");
        const event = await makeEvent();
        await link(healthRecord, "projects", project);
        await link(event, "project", project);
        expect(database("healthRecords").sensitive).toBe(true);

        expect(keysOf((await related(project.id, resolver, externalClient)) ?? [])).toEqual(["events"]);
        expect(keysOf(await relatedRows(project.id))).toEqual(["events", "healthRecords"]);
      });

      it("is refused for a record of a sensitive database and for no other", async () => {
        const healthRecord = await make("healthRecords");
        const project = await make("projects");

        await expect(related(healthRecord.id, resolver, externalClient)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await related(project.id, resolver, externalClient)).toEqual([]);
      });

      it("gets a row for a user-created database, which no grant closes for it", async () => {
        const project = await make("projects");
        const notes = await userDatabase("Notes");
        await relationBetween(notes, database("projects"), "project");
        await link(await userItem(notes), "project", project);

        expect(keysOf((await related(project.id, resolver, externalClient)) ?? [])).toEqual([null]);
      });
    });

    describe("an agent", () => {
      let agentProject: string;
      let project: ItemRow;

      beforeEach(async () => {
        agentProject = await inTenant(() => createTestProjectItem(pool));
        project = await make("projects");
        const healthRecord = await make("healthRecords");
        const event = await makeEvent();
        await link(healthRecord, "projects", project);
        await link(event, "project", project);
      });

      it("gets no row for a database it has no grant for, and the row once it may read it", async () => {
        expect(database("healthRecords").sensitive).toBe(true);

        const without = await related(project.id, resolver, agentProject);
        expect(keysOf(without ?? [])).toEqual(["events"]);

        await inTenant(() =>
          withTransaction(pool, (client) =>
            setAgentDatabaseGrant(client, {
              projectItemId: agentProject,
              databaseId: database("healthRecords").id,
              access: "read",
            }),
          ),
        );
        const withGrant = await related(project.id, resolver, agentProject);
        expect(keysOf(withGrant ?? [])).toEqual(["events", "healthRecords"]);
        // A person reads every collection regardless of any grant.
        expect(keysOf(await relatedRows(project.id))).toEqual(["events", "healthRecords"]);
      });

      it("is refused for a record of a database it may not read", async () => {
        const healthRecord = await make("healthRecords");

        await expect(related(healthRecord.id, resolver, agentProject)).rejects.toBeInstanceOf(ForbiddenError);
      });

      it("gets no row for a user-created database a grant closes, and the row again once the grant allows reading", async () => {
        const notes = await userDatabase("Notes");
        await relationBetween(notes, database("projects"), "project");
        await link(await userItem(notes), "project", project);
        const setAccess = (access: "none" | "read") =>
          inTenant(() =>
            withTransaction(pool, (client) =>
              setAgentDatabaseGrant(client, { projectItemId: agentProject, databaseId: notes.id, access }),
            ),
          );
        const keys = async () => keysOf((await related(project.id, resolver, agentProject)) ?? []);
        // A user-created database is open to an agent without a grant.
        expect(await keys()).toEqual(["events", null]);

        await setAccess("none");
        expect(await keys()).toEqual(["events"]);

        await setAccess("read");
        expect(await keys()).toEqual(["events", null]);
      });
    });
  });

  describe("contributors", () => {
    const unregister: Array<() => void> = [];

    afterEach(() => {
      for (const remove of unregister.splice(0)) remove();
    });

    it("has the mail thread count of people (issue gh-1874) and no other registered", () => {
      expect(relatedRowContributorsFor("people")).toEqual([personMailThreadsRelatedRow]);
      expect(relatedRowContributorsFor("projects")).toEqual([]);
    });

    it("lists a row a module registers for a record type, in order and under the other rules, and stops after unregister", async () => {
      const person = await make("people");
      const event = await makeEvent();
      await link(event, "people", person);
      const notes = await userDatabase("Notes");
      const seen: string[] = [];
      const row = (count: number): RelatedCollectionRow => ({
        databaseKey: null,
        databaseId: notes.id,
        count,
        via: "direct",
        filter: null,
      });
      unregister.push(
        registerRelatedRowContributor("people", async (context) => {
          seen.push(`${context.databaseKey}:${context.itemId === person.id}`);
          return row(4);
        }),
      );

      const rows = await relatedRows(person.id);

      expect(rows.map((candidate) => candidate.databaseKey ?? "custom")).toEqual(["events", "custom"]);
      expect(rowOf(rows, notes.id).count).toBe(4);
      expect(seen).toEqual([`people:true`]);
      // The registration is for people, so a record of another type is not asked.
      await relatedRows((await make("projects")).id);
      expect(seen).toHaveLength(1);

      unregister.pop()!();
      expect(keysOf(await relatedRows(person.id))).toEqual(["events"]);
    });

    it("drops a contributed row that is empty, or whose database is not listed, and a contributor that has no row", async () => {
      const person = await make("people");
      const notes = await userDatabase("Notes");
      unregister.push(
        registerRelatedRowContributor("people", async () => ({
          databaseKey: null,
          databaseId: notes.id,
          count: 0,
          via: "direct",
          filter: null,
        })),
        registerRelatedRowContributor("people", async () => ({
          databaseKey: null,
          databaseId: randomUUID(),
          count: 3,
          via: "direct",
          filter: null,
        })),
        registerRelatedRowContributor("people", async () => null),
      );

      expect(await relatedRows(person.id)).toEqual([]);
    });
  });

  describe("the Threads database", () => {
    /** A thread, through the mail store, which creates the thread's item; the Threads schema is seeded and locked. */
    async function thread(): Promise<Pick<ItemRow, "id" | "databaseId">> {
      return inTenant(() =>
        withTransaction(pool, async (client) => {
          const created = await createMailThread(client, "Subject");
          const { rows } = await client.query<{ item_id: string }>(
            "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
            [created.id],
          );
          const itemId = rows[0]?.item_id;
          if (!itemId) throw new Error("Missing the thread's item");
          return { id: itemId, databaseId: database("threads").id };
        }),
      );
    }

    function threadsRowsOf(rows: readonly RelatedCollectionRow[]): RelatedCollectionRow[] {
      return rows.filter((row) => row.databaseKey === "threads");
    }

    function threadsRow(count: number, via: "direct" | "project"): RelatedCollectionRow {
      return { databaseKey: "threads", databaseId: database("threads").id, count, via, filter: null };
    }

    it("lists the threads of a project and of a company by the thread's own relation, without a filter, though the mail module makes the database internal", async () => {
      expect(resolver.resolve(database("threads")).clientVisible).toBe(false);
      const project = await make("projects");
      const company = await make("companies");
      const first = await thread();
      await link(first, "project", project);
      await link(first, "company", company);
      await thread();

      for (const viewed of [project, company]) {
        expect(await relatedRows(viewed.id)).toEqual([threadsRow(1, "direct")]);
      }
    });

    it("counts the threads of an area through the projects of the area", async () => {
      const area = await make("areas");
      const project = await make("projects");
      const otherProject = await make("projects");
      await link(project, "area", area);
      const inArea = await thread();
      const elsewhere = await thread();
      await thread();
      await link(inArea, "project", project);
      await link(elsewhere, "project", otherProject);

      expect(threadsRowsOf(await relatedRows(area.id))).toEqual([threadsRow(1, "project")]);
    });

    it("has no row for an area when no thread belongs to its projects", async () => {
      const area = await make("areas");
      const project = await make("projects");
      const unrelated = await thread();
      await link(unrelated, "project", project);

      expect(threadsRowsOf(await relatedRows(area.id))).toEqual([]);
    });

    it("has no row for an area when the Threads database is archived", async () => {
      const area = await make("areas");
      const project = await make("projects");
      await link(project, "area", area);
      await link(await thread(), "project", project);
      expect(threadsRowsOf(await relatedRows(area.id))).toEqual([threadsRow(1, "project")]);

      // The API refuses to archive a system database; this is the state of a tenant whose Threads database is not listed.
      await admin.query("UPDATE databases SET archived_at = now() WHERE id = $1", [database("threads").id]);

      expect(threadsRowsOf(await relatedRows(area.id))).toEqual([]);
    });
  });

  it("lists a journal entry on a project, and not on an area, which omits Journal", async () => {
    const area = await make("areas");
    const project = await make("projects");
    const entry = await journalEntry();
    await link(entry, "area", area);
    await link(entry, "project", project);

    expect(keysOf(await relatedRows(project.id))).toEqual(["journal"]);
    expect(await relatedRows(area.id)).toEqual([]);
  });
});
