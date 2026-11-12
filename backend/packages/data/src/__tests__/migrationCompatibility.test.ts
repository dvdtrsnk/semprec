import { mkdtemp, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { login, verifySessionToken } from "../auth/authActions.js";
import { hashPassword } from "../auth/passwordHash.js";
import { runMigrations } from "../db/migrate.js";
import { withTransaction } from "../db/pool.js";
import { runApprovalRequestExecutionStatusCutoverMigration } from "../mcp/approvalRequestExecutionStatusCutoverMigration.js";
import { getApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";
import { raiseProblem } from "../semp/sempProblemsStore.js";
import {
  ensureItemAutomation,
  markItemAutomationError,
  markItemAutomationNotFound,
} from "../library/itemAutomationStore.js";
import { upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";

/**
 * Compatibility fixture for issue #191: applies each migration example on top of the previous
 * release's schema with the real migration runner, then runs the previous release's code against
 * the result — exactly what happens while a deploy migrates and after `deploy.sh --rollback`.
 */

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrationExamples");
const LONG_TITLE = "a title longer than ten characters";

/** pg-pool.end() may resolve before its sockets finish closing. Never FORCE those sockets away. */
async function dropClosedDatabase(admin: Pool, name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Invalid fixture database name");
  await vi.waitFor(
    async () => {
      const { rows } = await admin.query<{ remaining: number }>(
        "SELECT count(*)::int AS remaining FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      expect(rows).toEqual([{ remaining: 0 }]);
    },
    { timeout: 5000, interval: 10 },
  );
  await admin.query(`DROP DATABASE "${name}"`);
}

it("adds unverified classification without changing populated historical blobs", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  const name = `batch23_blobs_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch23-blobs-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0131_blob_detected_mime_type.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort())
      await copyFile(path.join(migrations, file), path.join(dir, file));
    await runMigrations(scratch, dir);
    const tenant = await scratch.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId || tenant.rows.length !== 1) throw new Error("Expected historical tenant");
    await scratch.query(
      "INSERT INTO blobs (tenant_id, mime_type, byte_size, storage_key, content_hash) VALUES ($1, $2, $3, $4, $5)",
      [tenantId, "image/png", 12, "historical-key", "historical-hash"],
    );
    const before = await scratch.query<{ row: unknown }>("SELECT to_jsonb(b) AS row FROM blobs b");
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);
    const after = await scratch.query<{ row: unknown; detected_mime_type: string | null }>(
      "SELECT to_jsonb(b) - 'detected_mime_type' AS row, detected_mime_type FROM blobs b",
    );
    expect(after.rows).toEqual(before.rows.map(({ row }) => ({ row, detected_mime_type: null })));
    await runMigrations(scratch, dir);
    expect((await scratch.query("SELECT detected_mime_type FROM blobs")).rows).toEqual([{ detected_mime_type: null }]);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "Blob upgrade cleanup failed",
    );
  if (failure) throw failure.error;
}, 120_000);

it("preserves populated users when the display name migration runs", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The database identifier consists of a fixed prefix and generated UUID hex.
  const name = `batch20_users_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch20-users-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0124_users_display_name.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenant = await scratch.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId || tenant.rows.length !== 1) throw new Error("Expected one historical tenant");
    const password = "synthetic-historical-password";
    const passwordHash = await hashPassword(password);
    const userId = randomUUID();
    // The current createUser writer selects display_name, which does not exist in the historical schema.
    await scratch.query(
      "INSERT INTO users (id, tenant_id, email, password_hash, role, locale) VALUES ($1, $2, $3, $4, $5, $6)",
      [userId, tenantId, "legacy@example.test", passwordHash, "admin", "en"],
    );
    const second = await scratch.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
    const secondTenantId = second.rows[0]?.id;
    if (!secondTenantId) throw new Error("Expected second historical tenant");
    await scratch.query(
      "INSERT INTO users (tenant_id, email, password_hash, role, locale) VALUES ($1, $2, $3, $4, $5)",
      [secondTenantId, "second@example.test", "other-hash", "member", "cs"],
    );
    const before = await scratch.query<{ row: unknown }>("SELECT to_jsonb(u) AS row FROM users u ORDER BY id");
    expect(before.rows).toHaveLength(2);
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);
    const after = await scratch.query<{ row: unknown; display_name: string | null }>(
      "SELECT to_jsonb(u) - 'display_name' AS row, display_name FROM users u ORDER BY id",
    );
    expect(after.rows).toEqual(before.rows.map(({ row }) => ({ row, display_name: null })));
    const db = scratch;
    const result = await runAsSystem("historical-login-test", () =>
      login(db, {
        email: "legacy@example.test",
        password,
        platform: "ios",
        ip: "192.0.2.4",
      }),
    );
    expect(result.user).toMatchObject({ id: userId, email: "legacy@example.test", displayName: null });
    expect(result.role).toBe("admin");
    const identity = await runAsSystem("historical-login-test", () => verifySessionToken(db, result.token));
    expect(identity).toMatchObject({ tenantId, role: "admin", user: { id: userId, displayName: null } });
    const sessions = await scratch.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM sessions WHERE id = $1",
      [result.session.id],
    );
    expect(sessions.rows).toEqual([{ id: result.session.id, user_id: userId }]);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "User upgrade cleanup failed",
    );
  if (failure) throw failure.error;
}, 120_000);

