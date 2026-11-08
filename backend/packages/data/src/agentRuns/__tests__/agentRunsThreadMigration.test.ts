import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createPool } from "../../db/pool.js";
import { runMigrations } from "../../db/migrate.js";

const migrations = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const expand = "0096_agent_runs_thread_id.sql";
const validate = "0097_validate_agent_runs_thread_fkey.sql";

it.each([
  ["historical single-tenant schema", false],
  ["test-modified two-tenant schema", true],
])(
  "upgrades populated runs on the %s with the real migration runner",
  async (_name, multipleTenants) => {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");
    const admin = createPool(connectionString);
    const name = `thread_migration_${randomUUID().replaceAll("-", "")}`;
    const dir = await mkdtemp(path.join(tmpdir(), "semprec-thread-migration-"));
    let created = false;
    let database: ReturnType<typeof createPool> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
      created = true;
      const url = new URL(connectionString);
      url.pathname = `/${name}`;
      database = createPool(url.toString(), { statementTimeoutMs: 15_000 });
      for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql") && f < expand).sort()) {
        await copyFile(path.join(migrations, file), path.join(dir, file));
      }
      await runMigrations(database, dir);
      const { rows: zero } = await database.query<{ id: string }>("SELECT id FROM tenants");
      const tenantIds = [zero[0]!.id];
      if (multipleTenants) {
        // This fixture models the later multi-tenant cutover, not the historical pre-0096 schema.
        await database.query("DROP INDEX tenants_single_tenant_guard");
        const { rows: extra } = await database.query<{ id: string }>(
          "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
        );
        tenantIds.push(extra[0]!.id);
      }
      const runIds: string[] = [];
      for (const tenantId of tenantIds) {
        const { rows } = await database.query<{ id: string }>(
          "INSERT INTO agent_runs (tenant_id, triggered_by, task) VALUES ($1, 'user', 'existing') RETURNING id",
          [tenantId],
        );
        runIds.push(rows[0]!.id);
      }
      await copyFile(path.join(migrations, expand), path.join(dir, expand));
      if (multipleTenants) {
        await runMigrations(database, dir);
      } else {
        const gate = await database.connect();
        const reader = await database.connect();
        const writer = await database.connect();
        let migration: Promise<void> | undefined;
        let read: Promise<unknown> | undefined;
        let write: Promise<unknown> | undefined;
        let gateOpen = false;
        try {
          await gate.query("BEGIN");
          gateOpen = true;
          await gate.query("LOCK TABLE schema_migrations IN SHARE MODE");
          await reader.query("SET statement_timeout = '10s'");
          await writer.query("SET statement_timeout = '10s'");
          const readerPid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          migration = runMigrations(database, dir);
          void migration.catch(() => {});
          let migrationPid = 0;
          await vi.waitFor(
            async () => {
              const { rows } = await database!.query<{ pid: number }>(
                `SELECT a.pid FROM pg_stat_activity a
               JOIN pg_locks l ON l.pid = a.pid
               WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
                 AND a.query LIKE 'INSERT INTO schema_migrations%'
                 AND l.relation = 'agent_runs'::regclass AND l.mode = 'AccessExclusiveLock' AND l.granted`,
              );
              expect(rows).toHaveLength(1);
              migrationPid = rows[0]!.pid;
            },
            { timeout: 5000, interval: 20 },
          );
          read = reader.query("SELECT id FROM agent_runs WHERE id = $1", [runIds[0]]);
          write = writer.query("UPDATE agent_runs SET task = task WHERE id = $1", [runIds[0]]);
          void read.catch(() => {});
          void write.catch(() => {});
          await vi.waitFor(
            async () => {
              const { rows } = await database!.query<{ pid: number; blockers: number[] }>(
                "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ANY($1::int[])",
                [[readerPid, writerPid]],
              );
              expect(rows).toHaveLength(2);
              expect(rows.every((row) => row.blockers.includes(migrationPid))).toBe(true);
            },
            { timeout: 5000, interval: 20 },
          );
          await gate.query("COMMIT");
          gateOpen = false;
          const outcomes = await Promise.allSettled([migration, read, write]);
          expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
        } finally {
          if (gateOpen) await gate.query("ROLLBACK");
          await Promise.allSettled([migration, read, write].filter((operation) => operation !== undefined));
          gate.release();
          reader.release();
          writer.release();
        }
      }
      const before = await database.query<{ convalidated: boolean }>(
        "SELECT convalidated FROM pg_constraint WHERE conname = 'agent_runs_thread_id_fkey'",
      );
      expect(before.rows).toEqual([{ convalidated: false }]);
      await copyFile(path.join(migrations, validate), path.join(dir, validate));
      await runMigrations(database, dir);
      const after = await database.query<{ convalidated: boolean }>(
        "SELECT convalidated FROM pg_constraint WHERE conname = 'agent_runs_thread_id_fkey'",
      );
      expect(after.rows).toEqual([{ convalidated: true }]);
      const runs = await database.query<{
        id: string;
        tenant_id: string;
        thread_id: string | null;
        task: string;
        triggered_by: string;
      }>("SELECT id, tenant_id, thread_id, task, triggered_by FROM agent_runs WHERE id = ANY($1::uuid[]) ORDER BY id", [
        runIds,
      ]);
      expect(runs.rows).toHaveLength(tenantIds.length);
      expect(runs.rows.map((row) => `${row.id}:${row.tenant_id}`).sort()).toEqual(
        runIds.map((id, index) => `${id}:${tenantIds[index]}`).sort(),
      );
      expect(runs.rows.map((row) => row.tenant_id).sort()).toEqual(tenantIds.sort());
      expect(runs.rows.map((row) => row.id).sort()).toEqual([...runIds].sort());
      expect(runs.rows.every((row) => row.thread_id === null)).toBe(true);
      expect(runs.rows.every((row) => row.task === "existing" && row.triggered_by === "user")).toBe(true);
      const errorCodeMigration = "0104_agent_run_error_code.sql";
      for (const file of (await readdir(migrations))
        .filter((f) => f.endsWith(".sql") && f > validate && f < errorCodeMigration)
        .sort()) {
        await copyFile(path.join(migrations, file), path.join(dir, file));
      }
      await runMigrations(database, dir);
      await copyFile(path.join(migrations, errorCodeMigration), path.join(dir, errorCodeMigration));
      await runMigrations(database, dir);
      await database.query(
        "UPDATE agent_runs SET status = 'error', result = 'legacy', finished_at = now() WHERE id = $1",
        [runIds[0]],
      );
      const legacy = await database.query<{ status: string; result: string; error_code: string | null }>(
        "SELECT status, result, error_code FROM agent_runs WHERE id = $1",
        [runIds[0]],
      );
      expect(legacy.rows).toEqual([{ status: "error", result: "legacy", error_code: null }]);
    } catch (error) {
      failure = { error };
    }
    for (const cleanup of [
      () => database?.end(),
      () => (created ? admin.query(`DROP DATABASE "${name}" WITH (FORCE)`) : undefined),
      () => admin.end(),
      () => rm(dir, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  },
  120_000,
);
