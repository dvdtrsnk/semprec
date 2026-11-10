import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTestTenant, createRuntimeRolePool } from "../../testSupport/tenantFixtures.js";
import { runTranscriptionLanguageCodeCutoverMigration } from "../transcriptionLanguageCodeCutoverMigration.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";

describe("transcription language cutover", () => {
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  async function seed(tenant: string) {
    return runInTenant(tenant, async () => {
      await seedSystem(pool, createViewTypeRegistry());
      return withTransaction(pool, async (client) => {
        const fixtures: { moduleId: string; language: string | null; id: string }[] = [];
        for (const moduleId of ["transcripts", "files"]) {
          const db = await getDatabaseByModuleId(client, moduleId);
          if (!db) throw new Error("Missing seeded database");
          for (const language of ["czech", null, "cs", "unmapped"]) {
            const item = await createItemWithClient(client, { databaseId: db.id, properties: {} });
            fixtures.push({ moduleId, language, id: item.id });
            await writeComputed(
              client,
              db.id,
              item.id,
              moduleId === "files" ? "asr" : "language",
              moduleId === "files" ? { language, chunks: { "0": "preserved" } } : language,
            );
          }
        }
        return fixtures;
      });
    });
  }
  async function read(tenant: string) {
    return runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const result = await client.query<{ id: string; computed: unknown; xmin: string }>(
          `SELECT i.id, i.computed, i.xmin::text FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id IN ('files', 'transcripts') ORDER BY i.id`,
        );
        return result.rows;
      }),
    );
  }
  it("converts both caches, preserves codes/null/chunks, is idempotent and isolates tenants", async () => {
    const first = await createTestTenant(admin);
    const second = await createTestTenant(admin);
    const fixtures = await seed(first);
    await seed(second);
    const untouched = await read(second);
    const before = await read(first);
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await runInTenant(first, () => runTranscriptionLanguageCodeCutoverMigration(pool));
      const changed = await read(first);
      for (const fixture of fixtures) {
        const expected =
          fixture.language === "czech" ? "cs" : fixture.language === "unmapped" ? null : fixture.language;
        expect(changed.find((row) => row.id === fixture.id)?.computed).toEqual(
          fixture.moduleId === "files"
            ? { asr: { language: expected, chunks: { "0": "preserved" } } }
            : { language: expected },
        );
      }
      expect(changed.map((row) => row.computed)).toEqual(
        expect.arrayContaining([
          { language: "cs" },
          { language: null },
          { asr: { language: "cs", chunks: { "0": "preserved" } } },
          { asr: { language: null, chunks: { "0": "preserved" } } },
        ]),
      );
      expect(JSON.stringify(changed)).not.toContain("czech");
      expect(JSON.stringify(changed)).not.toContain("unmapped");
      expect(changed).toHaveLength(8);
      for (const row of before.filter(
        (row) => !JSON.stringify(row.computed).includes("czech") && !JSON.stringify(row.computed).includes("unmapped"),
      )) {
        expect(changed.find((current) => current.id === row.id)).toEqual(row);
      }
      expect(await read(second)).toEqual(untouched);
      await runInTenant(first, () => runTranscriptionLanguageCodeCutoverMigration(pool));
      expect(await read(first)).toEqual(changed);
      expect(events).toEqual([]);
    } finally {
      setInvalidationHook(() => {});
    }
  });
  it("runs the registered language migration through the tenant cutover runner", async () => {
    const tenant = await createTestTenant(admin);
    const fixtures = await seed(tenant);
    await runTenantCutoverMigrations(pool);
    const changed = await read(tenant);
    const originals = fixtures.filter((entry) => entry.language === "czech");
    expect(originals).toHaveLength(2);
    for (const fixture of originals) {
      expect(changed.find((row) => row.id === fixture.id)?.computed).toEqual(
        fixture.moduleId === "files" ? { asr: { language: "cs", chunks: { "0": "preserved" } } } : { language: "cs" },
      );
    }
  });
  it("skips a tenant without seeded databases", async () => {
    const tenant = await createTestTenant(admin);
    await expect(
      runInTenant(tenant, () => runTranscriptionLanguageCodeCutoverMigration(pool)),
    ).resolves.toBeUndefined();
  });
});
