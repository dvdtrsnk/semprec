import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runOnce, type TaskList } from "@semprec/queue";
import {
  createChokePoint,
  createModuleRegistryDriftCheckAction,
  mergeModuleTaskList,
  ORPHANED_OWNER_PROCESS_FINDING_KIND,
  runModuleDataMigrations,
  runMigrations,
  type ChokePoint,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(FIXTURES_DIR, "fixtures/migrations");

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

let pool: Pool;
let chokePoint: ChokePoint;

/**
 * Loads both fixture modules the way a real composition root would: explicit paths, both
 * declared active from the start — proving `ModuleRegistry.loadModule` accepts two
 * independent modules whose ids/task names/heartbeat rule kinds/database keys never collide.
 */
async function loadRegistry(): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(async () => new Set(["e2e-alpha", "e2e-beta"]));
  await registry.loadModule(fixturePath("alphaModule.js"));
  await registry.loadModule(fixturePath("betaModule.js"));
  return registry;
}

describe("e2e: cross-module scenario (module-contract issue #114)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("applies each module's own structural migration exactly once via the shared forward-only runner", async () => {
    await runMigrations(pool, path.join(MIGRATIONS_DIR, "alpha"));
    await runMigrations(pool, path.join(MIGRATIONS_DIR, "beta"));

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('e2e_alpha_marker', 'e2e_beta_marker')`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual(["e2e_alpha_marker", "e2e_beta_marker"]);

    // Re-running must be a no-op (forward-only, tracked in the shared schema_migrations table)
    // rather than re-executing the file and failing on the already-existing table.
    await expect(runMigrations(pool, path.join(MIGRATIONS_DIR, "alpha"))).resolves.not.toThrow();
  });

  it("resolves both modules' custom heartbeat rule kinds to their own, non-colliding schema/nextFireAt", async () => {
    const registry = await loadRegistry();
    const definitions = await registry.getHeartbeatRuleKindDefinitions();
    const byKind = new Map(definitions.map((d) => [d.kind, d]));

    expect([...byKind.keys()].sort()).toEqual(["e2eAlpha.onTick", "e2eBeta.onTick"]);

    const alpha = byKind.get("e2eAlpha.onTick")!;
    expect(alpha.moduleId).toBe("e2e-alpha");
    expect(alpha.schema.safeParse({ kind: "e2eAlpha.onTick" }).success).toBe(true);
    expect(alpha.schema.safeParse({ kind: "e2eBeta.onTick" }).success).toBe(false);
    expect(alpha.nextFireAt({ kind: "e2eAlpha.onTick" }, "UTC", new Date(0))!.getTime()).toBe(60_000);

    const beta = byKind.get("e2eBeta.onTick")!;
    expect(beta.moduleId).toBe("e2e-beta");
    expect(beta.nextFireAt({ kind: "e2eBeta.onTick" }, "UTC", new Date(0))!.getTime()).toBe(120_000);
  });

  it("runs a task in one module that hands off to a task in the other module via the real queue", async () => {
    const registry = await loadRegistry();
    const alphaDb = await chokePoint.createDatabase({ name: "Alpha", ownerModuleId: "e2eAlphaItems" });
    const betaDb = await chokePoint.createDatabase({ name: "Beta", ownerModuleId: "e2eBetaItems" });
    await chokePoint.createProperty({ databaseId: alphaDb.id, key: "value", name: "Value", type: "text" });
    await chokePoint.createProperty({ databaseId: betaDb.id, key: "sourceItemId", name: "Source item", type: "text" });

    const taskList: TaskList = await mergeModuleTaskList({}, registry);
    await pool.query(`SELECT graphile_worker.add_job($1, $2::json)`, [
      "e2eAlpha.ingest",
      JSON.stringify({ alphaDatabaseId: alphaDb.id, betaDatabaseId: betaDb.id, value: "hello" }),
    ]);

    await runOnce({ pgPool: pool, taskList });

    const alphaItems = await chokePoint.listItems(alphaDb.id, {});
    expect(alphaItems.items).toHaveLength(1);
    expect(alphaItems.items[0].properties).toEqual({ value: "hello" });

    const betaItems = await chokePoint.listItems(betaDb.id, {});
    expect(betaItems.items).toHaveLength(1);
    expect(betaItems.items[0].properties).toEqual({ sourceItemId: alphaItems.items[0].id });
  });

  it("runs one module's declared data migration without touching the other module's database", async () => {
    const registry = await loadRegistry();
    const alphaDb = await chokePoint.createDatabase({ name: "Alpha", ownerModuleId: "e2eAlphaItems" });
    const betaDb = await chokePoint.createDatabase({ name: "Beta", ownerModuleId: "e2eBetaItems" });
    await chokePoint.createProperty({ databaseId: alphaDb.id, key: "value", name: "Value", type: "text" });
    await chokePoint.createProperty({ databaseId: betaDb.id, key: "sourceItemId", name: "Source item", type: "text" });
    const alphaItem = await chokePoint.createItem({ databaseId: alphaDb.id, properties: { value: "unmigrated" } });
    const betaItem = await chokePoint.createItem({ databaseId: betaDb.id, properties: { sourceItemId: "n/a" } });

    await runModuleDataMigrations(pool, registry);

    const migratedAlpha = await chokePoint.getItem(alphaDb.id, alphaItem.id);
    expect(migratedAlpha!.properties).toEqual({ value: "unmigrated", migrated: true });

    const untouchedBeta = await chokePoint.getItem(betaDb.id, betaItem.id);
    expect(untouchedBeta!.properties).toEqual({ sourceItemId: "n/a" });
  });

  it("drift-checks live owner_process state across both modules, resolving once the owning module is active again", async () => {
    const db = await chokePoint.createDatabase({ name: "Alpha", ownerModuleId: "e2eAlphaItems" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "managedByAlpha",
      name: "Managed",
      type: "text",
      owner: "system",
      ownerProcess: "e2e-alpha",
    });

    const action = createModuleRegistryDriftCheckAction(pool, {
      activeHeartbeatActionIds: new Set(),
      activeProcessIds: new Set(["e2e-alpha", "e2e-beta"]),
    });
    await action({}, { heartbeatId: "hb", projectItemId: "unused" });
    const { rows: whileActive } = await pool.query(
      `SELECT id FROM notifications WHERE kind = $1 AND resolved_at IS NULL`,
      [ORPHANED_OWNER_PROCESS_FINDING_KIND],
    );
    expect(whileActive).toHaveLength(0);

    // "e2e-alpha" is deactivated: its own property's owner_process is now orphaned.
    const actionAfterDeactivation = createModuleRegistryDriftCheckAction(pool, {
      activeHeartbeatActionIds: new Set(),
      activeProcessIds: new Set(["e2e-beta"]),
    });
    await actionAfterDeactivation({}, { heartbeatId: "hb", projectItemId: "unused" });
    const { rows: afterDeactivation } = await pool.query(
      `SELECT dedupe_key, resolved_at FROM notifications WHERE kind = $1`,
      [ORPHANED_OWNER_PROCESS_FINDING_KIND],
    );
    expect(afterDeactivation).toEqual([{ dedupe_key: "e2e-alpha", resolved_at: null }]);

    // Reactivating it resolves the finding rather than leaving it dangling.
    await action({}, { heartbeatId: "hb", projectItemId: "unused" });
    const { rows: afterReactivation } = await pool.query(
      `SELECT resolved_at FROM notifications WHERE kind = $1 AND dedupe_key = $2`,
      [ORPHANED_OWNER_PROCESS_FINDING_KIND, "e2e-alpha"],
    );
    expect(afterReactivation[0]!.resolved_at).not.toBeNull();
  });
});
