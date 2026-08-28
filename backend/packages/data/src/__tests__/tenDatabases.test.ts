import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createBlob, getBlob } from "../blobs/blobsStore.js";
import { createTaskRecurrence } from "../tasks/taskRecurrenceStore.js";
import { advanceTaskRecurrence } from "../tasks/advanceTaskRecurrence.js";
import { computeNextDueDate } from "../tasks/nextDueDate.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";

let pool: Pool;
let chokePoint: ChokePoint;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("ten hardcoded databases (issue #24)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("seeds all ten databases as system, schema-locked databases with a default system view", async () => {
    const moduleIds = ["areas", "projects", "tasks", "people", "files", "events", "healthRecords", "companies", "transcripts", "journal"];
    for (const moduleId of moduleIds) {
      const databaseId = await databaseIdFor(moduleId);
      const { rows } = await pool.query("SELECT system, schema_locked FROM databases WHERE id = $1", [databaseId]);
      expect(rows[0]).toEqual({ system: true, schema_locked: true });

      const { rows: viewRows } = await pool.query("SELECT type, created_by, is_default FROM views WHERE database_id = $1", [databaseId]);
      expect(viewRows).toHaveLength(1);
      expect(viewRows[0].created_by).toBe("system");
      expect(viewRows[0].is_default).toBe(true);
      expect(viewRows[0].type).toBe(moduleId === "journal" ? TEMPORAL_SWITCHER_VIEW_TYPE : "table");
    }
  });

  it("links Areas and Projects through a real bidirectional relation, not text", async () => {
    const areasId = await databaseIdFor("areas");
    const projectsId = await databaseIdFor("projects");
    const area = await chokePoint.createItem({ databaseId: areasId, properties: { name: "Leisure" } });
    const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Vacation planning" } });

    const { rows: propRows } = await pool.query("SELECT id FROM properties WHERE database_id = $1 AND key = 'area'", [projectsId]);
    await chokePoint.createRelation({ relationPropertyId: propRows[0].id, itemId: project.id, targetItemId: area.id });

    const edges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, area.id));
    expect(edges).toHaveLength(1);
    expect([edges[0].itemA, edges[0].itemB]).toContain(project.id);
  });

  it("Projects->Companies is a real relation (fix), not the mock's free-form select", async () => {
    const projectsId = await databaseIdFor("projects");
    const companiesId = await databaseIdFor("companies");
    const company = await chokePoint.createItem({ databaseId: companiesId, properties: { name: "MeguMethod" } });
    const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Client work" } });

    const { rows: propRows } = await pool.query("SELECT id FROM properties WHERE database_id = $1 AND key = 'company'", [projectsId]);
    expect(propRows).toHaveLength(1);
    await chokePoint.createRelation({ relationPropertyId: propRows[0].id, itemId: project.id, targetItemId: company.id });

    // the inverse ("Companies -> Projects") side exists too and is queryable from the company's item
    const { rows: inverseProp } = await pool.query("SELECT id FROM properties WHERE database_id = $1 AND key = 'projects'", [companiesId]);
    expect(inverseProp).toHaveLength(1);
    const allEdges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, company.id));
    expect(allEdges).toHaveLength(1);
  });

  it("a systemActive project can be deactivated but not deleted", async () => {
    const projectsId = await databaseIdFor("projects");
    const systemProject = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Email", systemActive: true } });

    await expect(chokePoint.softDeleteItem(projectsId, systemProject.id)).rejects.toThrow(/system-active/);

    const deactivated = await chokePoint.updateItem({ databaseId: projectsId, itemId: systemProject.id, propertiesPatch: { systemActive: false } });
    expect(deactivated.properties.systemActive).toBe(false);
    const nowDeletable = await chokePoint.softDeleteItem(projectsId, systemProject.id);
    expect(nowDeletable?.deletedAt).not.toBeNull();

    // an ordinary (non-system) project is unaffected
    const ordinary = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Side project" } });
    const deleted = await chokePoint.softDeleteItem(projectsId, ordinary.id);
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it("Health records <-> Areas is bidirectional (fix: was one-directional in the mock)", async () => {
    const healthRecordsId = await databaseIdFor("healthRecords");
    const { rows } = await pool.query(
      "SELECT p.id, rd.property_id_a, rd.property_id_b FROM properties p JOIN relation_definitions rd ON rd.property_id_a = p.id OR rd.property_id_b = p.id WHERE p.database_id = $1 AND p.key = 'area'",
      [healthRecordsId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].property_id_a).not.toBeNull();
    expect(rows[0].property_id_b).not.toBeNull();
  });

  it("Transcripts.status is owner:system and rejected by the generic item-update path", async () => {
    const transcriptsId = await databaseIdFor("transcripts");
    const transcript = await chokePoint.createItem({ databaseId: transcriptsId, properties: { name: "Standup" } });
    await expect(
      chokePoint.updateItem({ databaseId: transcriptsId, itemId: transcript.id, propertiesPatch: { status: "done" } }),
    ).rejects.toThrow();
  });

  it("blobs: creates and reads back a blob for the Files DB's `file` property", async () => {
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "application/pdf", byteSize: 123456789012, storageKey: "files/abc.pdf" }),
    );
    expect(blob.byteSize).toBe("123456789012");

    const filesId = await databaseIdFor("files");
    const file = await chokePoint.createItem({ databaseId: filesId, properties: { name: "Lease.pdf", file: { blobId: blob.id } } });
    expect((file.properties as { file: { blobId: string } }).file.blobId).toBe(blob.id);

    const fetched = await withTransaction(pool, (client) => getBlob(client, blob.id));
    expect(fetched?.storageKey).toBe("files/abc.pdf");
  });

  it("task recurrence: completing a fixed-weekday task creates the next instance and preserves its Project link", async () => {
    const tasksId = await databaseIdFor("tasks");
    const projectsId = await databaseIdFor("projects");
    const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Household" } });
    const task = await chokePoint.createItem({
      databaseId: tasksId,
      properties: { name: "Take out trash", status: "notDone", date: "2026-08-24" },
    });

    const { rows: propRows } = await pool.query("SELECT id FROM properties WHERE database_id = $1 AND key = 'project'", [tasksId]);
    await chokePoint.createRelation({ relationPropertyId: propRows[0].id, itemId: task.id, targetItemId: project.id });

    await withTransaction(pool, (client) =>
      createTaskRecurrence(client, { itemId: task.id, mode: "fixed", rule: { kind: "weekdays", days: ["mon", "fri"] } }),
    );

    const next = await advanceTaskRecurrence(pool, { databaseId: tasksId, itemId: task.id, timezone: "Europe/Prague" });
    expect(next).not.toBeNull();
    expect(next!.properties.name).toBe("Take out trash");
    expect(next!.properties.status).toBe("notDone");

    const completed = await chokePoint.getItem(tasksId, task.id);
    expect(completed?.properties.status).toBe("done");

    // the new instance carries forward the Project relation
    const newEdges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, next!.id));
    expect(newEdges).toHaveLength(1);
    expect([newEdges[0].itemA, newEdges[0].itemB]).toContain(project.id);

    // completing a task with no recurrence is a no-op
    const plain = await chokePoint.createItem({ databaseId: tasksId, properties: { name: "One-off", status: "notDone" } });
    const noop = await advanceTaskRecurrence(pool, { databaseId: tasksId, itemId: plain.id, timezone: "Europe/Prague" });
    expect(noop).toBeNull();
  });

  it("computeNextDueDate: fixed nthWeekday and floating interval rules", () => {
    const secondTuesday = computeNextDueDate("fixed", { kind: "nthWeekday", n: 2, weekday: "tue" }, "UTC", new Date("2026-08-01T00:00:00Z"));
    expect(secondTuesday).toBe("2026-08-11");

    const inTwoWeeks = computeNextDueDate("floating", { unit: "weeks", n: 2 }, "UTC", new Date("2026-08-01T00:00:00Z"));
    expect(inTwoWeeks).toBe("2026-08-15");
  });

  it("computeNextDueDate: fixed monthDates rolls to the next month once the date has passed", () => {
    const withinMonth = computeNextDueDate("fixed", { kind: "monthDates", dates: [15] }, "UTC", new Date("2026-08-01T00:00:00Z"));
    expect(withinMonth).toBe("2026-08-15");

    const alreadyPassed = computeNextDueDate("fixed", { kind: "monthDates", dates: [15] }, "UTC", new Date("2026-08-20T00:00:00Z"));
    expect(alreadyPassed).toBe("2026-09-15");
  });

  it("journal: lazily creates one item per period and is idempotent for the same period", async () => {
    const journalId = await databaseIdFor("journal");
    const first = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
    );
    expect(first.properties).toMatchObject({ type: "day", period: "2026-08-28" });

    // Europe/Prague is UTC+2 in August (CEST) — 18:00Z is still 2026-08-28 locally.
    const second = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T18:00:00Z"), "Europe/Prague"),
    );
    expect(second.id).toBe(first.id);

    const otherDay = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-29T10:00:00Z"), "Europe/Prague"),
    );
    expect(otherDay.id).not.toBe(first.id);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [journalId]);
    expect(rows[0].n).toBe(2);
  });

  it("journal has no default area (fix: the mock hardwired every entry to one Area)", async () => {
    const journalId = await databaseIdFor("journal");
    const item = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "month", new Date("2026-08-01T00:00:00Z"), "Europe/Prague"),
    );
    const edges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, item.id));
    expect(edges).toHaveLength(0);
  });
});