it("adds the move state table over populated mail without changing existing metadata", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The generated identifier is a fixed prefix and UUID hex.
  const name = `batch18_move_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch18-move-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0129_mail_message_move_sync_state.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    const db = scratch;
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(db, dir);
    const tenants = await db.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenants.rows[0]?.id;
    if (!tenantId || tenants.rows.length !== 1) throw new Error("Expected one historical tenant");
    const { mailboxId, messageId } = await runInTenant(tenantId, () =>
      withTransaction(db, async (client) => {
        // The current database writer returns databases.overview_hidden, which only the later
        // database_overview_hidden migration adds; write the two fixture databases, each with its items
        // partition, in the shape this schema has.
        const createFixtureDatabase = async (name: string): Promise<{ id: string }> => {
          const { rows } = await client.query<{ id: string }>("INSERT INTO databases (name) VALUES ($1) RETURNING id", [
            name,
          ]);
          const id = rows[0]?.id;
          if (id === undefined) throw new Error("Expected the inserted fixture database");
          await client.query("SELECT create_items_partition($1::uuid)", [id]);
          return { id };
        };
        const mailboxDb = await createFixtureDatabase("Mailboxes");
        const emailDb = await createFixtureDatabase("Emails");
        // The current item writer returns items.created_at, which only migration 0143 adds; write the two
        // fixture rows in the actual pre-0143 shape, in the historical tenant.
        const mailbox = { id: randomUUID() };
        const message = { id: randomUUID() };
        for (const [item, databaseId] of [
          [mailbox, mailboxDb.id],
          [message, emailDb.id],
        ] as const) {
          await client.query("INSERT INTO items (id, database_id, tenant_id) VALUES ($1, $2, $3)", [
            item.id,
            databaseId,
            tenantId,
          ]);
        }
        await upsertMailMessageMeta(client, {
          itemId: message.id,
          mailboxItemId: mailbox.id,
          messageId: `<${randomUUID()}@example.test>`,
          envelope: {},
        });
        return { mailboxId: mailbox.id, messageId: message.id };
      }),
    );
    const before = (
      await db.query<{ row: unknown }>("SELECT to_jsonb(m) AS row FROM mail_message_meta m WHERE item_id = $1", [
        messageId,
      ])
    ).rows[0]?.row;
    expect(before).toBeDefined();
    expect(
      (
        await db.query<{ name: string | null }>(
          "SELECT to_regclass('public.mail_message_move_sync_state')::text AS name",
        )
      ).rows,
    ).toEqual([{ name: null }]);
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(db, dir);
    expect(
      (
        await db.query<{ row: unknown }>("SELECT to_jsonb(m) AS row FROM mail_message_meta m WHERE item_id = $1", [
          messageId,
        ])
      ).rows[0]?.row,
    ).toEqual(before);
    const catalog = await db.query<{ relrowsecurity: boolean; can_insert: boolean; policy_count: string }>(
      `SELECT c.relrowsecurity, has_table_privilege('semprec_side', c.oid, 'INSERT') AS can_insert,
         (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
       FROM pg_class c WHERE c.oid = 'mail_message_move_sync_state'::regclass`,
    );
    expect(catalog.rows).toEqual([{ relrowsecurity: true, can_insert: true, policy_count: "2" }]);
    await runInTenant(tenantId, () =>
      withTransaction(db, (client) =>
        client.query(
          'INSERT INTO mail_message_move_sync_state (message_item_id, mailbox_item_id, desired_purpose, source_evidence) VALUES ($1, $2, \'archive\', \'{"provider":"gmail","providerMessageId":"fixture"}\')',
          [messageId, mailboxId],
        ),
      ),
    );
    await expect(
      runInTenant(tenantId, () =>
        withTransaction(db, (client) =>
          client.query(
            "UPDATE mail_message_move_sync_state SET desired_purpose = 'unknown' WHERE message_item_id = $1",
            [messageId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "Move upgrade cleanup failed",
    );
  if (failure) throw failure.error;
}, 120_000);

it("preserves a historical problem and lazily records its last known occurrence on upgrade", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The generated database identifier contains a fixed prefix and UUID hex.
  const name = `batch18_receipt_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch18-receipt-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0128_semp_problem_occurrences.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    const db = scratch;
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(db, dir);
    const tenants = await db.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenants.rows[0]?.id;
    if (!tenantId || tenants.rows.length !== 1) throw new Error("Expected one historical tenant");
    const userId = randomUUID();
    const sourceId = randomUUID();
    // The pre-upgrade store wrote this row without an occurrence receipt table.
    await db.query("INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'unused')", [
      userId,
      tenantId,
      `${userId}@example.test`,
    ]);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO semp_problems (tenant_id, user_id, category, kind, severity, source_table, source_id, dedupe_key, occurrence_count, last_occurrence_key)
       VALUES ($1, $2, 'mail', 'sync', 'warning', 'mail_account_sync_state', $3, 'upgrade', 4, 'old-last') RETURNING id`,
      [tenantId, userId, sourceId],
    );
    const problemId = inserted.rows[0]?.id;
    if (!problemId) throw new Error("Missing historical problem");
    const before = (
      await db.query<{ row: unknown }>("SELECT to_jsonb(p) AS row FROM semp_problems p WHERE id = $1", [problemId])
    ).rows[0]?.row;
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(db, dir);
    expect(
      (await db.query<{ row: unknown }>("SELECT to_jsonb(p) AS row FROM semp_problems p WHERE id = $1", [problemId]))
        .rows[0]?.row,
    ).toEqual(before);
    expect((await db.query("SELECT 1 FROM semp_problem_occurrences")).rows).toEqual([]);
    await runInTenant(tenantId, () =>
      withTransaction(db, (client) =>
        raiseProblem(client, {
          userId,
          category: "mail",
          kind: "sync",
          severity: "warning",
          sourceTable: "mail_account_sync_state",
          sourceId,
          dedupeKey: "upgrade",
          occurrenceKey: "new-job",
        }),
      ),
    );
    await runInTenant(tenantId, () =>
      withTransaction(db, (client) =>
        raiseProblem(client, {
          userId,
          category: "mail",
          kind: "sync",
          severity: "warning",
          sourceTable: "mail_account_sync_state",
          sourceId,
          dedupeKey: "upgrade",
          occurrenceKey: "old-last",
        }),
      ),
    );
    expect(
      (
        await db.query<{ occurrence_count: number }>("SELECT occurrence_count FROM semp_problems WHERE id = $1", [
          problemId,
        ])
      ).rows,
    ).toEqual([{ occurrence_count: 5 }]);
    expect(
      (
        await db.query<{ occurrence_key: string }>(
          "SELECT occurrence_key FROM semp_problem_occurrences WHERE problem_id = $1 ORDER BY occurrence_key",
          [problemId],
        )
      ).rows,
    ).toEqual([{ occurrence_key: "new-job" }, { occurrence_key: "old-last" }]);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "Receipt upgrade cleanup failed",
    );
  if (failure) throw failure.error;
}, 120_000);

it("upgrades a populated search index through the page text migration", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The database identifier consists of a fixed prefix and UUID hex.
  const name = `batch18_search_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch18-search-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0120_item_search_index_body.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    const db = scratch;
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(db, dir);
    const tenants = await db.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenants.rows[0]?.id;
    if (!tenantId || tenants.rows.length !== 1) throw new Error("Expected one historical tenant");
    const databaseId = randomUUID();
    const itemId = randomUUID();
    await runInTenant(tenantId, () =>
      withTransaction(db, async (client) => {
        // Current item writers require later schema; use the actual pre-0120 shape.
        await client.query("INSERT INTO databases (id, name, tenant_id) VALUES ($1, 'Legacy', $2)", [
          databaseId,
          tenantId,
        ]);
        await client.query("SELECT create_items_partition($1::uuid)", [databaseId]);
        await client.query("INSERT INTO items (id, database_id, tenant_id) VALUES ($1, $2, $3)", [
          itemId,
          databaseId,
          tenantId,
        ]);
        await client.query(
          "INSERT INTO item_search_index (item_id, database_id, search_vector, tenant_id) VALUES ($1, $2, to_tsvector('simple', 'legacy text'), $3)",
          [itemId, databaseId, tenantId],
        );
      }),
    );
    const before = (
      await db.query<{ row: unknown }>("SELECT to_jsonb(s) AS row FROM item_search_index s WHERE item_id = $1", [
        itemId,
      ])
    ).rows[0]?.row;
    expect(before).toBeDefined();
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(db, dir);
    const upgraded = await db.query<{ old_row: unknown; body: string | null; page_text: string | null }>(
      "SELECT to_jsonb(s) - 'body' - 'page_text' AS old_row, body, page_text FROM item_search_index s WHERE item_id = $1",
      [itemId],
    );
    expect(upgraded.rows).toEqual([{ old_row: before, body: null, page_text: null }]);
    await db.query(
      "UPDATE item_search_index SET search_vector = to_tsvector('simple', 'old writer') WHERE item_id = $1",
      [itemId],
    );
    expect(
      (
        await db.query<{ body: string | null; page_text: string | null; matches: boolean }>(
          "SELECT body, page_text, search_vector @@ plainto_tsquery('simple', 'writer') AS matches FROM item_search_index WHERE item_id = $1",
          [itemId],
        )
      ).rows,
    ).toEqual([{ body: null, page_text: null, matches: true }]);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "Search upgrade cleanup failed",
    );
  if (failure) throw failure.error;
}, 120_000);

