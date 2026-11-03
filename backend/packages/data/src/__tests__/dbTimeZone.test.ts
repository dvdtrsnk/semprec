import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createTestTenant, tenantZeroSessionOptions } from "../testSupport/tenantFixtures.js";
import type { FilterNode } from "../views/filterTree.js";

const ZONES = ["UTC", "Pacific/Auckland", "America/Los_Angeles"] as const;
const pools: Pool[] = [];

function connectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set — is vitest's globalSetup wired up?");
  return url;
}

function poolInZone(zone: string): Pool {
  const pool = new Pool({
    connectionString: connectionString(),
    options: `${tenantZeroSessionOptions()} -c TimeZone=${zone}`,
  });
  pools.push(pool);
  return pool;
}

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
});

describe("createPool session time zone", () => {
  it("reports UTC on a plain pool", async () => {
    const pool = createPool(connectionString());
    pools.push(pool);
    const result = await runAsSystem("test", () => pool.query<{ TimeZone: string }>("SHOW TimeZone"));
    expect(result.rows[0]?.TimeZone).toBe("UTC");
  });

  it("reports UTC on a pool with the role option", async () => {
    const pool = createPool(connectionString(), { role: "semprec_data" });
    pools.push(pool);
    const result = await runAsSystem("test", () =>
      pool.query<{ zone: string; role: string }>("SELECT current_setting('TimeZone') AS zone, current_user AS role"),
    );
    expect(result.rows[0]).toEqual({ zone: "UTC", role: "semprec_data" });
  });

  it("preserves role and tenant isolation across a rolled-back transaction and view queries", async () => {
    const admin = getTestPool();
    pools.push(admin);
    await resetDatabase(admin);
    const tenantA = await createTestTenant(admin);
    const tenantB = await createTestTenant(admin);
    const adminChokePoint = createChokePoint(admin);
    const fixture = await runInTenant(tenantA, async () => {
      const database = await adminChokePoint.createDatabase({ name: "Scoped dates" });
      await adminChokePoint.createProperty({ databaseId: database.id, key: "due", name: "Due", type: "date" });
      const item = await adminChokePoint.createItem({ databaseId: database.id, properties: { due: "2026-10-16" } });
      const view = await adminChokePoint.createView({ databaseId: database.id, type: "table", name: "Dates" });
      return { item, view };
    });
    const runtime = createPool(connectionString(), { role: "semprec_data" });
    pools.push(runtime);
    const cp = createChokePoint(runtime);
    const rollback = new Error("rollback probe");
    await expect(
      runInTenant(tenantA, () =>
        withTransaction(runtime, async (client) => {
          const result = await client.query<{ zone: string; role: string; tenant: string }>(
            "SELECT current_setting('TimeZone') AS zone, current_user AS role, current_setting('app.tenant_id') AS tenant",
          );
          expect(result.rows[0]).toEqual({ zone: "UTC", role: "semprec_data", tenant: tenantA });
          throw rollback;
        }),
      ),
    ).rejects.toBe(rollback);
    const input = { filter: { type: "on_or_after", property: "due", value: "2026-10-16" } };
    const visible = await runInTenant(tenantA, () => cp.queryViewItems(fixture.view.id, input));
    expect(visible.items.map((item) => item.id)).toEqual([fixture.item.id]);
    await expect(runInTenant(tenantB, () => cp.queryViewItems(fixture.view.id, input))).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await runInTenant(tenantA, () => cp.queryViewItems(fixture.view.id, input))).items.map((item) => item.id),
    ).toEqual([fixture.item.id]);
  });
});

describe("view filters and sorts do not depend on the session time zone", () => {
  let chokePoints: Map<string, ChokePoint>;
  let databaseId: string;

  beforeEach(async () => {
    const admin = getTestPool();
    pools.push(admin);
    await resetDatabase(admin);
    chokePoints = new Map(ZONES.map((zone) => [zone, createChokePoint(poolInZone(zone))]));
    const utc = chokePoints.get("UTC")!;
    databaseId = (await utc.createDatabase({ name: "Events" })).id;
    await utc.createProperty({ databaseId, key: "date", name: "Date", type: "date" });
    await utc.createProperty({ databaseId, key: "name", name: "Name", type: "text" });
    const seed = [
      ["day15", "2026-10-15"],
      ["day16", "2026-10-16"],
      ["day17", "2026-10-17"],
      ["lateUtc", "2026-10-16T23:30:00Z"],
      ["offset", "2026-10-16T01:00:00+02:00"],
    ] as const;
    for (const [name, date] of seed) await utc.createItem({ databaseId, properties: { name, date } });
  });

  async function names(zone: string, filter?: FilterNode, direction: "asc" | "desc" = "asc"): Promise<string[]> {
    const result = await chokePoints
      .get(zone)!
      .queryDatabaseItems(databaseId, { filter, sort: [{ property: "date", direction }] });
    return result.items.map((item) => String(item.properties.name));
  }

  /** Restricts a condition to the stored values that carry a time and an offset or `Z`. */
  const withTime = (condition: FilterNode): FilterNode => ({
    type: "and",
    nodes: [condition, { type: "contains", property: "date", value: "T" }],
  });

  const filters: Array<[string, FilterNode, string[]]> = [
    [
      "date-only on_or_after",
      { type: "on_or_after", property: "date", value: "2026-10-16" },
      ["offset", "day16", "lateUtc", "day17"],
    ],
    ["date-only before", { type: "before", property: "date", value: "2026-10-16" }, ["day15"]],
    [
      "date-only date_range of one day",
      { type: "date_range", property: "date", value: { from: "2026-10-16", to: "2026-10-16" } },
      ["offset", "day16", "lateUtc"],
    ],
    [
      "datetime with offset after",
      withTime({ type: "after", property: "date", value: "2026-10-16T00:00:00+02:00" }),
      ["offset", "lateUtc"],
    ],
    [
      "datetime on_or_after",
      withTime({ type: "on_or_after", property: "date", value: "2026-10-16T23:00:00Z" }),
      ["lateUtc"],
    ],
  ];

  it("filters the seeded Events date consistently across session zones", async () => {
    const admin = getTestPool();
    pools.push(admin);
    await inTenantZero(() => seedSystem(admin));
    const events = await inTenantZero(() =>
      withTransaction(admin, (client) => getDatabaseByModuleId(client, "events")),
    );
    if (!events) throw new Error("Missing seeded Events database");
    const utc = chokePoints.get("UTC")!;
    const match = await utc.createItem({ databaseId: events.id, properties: { name: "Match", date: "2026-10-16" } });
    const before = await utc.createItem({ databaseId: events.id, properties: { name: "Before", date: "2026-10-15" } });
    const after = await utc.createItem({ databaseId: events.id, properties: { name: "After", date: "2026-10-17" } });
    for (const zone of ZONES) {
      const result = await chokePoints.get(zone)!.queryDatabaseItems(events.id, {
        filter: { type: "date_range", property: "date", value: { from: "2026-10-16", to: "2026-10-16" } },
      });
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain(match.id);
      expect(ids).not.toContain(before.id);
      expect(ids).not.toContain(after.id);
    }
  });

  it.each(filters)("%s returns the expected rows in every zone", async (_label, filter, expected) => {
    for (const zone of ZONES) expect(await names(zone, filter)).toEqual(expected);
  });

  it.each(["asc", "desc"] as const)("sorts by date identically in every zone (%s)", async (direction) => {
    const expected = ["day15", "offset", "day16", "lateUtc", "day17"];
    if (direction === "desc") expected.reverse();
    for (const zone of ZONES) expect(await names(zone, undefined, direction)).toEqual(expected);
  });
});
