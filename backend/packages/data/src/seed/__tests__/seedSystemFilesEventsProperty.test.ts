import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../seedSystem.js";

vi.mock("../../chokePoint/propertiesStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../chokePoint/propertiesStore.js")>();
  return { ...actual, getPropertyByKey: vi.fn(actual.getPropertyByKey) };
});

let adminPool: Pool;
let dataPool: Pool;

/**
 * Issue #1698: `seedSystem` puts the `Files.events` property id into the transcription trigger's config.
 * `seedTenDatabasesInTransaction` always creates that property, so the missing-property refusal is
 * reached by making the one lookup of the key `events` answer "not found".
 */
describe("seedSystem without a Files.events property (issue #1698)", () => {
  let realGetPropertyByKey: typeof propertiesStore.getPropertyByKey;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const actual = await vi.importActual<typeof import("../../chokePoint/propertiesStore.js")>(
      "../../chokePoint/propertiesStore.js",
    );
    realGetPropertyByKey = actual.getPropertyByKey;
  });

  beforeEach(async () => resetDatabase(adminPool));

  afterEach(() => {
    vi.mocked(propertiesStore.getPropertyByKey).mockImplementation(realGetPropertyByKey);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("refuses to seed, and rolls the structural seed back, when the property is not found", async () => {
    const tenant = getTenantZeroId();
    const lookedUp: string[] = [];
    vi.mocked(propertiesStore.getPropertyByKey).mockImplementation((client, databaseId, key) => {
      lookedUp.push(key);
      return key === "events" ? Promise.resolve(null) : realGetPropertyByKey(client, databaseId, key);
    });

    await expect(runInTenant(tenant, () => seedSystem(dataPool, createViewTypeRegistry()))).rejects.toThrow(
      "Files.events property not found after seedTenDatabasesInTransaction",
    );

    expect(lookedUp.filter((key) => key === "events")).toHaveLength(1);
    const { rows } = await runInTenant(tenant, () =>
      dataPool.query<{ databases: number; heartbeats: number }>(
        `SELECT (SELECT count(*)::int FROM databases) AS databases,
                (SELECT count(*)::int FROM project_heartbeats) AS heartbeats`,
      ),
    );
    expect(rows).toEqual([{ databases: 0, heartbeats: 0 }]);
  });
});