it("upgrades populated heartbeats and sessions through tick and device migrations", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  const name = `batch16_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch16-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    // The database name is a fixed prefix followed by UUID hex.
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    const db = scratch;
    const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();
    async function advance(through: string): Promise<void> {
      for (const file of files.filter((entry) => entry <= through)) {
        await copyFile(path.join(migrations, file), path.join(dir, file));
      }
      await runMigrations(db, dir);
    }
    await advance("0086_z.sql");
    const tenant = await db.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId || tenant.rows.length !== 1) throw new Error("Expected one historical tenant");
    const databaseId = randomUUID();
    const projectId = randomUUID();
    const heartbeatId = randomUUID();
    const userId = randomUUID();
    const sessionId = randomUUID();
    // Current stores depend on later columns; these rows use the actual pre-0087 schema.
    await runInTenant(tenantId, () =>
      withTransaction(db, async (client) => {
        await client.query(
          "INSERT INTO databases (id, name, owner_module_id, system, tenant_id) VALUES ($1, 'Projects', 'projects', true, $2)",
          [databaseId, tenantId],
        );
        await client.query("SELECT create_items_partition($1::uuid)", [databaseId]);
        await client.query("INSERT INTO items (id, database_id, tenant_id) VALUES ($1, $2, $3)", [
          projectId,
          databaseId,
          tenantId,
        ]);
        await client.query(
          "INSERT INTO project_heartbeats (id, project_item_id, name, rule, action_id, tenant_id) VALUES ($1, $2, 'Legacy', $3::jsonb, 'core.agentRun', $4)",
          [heartbeatId, projectId, JSON.stringify({ kind: "interval", minutes: 5 }), tenantId],
        );
        await client.query("INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'unused')", [
          userId,
          tenantId,
          `${userId}@example.test`,
        ]);
        await client.query(
          "INSERT INTO sessions (id, user_id, token_hash, platform, expires_at) VALUES ($1, $2, 'legacy-token', 'ios', now() + interval '1 day')",
          [sessionId, userId],
        );
      }),
    );
    await advance("0087_z.sql");
    const tickSchema = await db.query<{ relrowsecurity: boolean; can_insert: boolean }>(
      "SELECT relrowsecurity, has_table_privilege('semprec_side', 'semp_threads', 'INSERT') AS can_insert FROM pg_class WHERE oid = 'semp_threads'::regclass",
    );
    expect(tickSchema.rows).toEqual([{ relrowsecurity: true, can_insert: true }]);
    const insertTick = () =>
      runInTenant(tenantId, () =>
        withTransaction(db, (client) =>
          client.query("INSERT INTO semp_threads (tenant_id, kind, heartbeat_id) VALUES ($1, 'tick', $2)", [
            tenantId,
            heartbeatId,
          ]),
        ),
      );
    await insertTick();
    await expect(insertTick()).rejects.toMatchObject({ code: "23505" });
    expect(
      (await db.query<{ name: string }>("SELECT name FROM project_heartbeats WHERE id = $1", [heartbeatId])).rows,
    ).toEqual([{ name: "Legacy" }]);
    await advance("0091_z.sql");
    const legacy = await db.query<{
      device_id: string | null;
      device_name: string | null;
      device_kind: string | null;
      os_version: string | null;
      app_version: string | null;
    }>("SELECT device_id, device_name, device_kind, os_version, app_version FROM sessions WHERE id = $1", [sessionId]);
    expect(legacy.rows).toEqual([
      { device_id: null, device_name: null, device_kind: null, os_version: null, app_version: null },
    ]);
    const legacyWriter = await withTransaction(db, (client) =>
      client.query<{ device_kind: string | null }>(
        "INSERT INTO sessions (user_id, token_hash, platform, expires_at) VALUES ($1, 'legacy-writer', 'web', now() + interval '1 day') RETURNING device_kind",
        [userId],
      ),
    );
    expect(legacyWriter.rows).toEqual([{ device_kind: null }]);
    await expect(
      withTransaction(db, (client) =>
        client.query("UPDATE sessions SET device_kind = 'phone' WHERE id = $1", [sessionId]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(failure ? [failure.error, ...cleanupErrors] : cleanupErrors, "Upgrade cleanup failed", {
      cause: failure?.error,
    });
  if (failure) throw failure.error;
}, 120_000);

it("upgrades populated approvals and notifications through the batch 15 additive migrations", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The generated database identifier contains only a fixed prefix and UUID hex.
  const name = `batch15_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch15-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  let files: string[] = [];
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    const db = scratch;
    async function migrateThrough(last: string): Promise<void> {
      for (const file of files.filter((entry) => entry <= last)) {
        await copyFile(path.join(migrations, file), path.join(dir, file));
      }
      await runMigrations(db, dir);
    }
    const prior = files.find((file) => file.startsWith("0115_"));
    if (!prior) throw new Error("Missing pre-0116 migration");
    await migrateThrough(prior);
    await runApprovalRequestExecutionStatusCutoverMigration(db);
    await runAgentRunsActorUserIdCutoverMigration(db);
    const tenantId = (await db.query<{ id: string }>("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
    if (!tenantId) throw new Error("Missing initial tenant");
    const userId = randomUUID();
    const runId = randomUUID();
    const requestId = randomUUID();
    const notificationId = randomUUID();
    // Current writers cannot target the pre-0116 schema, so these are historical fixtures.
    await withTransaction(db, async (client) => {
      await client.query("INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'unused')", [
        userId,
        tenantId,
        `${userId}@example.test`,
      ]);
      await client.query(
        "INSERT INTO agent_runs (id, tenant_id, actor_user_id, triggered_by, task) VALUES ($1, $2, $3, 'user', 'legacy')",
        [runId, tenantId, userId],
      );
      await client.query(
        'INSERT INTO approval_requests (id, tenant_id, agent_run_id, tool_name, risk_class, payload, resource_snapshot) VALUES ($1, $2, $3, \'legacy_tool\', \'unclassified\', $4::jsonb, \'{"kind":"test","resourceId":"legacy","sha256":null}\'::jsonb)',
        [
          requestId,
          tenantId,
          runId,
          JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} }),
        ],
      );
      await client.query(
        "INSERT INTO notifications (id, tenant_id, user_id, kind, title, source_table, source_id, transition_instance) VALUES ($1, $2, $3, 'approval_pending', 'Legacy', 'legacy', 'old', 'one')",
        [notificationId, tenantId, userId],
      );
    });
    const originalApproval = (
      await db.query<{ row: unknown }>("SELECT to_jsonb(a) AS row FROM approval_requests a WHERE id = $1", [requestId])
    ).rows[0]?.row;
    const originalNotification = (
      await db.query<{ row: unknown }>("SELECT to_jsonb(n) AS row FROM notifications n WHERE id = $1", [notificationId])
    ).rows[0]?.row;
    expect(originalApproval).toBeDefined();
    expect(originalNotification).toBeDefined();
    await migrateThrough("0116_approval_requests_tool_call_id.sql");
    const afterId = await db.query<{ tool_name: string; tool_call_id: string | null }>(
      "SELECT tool_name, tool_call_id FROM approval_requests WHERE id = $1",
      [requestId],
    );
    expect(afterId.rows).toEqual([{ tool_name: "legacy_tool", tool_call_id: null }]);
    await withTransaction(db, async (client) => {
      await client.query("UPDATE approval_requests SET tool_call_id = 'call' WHERE id = $1", [requestId]);
      await client.query(
        "INSERT INTO approval_requests (tenant_id, agent_run_id, tool_name, risk_class, payload, resource_snapshot) VALUES ($1, $2, 'old_writer', 'unclassified', $3::jsonb, $4::jsonb), ($1, $2, 'old_writer_2', 'unclassified', $3::jsonb, $4::jsonb)",
        [
          tenantId,
          runId,
          JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} }),
          JSON.stringify({ kind: "test", resourceId: "legacy", sha256: null }),
        ],
      );
    });
    await expect(
      withTransaction(db, (client) =>
        client.query(
          "INSERT INTO approval_requests (tenant_id, agent_run_id, tool_name, risk_class, payload, resource_snapshot, tool_call_id) VALUES ($1, $2, 'duplicate', 'unclassified', $3::jsonb, $4::jsonb, 'call')",
          [
            tenantId,
            runId,
            JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} }),
            JSON.stringify({ kind: "test", resourceId: "legacy", sha256: null }),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await migrateThrough("0117_approval_requests_description.sql");
    expect(
      (
        await db.query<{ row: unknown }>(
          "SELECT to_jsonb(a) - 'tool_call_id' - 'description' AS row FROM approval_requests a WHERE id = $1",
          [requestId],
        )
      ).rows[0]?.row,
    ).toEqual(originalApproval);
    await withTransaction(db, (client) =>
      client.query(
        "INSERT INTO approval_requests (tenant_id, agent_run_id, tool_name, risk_class, payload, resource_snapshot) VALUES ($1, $2, 'post_0117_writer', 'unclassified', $3::jsonb, $4::jsonb)",
        [
          tenantId,
          runId,
          JSON.stringify({ mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} }),
          JSON.stringify({ kind: "test", resourceId: "legacy", sha256: null }),
        ],
      ),
    );
    expect(
      (
        await db.query<{ tool_call_id: string | null; description: unknown }>(
          "SELECT tool_call_id, description FROM approval_requests WHERE tool_name = 'post_0117_writer'",
        )
      ).rows,
    ).toEqual([{ tool_call_id: null, description: null }]);
    const description = await db.query<{ description: unknown }>(
      "SELECT description FROM approval_requests WHERE id = $1",
      [requestId],
    );
    expect(description.rows).toEqual([{ description: null }]);
    expect(await getApprovalRequest(db, requestId)).toMatchObject({
      id: requestId,
      toolName: "legacy_tool",
      executionStatus: "not_approved",
      toolCallId: "call",
      description: null,
    });
    await migrateThrough("0122_notifications_body.sql");
    expect(
      (
        await db.query<{ row: unknown }>("SELECT to_jsonb(n) - 'body' AS row FROM notifications n WHERE id = $1", [
          notificationId,
        ])
      ).rows[0]?.row,
    ).toEqual(originalNotification);
    const notification = await db.query<{ title: string; body: string | null }>(
      "SELECT title, body FROM notifications WHERE id = $1",
      [notificationId],
    );
    expect(notification.rows).toEqual([{ title: "Legacy", body: null }]);
    await withTransaction(db, (client) =>
      client.query(
        "INSERT INTO notifications (tenant_id, user_id, kind, title, source_table, source_id, transition_instance) VALUES ($1, $2, 'approval_pending', 'Old writer', 'legacy', 'new', 'one')",
        [tenantId, userId],
      ),
    );
    expect(
      (await db.query<{ body: string | null }>("SELECT body FROM notifications WHERE source_id = 'new'")).rows,
    ).toEqual([{ body: null }]);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "Batch 15 migration test cleanup failed",
    );
  if (failure) throw failure.error;
}, 120_000);

