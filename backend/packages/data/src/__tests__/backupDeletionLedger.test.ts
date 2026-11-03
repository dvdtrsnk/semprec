import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { beginTenantDeletion } from "../tenancy/deleteAccount.js";
import { handleTenantPurgeTask } from "../tenancy/tenantPurgeJob.js";
import { validateRestoreLedger } from "../tenancy/validateRestoreLedger.js";
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
