import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { withTransaction } from "../../db/pool.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { createInboxItemWithClient } from "../../inbox/inboxStore.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createApiCoreTaskList } from "../../worker.js";
import { enqueueTenantSearchReindex, handleItemSearchReindexDependentsTask } from "../itemSearchFanout.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let foreign: string;
/** The tenant the helpers act in. The queue runs outside any tenant scope, between such steps. */
let scope: string;

const REINDEX = CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS;
const BACKFILL = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
/** The Inbox owner's recompute of a Journal day's cached entries (inbox/journalInboxCompute.ts). */
const RECOMPUTE = CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE;
const envelope = z.object({ payload: z.record(z.string(), z.unknown()) });

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(scope, fn);
}

async function db(key: string): Promise<string> {
  const database = (await inTenant(() => cp.listDatabases())).find((row) => row.ownerModuleId === key);
  if (!database) throw new Error(`Missing ${key}`);
  return database.id;
}

async function item(moduleId: string, name: string): Promise<string> {
  const databaseId = await db(moduleId);
  return (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
}

async function relationPropertyId(moduleId: string, key: string): Promise<string> {
  const databaseId = await db(moduleId);
  const property = await inTenant(() => withTransaction(pool, (client) => getPropertyByKey(client, databaseId, key)));
  if (!property) throw new Error(`Missing ${moduleId}.${key}`);
  return property.id;
}

async function link(moduleId: string, key: string, from: string, to: string): Promise<void> {
  const relationProperty = await relationPropertyId(moduleId, key);
  await inTenant(() =>
    cp.createRelation({ relationPropertyId: relationProperty, callerItemId: from, targetItemId: to }),
  );
}

async function unlink(moduleId: string, key: string, from: string, to: string): Promise<void> {
  const relationProperty = await relationPropertyId(moduleId, key);
  await inTenant(() =>
    cp.deleteRelation({ relationPropertyId: relationProperty, callerItemId: from, targetItemId: to }),
  );
}

async function rename(moduleId: string, itemId: string, name: string): Promise<void> {
  const databaseId = await db(moduleId);
  await inTenant(() => cp.updateItem({ databaseId, itemId, propertiesPatch: { name } }));
}

/** Whether the item's search document contains the exact word. */
async function contains(itemId: string, word: string): Promise<boolean> {
  const { rows } = await inTenant(() =>
    pool.query<{ matches: boolean }>(
      "SELECT search_vector @@ plainto_tsquery('czech_simple', $2) AS matches FROM item_search_index WHERE item_id = $1",
      [itemId, word],
    ),
  );
  return rows[0]?.matches ?? false;
}

async function indexedAt(itemId: string): Promise<string | undefined> {
  const { rows } = await inTenant(() =>
    pool.query<{ updated_at: string }>("SELECT updated_at::text FROM item_search_index WHERE item_id = $1", [itemId]),
  );
  return rows[0]?.updated_at;
}

/** The queued payloads of a task, read through the queue's test observation helper. */
async function queued(identifier: string): Promise<Record<string, unknown>[]> {
  return (await readJobPayloadsByIdentifier(admin, identifier)).map((raw) => envelope.parse(raw).payload);
}

function searchHandlers() {
  const taskList = createApiCoreTaskList(pool, createActionRegistry());
  const reindex = taskList[REINDEX];
  const backfill = taskList[BACKFILL];
  const recompute = taskList[RECOMPUTE];
  if (!reindex || !backfill || !recompute) throw new Error("Search handlers missing from the production API task list");
  return { reindex, backfill, recompute };
}

/**
 * Runs the queued reindex, backfill and Journal recompute jobs with the production API task list's
 * own handlers until none is left, so jobs a running job queues (continuations, an area's project
 * items) run too.
 */
async function runQueued(): Promise<void> {
  const { reindex, backfill, recompute } = searchHandlers();
  // One run may leave jobs of the serialized tenant lane for the next one, so it repeats while it
  // makes progress.
  let remaining = Number.POSITIVE_INFINITY;
  for (;;) {
    await runOnce({ pgPool: admin }, { [REINDEX]: reindex, [BACKFILL]: backfill, [RECOMPUTE]: recompute });
    const left = (await queued(REINDEX)).length + (await queued(BACKFILL)).length + (await queued(RECOMPUTE)).length;
    if (left === 0) return;
    if (left >= remaining) {
      const { rows } = await admin.query<{ task_identifier: string; attempts: number; last_error: string | null }>(
        "SELECT task_identifier, attempts, last_error FROM graphile_worker.jobs ORDER BY id",
      );
      throw new Error(`Search jobs stopped making progress: ${JSON.stringify(rows)}`);
    }
    remaining = left;
  }
}

/** A Journal day and one Inbox entry on it, written through the Inbox capture write. */
async function journalEntry(text: string) {
  const journal = await db("journal");
  const inbox = await db("inbox");
  const day = await inTenant(() =>
    withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journal, "day", new Date("2026-10-27T12:00:00Z"), "UTC"),
    ),
  );
  const entry = await inTenant(() =>
    withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inbox, date: "2026-10-27", time: "12:00", text }),
    ),
  );
  return { inbox, day, entry };
}

