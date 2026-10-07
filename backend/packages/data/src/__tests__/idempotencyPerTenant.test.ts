import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { findIdempotentReplay, insertItemWithReplay, softDeleteItem } from "../chokePoint/itemsStore.js";
import { ConflictError } from "../errors.js";

let pool: Pool;

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let primary: unknown;
  let failed = false;
  try {
    await client.query("BEGIN");
    await fn(client);
  } catch (err) {
    failed = true;
    primary = err;
  }
  let rollbackError: unknown;
  let rollbackFailed = false;
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    rollbackFailed = true;
    rollbackError = err;
  } finally {
    client.release();
  }
  // The test's own failure is the real one; a rollback failure only surfaces when nothing else failed.
  if (failed) throw primary;
  if (rollbackFailed) throw rollbackError;
}

async function dropLegacyKey(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey");
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Drops the legacy key, adds a second tenant with one database each, and runs as `semprec_data`. */
async function twoTenants(client: PoolClient) {
  await dropLegacyKey(client);
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
  const tenantA = rows[0]?.id;
  if (!tenantA) throw new Error("no first tenant");
  const { rows: inserted } = await client.query<{ id: string }>(
    "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
  );
  const tenantB = inserted[0]?.id;
  if (!tenantB) throw new Error("second tenant was not inserted");
  await scopeTo(client, tenantA);
  const dbA = await createDatabase(client, { name: "A" });
  await scopeTo(client, tenantB);
  const dbB = await createDatabase(client, { name: "B" });
  await client.query("SET LOCAL ROLE semprec_data");
  return { tenantA, tenantB, dbA, dbB };
}

describe("idempotency reservations are per tenant", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reusing a key for a different database conflicts with exactly { key } and no database id", async () => {
    await resetDatabase(pool);
    const chokePoint = createChokePoint(pool);
    const dbA = await chokePoint.createDatabase({ name: "A" });
    const dbB = await chokePoint.createDatabase({ name: "B" });
    await chokePoint.createItem({ databaseId: dbA.id, properties: {}, idempotencyKey: "shared" });

    const error = await chokePoint.createItem({ databaseId: dbB.id, properties: {}, idempotencyKey: "shared" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConflictError);
    const conflict = error as ConflictError;
    expect(conflict.code).toBe("version_conflict");
    expect(conflict.details).toEqual({ key: "shared" });
    expect(conflict.message).not.toContain(dbA.id);
    expect(conflict.message).not.toContain(dbB.id);
  });

  it("replays without the legacy primary key", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "A" });
    await inRolledBackTransaction(async (client) => {
      await dropLegacyKey(client);
      const first = await insertItemWithReplay(client, { databaseId: db.id, properties: {}, idempotencyKey: "k" });
      const second = await insertItemWithReplay(client, { databaseId: db.id, properties: {}, idempotencyKey: "k" });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.item.id).toBe(first.item.id);
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1",
        [db.id],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  it("keeps the same key independent across two tenants", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB, dbA, dbB } = await twoTenants(client);

      await client.query("RESET ROLE");
      await scopeTo(client, tenantA);
      await client.query("SET LOCAL ROLE semprec_data");
      const inA = await insertItemWithReplay(client, { databaseId: dbA.id, properties: {}, idempotencyKey: "k" });

      await client.query("RESET ROLE");
      await scopeTo(client, tenantB);
      await client.query("SET LOCAL ROLE semprec_data");
      const inB = await insertItemWithReplay(client, { databaseId: dbB.id, properties: {}, idempotencyKey: "k" });
      expect(inB.created).toBe(true);
      expect(inB.item.id).not.toBe(inA.item.id);
      expect((await findIdempotentReplay(client, dbB.id, "k"))?.id).toBe(inB.item.id);
      expect(await findIdempotentReplay(client, dbA.id, "k")).toBeNull();

      await client.query("RESET ROLE");
      await scopeTo(client, tenantA);
      await client.query("SET LOCAL ROLE semprec_data");
      const replayA = await insertItemWithReplay(client, { databaseId: dbA.id, properties: {}, idempotencyKey: "k" });
      expect(replayA.created).toBe(false);
      expect(replayA.item.id).toBe(inA.item.id);
      expect((await findIdempotentReplay(client, dbA.id, "k"))?.id).toBe(inA.item.id);
    });
  });

  it("releasing a trashed reservation in one tenant leaves the other tenant's reservation untouched", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB, dbA, dbB } = await twoTenants(client);

      await client.query("RESET ROLE");
      await scopeTo(client, tenantA);
      await client.query("SET LOCAL ROLE semprec_data");
      const inA = await insertItemWithReplay(client, { databaseId: dbA.id, properties: {}, idempotencyKey: "k" });

      await client.query("RESET ROLE");
      await scopeTo(client, tenantB);
      await client.query("SET LOCAL ROLE semprec_data");
      const firstB = await insertItemWithReplay(client, { databaseId: dbB.id, properties: {}, idempotencyKey: "k" });
      await softDeleteItem(client, dbB.id, firstB.item.id);
      const secondB = await insertItemWithReplay(client, { databaseId: dbB.id, properties: {}, idempotencyKey: "k" });
      expect(secondB.created).toBe(true);
      expect(secondB.item.id).not.toBe(firstB.item.id);

      await client.query("RESET ROLE");
      const { rows } = await client.query<{ tenant_id: string; item_id: string }>(
        "SELECT tenant_id, item_id FROM idempotency_keys WHERE key = 'k' ORDER BY tenant_id",
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.tenant_id === tenantA)?.item_id).toBe(inA.item.id);
      expect(rows.find((row) => row.tenant_id === tenantB)?.item_id).toBe(secondB.item.id);
    });
  });
});
