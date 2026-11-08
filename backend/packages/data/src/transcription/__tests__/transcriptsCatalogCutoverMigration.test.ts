import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
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
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT config FROM properties WHERE database_id = $1 AND key = 'status'`,
    [transcriptsId],
  );
  const config = z
    .object({ config: z.object({ options: z.array(z.object({ key: z.string() })).optional() }) })
    .parse(rows[0]);
  return (config.config.options ?? []).map((option) => option.key);
}

async function speakersPropertyCount(transcriptsId: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM properties WHERE database_id = $1 AND key = 'speakers'`,
    [transcriptsId],
  );
  return rows[0]?.count ?? 0;
}

const RELATION_PAIRS = [
  { moduleId: "projects", transcriptsKey: "project", otherKey: "transcripts", cardinality: "one_to_many" },
  { moduleId: "companies", transcriptsKey: "company", otherKey: "transcripts", cardinality: "one_to_many" },
  { moduleId: "people", transcriptsKey: "people", otherKey: "transcripts", cardinality: "many_to_many" },
] as const;

/** Reads both sides of a Transcripts relation pair and its definition; throws when either side is missing. */
async function relationPairShape(
  transcriptsId: string,
  otherDatabaseId: string,
  pair: (typeof RELATION_PAIRS)[number],
) {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id, database_id, config FROM properties
     WHERE (database_id = $1 AND key = $3) OR (database_id = $2 AND key = $4)`,
    [transcriptsId, otherDatabaseId, pair.transcriptsKey, pair.otherKey],
  );
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        database_id: z.uuid(),
        config: z.object({ relationDefinitionId: z.uuid(), targetDatabaseId: z.uuid() }),
      }),
    )
    .parse(result.rows);
  const mine = rows.find((row) => row.database_id === transcriptsId);
  const other = rows.find((row) => row.database_id === otherDatabaseId);
  if (!mine || !other) throw new Error(`Relation pair '${pair.transcriptsKey}' is incomplete`);
  const { rows: definitions } = await pool.query<{ property_id_a: string; cardinality: string }>(
    `SELECT property_id_a, cardinality FROM relation_definitions WHERE id = $1`,
    [mine.config.relationDefinitionId],
  );
  return {
    relationDefinitionId: mine.config.relationDefinitionId,
    transcriptsPropertyId: mine.id,
    otherPropertyId: other.id,
    transcriptsTarget: mine.config.targetDatabaseId,
    otherTarget: other.config.targetDatabaseId,
    propertyIdA: definitions[0]!.property_id_a,
    cardinality: definitions[0]!.cardinality,
  };
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
    const speakersResult = await pool.query<Record<string, unknown>>(
      `SELECT id, config FROM properties WHERE database_id = $1 AND key = 'speakers'`,
      [transcriptsId],
    );
    const speakersRows = z
      .array(z.object({ id: z.uuid(), config: z.object({ relationDefinitionId: z.uuid() }) }))
      .parse(speakersResult.rows);
    const speakers = speakersRows[0];
    if (speakers) {
      await pool.query(`DELETE FROM properties WHERE id = $1`, [speakers.id]);
      await pool.query(`DELETE FROM relation_definitions WHERE id = $1`, [speakers.config.relationDefinitionId]);
    }
    // Issue #1470: drop the project, company and people pairs (both properties and the definition).
    for (const pair of RELATION_PAIRS) {
      const shape = await relationPairShape(transcriptsId, await databaseIdFor(pair.moduleId), pair);
      await pool.query(`DELETE FROM properties WHERE id = ANY($1::uuid[])`, [
        [shape.transcriptsPropertyId, shape.otherPropertyId],
      ]);
      await pool.query(`DELETE FROM relation_definitions WHERE id = $1`, [shape.relationDefinitionId]);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("adds the project, company and people pairs with both sides, targets and cardinality (issue #1470)", async () => {
    await runTranscriptsCatalogCutoverMigration(pool);

    for (const pair of RELATION_PAIRS) {
      const otherId = await databaseIdFor(pair.moduleId);
      const shape = await relationPairShape(transcriptsId, otherId, pair);
      expect(shape.cardinality).toBe(pair.cardinality);
      expect(shape.transcriptsTarget).toBe(otherId);
      expect(shape.otherTarget).toBe(transcriptsId);
      // For one_to_many, property A (the "one" side) is the other database's `transcripts`.
      expect(shape.propertyIdA).toBe(
        pair.cardinality === "one_to_many" ? shape.otherPropertyId : shape.transcriptsPropertyId,
      );
    }
  });

  it("a second run changes nothing and leaves 'event' and 'speakers' untouched (issue #1470)", async () => {
    await runTranscriptsCatalogCutoverMigration(pool);
    const snapshot = async () => ({
      properties: (await pool.query(`SELECT id, key, config FROM properties ORDER BY id`)).rows,
      definitions: (await pool.query(`SELECT * FROM relation_definitions ORDER BY id`)).rows,
    });
    const before = await snapshot();

    await runTranscriptsCatalogCutoverMigration(pool);

    expect(await snapshot()).toEqual(before);
    const { rows } = await pool.query<{ key: string }>(
      `SELECT key FROM properties WHERE database_id = $1 AND key IN ('event', 'speakers')`,
      [transcriptsId],
    );
    expect(rows.map((row) => row.key).sort()).toEqual(["event", "speakers"]);
  });

  it.each(RELATION_PAIRS)(
    "skips a missing $moduleId target and adds its pair when that module exists",
    async (pair) => {
      const otherId = await databaseIdFor(pair.moduleId);
      await pool.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [otherId]);
      await runTranscriptsCatalogCutoverMigration(pool);
      const missing = await pool.query<Record<string, unknown>>(
        "SELECT id FROM properties WHERE (database_id = $1 AND key = $3) OR (database_id = $2 AND key = $4)",
        [transcriptsId, otherId, pair.transcriptsKey, pair.otherKey],
      );
      expect(missing.rows).toEqual([]);
      for (const other of RELATION_PAIRS.filter((candidate) => candidate.moduleId !== pair.moduleId))
        expect((await relationPairShape(transcriptsId, await databaseIdFor(other.moduleId), other)).cardinality).toBe(
          other.cardinality,
        );
      await pool.query("UPDATE databases SET owner_module_id = $2 WHERE id = $1", [otherId, pair.moduleId]);
      await runTranscriptsCatalogCutoverMigration(pool);
      expect((await relationPairShape(transcriptsId, otherId, pair)).cardinality).toBe(pair.cardinality);
    },
  );

  it("fails closed and rolls back when the existing status options are malformed", async () => {
    await pool.query(
      "UPDATE properties SET config = '{\"options\": \"invalid\"}'::jsonb, owner_process = 'previous-owner' WHERE database_id = $1 AND key = 'status'",
      [transcriptsId],
    );
    await expect(runTranscriptsCatalogCutoverMigration(pool)).rejects.toThrow();
    const result = await pool.query("SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
      transcriptsId,
      ["project", "company", "people", "speakers"],
    ]);
    expect(result.rows).toEqual([]);
    const status = await pool.query<Record<string, unknown>>(
      "SELECT owner_process FROM properties WHERE database_id = $1 AND key = 'status'",
      [transcriptsId],
    );
    expect(z.object({ owner_process: z.string() }).parse(status.rows[0]).owner_process).toBe("previous-owner");
  });

  it("adds the 'error' status option and the 'speakers' relation to an already-provisioned Transcripts database", async () => {
    expect(await statusOptions(transcriptsId)).not.toContain("error");
    expect(await speakersPropertyCount(transcriptsId)).toBe(0);

    await runTranscriptsCatalogCutoverMigration(pool);

    expect(await statusOptions(transcriptsId)).toEqual(["recording", "processing", "done", "error"]);
    expect(await speakersPropertyCount(transcriptsId)).toBe(1);

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT config FROM properties WHERE database_id = $1 AND key = 'speakers'`,
      [transcriptsId],
    );
    const speaker = z
      .object({ config: z.object({ relationDefinitionId: z.uuid(), targetDatabaseId: z.uuid() }) })
      .parse(rows[0]);
    expect(speaker.config.targetDatabaseId).toBe(peopleId);
    const { rows: relationRows } = await pool.query<{ cardinality: string }>(
      `SELECT cardinality FROM relation_definitions WHERE id = $1`,
      [speaker.config.relationDefinitionId],
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
