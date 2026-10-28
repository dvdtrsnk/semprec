import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bindToTenantZero, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import { compileFilterNode } from "../views/filterCompiler.js";
import { parseFilterNode } from "../views/filterTree.js";
import { ValidationError } from "../errors.js";
import type { PropertyRow } from "../types.js";

let pool: Pool;
let cp: ChokePoint;
let databases: Record<string, string>;
let taskProject: PropertyRow;
let projectArea: PropertyRow;
let fileProjects: PropertyRow;

function filter(value: string, first = "project") {
  return { type: "relation_path_contains", path: [first, "area"], value };
}

async function item(database: string) {
  const id = databases[database];
  if (!id) throw new Error(`Missing database ${database}`);
  return cp.createItem({ databaseId: id, properties: {} });
}

async function relation(property: PropertyRow, callerItemId: string, targetItemId: string) {
  return cp.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId });
}

async function property(database: string, key: string) {
  const id = databases[database];
  if (!id) throw new Error(`Missing database ${database}`);
  const result = (await cp.listProperties(id)).find((entry) => entry.key === key);
  if (!result) throw new Error(`Missing property ${database}.${key}`);
  return result;
}

/** Inspect unknown EXPLAIN JSON without casting its shape. */
function executedPartitions(raw: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(raw)) {
    for (const entry of raw) executedPartitions(entry, result);
  } else if (raw !== null && typeof raw === "object") {
    const name = "Relation Name" in raw ? raw["Relation Name"] : undefined;
    const loops = "Actual Loops" in raw ? raw["Actual Loops"] : undefined;
    if (typeof name === "string" && name.startsWith("items_p_") && typeof loops === "number" && loops > 0) {
      result.add(name);
    }
    for (const entry of Object.values(raw)) executedPartitions(entry, result);
  }
  return result;
}

