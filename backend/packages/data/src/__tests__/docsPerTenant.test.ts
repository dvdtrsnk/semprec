import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { deleteDocByItemId, getDocByItemId, getOrCreateDoc } from "../docs/docsStore.js";
import { ConflictError, NotFoundError } from "../errors.js";

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

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  await client.query("SET LOCAL ROLE semprec_data");
}

async function countDocs(client: PoolClient, itemId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM docs WHERE item_id = $1", [
    itemId,
  ]);
  return rows[0]?.n ?? 0;
}

/** Drops the legacy index, adds a second tenant with one database each, and runs as `semprec_data`. */
async function twoTenants(client: PoolClient) {
  await client.query("DROP INDEX docs_item_id_idx");
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
  const tenantA = rows[0]?.id;
  if (!tenantA) throw new Error("no first tenant");
  const { rows: inserted } = await client.query<{ id: string }>(
    "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
  );
  const tenantB = inserted[0]?.id;
  if (!tenantB) throw new Error("second tenant was not inserted");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
  const dbA = await createDatabase(client, { name: "A" });
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
  const dbB = await createDatabase(client, { name: "B" });
  return { tenantA, tenantB, dbA, dbB };
}

async function insertItemWithId(client: PoolClient, databaseId: string, id: string): Promise<void> {
  await client.query(`INSERT INTO items (id, database_id, properties) VALUES ($1, $2, '{}')`, [id, databaseId]);
}

describe("docs are per tenant", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("converges concurrent first writes on one doc while both unique indexes exist", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Pages" });
    const item = await insertItem(pool, { databaseId: db.id, properties: {} });

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'docs' AND indexname IN ('docs_item_id_idx', 'docs_tenant_item_id_uq')",
    );
    expect(indexes.map((r) => r.indexname).sort()).toEqual(["docs_item_id_idx", "docs_tenant_item_id_uq"]);

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      const created = await getOrCreateDoc(first, item.id, "page");
      const { rows: pidRows } = await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const firstPid = pidRows[0]!.pid;

      const racing = getOrCreateDoc(second, item.id, "page");
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [firstPid],
          );
          expect(Number(rows[0]!.count)).toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      await first.query("COMMIT");

      const resolved = await racing;
      expect(resolved.id).toBe(created.id);
    } catch (err) {
      await first.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      first.release();
      second.release();
    }

    const counts = await pool.query<{ docs: number; snapshots: number; history: number }>(
      `SELECT (SELECT count(*)::int FROM docs WHERE item_id = $1) AS docs,
              (SELECT count(*)::int FROM doc_snapshots s JOIN docs d ON d.id = s.doc_id WHERE d.item_id = $1) AS snapshots,
              (SELECT count(*)::int FROM doc_snapshot_history h JOIN docs d ON d.id = h.doc_id WHERE d.item_id = $1) AS history`,
      [item.id],
    );
    expect(counts.rows[0]).toEqual({ docs: 1, snapshots: 1, history: 1 });
  });

  it("works without the legacy index: repeat write is idempotent, a different kind conflicts", async () => {
    await resetDatabase(pool);
    const db = await createChokePoint(pool).createDatabase({ name: "Pages" });
    const item = await insertItem(pool, { databaseId: db.id, properties: {} });
    await inRolledBackTransaction(async (client) => {
      await client.query("DROP INDEX docs_item_id_idx");
      const first = await getOrCreateDoc(client, item.id, "page");
      const again = await getOrCreateDoc(client, item.id, "page");
      expect(again.id).toBe(first.id);
      expect(await countDocs(client, item.id)).toBe(1);
      await expect(getOrCreateDoc(client, item.id, "canvas")).rejects.toBeInstanceOf(ConflictError);
      expect(await countDocs(client, item.id)).toBe(1);
    });
  });

  it("gives the same item id in two tenants a doc each", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB, dbA, dbB } = await twoTenants(client);
      const itemId = "11111111-1111-4111-8111-111111111111";
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await insertItemWithId(client, dbA.id, itemId);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      await insertItemWithId(client, dbB.id, itemId);

      await scopeTo(client, tenantA);
      const docA = await getOrCreateDoc(client, itemId, "page");
      await scopeTo(client, tenantB);
      const docB = await getOrCreateDoc(client, itemId, "canvas");
      expect(docB.id).not.toBe(docA.id);

      expect(await getDocByItemId(client, itemId)).toEqual(docB);
      await scopeTo(client, tenantA);
      expect(await getDocByItemId(client, itemId)).toEqual(docA);
    });
  });

  it("treats another tenant's item as missing", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const { tenantA, tenantB, dbA } = await twoTenants(client);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const itemA = await insertItem(client, { databaseId: dbA.id, properties: {} });

      await scopeTo(client, tenantA);
      const docA = await getOrCreateDoc(client, itemA.id, "page");

      await scopeTo(client, tenantB);
      await expect(getOrCreateDoc(client, itemA.id, "page")).rejects.toBeInstanceOf(NotFoundError);
      expect(await getDocByItemId(client, itemA.id)).toBeNull();
      await deleteDocByItemId(client, itemA.id);

      await client.query("RESET ROLE");
      expect(await countDocs(client, itemA.id)).toBe(1);
      await scopeTo(client, tenantA);
      expect(await getDocByItemId(client, itemA.id)).toEqual(docA);
    });
  });
});
