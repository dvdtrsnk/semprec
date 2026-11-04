import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { getItemById, writeComputed } from "../chokePoint/itemsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

describe("transcript duration tenant cutover", () => {
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
  beforeEach(async () => resetDatabase(admin));
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("reserves durationSeconds and finalizedAt in the computed-key registry", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      const registry = createComputedKeyRegistry();
      await seedSystem(pool, undefined, registry);
      const cp = createChokePoint(pool, registry);
      const database = await cp.createDatabase({ name: "Registry control" });
      expect(
        await cp.createProperty({ databaseId: database.id, key: "ordinary", name: "Ordinary", type: "number" }),
      ).toMatchObject({ key: "ordinary" });
      for (const key of ["durationSeconds", "finalizedAt"]) {
        await expect(cp.createProperty({ databaseId: database.id, key, name: key, type: "number" })).rejects.toThrow(
          /declared module cache key/i,
        );
      }
    });
  });

  it("runs the registered backfill for each maintained tenant and leaves existing values unchanged on replay", async () => {
    async function fixture(tenantId: string, seconds: number) {
      return runInTenant(tenantId, async () => {
        await seedSystem(pool);
        return withTransaction(pool, async (client) => {
          const files = await getDatabaseByModuleId(client, "files");
          const transcripts = await getDatabaseByModuleId(client, "transcripts");
          if (!files || !transcripts) throw new Error("Missing seeded databases");
          const file = await createItemWithClient(client, { databaseId: files.id, properties: {} });
          await writeComputed(client, files.id, file.id, "prepare", { durationSeconds: seconds });
          const transcript = await createItemWithClient(
            client,
            { databaseId: transcripts.id, properties: { link: `semprec://items/${file.id}` } },
            { allowedSystemKeys: ["link"], systemOwnerProcess: "transcribe" },
          );
          return { databaseId: transcripts.id, itemId: transcript.id };
        });
      });
    }
    const tenantA = await createTestTenant(admin);
    const tenantB = await createTestTenant(admin);
    const a = await fixture(tenantA, 42);
    const b = await fixture(tenantB, 73);
    async function read(tenantId: string, item: typeof a) {
      return runInTenant(tenantId, () =>
        withTransaction(pool, (client) => getItemById(client, item.databaseId, item.itemId)),
      );
    }
    expect((await read(tenantA, a))?.computed.durationSeconds).toBeUndefined();
    expect(await read(tenantB, a)).toBeNull();
    await runTenantCutoverMigrations(pool);
    const firstA = await read(tenantA, a);
    const firstB = await read(tenantB, b);
    expect(firstA?.computed.durationSeconds).toBe(42);
    expect(firstB?.computed.durationSeconds).toBe(73);
    expect(await read(tenantB, a)).toBeNull();
    await runTenantCutoverMigrations(pool);
    expect(await read(tenantA, a)).toEqual(firstA);
    expect(await read(tenantB, b)).toEqual(firstB);
  });
});