/**
 * Fault injection (R1 P2, parent D5): makes the search-index write of exactly one item fail, which no
 * production input can do on demand. The item id reaches the trigger's WHEN clause as a literal quoted
 * by Postgres (`format('%L')` in a DO block, read from a session setting), never interpolated here.
 * Cleanup runs after `run` settled, on the same dedicated client; a failed cleanup discards that
 * client, and a primary failure and a cleanup failure are reported together.
 */
async function withIndexWriteFault(itemId: string, run: () => Promise<void>): Promise<void> {
  const client = await admin.connect();
  let primary: { error: unknown } | undefined;
  try {
    await client.query("SELECT set_config('semprec_test.fault_item', $1, false)", [itemId]);
    await client.query(`CREATE FUNCTION fanout_index_fault_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test index write failure'; END $$`);
    await client.query(`DO $$ BEGIN EXECUTE format(
      'CREATE TRIGGER fanout_index_fault_test BEFORE INSERT OR UPDATE ON item_search_index FOR EACH ROW '
      'WHEN (NEW.item_id = %L::uuid) EXECUTE FUNCTION fanout_index_fault_test()',
      current_setting('semprec_test.fault_item')); END $$`);
    await run();
  } catch (error) {
    primary = { error };
  }
  let cleanup: { error: unknown } | undefined;
  try {
    await client.query("DROP TRIGGER IF EXISTS fanout_index_fault_test ON item_search_index");
    await client.query("DROP FUNCTION IF EXISTS fanout_index_fault_test()");
  } catch (error) {
    cleanup = { error };
  }
  client.release(cleanup ? new Error("Fault trigger cleanup failed; the connection is discarded") : undefined);
  if (primary && cleanup) throw new AggregateError([primary.error, cleanup.error], "Fault test and its cleanup failed");
  if (primary) throw primary.error;
  if (cleanup) throw cleanup.error;
}

