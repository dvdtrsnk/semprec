import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";

/**
 * Issue #243: `0040_least_privilege_roles.sql` (run once by `globalSetup.ts` for the whole test
 * run, like every other migration) creates `semprec_data`/`semprec_side` with no password —
 * real deployments set one out-of-band (issue #175). These tests need to actually log in as
 * each role against the shared embedded-Postgres instance, so they set a test-only password
 * here, once, using the admin pool's superuser privileges. Generated at run time (not a literal)
 * so no credential-shaped string is committed to source control.
 */
const TEST_ROLE_PASSWORD = randomUUID();

let adminPool: Pool;
let dataPool: Pool;
let sidePool: Pool;
let chokePoint: ChokePoint;

function roleConnectionString(role: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = TEST_ROLE_PASSWORD;
  return url.toString();
}

async function seedDatabaseAndItem() {
  const db = await chokePoint.createDatabase({ name: `Least-privilege test ${randomUUID()}` });
  const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
  return { db, item };
}

describe("least-privilege runtime roles (semprec_data / semprec_side)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    await adminPool.query(`ALTER ROLE semprec_data WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await adminPool.query(`ALTER ROLE semprec_side WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    dataPool = new Pool({ connectionString: roleConnectionString("semprec_data") });
    sidePool = new Pool({ connectionString: roleConnectionString("semprec_side") });
    chokePoint = createChokePoint(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await sidePool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  describe("semprec_side", () => {
    it("can SELECT choke-point tables but not mutate them", async () => {
      const { db, item } = await seedDatabaseAndItem();

      await expect(sidePool.query(`SELECT * FROM items WHERE id = $1`, [item.id])).resolves.toBeDefined();
      await expect(sidePool.query(`SELECT * FROM databases WHERE id = $1`, [db.id])).resolves.toBeDefined();

      await expect(
        sidePool.query(`INSERT INTO items (id, database_id, properties) VALUES (gen_random_uuid(), $1, '{}')`, [db.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(sidePool.query(`UPDATE items SET properties = '{}' WHERE id = $1`, [item.id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(sidePool.query(`DELETE FROM items WHERE id = $1`, [item.id])).rejects.toThrow(/permission denied/);
      await expect(sidePool.query(`UPDATE databases SET name = 'renamed' WHERE id = $1`, [db.id])).rejects.toThrow(
        /permission denied/,
      );
    });

    it("can fully operate a module side table", async () => {
      await expect(
        sidePool.query(
          `INSERT INTO process_heartbeats (process, pid, version, started_at, beat_at) VALUES ('least-privilege-test', 1, '0.0.0', now(), now())`,
        ),
      ).resolves.toBeDefined();
      await expect(
        sidePool.query(`UPDATE process_heartbeats SET pid = 2 WHERE process = 'least-privilege-test'`),
      ).resolves.toBeDefined();
      await expect(
        sidePool.query(`DELETE FROM process_heartbeats WHERE process = 'least-privilege-test'`),
      ).resolves.toBeDefined();
    });

    it("can insert into a bigserial-keyed side table", async () => {
      await expect(
        sidePool.query(
          `INSERT INTO ai_gateway_calls (provider, model, cost_usd) VALUES ('anthropic', 'test-model', 0) RETURNING id`,
        ),
      ).resolves.toBeDefined();
    });

    it("can insert into a bigserial-keyed side table created after 0040 ran", async () => {
      // A table the migrating role creates later, granted the way a migration adding a side table
      // would grant it: table DML only. Its sequence must be covered by 0047's default privileges.
      const table = `least_privilege_late_${randomUUID().replaceAll("-", "")}`;
      await adminPool.query(`CREATE TABLE ${table} (id bigserial PRIMARY KEY, note text)`);
      try {
        await adminPool.query(`GRANT SELECT, INSERT ON ${table} TO semprec_side`);
        const { rows } = await sidePool.query<{ id: string }>(
          `INSERT INTO ${table} (note) VALUES ('late') RETURNING id`,
        );
        expect(rows).toEqual([{ id: "1" }]);
      } finally {
        await adminPool.query(`DROP TABLE ${table}`);
      }
    });

    it("can enqueue and read graphile-worker jobs", async () => {
      await expect(
        sidePool.query(`SELECT graphile_worker.add_job('least_privilege_test_task', '{}'::json)`),
      ).resolves.toBeDefined();
      await expect(sidePool.query(`SELECT * FROM graphile_worker.jobs LIMIT 1`)).resolves.toBeDefined();
    });
  });

  describe("semprec_data", () => {
    it("completes a full generic (choke-point) transaction", async () => {
      const { db, item } = await seedDatabaseAndItem();

      const { rows: itemRows } = await dataPool.query<{ id: string }>(
        `INSERT INTO items (database_id, properties) VALUES ($1, '{}') RETURNING id`,
        [db.id],
      );
      const secondItemId = itemRows[0]!.id;

      await expect(
        dataPool.query(`UPDATE items SET properties = '{"a": 1}' WHERE id = $1`, [item.id]),
      ).resolves.toBeDefined();
      await expect(dataPool.query(`DELETE FROM items WHERE id = $1`, [secondItemId])).resolves.toBeDefined();
    });

    it("also operates module side tables, via its membership in semprec_side", async () => {
      await expect(
        dataPool.query(
          `INSERT INTO process_heartbeats (process, pid, version, started_at, beat_at) VALUES ('least-privilege-test-data-role', 1, '0.0.0', now(), now())`,
        ),
      ).resolves.toBeDefined();
      await expect(
        dataPool.query(`UPDATE process_heartbeats SET pid = 2 WHERE process = 'least-privilege-test-data-role'`),
      ).resolves.toBeDefined();
      await expect(
        dataPool.query(`DELETE FROM process_heartbeats WHERE process = 'least-privilege-test-data-role'`),
      ).resolves.toBeDefined();
    });
  });
});
