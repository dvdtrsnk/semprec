import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { mintMcpRunCredential, resolveMcpRunCredential } from "../mcp/mcpRunCredentialAction.js";
import { recordDesiredMailMessageFlags } from "../mail/mailMessageFlagSyncStore.js";

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
      // Interpolated because DDL cannot take a bind parameter; safe only because the name is
      // built here from hex UUID characters, never from input.
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

    it("cannot create an items partition", async () => {
      await expect(sidePool.query(`SELECT create_items_partition($1::uuid)`, [randomUUID()])).rejects.toThrow(
        /permission denied/,
      );
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

    it("creates a database, its items partition and an item through its own choke point", async () => {
      const dataChokePoint = createChokePoint(dataPool);

      const db = await dataChokePoint.createDatabase({ name: `Least-privilege data-role ${randomUUID()}` });
      const item = await dataChokePoint.createItem({ databaseId: db.id, properties: {} });

      expect(item.databaseId).toBe(db.id);
      const { rows } = await adminPool.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relname = $1`, [
        `items_p_${db.id.replaceAll("-", "")}`,
      ]);
      expect(rows).toEqual([{ relname: `items_p_${db.id.replaceAll("-", "")}` }]);
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

  describe("runtime role grants cover every table", () => {
    const CHOKE_POINT_TABLES = [
      "databases",
      "properties",
      "relation_definitions",
      "items",
      "item_relations",
      "views",
      "view_items",
      "idempotency_keys",
      "rollup_dependencies",
    ];
    const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE"];

    async function listTables(): Promise<{ name: string; oid: string }[]> {
      const { rows } = await adminPool.query<{ name: string; oid: string }>(
        `SELECT c.relname AS name, c.oid::text AS oid
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r', 'p')
            AND NOT c.relispartition
            AND c.relname <> 'schema_migrations'
          ORDER BY c.relname`,
      );
      return rows;
    }

    async function hasPrivilege(role: string, tableOid: string, privilege: string): Promise<boolean> {
      const { rows } = await adminPool.query<{ granted: boolean }>(
        `SELECT has_table_privilege($1, $2::oid, $3) AS granted`,
        [role, tableOid, privilege],
      );
      return rows[0]?.granted === true;
    }

    it("lists every choke-point table", async () => {
      const names = new Set((await listTables()).map((table) => table.name));
      expect(CHOKE_POINT_TABLES.filter((name) => !names.has(name))).toEqual([]);
    });

    it("grants every table the privileges its class requires, and no more on choke-point tables", async () => {
      const chokePointNames = new Set(CHOKE_POINT_TABLES);
      const offenders: string[] = [];
      for (const table of await listTables()) {
        const isChokePoint = chokePointNames.has(table.name);
        if (!(await hasPrivilege("semprec_side", table.oid, "SELECT"))) {
          offenders.push(`${table.name}:semprec_side:SELECT`);
        }
        for (const privilege of WRITE_PRIVILEGES) {
          const sideHas = await hasPrivilege("semprec_side", table.oid, privilege);
          if (sideHas === isChokePoint) offenders.push(`${table.name}:semprec_side:${privilege}`);
        }
        for (const privilege of ["SELECT", ...WRITE_PRIVILEGES]) {
          if (!(await hasPrivilege("semprec_data", table.oid, privilege))) {
            offenders.push(`${table.name}:semprec_data:${privilege}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("late side tables (agent_run_mcp_credentials, mail_message_flag_sync_state)", () => {
    it("mints and resolves an MCP run credential as semprec_data", async () => {
      const passwordHash = await hashPassword("s3cret-password");
      const user = await createUser(adminPool, {
        email: `owner-${randomUUID()}@example.test`,
        passwordHash,
        locale: "en",
      });

      const minted = await mintMcpRunCredential(dataPool, {
        projectItemId: randomUUID(),
        capabilities: ["core.item.read"],
        userId: user.id,
      });
      const resolved = await resolveMcpRunCredential(dataPool, minted.token);

      expect(resolved?.runId).toBe(minted.run.id);
    });

    it("records desired mail flags as semprec_data and reads them back as semprec_side", async () => {
      const messageItemId = randomUUID();

      await withTransaction(dataPool, (client) => recordDesiredMailMessageFlags(client, messageItemId, { read: true }));

      const { rows } = await sidePool.query<{ desired_state: boolean }>(
        `SELECT desired_state FROM mail_message_flag_sync_state WHERE message_item_id = $1 AND property_key = 'read'`,
        [messageItemId],
      );
      expect(rows).toEqual([{ desired_state: true }]);
    });

    it("lets semprec_side UPDATE and DELETE rows of both tables", async () => {
      const passwordHash = await hashPassword("s3cret-password");
      const user = await createUser(adminPool, {
        email: `owner-${randomUUID()}@example.test`,
        passwordHash,
        locale: "en",
      });
      const minted = await mintMcpRunCredential(adminPool, {
        projectItemId: randomUUID(),
        capabilities: ["core.item.read"],
        userId: user.id,
      });
      const messageItemId = randomUUID();
      await withTransaction(adminPool, (client) =>
        recordDesiredMailMessageFlags(client, messageItemId, { read: true }),
      );

      const credentialUpdate = await sidePool.query(
        `UPDATE agent_run_mcp_credentials SET expires_at = now() WHERE agent_run_id = $1`,
        [minted.run.id],
      );
      const flagUpdate = await sidePool.query(
        `UPDATE mail_message_flag_sync_state SET current_state = true WHERE message_item_id = $1`,
        [messageItemId],
      );
      const credentialDelete = await sidePool.query(`DELETE FROM agent_run_mcp_credentials WHERE agent_run_id = $1`, [
        minted.run.id,
      ]);
      const flagDelete = await sidePool.query(`DELETE FROM mail_message_flag_sync_state WHERE message_item_id = $1`, [
        messageItemId,
      ]);

      expect([credentialUpdate.rowCount, flagUpdate.rowCount, credentialDelete.rowCount, flagDelete.rowCount]).toEqual([
        1, 1, 1, 1,
      ]);
    });
  });
});
