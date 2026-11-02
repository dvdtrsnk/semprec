import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInTenant } from "@semprec/shared";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runMigrations } from "../../db/migrate.js";
import { withTransaction } from "../../db/pool.js";

it("upgrades persisted mail metadata and retains the legacy insert default", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  const name = `mail_bulk_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-mail-bulk-upgrade-"));
  const migrations = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  const target = "0103_mail_message_meta_is_bulk.sql";
  let scratch: Pool | undefined;
  let created = false;
  const failures: unknown[] = [];
  try {
    // name is a fixed prefix followed only by hexadecimal UUID digits.
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of (await readdir(migrations)).filter((entry) => entry.endsWith(".sql") && entry < target).sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenant = await scratch.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 1");
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error("Missing initial tenant");
    const database = scratch;
    const oldId = randomUUID();
    const laterId = randomUUID();
    await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query("INSERT INTO mail_message_meta (item_id, message_id) VALUES ($1, $2)", [
          oldId,
          "<old@example.test>",
        ]),
      ),
    );
    await copyFile(path.join(migrations, target), path.join(dir, target));
    await runMigrations(database, dir);
    await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query("INSERT INTO mail_message_meta (item_id, message_id) VALUES ($1, $2)", [
          laterId,
          "<later@example.test>",
        ]),
      ),
    );
    const rows = await runInTenant(tenantId, () =>
      withTransaction(database, (client) =>
        client.query<{ item_id: string; is_bulk: boolean }>(
          "SELECT item_id, is_bulk FROM mail_message_meta ORDER BY message_id",
        ),
      ),
    );
    expect(rows.rows).toEqual([
      { item_id: laterId, is_bulk: false },
      { item_id: oldId, is_bulk: false },
    ]);
    await expect(
      runInTenant(tenantId, () =>
        withTransaction(database, (client) =>
          client.query("UPDATE mail_message_meta SET is_bulk = NULL WHERE item_id = $1", [oldId]),
        ),
      ),
    ).rejects.toMatchObject({ code: "23502" });
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      // The same fixed-prefix, hexadecimal UUID identifier was created above.
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
  if (failures.length > 1)
    throw new AggregateError(failures, "Mail bulk migration test failed and cleanup also failed");
}, 120_000);
