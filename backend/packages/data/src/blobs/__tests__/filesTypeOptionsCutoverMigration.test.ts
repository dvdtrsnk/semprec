import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool } from "../../testSupport/tenantFixtures.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { runFilesTypeOptionsCutoverMigration } from "../filesTypeOptionsCutoverMigration.js";

let pool: Pool;
let runtimePool: Pool | undefined;

async function typeConfig(): Promise<{ options: { key: string }[] }> {
  const { rows } = await pool.query<{ config: { options: { key: string }[] } }>(
    `SELECT p.config FROM properties p JOIN databases d ON d.id = p.database_id
     WHERE d.owner_module_id = 'files' AND p.key = 'type'`,
  );
  if (!rows[0]) throw new Error("Files type property was not seeded");
  return rows[0].config;
}

describe("runFilesTypeOptionsCutoverMigration (issue #1410)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  it("is a no-op when there is no Files database", async () => {
    await resetDatabase(pool);
    await expect(runFilesTypeOptionsCutoverMigration(pool)).resolves.toBeUndefined();
  });

  it("appends png, heic and audio to a populated install once, keeping existing options", async () => {
    await pool.query(
      `UPDATE properties p SET config = jsonb_set(config, '{options}', '[{"key":"pdf"},{"key":"xlsx"},{"key":"docx"},{"key":"jpg"}]'::jsonb)
       FROM databases d WHERE d.id = p.database_id AND d.owner_module_id = 'files' AND p.key = 'type'`,
    );

    await runFilesTypeOptionsCutoverMigration(pool);
    const afterFirst = await typeConfig();
    expect(afterFirst.options.map((o) => o.key)).toEqual(["pdf", "xlsx", "docx", "jpg", "png", "heic", "audio"]);

    await runFilesTypeOptionsCutoverMigration(pool);
    expect(await typeConfig()).toEqual(afterFirst);
  });

  it("changes nothing on a fresh install that already has the options", async () => {
    const before = await typeConfig();
    expect(before.options.map((o) => o.key)).toEqual(["pdf", "xlsx", "docx", "jpg", "png", "heic", "audio"]);
    await runFilesTypeOptionsCutoverMigration(pool);
    expect(await typeConfig()).toEqual(before);
  });

  it("upgrades a populated install through the tenant cutover runner twice", async () => {
    await pool.query(
      `UPDATE properties p SET config = jsonb_set(config, '{options}', '[{"key":"pdf"},{"key":"xlsx"},{"key":"docx"},{"key":"jpg"}]'::jsonb)
       FROM databases d WHERE d.id = p.database_id AND d.owner_module_id = 'files' AND p.key = 'type'`,
    );
    runtimePool ??= await createRuntimeRolePool(pool, "semprec_data");
    await runAsSystem("Files type cutover test", () => runTenantCutoverMigrations(runtimePool!));
    const first = await typeConfig();
    expect(first.options.map((option) => option.key)).toEqual(["pdf", "xlsx", "docx", "jpg", "png", "heic", "audio"]);
    await runAsSystem("Files type cutover test", () => runTenantCutoverMigrations(runtimePool!));
    expect(await typeConfig()).toEqual(first);
  });
});
