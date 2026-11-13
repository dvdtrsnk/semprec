import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { ValidationError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let tasks: string;
let cp: ChokePoint;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

/** Every stored Tasks row, deleted or not, with the version stamp the optimistic update checks. */
async function storedTasks(): Promise<{ id: string; properties: Record<string, unknown>; updated_at: string }[]> {
  return inTenant(async () => {
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown>; updated_at: string }>(
      "SELECT id, properties, updated_at::text FROM items WHERE database_id = $1 ORDER BY id",
      [tasks],
    );
    return rows;
  });
}

async function expectRefused(write: Promise<unknown>): Promise<void> {
  const error = await write.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ code: "validation_failed", details: { field: "status" } });
}

describe("a task always has a status (issue sp-9cf1be65)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool));
    cp = createChokePoint(pool);
    const databases = await inTenant(() => cp.listDatabases());
    const found = databases.find((database) => database.ownerModuleId === "tasks");
    if (!found) throw new Error("the Tasks database is not seeded");
    tasks = found.id;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("stores notDone for a create that does not name a status", async () => {
    const created = await inTenant(() => cp.createItem({ databaseId: tasks, properties: { name: "Task" } }));

    expect(created.properties.status).toBe("notDone");
    const stored = await storedTasks();
    expect(stored.map((row) => row.properties.status)).toEqual(["notDone"]);
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["a number", 1],
  ])("refuses a create that names status %s and stores nothing", async (_name, status) => {
    await expectRefused(inTenant(() => cp.createItem({ databaseId: tasks, properties: { name: "Task", status } })));

    expect(await storedTasks()).toEqual([]);
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["a number", 1],
  ])("refuses an update to status %s and leaves the task as it was", async (_name, status) => {
    const created = await inTenant(() => cp.createItem({ databaseId: tasks, properties: { name: "Task" } }));
    const before = await storedTasks();

    await expectRefused(
      inTenant(() =>
        cp.updateItem({
          databaseId: tasks,
          itemId: created.id,
          ifVersion: created.updatedAt,
          propertiesPatch: { status },
        }),
      ),
    );

    expect(await storedTasks()).toEqual(before);
  });

  it("still updates a task to done and renames a task that has no stored status", async () => {
    const created = await inTenant(() => cp.createItem({ databaseId: tasks, properties: { name: "Task" } }));
    const done = await inTenant(() =>
      cp.updateItem({
        databaseId: tasks,
        itemId: created.id,
        ifVersion: created.updatedAt,
        propertiesPatch: { status: "done" },
      }),
    );
    expect(done.properties.status).toBe("done");
    expect((await storedTasks()).map((row) => row.properties.status)).toEqual(["done"]);

    // A row stored before the property default existed: the choke point cannot produce it, so it is inserted directly.
    const legacyId = await inTenant(async () => {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb) RETURNING id",
        [tasks, JSON.stringify({ name: "Legacy" })],
      );
      const row = rows[0];
      if (!row) throw new Error("the legacy task was not inserted");
      return row.id;
    });
    const legacy = await inTenant(() => cp.getItem(tasks, legacyId));
    if (!legacy) throw new Error("the legacy task is not readable");
    const renamed = await inTenant(() =>
      cp.updateItem({
        databaseId: tasks,
        itemId: legacyId,
        ifVersion: legacy.updatedAt,
        propertiesPatch: { name: "Renamed" },
      }),
    );
    expect(renamed.properties.name).toBe("Renamed");
    expect(renamed.properties).not.toHaveProperty("status");
  });
});
