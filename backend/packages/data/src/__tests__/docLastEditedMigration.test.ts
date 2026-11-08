import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";

it("upgrades populated documents through migration 0088 without a backfill and permits legacy writes", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // This identifier contains only a fixed prefix and UUID hex.
  const name = `doc_edit_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-doc-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0088_docs_last_edited.sql";
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
    const tenant = await scratch.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("The initial tenant is missing");
    const id = randomUUID();
    const item = randomUUID();
    // Historical fixture: a pre-0088 docs row cannot be written by the current store.
    await scratch.query("INSERT INTO docs (id, item_id, tenant_id, kind) VALUES ($1, $2, $3, 'page')", [
      id,
      item,
      tenantId,
    ]);
    const before = await scratch.query<{ id: string; item_id: string; created_at: Date }>(
      "SELECT id, item_id, created_at FROM docs WHERE id = $1",
      [id],
    );
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);
    const after = await scratch.query<{
      id: string;
      item_id: string;
      created_at: Date;
      last_edited_at: Date | null;
      last_edited_by: string | null;
    }>("SELECT id, item_id, created_at, last_edited_at, last_edited_by FROM docs WHERE id = $1", [id]);
    expect(after.rows).toEqual([{ ...before.rows[0], last_edited_at: null, last_edited_by: null }]);
    const legacyId = randomUUID();
    // Emulate the previous release's insert, which does not name the new columns.
    await scratch.query("INSERT INTO docs (id, item_id, tenant_id, kind) VALUES ($1, $2, $3, 'page')", [
      legacyId,
      randomUUID(),
      tenantId,
    ]);
    const legacy = await scratch.query<{ last_edited_at: Date | null; last_edited_by: string | null }>(
      "SELECT last_edited_at, last_edited_by FROM docs WHERE id = $1",
      [legacyId],
    );
    expect(legacy.rows).toEqual([{ last_edited_at: null, last_edited_by: null }]);
    await expect(scratch.query("UPDATE docs SET last_edited_by = 'invalid' WHERE id = $1", [id])).rejects.toMatchObject(
      { code: "23514" },
    );
    await runMigrations(scratch, dir);
    expect((await scratch.query<{ id: string }>("SELECT id FROM docs ORDER BY id")).rows).toHaveLength(2);
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
