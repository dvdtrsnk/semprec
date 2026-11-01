import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createPool } from "../../db/pool.js";
import { runMigrations } from "../../db/migrate.js";

const migrations = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const expand = "0096_agent_runs_thread_id.sql";
const validate = "0097_validate_agent_runs_thread_fkey.sql";

it("upgrades populated tenant runs with the real migration runner", async () => {
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
    database = createPool(url.toString());
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql") && f < expand).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(database, dir);
    // The later multi-tenant cutover removes this guard; the fixture exercises two tenants before it.
    await database.query("DROP INDEX tenants_single_tenant_guard");
    const { rows: extra } = await database.query<{ id: string }>(
      "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
    );
    const { rows: zero } = await database.query<{ id: string }>("SELECT id FROM tenants WHERE id <> $1", [
      extra[0]!.id,
    ]);
    const tenantIds = [zero[0]!.id, extra[0]!.id];
    const runIds: string[] = [];
    for (const tenantId of tenantIds) {
      const { rows } = await database.query<{ id: string }>(
        "INSERT INTO agent_runs (tenant_id, triggered_by, task) VALUES ($1, 'user', 'existing') RETURNING id",
        [tenantId],
      );
      runIds.push(rows[0]!.id);
    }
    await copyFile(path.join(migrations, expand), path.join(dir, expand));
    await runMigrations(database, dir);
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
    const runs = await database.query<{ id: string; tenant_id: string; thread_id: string | null }>(
      "SELECT id, tenant_id, thread_id FROM agent_runs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [runIds],
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.map((row) => row.tenant_id).sort()).toEqual(tenantIds.sort());
    expect(runs.rows.every((row) => row.thread_id === null)).toBe(true);
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
}, 120_000);
