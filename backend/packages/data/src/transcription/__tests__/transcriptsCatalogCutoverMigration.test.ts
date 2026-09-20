import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { runTranscriptsCatalogCutoverMigration } from "../transcriptsCatalogCutoverMigration.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function statusOptions(transcriptsId: string): Promise<string[]> {
  const { rows } = await pool.query<{ config: { options?: { key: string }[] } }>(
    `SELECT config FROM properties WHERE database_id = $1 AND key = 'status'`,
    [transcriptsId],
  );
  return (rows[0]?.config.options ?? []).map((option) => option.key);
}

async function speakersPropertyCount(transcriptsId: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM properties WHERE database_id = $1 AND key = 'speakers'`,
    [transcriptsId],
  );
  return rows[0]?.count ?? 0;
}

/**
 * `globalSetup.ts` already runs this migration once against a database with no Transcripts
 * database yet (a fresh test DB, before any test's `seedSystem` call), exercising its "not
 * seeded yet" no-op path. This file seeds a Transcripts database in the current, already-correct
 * shape (`seedTenDatabases.ts`'s target state), reverts it to the pre-issue-#180 shape a real
 * already-provisioned instance would have — no `error` status option, no `speakers` relation —
 * then re-invokes the cutover directly to exercise the actual backfill.
 */
describe("runTranscriptsCatalogCutoverMigration (issue #180)", () => {
  let transcriptsId: string;
  let peopleId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    transcriptsId = await databaseIdFor("transcripts");
    peopleId = await databaseIdFor("people");

    // Revert to the pre-#180 shape: drop the `error` status option, and drop the `speakers`
    // relation property + its relation definition entirely.
    await pool.query(
      `UPDATE properties SET config = jsonb_set(config, '{options}', '[{"key":"recording"},{"key":"processing"},{"key":"done"}]'::jsonb)
       WHERE database_id = $1 AND key = 'status'`,
      [transcriptsId],
    );
    const { rows: speakersRows } = await pool.query<{ id: string; config: { relationDefinitionId: string } }>(
      `SELECT id, config FROM properties WHERE database_id = $1 AND key = 'speakers'`,
      [transcriptsId],
    );
    const speakers = speakersRows[0];
    if (speakers) {
      await pool.query(`DELETE FROM properties WHERE id = $1`, [speakers.id]);
      await pool.query(`DELETE FROM relation_definitions WHERE id = $1`, [speakers.config.relationDefinitionId]);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("adds the 'error' status option and the 'speakers' relation to an already-provisioned Transcripts database", async () => {
    expect(await statusOptions(transcriptsId)).not.toContain("error");
    expect(await speakersPropertyCount(transcriptsId)).toBe(0);

    await runTranscriptsCatalogCutoverMigration(pool);

    expect(await statusOptions(transcriptsId)).toEqual(["recording", "processing", "done", "error"]);
    expect(await speakersPropertyCount(transcriptsId)).toBe(1);

    const { rows } = await pool.query<{ config: { relationDefinitionId: string; targetDatabaseId: string } }>(
      `SELECT config FROM properties WHERE database_id = $1 AND key = 'speakers'`,
      [transcriptsId],
    );
    expect(rows[0]!.config.targetDatabaseId).toBe(peopleId);
    const { rows: relationRows } = await pool.query<{ cardinality: string }>(
      `SELECT cardinality FROM relation_definitions WHERE id = $1`,
      [rows[0]!.config.relationDefinitionId],
    );
    expect(relationRows[0]!.cardinality).toBe("many_to_many");
  });

  it("is idempotent: a second run does not duplicate the status option or the speakers property", async () => {
    await runTranscriptsCatalogCutoverMigration(pool);
    await runTranscriptsCatalogCutoverMigration(pool);

    expect(await statusOptions(transcriptsId)).toEqual(["recording", "processing", "done", "error"]);
    expect(await speakersPropertyCount(transcriptsId)).toBe(1);
  });

  it("no-ops when the Transcripts database does not exist yet", async () => {
    await resetDatabase(pool);
    await expect(runTranscriptsCatalogCutoverMigration(pool)).resolves.toBeUndefined();
  });
});
