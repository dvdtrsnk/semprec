import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { withTransaction } from "../db/pool.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { mailSyncProcessName, upsertProcessHeartbeat } from "../health/processHeartbeats.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { handleObservabilityCheckSystemTask } from "../observability/observabilityCheckSystem.js";

let pool: Pool;
let dataPool: Pool | undefined;
let tenantZero: string;

async function markAllProcessesFresh(): Promise<void> {
  for (const process of ["api", "agents", "transcribe", "ai-gateway"]) {
    await upsertProcessHeartbeat(pool, { process, pid: 1, version: "1.0.0" }, new Date());
  }
}

/** A tenant with its own Mailboxes database (tenant zero's is seeded). */
async function createTenantWithMailboxes(status?: "suspended"): Promise<string> {
  const tenantId = await createTestTenant(pool, status ? { status } : {});
  await runInTenant(tenantId, () =>
    withTransaction(dataPool!, async (client) => {
      await createDatabase(client, { name: MAILBOXES_MODULE_ID, system: true, ownerModuleId: MAILBOXES_MODULE_ID });
    }),
  );
  return tenantId;
}

/** An active mailbox with a sync-state row and a heartbeat five minutes old, created inside `tenantId`. */
async function createStaleMailbox(tenantId: string): Promise<string> {
  const mailboxId = await runInTenant(tenantId, () =>
    withTransaction(dataPool!, async (client) => {
      const database = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
      if (!database) throw new Error(`fixture: no mailboxes database in tenant ${tenantId}`);
      const item = await createItemWithClient(client, {
        databaseId: database.id,
        properties: tenantId === tenantZero ? { name: "Liveness", provider: "generic" } : {},
      });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
      return item.id;
    }),
  );
  await upsertProcessHeartbeat(pool, { process: mailSyncProcessName(mailboxId), pid: 1, version: "1.0.0" }, new Date());
  await pool.query("UPDATE process_heartbeats SET beat_at = now() - interval '5 minutes' WHERE process = $1", [
    mailSyncProcessName(mailboxId),
  ]);
  return mailboxId;
}

function runCheck(): Promise<void> {
  return runAsSystem("test", () => handleObservabilityCheckSystemTask(dataPool!, { job: { id: randomUUID() } }));
}

async function livenessRows(): Promise<Array<{ check_key: string; tenant_id: string; status: string }>> {
  const { rows } = await pool.query<{ check_key: string; tenant_id: string; status: string }>(
    `SELECT check_key, tenant_id, status FROM tenant_observability_checks
     WHERE check_key LIKE 'process:mailsync:%' ORDER BY check_key`,
  );
  return rows;
}

async function mailboxNotifications(): Promise<Array<{ user_id: string; payload: { mailboxItemId: string } }>> {
  const { rows } = await pool.query<{ user_id: string; payload: { mailboxItemId: string } }>(
    `SELECT user_id, payload FROM notifications WHERE kind = 'mail_sync_stalled'`,
  );
  return rows;
}

describe("per-tenant mailbox liveness (issue #1000)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await pool.query("DELETE FROM tenant_observability_checks");
    await seedSystem(pool);
    tenantZero = getTenantZeroId();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    await markAllProcessesFresh();
    await createUser(pool, {
      email: `${randomUUID()}@example.test`,
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await dataPool?.end();
    dataPool = undefined;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("writes one alerting row per tenant under its own tenant_id", async () => {
    const tenantB = await createTenantWithMailboxes();
    const mailboxZero = await createStaleMailbox(tenantZero);
    const mailboxB = await createStaleMailbox(tenantB);

    await runCheck();

    expect(await livenessRows()).toEqual(
      [
        { check_key: `process:mailsync:${mailboxZero}`, tenant_id: tenantZero, status: "alerting" },
        { check_key: `process:mailsync:${mailboxB}`, tenant_id: tenantB, status: "alerting" },
      ].sort((a, b) => a.check_key.localeCompare(b.check_key)),
    );
    const notified = (await mailboxNotifications()).map((row) => row.payload.mailboxItemId).sort();
    expect(notified).toEqual([mailboxZero, mailboxB].sort());
  });

  it("does not evaluate the mailbox of a suspended tenant", async () => {
    const suspended = await createTenantWithMailboxes("suspended");
    await createStaleMailbox(suspended);

    await runCheck();

    expect(await livenessRows()).toEqual([]);
  });

  it("evaluates both tenants' mailboxes in strict mode with no TenantScopeMissingError", async () => {
    const tenantB = await createTenantWithMailboxes();
    const mailboxZero = await createStaleMailbox(tenantZero);
    const mailboxB = await createStaleMailbox(tenantB);
    vi.stubEnv("SEMPREC_TENANT_SCOPE", "strict");

    await expect(runCheck()).resolves.toBeUndefined();

    expect((await livenessRows()).map((row) => row.check_key).sort()).toEqual(
      [`process:mailsync:${mailboxZero}`, `process:mailsync:${mailboxB}`].sort(),
    );
  });
});
