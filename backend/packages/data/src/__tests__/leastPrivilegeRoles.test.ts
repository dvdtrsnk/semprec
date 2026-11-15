import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantZeroSessionOptions,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { hashToken } from "../auth/token.js";
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

/** Expects `statement` to be refused for a missing privilege on `table` (SQLSTATE 42501). */
async function expectPermissionDenied(statement: Promise<unknown>, table: string): Promise<void> {
  await expect(statement).rejects.toMatchObject({
    code: "42501",
    message: expect.stringContaining(`permission denied for table ${table}`) as unknown,
  });
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
    // This suite checks grants, not isolation: like `getTestPool`'s, every connection starts in
    // tenant zero, which strict `app_tenant_default()` (#1067) no longer falls back to.
    const inTenantZeroOptions = tenantZeroSessionOptions();
    dataPool = new Pool({ connectionString: roleConnectionString("semprec_data"), options: inTenantZeroOptions });
    sidePool = new Pool({ connectionString: roleConnectionString("semprec_side"), options: inTenantZeroOptions });
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
    // Written only by semprec_data (migration 0057); semprec_side keeps SELECT on these two only
    // (migration 0177 revoked the rest); covered by identityTablePrivileges.test.ts.
    const IDENTITY_TABLES = new Set(["users", "tenants"]);

    // Deliberately without UPDATE for both runtime roles (migration 0062): rewriting a key row would
    // orphan every credential sealed under it, so a key is only ever inserted or deleted (crypto-shred).
    const NO_UPDATE_TABLES = new Set(["tenant_keys", "admin_audit_log", "tenant_deletions"]);

    // Operator configuration written only by semprec-api (migration 0070): the gateway's semprec_side
    // may read it but never raise its own caps, and nobody deletes a row (it goes with its tenant).
    // transcript_action_item_states (issue #1754) is written by the API's transcript route and the trash purge:
    // semprec_side reads it, semprec_data runs DML.
    // agent_runs and approval_requests (migration 0177) create or retarget an actor: the AI gateway reads
    // agent_runs to attribute a call, semprec_data runs the DML.
    const READ_ONLY_FOR_SIDE_TABLES = new Set([
      "tenant_ai_budgets",
      "transcript_action_item_states",
      "agent_runs",
      "approval_requests",
    ]);
    // Bearer credentials, session secrets, delivery endpoints and admin-plane rows no side process needs
    // (migration 0177): semprec_side holds no privilege on them, semprec_data holds DML directly.
    // admin_audit_log (migration 0074) is append-only and tenant_deletions (migration 0079) is the purge
    // tombstone: semprec_data only inserts. invites (migration 0077) is written by the admin routes only.
    const NO_ACCESS_FOR_SIDE_TABLES = new Set([
      "agent_run_mcp_credentials",
      "push_subscriptions",
      "sessions",
      "password_reset_tokens",
      "login_attempts",
      "invites",
      "admin_audit_log",
      "tenant_deletions",
    ]);
    // tenant_deletions (migration 0079) is the purge tombstone: semprec_data only inserts.
    const NO_DELETE_TABLES = new Set(["tenant_ai_budgets", "admin_audit_log", "tenant_deletions"]);

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
        const noAccessForSide = NO_ACCESS_FOR_SIDE_TABLES.has(table.name);
        const sideReadOnly =
          chokePointNames.has(table.name) ||
          IDENTITY_TABLES.has(table.name) ||
          READ_ONLY_FOR_SIDE_TABLES.has(table.name);
        if ((await hasPrivilege("semprec_side", table.oid, "SELECT")) === noAccessForSide) {
          offenders.push(`${table.name}:semprec_side:SELECT`);
        }
        const noUpdate = NO_UPDATE_TABLES.has(table.name);
        for (const privilege of WRITE_PRIVILEGES) {
          const expectedForSide = !noAccessForSide && !sideReadOnly && !(noUpdate && privilege === "UPDATE");
          const sideHas = await hasPrivilege("semprec_side", table.oid, privilege);
          if (sideHas !== expectedForSide) offenders.push(`${table.name}:semprec_side:${privilege}`);
        }
        for (const privilege of ["SELECT", ...WRITE_PRIVILEGES]) {
          const expectedForData =
            !(noUpdate && privilege === "UPDATE") && !(NO_DELETE_TABLES.has(table.name) && privilege === "DELETE");
          if ((await hasPrivilege("semprec_data", table.oid, privilege)) !== expectedForData) {
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
      // The run's actor must be the run's own tenant's user (agent_runs_actor_user_id_tenant_fkey).
      const user = await createUser(adminPool, {
        email: `owner-${randomUUID()}@example.test`,
        passwordHash,
        locale: "en",
        tenantId: getTenantZeroId(),
      });

      const projectItemId = await createTestProjectItem(adminPool);
      const minted = await withTransaction(dataPool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId: user.id }),
      );
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

    it("lets semprec_side UPDATE and DELETE mail_message_flag_sync_state rows", async () => {
      const messageItemId = randomUUID();
      await withTransaction(adminPool, (client) =>
        recordDesiredMailMessageFlags(client, messageItemId, { read: true }),
      );

      const flagUpdate = await sidePool.query(
        `UPDATE mail_message_flag_sync_state SET current_state = true WHERE message_item_id = $1`,
        [messageItemId],
      );
      const flagDelete = await sidePool.query(`DELETE FROM mail_message_flag_sync_state WHERE message_item_id = $1`, [
        messageItemId,
      ]);

      expect([flagUpdate.rowCount, flagDelete.rowCount]).toEqual([1, 1]);
    });

    it("refuses semprec_side every statement on agent_run_mcp_credentials", async () => {
      const passwordHash = await hashPassword("s3cret-password");
      // The run's actor must be the run's own tenant's user (agent_runs_actor_user_id_tenant_fkey).
      const user = await createUser(adminPool, {
        email: `owner-${randomUUID()}@example.test`,
        passwordHash,
        locale: "en",
        tenantId: getTenantZeroId(),
      });
      const projectItemId = await createTestProjectItem(adminPool);
      const minted = await withTransaction(dataPool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId: user.id }),
      );

      await expectPermissionDenied(
        sidePool.query(`UPDATE agent_run_mcp_credentials SET expires_at = now() WHERE agent_run_id = $1`, [
          minted.run.id,
        ]),
        "agent_run_mcp_credentials",
      );
      await expectPermissionDenied(
        sidePool.query(`DELETE FROM agent_run_mcp_credentials WHERE agent_run_id = $1`, [minted.run.id]),
        "agent_run_mcp_credentials",
      );
      await expectPermissionDenied(
        sidePool.query(`SELECT agent_run_id FROM agent_run_mcp_credentials`),
        "agent_run_mcp_credentials",
      );

      // The refused statements changed nothing: the credential still resolves, with its expiry.
      expect((await resolveMcpRunCredential(dataPool, minted.token))?.runId).toBe(minted.run.id);
      const { rows } = await adminPool.query<{ expired: boolean }>(
        `SELECT expires_at <= now() AS expired FROM agent_run_mcp_credentials WHERE agent_run_id = $1`,
        [minted.run.id],
      );
      expect(rows).toEqual([{ expired: false }]);
    });

    it("semprec_side cannot mint an MCP run credential", async () => {
      const passwordHash = await hashPassword("s3cret-password");
      // The run's actor must be the run's own tenant's user (agent_runs_actor_user_id_tenant_fkey).
      const user = await createUser(adminPool, {
        email: `owner-${randomUUID()}@example.test`,
        passwordHash,
        locale: "en",
        tenantId: getTenantZeroId(),
      });
      const otherUser = await createUser(adminPool, {
        email: `other-${randomUUID()}@example.test`,
        passwordHash,
        locale: "en",
        tenantId: await createTestTenant(adminPool),
      });
      const projectItemId = await createTestProjectItem(adminPool);
      // The one legitimate run and credential, written by semprec_data the way the mint action does.
      const minted = await withTransaction(dataPool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId: user.id }),
      );
      const rogueToken = `rogue-${randomUUID()}`;

      // Every statement runs in tenant zero's scope, where the minted run lives, as the review's sequence did.
      await expectPermissionDenied(
        sidePool.query(
          `INSERT INTO agent_runs (project_item_id, triggered_by, unit, task, actor_user_id)
           VALUES ($1, 'mcp', 'invocation', 'minted by the side role', $2)`,
          [projectItemId, user.id],
        ),
        "agent_runs",
      );
      await expectPermissionDenied(
        sidePool.query(`UPDATE agent_runs SET actor_user_id = $1 WHERE id = $2`, [otherUser.id, minted.run.id]),
        "agent_runs",
      );
      await expectPermissionDenied(
        sidePool.query(
          `INSERT INTO agent_run_mcp_credentials (tenant_id, agent_run_id, token_hash, capabilities, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
          [getTenantZeroId(), minted.run.id, hashToken(rogueToken), ["core.item.write"]],
        ),
        "agent_run_mcp_credentials",
      );
      await expectPermissionDenied(
        sidePool.query(
          `INSERT INTO approval_requests (agent_run_id, tool_name, risk_class, payload, resource_snapshot)
           VALUES ($1, 'rogue_tool', 'unclassified', '{}'::jsonb, '{"kind":"test","resourceId":"rogue","sha256":null}'::jsonb)`,
          [minted.run.id],
        ),
        "approval_requests",
      );
      await expectPermissionDenied(
        sidePool.query(
          `INSERT INTO push_subscriptions (user_id, channel, platform, endpoint, p256dh, auth_secret)
           VALUES ($1, 'web_push', 'web', 'https://attacker.example.test/push', 'p256dh', 'auth')`,
          [user.id],
        ),
        "push_subscriptions",
      );

      // Nothing was stored (checked on the admin pool, which bypasses row-level security).
      const { rows } = await adminPool.query<{
        runs: number;
        actor_user_id: string;
        credentials: number;
        approvals: number;
        subscriptions: number;
      }>(
        `SELECT (SELECT count(*)::int FROM agent_runs) AS runs,
                (SELECT actor_user_id FROM agent_runs WHERE id = $1) AS actor_user_id,
                (SELECT count(*)::int FROM agent_run_mcp_credentials) AS credentials,
                (SELECT count(*)::int FROM approval_requests) AS approvals,
                (SELECT count(*)::int FROM push_subscriptions) AS subscriptions`,
        [minted.run.id],
      );
      expect(rows).toEqual([{ runs: 1, actor_user_id: user.id, credentials: 1, approvals: 0, subscriptions: 0 }]);
      expect(await resolveMcpRunCredential(dataPool, rogueToken)).toBeNull();
      expect((await resolveMcpRunCredential(dataPool, minted.token))?.runId).toBe(minted.run.id);

      // What the AI gateway needs stays allowed: reading the runs and approval requests.
      const readable = await sidePool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE id = $1`, [minted.run.id]);
      expect(readable.rows).toEqual([{ id: minted.run.id }]);
      await expect(sidePool.query(`SELECT id FROM approval_requests`)).resolves.toBeDefined();
    });
  });
});