describe("relation_path_contains production queries", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await inTenantZero(() => seedSystem(pool));
    cp = bindToTenantZero(createChokePoint(pool));
    const rows = await pool.query<{ id: string; key: string }>("SELECT id, key FROM databases");
    databases = Object.fromEntries(rows.rows.map((row) => [row.key, row.id]));
    taskProject = await property("tasks", "project");
    projectArea = await property("projects", "area");
    fileProjects = await property("files", "projects");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns only tasks in Work, excluding no project and soft-deleted projects", async () => {
    const work = await item("areas");
    const personal = await item("areas");
    const workProject = await item("projects");
    const personalProject = await item("projects");
    const deletedProject = await item("projects");
    await relation(projectArea, workProject.id, work.id);
    await relation(projectArea, personalProject.id, personal.id);
    await relation(projectArea, deletedProject.id, work.id);
    const matching = await item("tasks");
    const other = await item("tasks");
    const deleted = await item("tasks");
    await item("tasks");
    await relation(taskProject, matching.id, workProject.id);
    await relation(taskProject, other.id, personalProject.id);
    await relation(taskProject, deleted.id, deletedProject.id);
    await cp.softDeleteItem(databases.projects!, deletedProject.id);
    const input = filter(work.id);
    expect((await cp.queryDatabaseItems(databases.tasks!, { filter: input })).items.map((row) => row.id)).toEqual([
      matching.id,
    ]);
    expect((await cp.listItems(databases.tasks!, { filter: input })).items.map((row) => row.id)).toEqual([matching.id]);
    expect((await cp.queryDatabaseItems(databases.tasks!, { filter: filter(randomUUID()) })).items).toEqual([]);
  });

  it("matches a file when any of several projects belongs to the area, once", async () => {
    const work = await item("areas");
    const personal = await item("areas");
    const first = await item("projects");
    const second = await item("projects");
    const third = await item("projects");
    await relation(projectArea, first.id, personal.id);
    await relation(projectArea, second.id, work.id);
    await relation(projectArea, third.id, work.id);
    const matching = await item("files");
    const other = await item("files");
    await item("files");
    for (const project of [first, second, third]) await relation(fileProjects, matching.id, project.id);
    await relation(fileProjects, other.id, first.id);
    expect(
      (await cp.queryDatabaseItems(databases.files!, { filter: filter(work.id, "projects") })).items.map(
        (row) => row.id,
      ),
    ).toEqual([matching.id]);
  });

  it("updates saved view results on the next view.query after an area move without editing views", async () => {
    const work = await item("areas");
    const personal = await item("areas");
    const project = await item("projects");
    const task = await item("tasks");
    await relation(projectArea, project.id, personal.id);
    await relation(taskProject, task.id, project.id);
    const workView = await cp.createView({
      databaseId: databases.tasks!,
      type: "table",
      name: "Work",
      config: { filter: filter(work.id) },
    });
    const personalView = await cp.createView({
      databaseId: databases.tasks!,
      type: "table",
      name: "Personal",
      config: { filter: filter(personal.id) },
    });
    expect((await cp.queryViewItems(workView.id, {})).items).toEqual([]);
    expect((await cp.queryViewItems(personalView.id, {})).items.map((row) => row.id)).toEqual([task.id]);
    await cp.deleteRelation({
      relationPropertyId: projectArea.id,
      callerItemId: project.id,
      targetItemId: personal.id,
    });
    await relation(projectArea, project.id, work.id);
    expect((await cp.queryViewItems(workView.id, {})).items.map((row) => row.id)).toEqual([task.id]);
    expect((await cp.queryViewItems(personalView.id, {})).items).toEqual([]);
    expect((await cp.queryView(workView.id)).items.map((row) => row.id)).toEqual([task.id]);
    expect((await cp.getView(workView.id))?.config).toEqual(workView.config);
    expect((await cp.getView(personalView.id))?.config).toEqual(personalView.config);
  });

  it.each([
    { path: ["missing", "area"] },
    { path: ["name", "area"] },
    { path: ["project", "missing"] },
    { path: ["project", "name"] },
    { path: ["project"] },
    { path: ["project", "area", "projects"] },
    { value: "invalid" },
  ])("rejects invalid query input %j with 400 on filter", async (override) => {
    const query = cp.queryDatabaseItems(databases.tasks!, { filter: { ...filter(randomUUID()), ...override } });
    await expect(query).rejects.toBeInstanceOf(ValidationError);
    await expect(query).rejects.toMatchObject({ status: 400, details: { field: "filter" } });
  });

  it("batches target metadata in two queries for multiple relations and stops at one level", async () => {
    const props = await cp.listProperties(databases.files!);
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          const metadata = await buildFilterProperties(client, props);
          expect(spy).toHaveBeenCalledTimes(2);
          const projects = metadata.get("projects");
          expect(projects?.targetDatabaseId).toBe(databases.projects);
          expect(projects?.targetRelationProperties?.get("area")).toMatchObject({
            type: "relation",
            relationSide: "b",
          });
          expect(projects?.targetRelationProperties?.has("name")).toBe(false);
          expect(projects?.targetRelationProperties?.get("area")?.targetRelationProperties).toBeUndefined();
          expect(metadata.get("area")?.targetDatabaseId).toBe(databases.areas);
        } finally {
          spy.mockRestore();
        }
      }),
    );
  });

  it("does not query for scalar-only metadata or malformed/missing target configs", async () => {
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          const scalar = await property("tasks", "name");
          expect((await buildFilterProperties(client, [scalar])).get("name")).toEqual({ type: "title" });
          expect(spy).not.toHaveBeenCalled();
          for (const config of [{}, { targetDatabaseId: "invalid" }]) {
            const props = await buildFilterProperties(client, [{ ...taskProject, config }]);
            expect(() => compileFilterNode(parseFilterNode(filter(randomUUID())), props, [])).toThrow(ValidationError);
          }
          expect(spy).toHaveBeenCalledTimes(2);
        } finally {
          spy.mockRestore();
        }
      }),
    );
  });

  it("EXPLAIN scans only the intermediate database partition for the exact compiled predicate", async () => {
    const work = await item("areas");
    const project = await item("projects");
    const task = await item("tasks");
    await relation(projectArea, project.id, work.id);
    await relation(taskProject, task.id, project.id);
    await pool.query("ANALYZE items");
    const props = await cp.listProperties(databases.tasks!);
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const metadata = await buildFilterProperties(client, props);
        // Use an outer one-row VALUES relation so the only items scan is the intermediate lookup.
        const params: unknown[] = [task.id];
        const predicate = compileFilterNode(parseFilterNode(filter(work.id)), metadata, params);
        const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1 FROM (VALUES ($1::uuid)) AS items(id) WHERE ${predicate}`,
          params,
        );
        expect(executedPartitions(rows[0]?.["QUERY PLAN"])).toEqual(
          new Set([`items_p_${databases.projects!.replace(/-/g, "")}`]),
        );
        const partitions = await client.query<{ count: string }>(
          "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'items\\_p\\_%'",
        );
        expect(Number(partitions.rows[0]?.count)).toBeGreaterThan(2);
      }),
    );
  });
});
