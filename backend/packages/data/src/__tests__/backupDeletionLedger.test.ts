import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createPool, withTransaction } from "../db/pool.js";
import { beginTenantDeletion } from "../tenancy/deleteAccount.js";
import { handleTenantPurgeTask, replayTenantDeletions } from "../tenancy/tenantPurgeJob.js";
import { validateRestoreLedger } from "../tenancy/validateRestoreLedger.js";
import { parseRestoreReplayLedger } from "../tenancy/restoreReplayLedger.js";
import { createBackupRecoveryFixture } from "./fixtures/backupRecovery.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let directory: string;

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});
beforeEach(async () => {
  await resetDatabase(admin);
  directory = await mkdtemp(join(tmpdir(), "semprec-ledger-validator-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await runtime.end();
  await admin.end();
});

async function tenant(): Promise<string> {
  const id = await createTestTenant(admin);
  await createUser(admin, { tenantId: id, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  return id;
}

describe("restore ledger database validation", () => {
  it("requires each exact purged tombstone while allowing a later present tenant", async () => {
    const purged = await tenant();
    const later = await tenant();
    await runInTenant(purged, () => withTransaction(runtime, (client) => beginTenantDeletion(client, purged)));
    await handleTenantPurgeTask(runtime, { files: directory, mailAttachments: directory });
    await expect(validateRestoreLedger(runtime, [purged, later])).resolves.toBeUndefined();
    await expect(validateRestoreLedger(runtime, [purged])).resolves.toBeUndefined();
    await expect(validateRestoreLedger(runtime, [later])).rejects.toThrow("Restore ledger validation failed");
    await expect(validateRestoreLedger(runtime, [])).rejects.toThrow("Restore ledger validation failed");
  });

  it("rejects an impossible tenant and tombstone coexistence", async () => {
    const active = await tenant();
    // Corrupt snapshot fixture: real purge never retains the tenant alongside its tombstone.
    await admin.query("INSERT INTO tenant_deletions (tenant_id, requested_at) VALUES ($1, now())", [active]);
    await expect(validateRestoreLedger(runtime, [active])).rejects.toThrow("Restore ledger validation failed");
  });
});

describe("PostgreSQL 16 dump and later replay ledger", () => {
  it("retains a purge after the dump while requiring every earlier tombstone", async () => {
    const fixture = await createBackupRecoveryFixture();
    const source = new Pool({ connectionString: fixture.adminUrl });
    const sourceRuntime = createPool(fixture.adminUrl, { role: "semprec_data" });
    let restored: Pool | undefined;
    let restoredRuntime: Pool | undefined;
    let restoredCreated = false;
    let failure: { value: unknown } | undefined;
    const cleanup: unknown[] = [];
    try {
      const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      await promisify(execFile)(process.execPath, [join(backend, "packages/data/dist/db/runMigrationsCli.js")], {
        cwd: backend,
        env: { ...process.env, DATABASE_URL: fixture.adminUrl, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        maxBuffer: 2_000_000,
      });
      const first = await createTestTenant(source);
      const later = await createTestTenant(source);
      for (const tenantId of [first, later]) {
        await createUser(source, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      }
      const purge = async (tenantId: string): Promise<void> => {
        await runInTenant(tenantId, () =>
          withTransaction(sourceRuntime, (client) => beginTenantDeletion(client, tenantId)),
        );
        await handleTenantPurgeTask(sourceRuntime, { files: directory, mailAttachments: directory });
      };
      await purge(first);
      const main = await fixture.exec([
        "pg_dump",
        "--username=postgres",
        "--dbname=postgres",
        "--format=custom",
        "--exclude-table-data=public.tenant_keys",
      ]);
      await purge(later);
      const ledger = await source.query<{ tenant_id: string }>(
        "SELECT tenant_id::text FROM tenant_deletions ORDER BY completed_at, tenant_id",
      );
      const ids = parseRestoreReplayLedger(Buffer.from(ledger.rows.map((row) => row.tenant_id).join("\n") + "\n"));
      expect(ids).toEqual(expect.arrayContaining([first, later]));
      await source.query("CREATE DATABASE restored_ledger");
      restoredCreated = true;
      await fixture.exec(
        ["pg_restore", "--username=postgres", "--dbname=restored_ledger", "--exit-on-error", "--no-owner"],
        main,
      );
      const url = new URL(fixture.adminUrl);
      url.pathname = "/restored_ledger";
      restored = new Pool({ connectionString: url.toString() });
      restoredRuntime = createPool(url.toString(), { role: "semprec_data" });
      const before = await restored.query<{ tenant: boolean; tombstone: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM tenants WHERE id=$1) AS tenant, EXISTS(SELECT 1 FROM tenant_deletions WHERE tenant_id=$1) AS tombstone",
        [later],
      );
      expect(before.rows[0]).toEqual({ tenant: true, tombstone: false });
      await expect(validateRestoreLedger(restoredRuntime, ids)).resolves.toBeUndefined();
      await expect(validateRestoreLedger(restoredRuntime, [later])).rejects.toThrow("Restore ledger validation failed");
      const replay = await replayTenantDeletions(restoredRuntime, [later]);
      expect(replay.marked).toEqual([later]);
      const after = await restored.query<{ status: string }>("SELECT status FROM tenants WHERE id=$1", [later]);
      expect(after.rows[0]?.status).toBe("deleting");
    } catch (error) {
      failure = { value: error };
    }
    try {
      await restoredRuntime?.end();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await restored?.end();
    } catch (error) {
      cleanup.push(error);
    }
    if (restoredCreated) {
      try {
        await source.query("DROP DATABASE restored_ledger");
        const absence = await source.query<{ present: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'restored_ledger') AS present",
        );
        if (absence.rows[0]?.present !== false) throw new Error("Restored ledger database removal was not established");
        console.info("RECOVERY_LEDGER_DB absent=true");
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await sourceRuntime.end();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await source.end();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await fixture.close();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Ledger fixture cleanup failed");
    if (failure) throw failure.value;
  }, 240_000);
});
