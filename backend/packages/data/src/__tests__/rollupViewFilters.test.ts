import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { handleRollupRecomputeTask } from "../rollup/recompute.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("view filters and sorts on rollup properties", () => {
  let projectsId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);

    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    projectsId = projects.id;
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "due", name: "Due", type: "date" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const sumProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "totalHours",
      name: "Total hours",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    const latestProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "lastDue",
      name: "Last due",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "latest", targetPropertyKey: "due" },
    });

    // alpha: 3 + 4 = 7, latest 2026-03-01; beta: 2, latest 2026-01-01; gamma: 10, latest 2026-05-01;
    // empty: no edges, so both rollups are null.
    const seed: Record<string, Array<{ hours: number; due: string }>> = {
      alpha: [
        { hours: 3, due: "2026-02-01T00:00:00Z" },
        { hours: 4, due: "2026-03-01T00:00:00Z" },
      ],
      beta: [{ hours: 2, due: "2026-01-01T00:00:00Z" }],
      gamma: [{ hours: 10, due: "2026-05-01T00:00:00Z" }],
      empty: [],
    };
    for (const [name, taskValues] of Object.entries(seed)) {
      const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
      ids[name] = project.id;
      for (const properties of taskValues) {
        const task = await chokePoint.createItem({ databaseId: tasks.id, properties });
        await chokePoint.createRelation({
          relationPropertyId: relation.id,
          callerItemId: project.id,
          targetItemId: task.id,
        });
      }
      await handleRollupRecomputeTask(pool, { rollupPropertyId: sumProp.id, itemId: project.id });
      await handleRollupRecomputeTask(pool, { rollupPropertyId: latestProp.id, itemId: project.id });
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function filteredIds(filter: unknown): Promise<string[]> {
    const { items } = await chokePoint.queryDatabaseItems(projectsId, { filter });
    return items.map((item) => item.id).sort();
  }

  it("the recompute has stored the rollup values in computed, not properties", async () => {
    const alpha = await chokePoint.getItem(projectsId, ids.alpha!);
    expect(alpha?.computed.totalHours).toBe(7);
    expect(alpha?.properties.totalHours).toBeUndefined();
    const empty = await chokePoint.getItem(projectsId, ids.empty!);
    expect(empty?.computed.totalHours).toBeNull();
  });

  it("equals on a sum rollup matches the computed value", async () => {
    expect(await filteredIds({ type: "equals", property: "totalHours", value: 7 })).toEqual([ids.alpha]);
  });

  it("is_empty and is_not_empty on a sum rollup test the computed value", async () => {
    expect(await filteredIds({ type: "is_empty", property: "totalHours" })).toEqual([ids.empty]);
    expect(await filteredIds({ type: "is_not_empty", property: "totalHours" })).toEqual(
      [ids.alpha!, ids.beta!, ids.gamma!].sort(),
    );
  });

  it("after on a latest rollup compares the computed timestamp", async () => {
    expect(await filteredIds({ type: "after", property: "lastDue", value: "2026-02-15T00:00:00Z" })).toEqual(
      [ids.alpha!, ids.gamma!].sort(),
    );
  });

  it("sorts by a sum rollup's computed value, nulls last in both directions", async () => {
    const asc = await chokePoint.queryDatabaseItems(projectsId, {
      sort: [{ property: "totalHours", direction: "asc" }],
    });
    expect(asc.items.map((item) => item.id)).toEqual([ids.beta, ids.alpha, ids.gamma, ids.empty]);

    const desc = await chokePoint.queryDatabaseItems(projectsId, {
      sort: [{ property: "totalHours", direction: "desc" }],
    });
    expect(desc.items.map((item) => item.id)).toEqual([ids.gamma, ids.alpha, ids.beta, ids.empty]);
  });

  it("pages through a sum-rollup sort one row at a time, visiting every parent once in order", async () => {
    for (const direction of ["asc", "desc"] as const) {
      const sort = [{ property: "totalHours", direction }];
      const expected = (await chokePoint.queryDatabaseItems(projectsId, { sort })).items.map((item) => item.id);

      const visited: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; ; pages += 1) {
        if (pages > 10) throw new Error("paging did not terminate");
        const page = await chokePoint.queryDatabaseItems(projectsId, { sort, limit: 1, cursor });
        visited.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(visited).toEqual(expected);
      expect(visited).toHaveLength(4);
    }
  });
});
