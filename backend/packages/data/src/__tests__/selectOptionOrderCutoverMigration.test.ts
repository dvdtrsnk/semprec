import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { z } from "zod";
import { createPool } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { runSelectOptionOrderCutoverMigration } from "../seed/selectOptionOrderCutoverMigration.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let data: Pool;
let first: string;
let second: string;
const targets = [
  ["projects", "status", ["inProgress", "longTerm", "done", "archived"]],
  ["healthRecords", "status", ["monitoring", "resolved"]],
  [
    "people",
    "relationship",
    ["client", "closeFriend", "parent", "girlfriend", "therapist", "neighbor", "colleague", "craftsman", "doctor"],
  ],
  ["events", "type", ["meeting", "standup", "event"]],
] as const;

async function property(tenant: string, moduleId: string, key: string) {
  return runInTenant(tenant, async () => {
    const { rows } = await data.query<Record<string, unknown>>(
      `SELECT p.id, p.config, p.xmin::text AS version FROM properties p
       JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = $1 AND p.key = $2`,
      [moduleId, key],
    );
    return z
      .object({
        id: z.string(),
        version: z.string(),
        config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()) }).passthrough(),
      })
      .parse(rows[0]);
  });
}

describe("select option order tenant cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    const role = await runAsSystem("check option order role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    first = getTenantZeroId();
    second = await createTestTenant(admin);
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("seeds the target order and upgrades preserved option objects through the tenant runner without repeat writes", async () => {
    for (const tenant of [first, second]) await runInTenant(tenant, () => seedSystem(data, createViewTypeRegistry()));
    for (const [moduleId, key, expected] of targets) {
      const fresh = await property(first, moduleId, key);
      expect(fresh.config.options.map((option) => option.key)).toEqual(expected);
      const populated = await property(second, moduleId, key);
      const old = [...populated.config.options]
        .reverse()
        .map((option) => ({ ...option, color: "#123456", extra: option.key }));
      old.push(
        { key: "customOne", color: "#654321", extra: "one" },
        { key: "customTwo", color: "#000000", extra: "two" },
      );
      // The system catalog is schema locked; this constructs a synthetic old catalog.
      const changed = await admin.query(
        "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
        [second, populated.id, JSON.stringify(old)],
      );
      expect(changed.rowCount).toBe(1);
    }
    const run = () => runAsSystem("select option order test", () => runTenantCutoverMigrations(data));
    await run();
    const versions = new Map<string, string>();
    for (const [moduleId, key, expected] of targets) {
      const result = await property(second, moduleId, key);
      expect(result.config.options.map((option) => option.key)).toEqual([...expected, "customOne", "customTwo"]);
      expect(result.config.options.slice(0, expected.length)).toEqual(
        expected.map((optionKey) => ({ key: optionKey, color: "#123456", extra: optionKey })),
      );
      expect(result.config.options.slice(-2)).toEqual([
        { key: "customOne", color: "#654321", extra: "one" },
        { key: "customTwo", color: "#000000", extra: "two" },
      ]);
      versions.set(moduleId, result.version);
    }
    await run();
    for (const [moduleId, key] of targets) {
      expect((await property(second, moduleId, key)).version).toBe(versions.get(moduleId));
    }
  });

  it("does nothing when the databases are absent", async () => {
    await expect(runInTenant(second, () => runSelectOptionOrderCutoverMigration(data))).resolves.toBeUndefined();
    const { rows } = await runInTenant(second, () => data.query("SELECT id FROM properties"));
    expect(rows).toHaveLength(0);
  });

  it("skips a missing property in an existing database without rewriting other catalogs", async () => {
    for (const tenant of [first, second]) await runInTenant(tenant, () => seedSystem(data, createViewTypeRegistry()));
    const removed = await property(second, "events", "type");
    const before = await property(second, "projects", "status");
    const foreign = await property(first, "events", "type");
    const deleted = await admin.query("DELETE FROM properties WHERE tenant_id = $1 AND id = $2", [second, removed.id]);
    expect(deleted.rowCount).toBe(1);
    await runInTenant(second, () => runSelectOptionOrderCutoverMigration(data));
    await runAsSystem("missing option property cutover test", () => runTenantCutoverMigrations(data));
    await runAsSystem("missing option property cutover replay", () => runTenantCutoverMigrations(data));
    expect(await property(second, "projects", "status")).toEqual(before);
    expect(await property(first, "events", "type")).toEqual(foreign);
    const missing = await runInTenant(second, () =>
      data.query("SELECT id FROM properties WHERE id = $1", [removed.id]),
    );
    expect(missing.rows).toEqual([]);
  });
});
