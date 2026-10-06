import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, ensureQueueSchema, grantQueueSchemaPrivileges, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { withTransaction } from "../db/pool.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { handleMailAccountSyncSweepTask, handleMailSearchReindexSweepTask } from "../mail/mailSyncJob.js";
import { createCoreTaskList } from "../worker.js";
import { logger as tenancyLogger } from "../tenancy/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const MISSING_MODULES_MESSAGE =
  "Mail module databases are not seeded (missing: emails, files, folders, mailboxes) — run packages/data/dist/db/runSeedCli.js";

let adminPool: Pool;
let pool: Pool;
let tenantZero: string;
let tenantB: string;

/** Tenant B's minimal mail fixture: the four module databases, no `key` (global until #1001). */
async function createMailDatabasesInTenantB(): Promise<void> {
  await runInTenant(tenantB, () =>
    withTransaction(pool, async (client) => {
      for (const ownerModuleId of [EMAILS_MODULE_ID, FILES_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID]) {
        await createDatabase(client, { name: ownerModuleId, system: true, ownerModuleId });
      }
    }),
  );
}

async function moduleDatabaseId(tenantId: string, moduleId: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, moduleId);
      if (!database) throw new Error(`fixture: no ${moduleId} database in tenant ${tenantId}`);
      return database.id;
    }),
  );
}

/** A mailbox item plus a due sync-state row (and a stored credential), created inside `tenantId`. */
async function createDueMailbox(tenantId: string): Promise<string> {
  const mailboxesId = await moduleDatabaseId(tenantId, MAILBOXES_MODULE_ID);
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const item = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: tenantId === tenantZero ? { name: "Sweep", provider: "generic" } : {},
      });
      await storeCredential(client, { itemId: item.id, credentialType: "app_password", plaintext: "s3cr3t" });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
      return item.id;
    }),
  );
}

/** An Emails item that never got an `item_search_index` row. */
async function createUnindexedEmail(tenantId: string): Promise<{ itemId: string; emailsId: string }> {
  const emailsId = await moduleDatabaseId(tenantId, EMAILS_MODULE_ID);
  const itemId = await runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const item = await createItemWithClient(
        client,
        { databaseId: emailsId, properties: tenantId === tenantZero ? { name: "Subject", body: "Body" } : {} },
        { allowedSystemKeys: ["name", "body"] },
      );
      return item.id;
    }),
  );
  return { itemId, emailsId };
}

async function indexRows(itemId: string): Promise<Array<{ tenant_id: string; database_id: string }>> {
  const { rows } = await adminPool.query<{ tenant_id: string; database_id: string }>(
    "SELECT tenant_id, database_id FROM item_search_index WHERE item_id = $1",
    [itemId],
  );
  return rows;
}

describe("mail sweeps run per tenant (issue #989)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    // Seeded while tenant zero is the only tenant, then tenant B joins without mail databases.
    await seedSystem(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    await ensureQueueSchema(adminPool);
    await grantQueueSchemaPrivileges(adminPool);
    vi.spyOn(tenancyLogger, "error").mockImplementation(() => {});
  });

  it("enqueues one mailAccountSync job per due mailbox, stamped with the mailbox's tenant", async () => {
    await createMailDatabasesInTenantB();
    const mailboxZero = await createDueMailbox(tenantZero);
    const mailboxB = await createDueMailbox(tenantB);

    await runAsSystem("test", () => handleMailAccountSyncSweepTask(pool));

    const envelopes = (await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)) as Array<{
      tenantId: string;
      payload: { mailboxItemId: string };
    }>;
    expect(envelopes).toHaveLength(2);
    expect(
      envelopes
        .map((e) => ({ tenantId: e.tenantId, mailboxItemId: e.payload.mailboxItemId }))
        .sort((a, b) => a.mailboxItemId.localeCompare(b.mailboxItemId)),
    ).toEqual(
      [
        { tenantId: tenantZero, mailboxItemId: mailboxZero },
        { tenantId: tenantB, mailboxItemId: mailboxB },
      ].sort((a, b) => a.mailboxItemId.localeCompare(b.mailboxItemId)),
    );
  });

  it("reindexes each tenant's unindexed email with its own tenant and Emails database", async () => {
    await createMailDatabasesInTenantB();
    const zero = await createUnindexedEmail(tenantZero);
    const b = await createUnindexedEmail(tenantB);
    expect(zero.emailsId).not.toBe(b.emailsId);

    await runAsSystem("test", () => handleMailSearchReindexSweepTask(pool));

    expect(await indexRows(zero.itemId)).toEqual([{ tenant_id: tenantZero, database_id: zero.emailsId }]);
    expect(await indexRows(b.itemId)).toEqual([{ tenant_id: tenantB, database_id: b.emailsId }]);
  });

  it("indexes tenant zero and rejects naming the missing module ids when tenant B has no mail databases", async () => {
    const zero = await createUnindexedEmail(tenantZero);

    const err: unknown = await runAsSystem("test", () => handleMailSearchReindexSweepTask(pool)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AggregateError);
    const errors = (err as AggregateError).errors as Error[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(MISSING_MODULES_MESSAGE);
    expect(await indexRows(zero.itemId)).toEqual([{ tenant_id: tenantZero, database_id: zero.emailsId }]);
  });

  it("resolves mail module ids per job: tenant B fails on the missing modules, tenant zero reaches the adapter", async () => {
    const mailboxZero = await createDueMailbox(tenantZero);
    await runInTenant(tenantZero, () =>
      enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, { mailboxItemId: mailboxZero }),
    );
    await runInTenant(tenantB, () =>
      enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, { mailboxItemId: "00000000-0000-4000-8000-000000000000" }),
    );

    await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, new Map()) });

    const { rows } = await adminPool.query<{ tenant_id: string; last_error: string | null }>(
      `SELECT jobs.payload->>'tenantId' AS tenant_id, jobs.last_error FROM graphile_worker._private_jobs jobs
       JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
       WHERE tasks.identifier = $1`,
      [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC],
    );
    const errorOf = (tenantId: string) => rows.find((r) => r.tenant_id === tenantId)?.last_error;
    expect(errorOf(tenantB)).toContain(MISSING_MODULES_MESSAGE);
    expect(errorOf(tenantZero)).toContain("No IMAP adapter configured for this composition root");
  });
});
