import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runMigrations } from "../../db/migrate.js";

it("adds mcp_client_name to a database with existing runs, leaving it NULL for them", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The identifier is a fixed prefix followed only by UUID hex digits.
  const name = `mcp_client_name_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-mcp-client-name-upgrade-"));
  const migrations = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    const files = (await readdir(migrations)).filter((entry) => entry.endsWith(".sql")).sort();
    // Found by its name, so the test follows the file when its ordinal changes.
    const migration = files.find((entry) => entry.endsWith("_agent_runs_mcp_client_name.sql"));
    if (!migration) throw new Error("The mcp_client_name migration is missing");
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of files.filter((entry) => entry < migration)) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenant = await scratch.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("The initial tenant is missing");
    // Historical fixture: the current store names the new column, so it cannot write a run before the migration.
    const existing = await scratch.query<{ id: string }>(
      "INSERT INTO agent_runs (tenant_id, triggered_by, task) VALUES ($1, 'mcp', 'existing'), ($1, 'user', 'existing') RETURNING id",
      [tenantId],
    );
    const existingIds = existing.rows.map((row) => row.id);
    expect(existingIds).toHaveLength(2);

    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);

    const after = await scratch.query<{ id: string; task: string; mcp_client_name: string | null }>(
      "SELECT id, task, mcp_client_name FROM agent_runs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [existingIds],
    );
    expect(after.rows).toEqual([...existingIds].sort().map((id) => ({ id, task: "existing", mcp_client_name: null })));
    // Emulates the previous release's insert, which does not name the new column.
    const legacy = await scratch.query<{ mcp_client_name: string | null }>(
      "INSERT INTO agent_runs (tenant_id, triggered_by, task) VALUES ($1, 'mcp', 'legacy') RETURNING mcp_client_name",
      [tenantId],
    );
    expect(legacy.rows).toEqual([{ mcp_client_name: null }]);
    // The store never writes a longer name, so only a direct statement reaches the check.
    await expect(
      scratch.query("UPDATE agent_runs SET mcp_client_name = repeat('x', 65) WHERE id = $1", [existingIds[0]]),
    ).rejects.toMatchObject({ code: "23514" });
    await scratch.query("UPDATE agent_runs SET mcp_client_name = repeat('x', 64) WHERE id = $1", [existingIds[0]]);
    const bounded = await scratch.query<{ length: number }>(
      "SELECT char_length(mcp_client_name) AS length FROM agent_runs WHERE id = $1",
      [existingIds[0]],
    );
    expect(bounded.rows).toEqual([{ length: 64 }]);
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
