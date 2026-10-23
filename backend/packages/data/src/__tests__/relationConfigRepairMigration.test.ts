import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";

let pool: Pool;
let chokePoint: ChokePoint;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

/**
 * Re-runs the actual 0014 repair/validation SQL (already applied once, against empty tables,
 * by globalSetup) against whatever `relation_definitions`/`properties` rows the test has set
 * up — the only way to exercise its repair/abort logic against pre-existing, possibly-corrupt
 * data without duplicating its SQL by hand.
 */
async function runConfigRepairMigration(): Promise<void> {
  const sql = await readFile(path.join(MIGRATIONS_DIR, "0014_relation_config_repair.sql"), "utf8");
  await pool.query(sql);
}

describe("relation-property config repair migration (issue #82)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("repairs a paired definition's targets from the opposite side's database_id", async () => {
    const source = await chokePoint.createDatabase({ name: "RepairPairedSource" });
    const target = await chokePoint.createDatabase({ name: "RepairPairedTarget" });
    const { property, inverseProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
      inverse: { key: "relInverse", name: "Rel inverse" },
    });

    // Simulate corruption from before this canonical config existed: both sides' config wiped.
    await pool.query("UPDATE properties SET config = '{}'::jsonb WHERE id = ANY($1::uuid[])", [
      [property.id, inverseProperty!.id],
    ]);

    await runConfigRepairMigration();

    const repairedA = await chokePoint.getProperty(property.id);
    const repairedB = await chokePoint.getProperty(inverseProperty!.id);
    expect(repairedA?.config).toEqual({
      relationDefinitionId: (repairedB?.config as { relationDefinitionId: string }).relationDefinitionId,
      targetDatabaseId: target.id,
    });
    expect(repairedB?.config).toEqual({
      relationDefinitionId: (repairedA?.config as { relationDefinitionId: string }).relationDefinitionId,
      targetDatabaseId: source.id,
    });
  });

  it("is a no-op on already-correct data (idempotent, safe to run twice)", async () => {
    const source = await chokePoint.createDatabase({ name: "RepairNoopSource" });
    const target = await chokePoint.createDatabase({ name: "RepairNoopTarget" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
    });
    const before = await chokePoint.getProperty(property.id);

    await runConfigRepairMigration();
    await runConfigRepairMigration();

    const after = await chokePoint.getProperty(property.id);
    expect(after?.config).toEqual(before?.config);
  });

  it("aborts with the offending property id when a paired side's stored relationDefinitionId doesn't match its own definition", async () => {
    const source = await chokePoint.createDatabase({ name: "RepairMismatchSource" });
    const target = await chokePoint.createDatabase({ name: "RepairMismatchTarget" });
    const { property: _property, inverseProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
      inverse: { key: "relInverse", name: "Rel inverse" },
    });

    await pool.query(
      "UPDATE properties SET config = jsonb_set(config, '{relationDefinitionId}', to_jsonb('00000000-0000-0000-0000-000000000000'::text)) WHERE id = $1",
      [inverseProperty!.id],
    );

    await expect(runConfigRepairMigration()).rejects.toThrow(new RegExp(inverseProperty!.id));
  });

  it("aborts with the offending property id when a one-way property's targetDatabaseId no longer references an existing database", async () => {
    const source = await chokePoint.createDatabase({ name: "RepairBadTargetSource" });
    const target = await chokePoint.createDatabase({ name: "RepairBadTargetTarget" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
    });

    await pool.query("DELETE FROM databases WHERE id = $1", [target.id]);
    // properties.database_id/config.targetDatabaseId carry no FK to databases (see 0001's own
    // notes on why item_id columns can't either) — deleting the target database directly
    // leaves this property's config pointing at nothing, exactly the corruption case the
    // migration must catch.

    await expect(runConfigRepairMigration()).rejects.toThrow(new RegExp(property.id));
  });

  it("aborts with the offending property id when a one-way property is missing targetDatabaseId entirely", async () => {
    const source = await chokePoint.createDatabase({ name: "RepairMissingTargetSource" });
    const target = await chokePoint.createDatabase({ name: "RepairMissingTargetTarget" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: source.id,
      key: "rel",
      name: "Rel",
      targetDatabaseId: target.id,
    });

    await pool.query("UPDATE properties SET config = config - 'targetDatabaseId' WHERE id = $1", [property.id]);

    await expect(runConfigRepairMigration()).rejects.toThrow(new RegExp(property.id));
  });
});
