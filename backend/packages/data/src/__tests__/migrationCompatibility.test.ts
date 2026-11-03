import { mkdtemp, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { runMigrations } from "../db/migrate.js";
import { withTransaction } from "../db/pool.js";
import { runApprovalRequestExecutionStatusCutoverMigration } from "../mcp/approvalRequestExecutionStatusCutoverMigration.js";
import { getApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";

/**
 * Compatibility fixture for issue #191: applies each migration example on top of the previous
 * release's schema with the real migration runner, then runs the previous release's code against
 * the result — exactly what happens while a deploy migrates and after `deploy.sh --rollback`.
 */

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrationExamples");
const LONG_TITLE = "a title longer than ten characters";

it("upgrades populated approvals and notifications through the batch 15 additive migrations", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The generated database identifier contains only a fixed prefix and UUID hex.
  const name = `batch15_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-batch15-upgrade-"));
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
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
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
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
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
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
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
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
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
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
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
