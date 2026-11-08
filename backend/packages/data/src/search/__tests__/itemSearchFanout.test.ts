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
import { enqueueTenantSearchReindex } from "../itemSearchFanout.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let foreign: string;
/** The tenant the helpers act in. The queue runs outside any tenant scope, between such steps. */
let scope: string;

const REINDEX = CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS;
const BACKFILL = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
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
  if (!reindex || !backfill) throw new Error("Search handlers missing from the production API task list");
  return { reindex, backfill };
}

/**
 * Runs the queued reindex and backfill jobs with the production API task list's own handlers until
 * none is left, so jobs a running job queues (continuations, an area's project items) run too.
 */
async function runQueued(): Promise<void> {
  const { reindex, backfill } = searchHandlers();
  // One run may leave jobs of the serialized tenant lane for the next one, so it repeats while it
  // makes progress.
  let remaining = Number.POSITIVE_INFINITY;
  for (;;) {
    await runOnce({ pgPool: admin }, { [REINDEX]: reindex, [BACKFILL]: backfill });
    const left = (await queued(REINDEX)).length + (await queued(BACKFILL)).length;
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

  it("rebuilds the Journal day's document when one of its Inbox entries changes", async () => {
    const journal = await db("journal");
    const inbox = await db("inbox");
    const day = await inTenant(() =>
      withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journal, "day", new Date("2026-10-27T12:00:00Z"), "UTC"),
      ),
    );
    const entry = await inTenant(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, { inboxDatabaseId: inbox, date: "2026-10-27", time: "12:00", text: "Mléko" }),
      ),
    );
    await runQueued();
    const before = await indexedAt(day.id);
    await inTenant(() => cp.updateItem({ databaseId: inbox, itemId: entry.id, propertiesPatch: { text: "Chléb" } }));
    expect(await queued(REINDEX)).toContainEqual({ kind: "item", itemId: day.id });
    await runQueued();
    expect(await indexedAt(day.id)).not.toBe(before);
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
