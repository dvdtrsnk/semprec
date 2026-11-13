import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

const { loadFullModuleRegistry } = vi.hoisted(() => ({ loadFullModuleRegistry: vi.fn() }));

vi.mock("../../manifest/fullModuleRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../manifest/fullModuleRegistry.js")>();
  loadFullModuleRegistry.mockImplementation(actual.loadFullModuleRegistry);
  return { ...actual, loadFullModuleRegistry };
});

const { createTrashItemsRouteHandler } = await import("../trashRouteHandlers.js");

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;

/** Creates one item in `databaseId` and trashes it, both through the choke point. */
async function trashItem(databaseId: string, properties: Record<string, unknown>): Promise<void> {
  await runInTenant(tenantId, async () => {
    const item = await chokePoint.createItem({ databaseId, properties }, undefined, undefined, { writerKind: "user" });
    await chokePoint.softDeleteItem(databaseId, item.id);
  });
}

/** Answers the list as the adapter calls the route. */
function list(): Promise<{ status: number; body: unknown }> {
  return runInTenant(tenantId, () =>
    createTrashItemsRouteHandler(dataPool)({
      req: { url: "/api/trash/items" },
      identity: { user: { locale: "en" } },
    }),
  );
}

/** Which database names the response carries, in the order of its rows. */
function databaseNames(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items)) {
    throw new Error("The body has no items");
  }
  return body.items.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("databaseName" in row) || typeof row.databaseName !== "string") {
      throw new Error("A row has no databaseName");
    }
    return row.databaseName;
  });
}

/** `GET /api/trash/items` must load the module catalogs only for a system database, and must not keep a failed load. */
describe("GET /api/trash/items catalog loading (issue gh-1851)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
    loadFullModuleRegistry.mockClear();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("does not load the module registry for a page of user database items only", async () => {
    const databaseId = await runInTenant(
      tenantId,
      async () => (await chokePoint.createDatabase({ name: "Movies" })).id,
    );
    await trashItem(databaseId, {});
    // The choke point writes above may load the registry themselves; only the route's own loads are counted.
    loadFullModuleRegistry.mockClear();

    const result = await list();

    expect(databaseNames(result.body)).toEqual(["Movies"]);
    expect(loadFullModuleRegistry).not.toHaveBeenCalled();
  });

  it("retries a failed registry load on the next request instead of caching the rejection, then loads once", async () => {
    const tasksDatabaseId = await runInTenant(tenantId, async () => {
      const database = await withTransaction(dataPool, (client) =>
        databasesStore.getDatabaseByModuleId(client, "tasks"),
      );
      if (!database) throw new Error("No tasks database");
      return database.id;
    });
    await trashItem(tasksDatabaseId, { name: "Row" });
    loadFullModuleRegistry.mockClear();
    loadFullModuleRegistry.mockRejectedValueOnce(new Error("registry missing"));

    await expect(list()).rejects.toThrow("registry missing");
    const second = await list();
    const third = await list();

    expect(databaseNames(second.body)).toEqual(["Tasks"]);
    expect(databaseNames(third.body)).toEqual(["Tasks"]);
    expect(loadFullModuleRegistry).toHaveBeenCalledTimes(2);
  });
});
