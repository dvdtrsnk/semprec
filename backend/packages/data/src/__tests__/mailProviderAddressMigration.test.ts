import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { runMigrations } from "../db/migrate.js";
import { createPool, withTransaction } from "../db/pool.js";

it("runs the provider address migration over historical rows and retains old-column writes", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The identifier contains only a fixed prefix and UUID hex digits.
  const name = `mail_address_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-mail-address-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const target = "0125_mail_provider_account_address.sql";
  const ids = {
    gmail: randomUUID(),
    duplicate: randomUUID(),
    otherTenant: randomUUID(),
    imap: randomUUID(),
    legacy: randomUUID(),
  };
  let scratch: Pool | undefined;
  let runtime: Pool | undefined;
  let created = false;
  const failures: unknown[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of (await readdir(migrations)).filter((entry) => entry.endsWith(".sql") && entry < target).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const { rows: tenants } = await scratch.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenants[0]?.id;
    if (!tenantId) throw new Error("Missing initial tenant");
    const database = scratch;
    const otherTenant = (
      await database.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id")
    ).rows[0]?.id;
    if (!otherTenant) throw new Error("Missing second tenant");
    // Current writers depend on later schema, so populate the actual pre-0125 columns directly.
    await runInTenant(tenantId, () =>
      withTransaction(database, async (client) => {
        await client.query(
          `INSERT INTO mail_account_sync_state (item_id, sync_mode, gmail_watch_email_address)
           VALUES ($1, 'gmail_api', 'Person@Example.COM'), ($2, 'imap', NULL), ($3, 'gmail_api', 'person@example.com')`,
          [ids.gmail, ids.imap, ids.duplicate],
        );
      }),
    );
    await runInTenant(otherTenant, () =>
      withTransaction(database, (client) =>
        client.query(
          "INSERT INTO mail_account_sync_state (item_id, sync_mode, gmail_watch_email_address) VALUES ($1, 'gmail_api', 'person@example.com')",
          [ids.otherTenant],
        ),
      ),
    );
    await copyFile(path.join(migrations, target), path.join(dir, target));
    await runMigrations(database, dir);
    runtime = createPool(scratchUrl.toString(), { role: "semprec_data" });
    const runtimePool = runtime;
    const role = await runtimePool.query<{ name: string; bypass: boolean; superuser: boolean }>(
      "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
    const rows = await runInTenant(tenantId, () =>
      withTransaction(runtimePool, (client) =>
        client.query<{
          item_id: string;
          provider_account_address: string | null;
          gmail_watch_email_address: string | null;
        }>(
          "SELECT item_id, provider_account_address, gmail_watch_email_address FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[])",
          [[ids.gmail, ids.duplicate, ids.imap]],
        ),
      ),
    );
    const ordered = [ids.gmail, ids.duplicate].sort();
    const byId = new Map(rows.rows.map((row) => [row.item_id, row]));
    expect(rows.rows).toHaveLength(3);
    expect(byId.get(ordered[0]!)?.provider_account_address).toBe("person@example.com");
    expect(byId.get(ordered[1]!)?.provider_account_address).toBeNull();
    expect(byId.get(ids.gmail)?.gmail_watch_email_address).toBe("Person@Example.COM");
    expect(byId.get(ids.duplicate)?.gmail_watch_email_address).toBe("person@example.com");
    expect(byId.get(ids.imap)?.provider_account_address).toBeNull();
    const foreign = await runInTenant(otherTenant, () =>
      withTransaction(runtimePool, (client) =>
        client.query<{ item_id: string; provider_account_address: string | null }>(
          "SELECT item_id, provider_account_address FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[])",
          [[ids.gmail, ids.duplicate, ids.otherTenant]],
        ),
      ),
    );
    expect(foreign.rows).toEqual([{ item_id: ids.otherTenant, provider_account_address: "person@example.com" }]);
    // This is an old-column SQL write, not execution of an earlier release binary.
    await runInTenant(tenantId, () =>
      withTransaction(runtimePool, (client) =>
        client.query("INSERT INTO mail_account_sync_state (item_id, sync_mode) VALUES ($1, 'imap')", [ids.legacy]),
      ),
    );
    const legacy = await runInTenant(tenantId, () =>
      withTransaction(runtimePool, (client) =>
        client.query<{ provider_account_address: string | null }>(
          "SELECT provider_account_address FROM mail_account_sync_state WHERE item_id = $1",
          [ids.legacy],
        ),
      ),
    );
    expect(legacy.rows).toEqual([{ provider_account_address: null }]);
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of [
    async () => runtime?.end(),
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
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Provider address migration test or cleanup failed");
}, 120_000);