it("upgrades populated item automation through migration 0092 and retains legacy reads and writes", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  const name = `automation_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-automation-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0092_item_automation_error_code.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort())
      await copyFile(path.join(migrations, file), path.join(dir, file));
    await runMigrations(scratch, dir);
    const tenantRows = await scratch.query<Record<string, unknown>>("SELECT id FROM tenants LIMIT 1");
    const tenantId = z.object({ id: z.uuid() }).parse(tenantRows.rows[0]).id;
    const oldId = randomUUID();
    await scratch.query(
      "INSERT INTO item_automation (item_id, tenant_id, status, error, attempts) VALUES ($1, $2, 'error', 'legacy diagnostic', 2)",
      [oldId, tenantId],
    );
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);
    const previous = await scratch.query<Record<string, unknown>>(
      "SELECT item_id, status, error, attempts, error_code FROM item_automation WHERE item_id = $1",
      [oldId],
    );
    expect(
      z
        .object({
          item_id: z.uuid(),
          status: z.string(),
          error: z.string(),
          attempts: z.number(),
          error_code: z.null(),
        })
        .parse(previous.rows[0]),
    ).toEqual({ item_id: oldId, status: "error", error: "legacy diagnostic", attempts: 2, error_code: null });
    const newId = randomUUID();
    await scratch.query(
      "INSERT INTO item_automation (item_id, tenant_id, status, error, attempts) VALUES ($1, $2, 'error', 'old writer', 1)",
      [newId, tenantId],
    );
    const legacy = await scratch.query<Record<string, unknown>>(
      "SELECT status, error, attempts FROM item_automation WHERE item_id = $1",
      [newId],
    );
    expect(z.object({ status: z.string(), error: z.string(), attempts: z.number() }).parse(legacy.rows[0])).toEqual({
      status: "error",
      error: "old writer",
      attempts: 1,
    });
  } catch (error) {
    failure = { error };
  }
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}, 120_000);

/** The previous release's data access: it names only `id` and `title`. */
async function previousReleaseWritesAndReadsANote(pool: Pool): Promise<void> {
  await pool.query("INSERT INTO notes (id, title) VALUES ($1, $2)", [1, LONG_TITLE]);
  const { rows } = await pool.query<{ id: number; title: string }>("SELECT id, title FROM notes WHERE id = $1", [1]);
  expect(rows).toEqual([{ id: 1, title: LONG_TITLE }]);
}

async function withScratchSchema(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `migration_compat_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const scratchPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await fn(scratchPool);
    } finally {
      await scratchPool.end();
      await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  } finally {
    await adminPool.end();
  }
}

