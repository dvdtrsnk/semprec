import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { ConflictError } from "../errors.js";

let pool: Pool;

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function addSecondTenant(client: PoolClient): Promise<string> {
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
  const id = rows[0]?.id;
  if (!id) throw new Error("second tenant was not inserted");
  return id;
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

describe("databases.key is unique per tenant and module databases resolve unambiguously", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("exposes databases_key_unique as the only unique key on exactly (tenant_id, key)", async () => {
    const { rows } = await pool.query<{ conname: string; contype: string; columns: string[] }>(
      `SELECT c.conname, c.contype,
              array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                    ORDER BY k.ord) AS columns
         FROM pg_constraint c
        WHERE c.conrelid = 'databases'::regclass AND c.conname = 'databases_key_unique'`,
    );
    expect(rows).toEqual([{ conname: "databases_key_unique", contype: "u", columns: ["tenant_id", "key"] }]);

    const { rows: indexes } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'databases' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
          AND (indexdef LIKE '%(key)%' OR indexdef LIKE '%(tenant_id, key)%')`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual(["databases_key_unique"]);
  });

  it("still rejects a duplicate key within one tenant with a ConflictError", async () => {
    await resetDatabase(pool);
    const chokePoint = createChokePoint(pool);
    await chokePoint.createDatabase({ name: null, key: "widgets", system: true });
    await expect(chokePoint.createDatabase({ name: null, key: "widgets", system: true })).rejects.toMatchObject({
      constructor: ConflictError,
      details: { field: "key" },
    });
  });

  it("accepts the same key in a second tenant", async () => {
    await resetDatabase(pool);
    await createChokePoint(pool).createDatabase({ name: null, key: "tasks", system: true });
    await inRolledBackTransaction(async (client) => {
      const tenantB = await addSecondTenant(client);
      await scopeTo(client, tenantB);
      const created = await createDatabase(client, { system: true, key: "tasks", name: null });
      expect(created.key).toBe("tasks");
      const { rows } = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM databases WHERE id = $1", [
        created.id,
      ]);
      expect(rows).toEqual([{ tenant_id: tenantB }]);
    });
  });

  it("resolves the system database when a non-system one shares the module id", async () => {
    await resetDatabase(pool);
    const chokePoint = createChokePoint(pool);
    await chokePoint.createDatabase({ name: "Plain files", ownerModuleId: "files" });
    const system = await chokePoint.createDatabase({ name: null, key: "files", ownerModuleId: "files", system: true });
    await inRolledBackTransaction(async (client) => {
      const found = await getDatabaseByModuleId(client, "files");
      expect(found?.id).toBe(system.id);
      expect(found?.system).toBe(true);
    });
  });

  it("fails on an ambiguous module id as the owner role and resolves per tenant under RLS", async () => {
    await resetDatabase(pool);
    const tenantZero = await createChokePoint(pool).createDatabase({
      name: null,
      key: "files",
      ownerModuleId: "files",
      system: true,
    });
    await inRolledBackTransaction(async (client) => {
      const tenantB = await addSecondTenant(client);
      await scopeTo(client, tenantB);
      const inB = await createDatabase(client, { name: null, key: "files", ownerModuleId: "files", system: true });
      expect(inB.id).not.toBe(tenantZero.id);

      const error = await getDatabaseByModuleId(client, "files").then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConflictError);
      expect((error as Error).message).toContain("'files'");
      expect((error as Error).message).toContain("2");

      await client.query("SET LOCAL ROLE semprec_data");
      const found = await getDatabaseByModuleId(client, "files");
      expect(found?.id).toBe(inB.id);
    });
  });

  it("returns null for an unknown module id", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      expect(await getDatabaseByModuleId(client, "noSuchModule")).toBeNull();
    });
  });
});