describe("search reindex fan-out (issue #1652)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    const role = await runAsSystem("verify fanout role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(pool));
    scope = tenant;
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("puts a renamed project's new title into its tasks' documents once the queued job ran", async () => {
    const project = await item("projects", "Alfaprojekt");
    const task = await item("tasks", "Faktura");
    await link("tasks", "project", task, project);
    await runQueued();
    expect(await contains(task, "alfaprojekt")).toBe(true);
    await rename("projects", project, "Betaprojekt");
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project });
    expect(await contains(task, "betaprojekt")).toBe(false);
    await runQueued();
    expect(await contains(task, "betaprojekt")).toBe(true);
    expect(await contains(task, "alfaprojekt")).toBe(false);
  });

  it("puts a project's new area title into its tasks' documents after the project moves", async () => {
    const oldArea = await item("areas", "Starooblast");
    const newArea = await item("areas", "Novooblast");
    const project = await item("projects", "Web");
    const task = await item("tasks", "Nasazení");
    await link("projects", "area", project, oldArea);
    await link("tasks", "project", task, project);
    await runQueued();
    expect(await contains(task, "starooblast")).toBe(true);
    await unlink("projects", "area", project, oldArea);
    await link("projects", "area", project, newArea);
    expect(await queued(REINDEX)).toContainEqual({ kind: "projectItems", projectItemId: project });
    await runQueued();
    expect(await contains(task, "novooblast")).toBe(true);
    expect(await contains(task, "starooblast")).toBe(false);
  });

  it("reaches the items of an area's projects when the area is renamed, through its projects found at run time", async () => {
    const area = await item("areas", "Zahrada");
    const project = await item("projects", "Skleník");
    const task = await item("tasks", "Zalít");
    await link("projects", "area", project, area);
    await link("tasks", "project", task, project);
    await runQueued();
    await rename("areas", area, "Sad");
    // The write queues only the area's referrers; its projects are found when that job runs.
    expect((await queued(REINDEX)).filter((payload) => payload.kind === "projectItems")).toEqual([]);
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: area });
    await runQueued();
    expect(await contains(task, "sad")).toBe(true);
    expect(await contains(task, "zahrada")).toBe(false);
  });

  it("drops a removed person's name from the event's document", async () => {
    const person = await item("people", "Vlasta");
    const event = await item("events", "Porada");
    await link("events", "people", event, person);
    await runQueued();
    expect(await contains(event, "vlasta")).toBe(true);
    await unlink("events", "people", event, person);
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: event });
    await runQueued();
    expect(await contains(event, "vlasta")).toBe(false);
  });

  it("drops a soft-deleted project's title from its tasks and brings it back after the restore", async () => {
    const project = await item("projects", "Gamaprojekt");
    const task = await item("tasks", "Revize");
    await link("tasks", "project", task, project);
    await runQueued();
    const projects = await db("projects");
    await inTenant(() => cp.softDeleteItem(projects, project));
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project });
    await runQueued();
    expect(await contains(task, "gamaprojekt")).toBe(false);
    await inTenant(() => cp.restoreItem(projects, project));
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project });
    await runQueued();
    expect(await contains(task, "gamaprojekt")).toBe(true);
  });

  it("puts an Inbox entry's new text into its Journal day's document and drops the old one, through the cache owner (R1 F2)", async () => {
    const { inbox, day, entry } = await journalEntry("Mléko");
    // The create queues the day's document (through the new journalDay edge) and the owner's recompute.
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: day.id });
    expect(await queued(RECOMPUTE)).toContainEqual({ journalDayItemId: day.id });
    await runQueued();
    expect(await contains(day.id, "mléko")).toBe(true);
    await inTenant(() => cp.updateItem({ databaseId: inbox, itemId: entry.id, propertiesPatch: { text: "Chléb" } }));
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: day.id });
    expect(await queued(RECOMPUTE)).toContainEqual({ journalDayItemId: day.id });
    await runQueued();
    expect(await contains(day.id, "chléb")).toBe(true);
    expect(await contains(day.id, "mléko")).toBe(false);
  });

  it("drops a trashed Inbox entry's text from its Journal day's document and brings it back after the restore (R1 F2)", async () => {
    const { inbox, day, entry } = await journalEntry("Pečivo");
    await runQueued();
    expect(await contains(day.id, "pečivo")).toBe(true);
    await inTenant(() => cp.softDeleteItem(inbox, entry.id));
    expect(await queued(RECOMPUTE)).toContainEqual({ journalDayItemId: day.id });
    await runQueued();
    expect(await contains(day.id, "pečivo")).toBe(false);
    await inTenant(() => cp.restoreItem(inbox, entry.id));
    expect(await queued(RECOMPUTE)).toContainEqual({ journalDayItemId: day.id });
    await runQueued();
    expect(await contains(day.id, "pečivo")).toBe(true);
  });

  it("queues both ends' documents when an edge is written (R1 P2)", async () => {
    const person = await item("people", "Ota");
    const event = await item("events", "Schůzka");
    await runQueued();
    await link("events", "people", event, person);
    const payloads = await queued(REINDEX);
    expect(payloads).toContainEqual({ kind: "item", itemId: event });
    expect(payloads).toContainEqual({ kind: "item", itemId: person });
    await runQueued();
    expect(await contains(event, "ota")).toBe(true);
  });

  it("queues the database's backfill for a property patch and for a property delete, each on its own (R1 P2)", async () => {
    const collection = await inTenant(() => cp.createDatabase({ name: "Archiv" }));
    const property = await inTenant(() =>
      cp.createProperty({ databaseId: collection.id, key: "note", name: "Note", type: "text" }),
    );
    const backfills = async () => (await queued(BACKFILL)).filter((payload) => payload.databaseId === collection.id);
    expect(await backfills()).toEqual([{ databaseId: collection.id, onlyMissing: false }]);
    await runQueued();
    expect(await backfills()).toEqual([]);
    await inTenant(() => cp.updateProperty(property.id, { name: "Poznámka" }));
    expect(await backfills()).toEqual([{ databaseId: collection.id, onlyMissing: false }]);
    await runQueued();
    expect(await backfills()).toEqual([]);
    await inTenant(() => cp.deleteProperty(property.id));
    expect(await backfills()).toEqual([{ databaseId: collection.id, onlyMissing: false }]);
  });

  it("leaves a trashed referrer's document as it was when the project is renamed (R1 P2)", async () => {
    const project = await item("projects", "Deltaprojekt");
    const live = await item("tasks", "Živý");
    const trashed = await item("tasks", "Smazaný");
    for (const task of [live, trashed]) await link("tasks", "project", task, project);
    await runQueued();
    const tasksDatabase = await db("tasks");
    await inTenant(() => cp.softDeleteItem(tasksDatabase, trashed));
    await runQueued();
    const before = await indexedAt(trashed);
    await rename("projects", project, "Epsilonprojekt");
    await runQueued();
    expect(await contains(live, "epsilonprojekt")).toBe(true);
    expect(await indexedAt(trashed)).toBe(before);
    expect(await contains(trashed, "epsilonprojekt")).toBe(false);
  });

  it("commits each chunk of referrers on its own and rolls back only a failing later chunk (R1 P2)", async () => {
    const project = await item("projects", "Bořivoj");
    const tasks: string[] = [];
    for (let index = 0; index < 101; index++) {
      const task = await item("tasks", `Úkol ${index}`);
      await link("tasks", "project", task, project);
      tasks.push(task);
    }
    await runQueued();
    await rename("projects", project, "Spytihněv");
    // The production handler is called directly, chunk by chunk, so each chunk's commit is observable.
    // Chunks follow the referrers' id order.
    const ordered = [...tasks].sort();
    const boundary = ordered[99];
    const last = ordered[100];
    if (!boundary || !last) throw new Error("Expected 101 referrers");
    await inTenant(() => handleItemSearchReindexDependentsTask(pool, { kind: "referrers", itemId: project }));
    const staleFirst: string[] = [];
    for (const task of ordered.slice(0, 100)) if (!(await contains(task, "spytihněv"))) staleFirst.push(task);
    expect(staleFirst).toEqual([]);
    expect(await contains(last, "spytihněv")).toBe(false);
    expect(await queued(REINDEX)).toContainEqual({ kind: "referrers", itemId: project, afterItemId: boundary });
    await withIndexWriteFault(last, async () => {
      await expect(
        inTenant(() =>
          handleItemSearchReindexDependentsTask(pool, { kind: "referrers", itemId: project, afterItemId: boundary }),
        ),
      ).rejects.toThrow("test index write failure");
    });
    // The first chunk stays committed; the failed chunk wrote nothing.
    const lostFirst: string[] = [];
    for (const task of ordered.slice(0, 100)) if (!(await contains(task, "spytihněv"))) lostFirst.push(task);
    expect(lostFirst).toEqual([]);
    expect(await contains(last, "spytihněv")).toBe(false);
    await runQueued();
    expect(await contains(last, "spytihněv")).toBe(true);
  });

  it("makes existing values of a newly added text property searchable once the queued backfill ran", async () => {
    const collection = await inTenant(() => cp.createDatabase({ name: "Sbírka" }));
    await inTenant(() => cp.createProperty({ databaseId: collection.id, key: "name", name: "Name", type: "title" }));
    const entry = await inTenant(() => cp.createItem({ databaseId: collection.id, properties: { name: "Exponát" } }));
    await runQueued();
    // A value stored before its property existed (as imported data can be): no write path stores an
    // undeclared key, so the fixture writes it directly in the tenant's scope.
    await inTenant(() =>
      withTransaction(pool, (client) =>
        client.query(
          "UPDATE items SET properties = properties || jsonb_build_object('origin', 'Mezopotámie') WHERE tenant_id = app_tenant_default() AND id = $1",
          [entry.id],
        ),
      ),
    );
    expect(await contains(entry.id, "mezopotámie")).toBe(false);
    await inTenant(() => cp.createProperty({ databaseId: collection.id, key: "origin", name: "Origin", type: "text" }));
    expect(await queued(BACKFILL)).toContainEqual({ databaseId: collection.id, onlyMissing: false });
    await runQueued();
    expect(await contains(entry.id, "mezopotámie")).toBe(true);
  });

  it("queues one backfill of the database for repeated property create, patch and delete", async () => {
    const collection = await inTenant(() => cp.createDatabase({ name: "Katalog" }));
    const property = await inTenant(() =>
      cp.createProperty({ databaseId: collection.id, key: "note", name: "Note", type: "text" }),
    );
    await inTenant(() => cp.updateProperty(property.id, { name: "Poznámka" }));
    await inTenant(() => cp.deleteProperty(property.id));
    expect((await queued(BACKFILL)).filter((payload) => payload.databaseId === collection.id)).toEqual([
      { databaseId: collection.id, onlyMissing: false },
    ]);
  });

  it("leaves one queued job for a project whose title changes three times in a row", async () => {
    const project = await item("projects", "První");
    await runQueued();
    for (const name of ["Druhý", "Třetí", "Čtvrtý"]) await rename("projects", project, name);
    expect(
      (await queued(REINDEX)).filter((payload) => payload.kind === "referrers" && payload.itemId === project),
    ).toHaveLength(1);
  });

  it("reindexes more referrers than one chunk through a committed continuation job", async () => {
    const project = await item("projects", "Bořivoj");
    const tasks: string[] = [];
    for (let index = 0; index < 101; index++) {
      const task = await item("tasks", `Úkol ${index}`);
      await link("tasks", "project", task, project);
      tasks.push(task);
    }
    await runQueued();
    await rename("projects", project, "Spytihněv");
    expect((await queued(REINDEX)).filter((payload) => payload.kind === "referrers")).toEqual([
      { kind: "referrers", itemId: project },
    ]);
    await runQueued();
    const stale: string[] = [];
    for (const task of tasks) if (!(await contains(task, "spytihněv"))) stale.push(task);
    expect(stale).toEqual([]);
  });

  it("queues the tenant-wide backfill for a profile language change", async () => {
    await inTenant(() => withTransaction(pool, (client) => enqueueTenantSearchReindex(client)));
    expect(await queued(BACKFILL)).toContainEqual({ onlyMissing: false });
  });

  it("never reaches another tenant's referrers", async () => {
    scope = foreign;
    const foreignProject = await item("projects", "Cizíprojekt");
    const foreignTask = await item("tasks", "Cizí");
    await link("tasks", "project", foreignTask, foreignProject);
    await runQueued();
    scope = tenant;
    const project = await item("projects", "Vlastní");
    await rename("projects", project, "Přejmenovaný");
    await runQueued();
    scope = foreign;
    expect(await contains(foreignTask, "cizíprojekt")).toBe(true);
    expect(await contains(foreignTask, "přejmenovaný")).toBe(false);
  });
});