/** Migrates a scratch schema to the previous release's schema plus one example, then runs `fn`. */
async function withExampleApplied(kind: "accepted" | "rejected", file: string, fn: (pool: Pool) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-migration-compat-"));
  try {
    await copyFile(path.join(EXAMPLES_DIR, "previous-release.sql"), path.join(dir, "0001_previous_release.sql"));
    await withScratchSchema(async (pool) => {
      await runMigrations(pool, dir);
      await previousReleaseWritesAndReadsANote(pool);
      await pool.query("DELETE FROM notes");

      await copyFile(path.join(EXAMPLES_DIR, kind, file), path.join(dir, `0002_${file}`));
      await runMigrations(pool, dir);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
      expect(rows.map((r) => r.id)).toEqual(["0001_previous_release.sql", `0002_${file}`]);

      await fn(pool);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const acceptedExamples = (await readdir(path.join(EXAMPLES_DIR, "accepted"))).filter((f) => f.endsWith(".sql"));
const rejectedExamples = (await readdir(path.join(EXAMPLES_DIR, "rejected"))).filter((f) => f.endsWith(".sql"));

describe("previous release's code after a migration example", () => {
  it("has examples of both kinds to run", () => {
    expect(acceptedExamples.length).toBeGreaterThan(0);
    expect(rejectedExamples.length).toBeGreaterThan(0);
  });

  it.each(acceptedExamples)("keeps working after accepted/%s", async (file) => {
    await withExampleApplied("accepted", file, previousReleaseWritesAndReadsANote);
  });

  it.each(rejectedExamples)("breaks after rejected/%s", async (file) => {
    await withExampleApplied("rejected", file, async (pool) => {
      // A SQLSTATE code: the database itself refused the previous release's statement.
      await expect(previousReleaseWritesAndReadsANote(pool)).rejects.toMatchObject({ code: expect.any(String) });
    });
  });
});

it("upgrades populated properties through the real runner and retains previous-release reads and writes", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The database name is a fixed prefix and UUID hex, so the identifier cannot escape.
  const name = `property_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-property-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0127_properties_initial_position.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenant = (await scratch.query<{ id: string }>("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
    if (!tenant) throw new Error("missing initial tenant");
    const databaseId = randomUUID();
    await scratch.query("INSERT INTO databases (id, name, tenant_id) VALUES ($1, 'Legacy', $2)", [databaseId, tenant]);
    await scratch.query(
      "INSERT INTO properties (database_id, key, name, type, tenant_id) VALUES ($1, 'z', 'Z', 'text', $2), ($1, 'a', 'A', 'text', $2)",
      [databaseId, tenant],
    );
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);
    const after = await scratch.query<{ key: string; initial_position: number | null }>(
      "SELECT key, initial_position FROM properties WHERE database_id = $1 ORDER BY initial_position ASC NULLS LAST, key",
      [databaseId],
    );
    expect(after.rows).toEqual([
      { key: "a", initial_position: null },
      { key: "z", initial_position: null },
    ]);
    // The previous release names only its existing columns on both writes and reads.
    await scratch.query(
      "INSERT INTO properties (database_id, key, name, type, tenant_id) VALUES ($1, 'm', 'M', 'text', $2)",
      [databaseId, tenant],
    );
    const legacy = await scratch.query<{
      id: string;
      database_id: string;
      key: string;
      name: string;
      type: string;
      config: unknown;
      locked: boolean;
      owner: string;
      owner_process: string | null;
      migration_status: string;
    }>(
      "SELECT id, database_id, key, name, type, config, locked, owner, owner_process, migration_status FROM properties WHERE database_id = $1 ORDER BY key",
      [databaseId],
    );
    expect(legacy.rows.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "a", name: "A" },
      { key: "m", name: "M" },
      { key: "z", name: "Z" },
    ]);
    expect(
      (
        await scratch.query<{ initial_position: number | null }>(
          "SELECT initial_position FROM properties WHERE database_id = $1 AND key = 'm'",
          [databaseId],
        )
      ).rows[0]?.initial_position,
    ).toBeNull();
    await expect(
      scratch.query("UPDATE properties SET initial_position = -1 WHERE database_id = $1 AND key = 'm'", [databaseId]),
    ).rejects.toMatchObject({ code: "23514" });
  } catch (error) {
    failure = { error };
  }
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}, 120_000);

it("upgrades populated MCP and notification rows through the batch 08 migrations", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The generated identifier contains only a fixed prefix and UUID hex.
  const name = `batch08_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch08-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    const db = scratch;
    async function migrateThrough(last: string): Promise<void> {
      for (const file of files.filter((entry) => entry <= last)) {
        await copyFile(path.join(migrations, file), path.join(dir, file));
      }
      await runMigrations(db, dir);
    }
    const prior = files.find((file) => file.startsWith("0092_"));
    if (!prior) throw new Error("Missing pre-0093 migration");
    await migrateThrough(prior);
    const tenantId = (await db.query<{ id: string }>("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
    if (!tenantId) throw new Error("Missing initial tenant");
    const userId = randomUUID();
    const serverId = randomUUID();
    const registrationId = randomUUID();
    const notificationId = randomUUID();
    await db.query("INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, $4)", [
      userId,
      tenantId,
      `${userId}@example.test`,
      "unused",
    ]);
    await db.query(
      "INSERT INTO mcp_tool_registrations (id, tenant_id, mcp_server_item_id, tool_name, tool_schema) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [registrationId, tenantId, serverId, "legacy_tool", "{}"],
    );
    await db.query(
      "INSERT INTO notifications (id, tenant_id, user_id, kind, title, source_table, source_id, transition_instance) VALUES ($1, $2, $3, 'approval_pending', 'Legacy', 'legacy', 'old', 'one')",
      [notificationId, tenantId, userId],
    );
    async function hasColumn(table: string, column: string): Promise<boolean> {
      const { rows } = await db.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present",
        [table, column],
      );
      return rows[0]?.present === true;
    }
    expect(await hasColumn("mcp_tool_registrations", "display_label")).toBe(false);

    await migrateThrough("0093_mcp_tool_display_label.sql");
    expect(
      (
        await db.query<{ tool_name: string; display_label: unknown }>(
          "SELECT tool_name, display_label FROM mcp_tool_registrations WHERE id = $1",
          [registrationId],
        )
      ).rows,
    ).toEqual([{ tool_name: "legacy_tool", display_label: null }]);
    await db.query("UPDATE mcp_tool_registrations SET description = $2 WHERE id = $1", [
      registrationId,
      "legacy update",
    ]);
    await expect(
      db.query("UPDATE mcp_tool_registrations SET display_label = $2::jsonb WHERE id = $1", [
        registrationId,
        '"invalid"',
      ]),
    ).rejects.toMatchObject({ code: "23514" });

    const beforeResolved = files.find((file) => file.startsWith("0097_"));
    if (!beforeResolved) throw new Error("Missing pre-0098 migration");
    await migrateThrough(beforeResolved);
    expect(await hasColumn("notifications", "resolved_at")).toBe(false);
    expect(
      (await db.query<{ title: string }>("SELECT title FROM notifications WHERE id = $1", [notificationId])).rows,
    ).toEqual([{ title: "Legacy" }]);
    await migrateThrough("0098_notifications_resolved_at.sql");
    expect(
      (
        await db.query<{ title: string; resolved_at: Date | null }>(
          "SELECT title, resolved_at FROM notifications WHERE id = $1",
          [notificationId],
        )
      ).rows,
    ).toEqual([{ title: "Legacy", resolved_at: null }]);
    await db.query("UPDATE notifications SET title = $2 WHERE id = $1", [notificationId, "Legacy updated"]);
    expect(
      (
        await db.query<{ name: string | null }>(
          "SELECT to_regclass('public.mcp_server_connection_state')::text AS name",
        )
      ).rows[0]?.name,
    ).toBeNull();
    await migrateThrough("0099_mcp_server_connection_state.sql");
    await db.query("INSERT INTO mcp_server_connection_state (tenant_id, mcp_server_item_id) VALUES ($1, $2)", [
      tenantId,
      serverId,
    ]);
    expect(
      (
        await db.query<{ last_connected_at: Date | null; last_error_reason: string | null }>(
          "SELECT last_connected_at, last_error_reason FROM mcp_server_connection_state WHERE tenant_id = $1",
          [tenantId],
        )
      ).rows,
    ).toEqual([{ last_connected_at: null, last_error_reason: null }]);
    await expect(
      db.query("UPDATE mcp_server_connection_state SET last_error_reason = $1 WHERE tenant_id = $2", [
        "invalid",
        tenantId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });

    const beforePreferences = files.find((file) => file.startsWith("0118_"));
    if (!beforePreferences) throw new Error("Missing pre-0119 migration");
    await migrateThrough(beforePreferences);
    expect(
      (await db.query<{ name: string | null }>("SELECT to_regclass('public.notification_preferences')::text AS name"))
        .rows[0]?.name,
    ).toBeNull();
    await migrateThrough("0119_notification_preferences.sql");
    await db.query("INSERT INTO notification_preferences (tenant_id, user_id) VALUES ($1, $2)", [tenantId, userId]);
    expect(
      (
        await db.query<{
          approvals: boolean;
          invites: boolean;
          reminders: boolean;
          problems_level: string;
          problems_summary: boolean;
          badge_approvals: boolean;
          badge_invites: boolean;
          badge_inbox: boolean;
        }>(
          "SELECT approvals, invites, reminders, problems_level, problems_summary, badge_approvals, badge_invites, badge_inbox FROM notification_preferences WHERE user_id = $1",
          [userId],
        )
      ).rows,
    ).toEqual([
      {
        approvals: true,
        invites: true,
        reminders: true,
        problems_level: "critical",
        problems_summary: true,
        badge_approvals: true,
        badge_invites: true,
        badge_inbox: false,
      },
    ]);
    const beforeKind = files.find((file) => file.startsWith("0120_"));
    if (!beforeKind) throw new Error("Missing pre-0121 migration");
    await migrateThrough(beforeKind);
    await expect(
      db.query(
        "INSERT INTO notifications (tenant_id, user_id, kind, title, source_table, source_id, transition_instance) VALUES ($1, $2, 'semp_problem', 'Problem', 'legacy', 'new', 'one')",
        [tenantId, userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await migrateThrough("0121_notification_kind_semp_problem.sql");
    await db.query(
      "INSERT INTO notifications (tenant_id, user_id, kind, title, source_table, source_id, transition_instance) VALUES ($1, $2, 'semp_problem', 'Problem', 'legacy', 'new', 'one'), ($1, $2, 'approval_pending', 'Old writer', 'legacy', 'old-writer', 'one')",
      [tenantId, userId],
    );
    expect(
      (await db.query<{ kind: string; title: string }>("SELECT kind, title FROM notifications ORDER BY title")).rows,
    ).toEqual([
      { kind: "approval_pending", title: "Legacy updated" },
      { kind: "approval_pending", title: "Old writer" },
      { kind: "semp_problem", title: "Problem" },
    ]);
  } catch (error) {
    failure = { error };
  }
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}, 120_000);

it("upgrades populated heartbeats and runs through origin and retry migrations", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // This identifier contains only the hexadecimal digits of a generated UUID.
  const name = `batch12_upgrade_${randomUUID().replaceAll("-", "")}`;
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch12-upgrade-"));
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    const db = scratch;
    const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();
    async function advance(through: string): Promise<void> {
      for (const file of files.filter((entry) => entry <= through))
        await copyFile(path.join(migrations, file), path.join(dir, file));
      await runMigrations(db, dir);
    }
    await advance("0099_z.sql");
    const tenantRow = await db.query<{ id: string }>("SELECT id FROM tenants");
    const tenantId = tenantRow.rows[0]?.id;
    if (!tenantId || tenantRow.rows.length !== 1) throw new Error("Expected the historical tenant");
    const heartbeatId = randomUUID();
    const runId = randomUUID();
    const databaseId = randomUUID();
    const projectId = randomUUID();
    await runInTenant(tenantId, () =>
      withTransaction(db, async (seedClient) => {
        // The current stores depend on later schema columns; seed the historical Projects shape here.
        await seedClient.query(
          "INSERT INTO databases (id, name, owner_module_id, system, tenant_id) VALUES ($1, 'Projects', 'projects', true, $2)",
          [databaseId, tenantId],
        );
        await seedClient.query("SELECT create_items_partition($1::uuid)", [databaseId]);
        await seedClient.query("INSERT INTO items (id, database_id, tenant_id) VALUES ($1, $2, $3)", [
          projectId,
          databaseId,
          tenantId,
        ]);
      }),
    );
    // These rows use the schema before the three migrations under test.
    await db.query(
      `INSERT INTO project_heartbeats (id, project_item_id, name, rule, action_id, enabled, tenant_id)
      VALUES ($1, $2, 'Legacy', '{"kind":"interval","minutes":5}', 'core.agentRun', false, $3)`,
      [heartbeatId, projectId, tenantId],
    );
    await db.query(
      "INSERT INTO agent_runs (id, heartbeat_id, triggered_by, task, tenant_id) VALUES ($1, $2, 'heartbeat', 'legacy', $3)",
      [runId, heartbeatId, tenantId],
    );
    await advance("0100_z.sql");
    const heartbeat = await db.query<{ name: string; enabled: boolean; origin: string }>(
      "SELECT name, enabled, origin FROM project_heartbeats WHERE id = $1",
      [heartbeatId],
    );
    expect(heartbeat.rows).toEqual([{ name: "Legacy", enabled: false, origin: "system" }]);
    const legacyHeartbeat = await db.query<{ origin: string }>(
      `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, tenant_id)
       VALUES ($1, 'Old writer', '{"kind":"interval","minutes":5}', 'core.agentRun', $2) RETURNING origin`,
      [projectId, tenantId],
    );
    expect(legacyHeartbeat.rows).toEqual([{ origin: "system" }]);
    await expect(
      db.query("UPDATE project_heartbeats SET origin = $2 WHERE id = $1", [heartbeatId, "invalid"]),
    ).rejects.toMatchObject({ code: "23514" });
    await advance("0106_z.sql");
    const retry = await db.query<{ task: string; attempt: number; retry_of_run_id: string | null }>(
      "SELECT task, attempt, retry_of_run_id FROM agent_runs WHERE id = $1",
      [runId],
    );
    expect(retry.rows).toEqual([{ task: "legacy", attempt: 1, retry_of_run_id: null }]);
    await db.query(
      "INSERT INTO agent_runs (retry_of_run_id, attempt, triggered_by, task, tenant_id) VALUES ($1, 2, 'user', 'retry', $2)",
      [runId, tenantId],
    );
    await expect(
      db.query(
        "INSERT INTO agent_runs (retry_of_run_id, triggered_by, task, tenant_id) VALUES ($1, 'user', 'duplicate', $2)",
        [runId, tenantId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query(
        "INSERT INTO agent_runs (retry_of_run_id, triggered_by, task, tenant_id) VALUES ($1, 'user', 'missing', $2)",
        [randomUUID(), tenantId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("UPDATE agent_runs SET attempt = 0 WHERE id = $1", [runId])).rejects.toMatchObject({
      code: "23514",
    });
    await advance("0109_z.sql");
    const occurrence = await db.query<{ task: string; heartbeat_occurrence_id: string | null }>(
      "SELECT task, heartbeat_occurrence_id FROM agent_runs WHERE id = $1",
      [runId],
    );
    expect(occurrence.rows).toEqual([{ task: "legacy", heartbeat_occurrence_id: null }]);
    await db.query("INSERT INTO agent_runs (triggered_by, task, tenant_id) VALUES ('user', 'legacy writer', $1)", [
      tenantId,
    ]);
    await expect(
      db.query("UPDATE agent_runs SET heartbeat_occurrence_id = $2 WHERE id = $1", [runId, randomUUID()]),
    ).rejects.toMatchObject({ code: "23503" });
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await dropClosedDatabase(admin, name);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(failure ? [failure.error, ...cleanupErrors] : cleanupErrors, "Upgrade cleanup failed", {
      cause: failure?.error,
    });
  if (failure) throw failure.error;
}, 120_000);

it.skipIf(!process.env.BATCH29_BRIDGE_READER)(
  "preserves older automation rows and reads W outcomes with the captured bridge reader",
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    const readerPath = process.env.BATCH29_BRIDGE_READER;
    if (!url || !readerPath || !path.isAbsolute(readerPath))
      throw new Error("Missing test database URL or absolute bridge reader path");
    const { pathToFileURL } = await import("node:url");
    const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(readerPath).href);
    if (
      typeof loaded !== "object" ||
      loaded === null ||
      !("getItemAutomation" in loaded) ||
      typeof loaded.getItemAutomation !== "function"
    ) {
      throw new Error("Bridge reader export missing");
    }
    const name = `batch29_bridge_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
    const dir = await mkdtemp(path.join(tmpdir(), "semprec-bridge-migrations-"));
    const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
    const migration = "0138_item_automation_not_found_and_source.sql";
    let scratch: Pool | undefined;
    let created = false;
    let failure: { error: unknown } | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const scratchUrl = new URL(url);
      scratchUrl.pathname = `/${name}`;
      scratch = new Pool({
        connectionString: scratchUrl.toString(),
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
      });
      for (const file of (await readdir(migrations))
        .filter((entry) => entry.endsWith(".sql") && entry < migration)
        .sort()) {
        await copyFile(path.join(migrations, file), path.join(dir, file));
      }
      await runMigrations(scratch, dir);
      const tenants = await scratch.query<{ id: string }>("SELECT id FROM tenants");
      const tenantId = tenants.rows[0]?.id;
      if (!tenantId || tenants.rows.length !== 1) throw new Error("Expected tenant");
      const oldId = randomUUID();
      await scratch.query(
        "INSERT INTO item_automation (tenant_id, item_id, status, error_code) VALUES ($1, $2, 'error', 'unknown')",
        [tenantId, oldId],
      );
      const before = await scratch.query<{ row: unknown }>(
        "SELECT to_jsonb(a) AS row FROM item_automation a WHERE item_id = $1",
        [oldId],
      );
      await copyFile(path.join(migrations, migration), path.join(dir, migration));
      await runMigrations(scratch, dir);
      const after = await scratch.query<{ row: unknown }>(
        "SELECT to_jsonb(a) - 'source' AS row FROM item_automation a WHERE item_id = $1",
        [oldId],
      );
      expect(after.rows).toEqual(before.rows);
      const cases = [
        { status: "notFound", code: null },
        { status: "error", code: "sourceUnavailable" },
        { status: "error", code: "rateLimited" },
        { status: "error", code: "invalidResponse" },
      ] as const;
      const ids: string[] = [];
      for (const entry of cases) {
        const id = randomUUID();
        ids.push(id);
        const pool = scratch;
        await runInTenant(tenantId, () =>
          withTransaction(pool, async (client) => {
            await ensureItemAutomation(client, id);
            if (entry.status === "notFound") await markItemAutomationNotFound(client, id, "openLibrary");
            else
              await markItemAutomationError(
                client,
                id,
                "Library metadata processing failed",
                entry.code,
                "openLibrary",
              );
          }),
        );
      }
      const client = await scratch.connect();
      try {
        for (const [index, id] of [oldId, ...ids].entries()) {
          const value: unknown = await Reflect.apply(loaded.getItemAutomation, undefined, [client, id]);
          const expected =
            index === 0
              ? { status: "error", errorCode: "unknown" }
              : { status: cases[index - 1]?.status, errorCode: cases[index - 1]?.code };
          expect(value).toMatchObject({ itemId: id, ...expected });
        }
      } finally {
        client.release();
      }
    } catch (error) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => scratch?.end(),
      async () => {
        if (created) await dropClosedDatabase(admin, name);
      },
      async () => admin.end(),
      async () => rm(dir, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Bridge fixture cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  },
  120_000,
);

it("adds Semp error and accounting columns over populated synthetic legacy rows through the registered runner", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // CREATE and DROP interpolate only this fixed ASCII prefix and randomUUID hex identifier.
  const name = `batch31_semp_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch31-migrations-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const additions = ["0139_semp_messages_error_code.sql", "0140_ai_gateway_calls_semp_message_id.sql"];
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({
      connectionString: scratchUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < additions[0]!)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenants = await scratch.query<{ id: string }>("SELECT id FROM tenants");
    const tenant = tenants.rows[0]?.id;
    if (!tenant || tenants.rows.length !== 1) throw new Error("Expected one synthetic legacy tenant");
    const thread = await scratch.query<{ id: string }>(
      "INSERT INTO semp_threads (tenant_id, kind) VALUES ($1, 'chat') RETURNING id",
      [tenant],
    );
    const threadId = thread.rows[0]?.id;
    if (!threadId) throw new Error("Expected synthetic legacy thread");
    await scratch.query(
      "INSERT INTO semp_messages (tenant_id, thread_id, role, text) VALUES ($1, $2, 'user', 'legacy text')",
      [tenant, threadId],
    );
    await scratch.query(
      "INSERT INTO ai_gateway_calls (tenant_id, provider, model, cost_usd) VALUES ($1, 'legacy', 'legacy', 0)",
      [tenant],
    );
    const beforeMessages = (
      await scratch.query("SELECT to_jsonb(m) AS row, ctid::text AS tuple, xmin::text AS version FROM semp_messages m")
    ).rows;
    const beforeCalls = (
      await scratch.query(
        "SELECT to_jsonb(c) AS row, ctid::text AS tuple, xmin::text AS version FROM ai_gateway_calls c",
      )
    ).rows;
    for (const file of additions) await copyFile(path.join(migrations, file), path.join(dir, file));
    await runMigrations(scratch, dir);
    const afterMessages = (
      await scratch.query(
        "SELECT to_jsonb(m) - 'error_code' AS row, ctid::text AS tuple, xmin::text AS version FROM semp_messages m WHERE error_code IS NULL",
      )
    ).rows;
    const afterCalls = (
      await scratch.query(
        "SELECT to_jsonb(c) - 'semp_message_id' AS row, ctid::text AS tuple, xmin::text AS version FROM ai_gateway_calls c WHERE semp_message_id IS NULL",
      )
    ).rows;
    expect(afterMessages).toEqual(beforeMessages);
    expect(afterCalls).toEqual(beforeCalls);
    await scratch.query(
      "INSERT INTO semp_messages (tenant_id, thread_id, role, text) VALUES ($1, $2, 'user', 'legacy-shaped write')",
      [tenant, threadId],
    );
    await scratch.query(
      "INSERT INTO ai_gateway_calls (tenant_id, provider, model, cost_usd) VALUES ($1, 'legacy', 'legacy', 0)",
      [tenant],
    );
    await runMigrations(scratch, dir);
    expect(
      (await scratch.query("SELECT count(*)::int AS count FROM semp_messages WHERE error_code IS NULL")).rows,
    ).toEqual([{ count: 2 }]);
    expect(
      (await scratch.query("SELECT count(*)::int AS count FROM ai_gateway_calls WHERE semp_message_id IS NULL")).rows,
    ).toEqual([{ count: 2 }]);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (!created) return;
      await dropClosedDatabase(admin, name);
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount !== 0) throw new Error("Scratch database still exists after DROP");
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
      "Semp migration cleanup failed",
      { cause: failure?.error },
    );
  if (failure) throw failure.error;
}, 120_000);
