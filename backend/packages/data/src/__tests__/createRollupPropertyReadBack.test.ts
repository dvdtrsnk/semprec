import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { NotFoundError } from "../errors.js";

vi.mock("../chokePoint/propertiesStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chokePoint/propertiesStore.js")>();
  return { ...actual, getProperty: vi.fn(actual.getProperty) };
});

let pool: Pool;
let chokePoint: ChokePoint;

describe("createProperty rollup read-back", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("throws a plain Error naming the property id and rolls back when the read-back returns null", async () => {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });

    vi.mocked(propertiesStore.getProperty).mockResolvedValueOnce(null);
    const error: unknown = await chokePoint
      .createProperty({
        databaseId: projects.id,
        key: "taskCount",
        name: "Task count",
        type: "rollup",
        config: { relationPropertyKey: "tasks", aggregation: "count" },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toMatch(
      /^Rollup property [0-9a-f-]{36} created in this transaction could not be read back$/,
    );

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM properties WHERE database_id = $1 AND key = $2`,
      [projects.id, "taskCount"],
    );
    expect(rows[0]?.count).toBe("0");
  });
});
