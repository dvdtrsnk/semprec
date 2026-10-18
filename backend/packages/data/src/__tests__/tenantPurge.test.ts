import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { enqueueJob } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { recordLoginAttempt } from "../auth/loginAttemptsStore.js";
import { createPasswordResetToken } from "../auth/passwordResetStore.js";
import { createSession } from "../auth/sessionsStore.js";
import { createUser } from "../auth/usersStore.js";
import { ingestUploadedFile } from "../blobs/fileUploadStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { getOrCreateTenantDataKey } from "../credentials/tenantKeysStore.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { mintMcpRunCredential } from "../mcp/mcpRunCredentialAction.js";
import { NOTIFICATION_KINDS } from "../notifications/notificationKinds.js";
import { writeNotification } from "../notifications/notify.js";
import { claimPushDeliveryTargets } from "../push/pushDeliveriesStore.js";
import { registerPushSubscription } from "../push/pushSubscriptionActions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { beginTenantDeletion } from "../tenancy/deleteAccount.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { handleTenantExportTask } from "../tenancy/tenantExportJob.js";
import { requestTenantExport } from "../tenancy/tenantExportsStore.js";
import { handleTenantPurgeTask, type TenantPurgeDirs } from "../tenancy/tenantPurgeJob.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let dirs: TenantPurgeDirs;
let filesStorage: LocalFsBlobStorageWriter;
let mailStorage: LocalFsBlobStorageWriter;

const countSchema = z.object({ n: z.coerce.number() });

/** What one tenant's seeded data left behind, for the erasure assertions. */
interface SeededTenant {
  tenantId: string;
  userId: string;
  email: string;
  databaseIds: string[];
  /** Absolute paths of every blob and export file written for the tenant. */
  filePaths: string[];
  /** The files-root path of the tenant's uploaded blob. */
  uploadPath: string;
}

async function databaseIdIn(tenantId: string, moduleId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    if (!rows[0]) throw new Error(`no '${moduleId}' database in tenant ${tenantId}`);
    return rows[0].id;
  });
}

async function provisionedTenant(): Promise<string> {
  const tenantId = await createTestTenant(adminPool, { status: "provisioning" });
  await provisionTenant(pool, tenantId);
  return tenantId;
}

/**
 * Writes items, a doc, a mail message with an attachment, an upload, an export, an agent run with an
 * MCP credential and an event, a notification with a push delivery, a credential and a tenant key,
 * plus the tenant's user with a session, a push registration, a reset token, login attempts and
 * an invite, into `tenantId`.
 */
async function seedTenant(tenantId: string): Promise<SeededTenant> {
  const email = `${randomUUID()}@example.com`;
  // The invite is addressed to the account's email; the API cannot create it once the account exists.
  const placeholder = await createUser(adminPool, { email: `${randomUUID()}@example.com`, passwordHash: "unused" });
  await adminPool.query("INSERT INTO invites (email, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4)", [
    email,
    `hash-${randomUUID()}`,
    placeholder.id,
    new Date(Date.now() + 86_400_000),
  ]);
  const user = await createUser(adminPool, { email, passwordHash: `hash-${randomUUID()}`, tenantId });
  const session = await createSession(adminPool, {
    userId: user.id,
    tokenHash: `hash-${randomUUID()}`,
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const subscription = await registerPushSubscription(adminPool, {
    userId: user.id,
    sessionId: session.id,
    channel: "web_push",
    platform: "web",
    endpoint: `https://push.example/${randomUUID()}`,
    p256dh: "key",
    authSecret: "secret",
  });
  await createPasswordResetToken(adminPool, {
    userId: user.id,
    tokenHash: `hash-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await recordLoginAttempt(adminPool, { email, ip: "10.1.2.3", succeeded: true });
  await recordLoginAttempt(adminPool, { email, ip: "10.1.2.4", succeeded: false });
  await adminPool.query(
    "INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd, monthly_cap_usd, updated_by) VALUES ($1, 5, 50, $2)",
    [tenantId, user.id],
  );
  await adminPool.query(
    "INSERT INTO admin_audit_log (actor_user_id, action, target_tenant_id) VALUES ($1, 'test.audit', $2)",
    [placeholder.id, tenantId],
  );

  const filesDatabaseId = await databaseIdIn(tenantId, "files");
  const emailsDatabaseId = await databaseIdIn(tenantId, "emails");
  const foldersDatabaseId = await databaseIdIn(tenantId, "folders");
  const databaseIds = await runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases ORDER BY id");
    return rows.map((row) => row.id);
  });

  const { fileKey, mailKey } = await runInTenant(tenantId, async () => {
    const { blob: fileBlob } = await ingestUploadedFile(pool, {
      filesDatabaseId,
      filename: "note.txt",
      contentType: "text/plain",
      source: Readable.from([`files-root-bytes-${randomUUID()}`]),
      storageKeyPrefix: "files",
      maxBytes: 1024,
      storage: filesStorage,
    });
    const properties = await createChokePoint(pool).listProperties(emailsDatabaseId);
    const relationId = (key: string): string => {
      const property = properties.find((p) => p.key === key);
      if (!property) throw new Error(`no '${key}' property on Emails`);
      return property.id;
    };
    const mailItemId = await withTransaction(pool, async (client) => {
      const folder = await createItemWithClient(
        client,
        { databaseId: foldersDatabaseId, properties: { name: "INBOX" } },
        { allowedSystemKeys: ["name"] },
      );
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId,
        filesDatabaseId,
        folderRelationPropertyId: relationId("folder"),
        attachmentsRelationPropertyId: relationId("attachments"),
        folderItemId: folder.id,
        mailboxItemId: randomUUID(),
        messageId: `<${randomUUID()}@example.com>`,
        subject: "Purge me",
        envelope: {},
        attachments: [
          {
            filename: "attached.bin",
            contentType: "application/octet-stream",
            contentId: null,
            disposition: "attachment",
            openStream: () => Readable.from([`mail-root-bytes-${randomUUID()}`]),
          },
        ],
        storage: mailStorage,
        storageKeyPrefix: "mail",
      });
      return ingested.itemId;
    });
    const { rows: mailBlobs } = await pool.query<{ storage_key: string }>(
      "SELECT b.storage_key FROM blobs b JOIN mail_attachments m ON m.blob_id = b.id",
    );
    const mailBlob = mailBlobs[0];
    if (!mailBlob) throw new Error("the mail ingest stored no attachment");

    // No production writer creates a doc without the realtime server; the doc sweeps' tests seed docs the same way.
    await pool.query("INSERT INTO docs (item_id) VALUES ($1)", [mailItemId]);
    await withTransaction(pool, async (client) => {
      await storeCredential(client, { itemId: mailItemId, credentialType: "api_key", plaintext: "secret" });
      await getOrCreateTenantDataKey(client);
    });

    const projectItemId = await createTestProjectItem(pool);
    const minted = await withTransaction(pool, (client) =>
      mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId: user.id }),
    );
    await insertAgentRunEvent(pool, minted.run.id, "run_status", { status: "running" });
    const childRun = await createAgentRun(pool, {
      projectItemId,
      parentRunId: minted.run.id,
      triggeredBy: "mcp",
      task: "child",
    });
    expect(childRun.parentRunId).toBe(minted.run.id);

    await withTransaction(pool, async (client) => {
      const notificationId = await writeNotification(client, {
        userId: user.id,
        kind: NOTIFICATION_KINDS[0],
        linkHref: null,
        sourceTable: "agent_runs",
        sourceId: minted.run.id,
        transitionInstance: randomUUID(),
      });
      await claimPushDeliveryTargets(client, notificationId, [subscription.id]);
    });

    const { requested } = await withTransaction(pool, async (client) => ({
      requested: await requestTenantExport(client, user.id),
    }));
    await handleTenantExportTask(
      pool,
      { files: filesStorage, mailAttachments: mailStorage },
      { exportId: requested.export.id },
      {},
    );
    return { fileKey: fileBlob.storageKey, mailKey: mailBlob.storage_key };
  });

  const exportKeys = await runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ storage_key: string }>("SELECT storage_key FROM tenant_exports");
    return rows.map((row) => row.storage_key);
  });
  const filePaths = [
    join(dirs.files, fileKey),
    join(dirs.mailAttachments, mailKey),
    ...exportKeys.map((key) => join(dirs.files, key)),
  ];
  return {
    tenantId,
    userId: user.id,
    email,
    databaseIds,
    filePaths,
    uploadPath: join(dirs.files, fileKey),
  };
}

async function beginDeletion(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => withTransaction(pool, (client) => beginTenantDeletion(client, tenantId)));
}

function purge(helpers: { abortSignal?: AbortSignal } = {}, using: Pool = pool): Promise<void> {
  return handleTenantPurgeTask(using, dirs, helpers);
}

async function tenantTables(): Promise<string[]> {
  const { rows } = await adminPool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY 1`,
  );
  return rows.map((row) => row.relname);
}

/** Row counts per table for rows whose `tenant_id` is `tenantId`, read as the table owner. */
async function rowCounts(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [...(await tenantTables()), "agent_run_mcp_credentials"]) {
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT count(*) AS n FROM "${table}" WHERE tenant_id = $1`,
      [tenantId],
    );
    counts[table] = countSchema.parse(rows[0]).n;
  }
  return counts;
}

async function nonEmptyTables(tenantId: string): Promise<string[]> {
  return Object.entries(await rowCounts(tenantId))
    .filter(([, n]) => n > 0)
    .map(([table]) => table);
}

async function tenantStatus(tenantId: string): Promise<string | undefined> {
  const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
  return rows[0]?.status;
}

async function tombstones(tenantId: string): Promise<{ requested_at: Date }[]> {
  const { rows } = await adminPool.query<{ requested_at: Date }>(
    "SELECT requested_at FROM tenant_deletions WHERE tenant_id = $1",
    [tenantId],
  );
  return rows;
}

async function partitionExists(databaseId: string): Promise<boolean> {
  const { rows } = await adminPool.query("SELECT 1 FROM pg_class WHERE relname = $1", [
    `items_p_${databaseId.replaceAll("-", "")}`,
  ]);
  return rows.length > 0;
}

/** Replaces a file with a non-empty directory, which `rm` without `recursive` refuses to delete. */
async function blockDeletion(path: string): Promise<void> {
  await rm(path, { force: true });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "keep"), "x");
}

async function unblockDeletion(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe("tenant purge (issue #1055)", () => {
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
    tenantA = getTenantZeroId();
    await runInTenant(tenantA, () => seedSystem(adminPool));
    const root = join(tmpdir(), `semprec-test-purge-${randomUUID()}`);
    dirs = { files: join(root, "files"), mailAttachments: join(root, "mail") };
    filesStorage = new LocalFsBlobStorageWriter(dirs.files);
    mailStorage = new LocalFsBlobStorageWriter(dirs.mailAttachments);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("erases a deleting tenant completely, leaves a tombstone and leaves another tenant untouched", async () => {
    const tenantB = await provisionedTenant();
    const a = await seedTenant(tenantA);
    const b = await seedTenant(tenantB);
    await runInTenant(tenantB, () => enqueueJob(pool, "purgeTestJob", { which: "b" }));
    await beginDeletion(tenantB);
    const { rows: before } = await adminPool.query<{ status_changed_at: Date }>(
      "SELECT status_changed_at FROM tenants WHERE id = $1",
      [tenantB],
    );
    const requestedAt = before[0]?.status_changed_at;
    const countsA = await rowCounts(tenantA);
    expect((await nonEmptyTables(tenantB)).length).toBeGreaterThan(10);
    expect(b.databaseIds.length).toBeGreaterThan(0);
    for (const path of b.filePaths) expect(existsSync(path)).toBe(true);
    expect(b.filePaths).toHaveLength(3);

    await purge();

    expect(await nonEmptyTables(tenantB)).toEqual([]);
    for (const databaseId of b.databaseIds) expect(await partitionExists(databaseId)).toBe(false);
    for (const path of b.filePaths) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dirs.files, tenantB))).toBe(false);
    expect(existsSync(join(dirs.mailAttachments, tenantB))).toBe(false);

    for (const [table, column, value] of [
      ["users", "id", b.userId],
      ["sessions", "user_id", b.userId],
      ["push_subscriptions", "user_id", b.userId],
      ["password_reset_tokens", "user_id", b.userId],
      ["login_attempts", "email", b.email],
      ["invites", "email", b.email],
      ["tenant_ai_budgets", "tenant_id", tenantB],
    ] as const) {
      const { rows } = await adminPool.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`,
        [value],
      );
      expect({ table, n: countSchema.parse(rows[0]).n }).toEqual({ table, n: 0 });
    }
    const tables = await adminPool.query<{ relname: string }>(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition",
    );
    for (const { relname } of tables.rows) {
      const { rows } = await adminPool.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM "${relname}" t WHERE t::text LIKE $1`,
        [`%${b.email}%`],
      );
      expect({ relname, n: countSchema.parse(rows[0]).n }).toEqual({ relname, n: 0 });
    }

    expect(await tenantStatus(tenantB)).toBeUndefined();
    const stones = await tombstones(tenantB);
    expect(stones).toHaveLength(1);
    expect(stones[0]?.requested_at).toEqual(requestedAt);
    const { rows: audit } = await adminPool.query("SELECT 1 FROM admin_audit_log WHERE target_tenant_id = $1", [
      tenantB,
    ]);
    expect(audit).toHaveLength(1);

    expect(await rowCounts(tenantA)).toEqual(countsA);
    for (const path of a.filePaths) expect(existsSync(path)).toBe(true);
    expect(await tenantStatus(tenantA)).toBe("active");
    expect((await tombstones(tenantA)).length).toBe(0);
  });

  it("removes only the deleting tenant's queued jobs", async () => {
    const tenantB = await provisionedTenant();
    await runInTenant(tenantA, () => enqueueJob(pool, "purgeTestJob", { which: "a" }));
    await runInTenant(tenantB, () => enqueueJob(pool, "purgeTestJob", { which: "b" }));
    await beginDeletion(tenantB);

    await purge();

    const remaining = z
      .array(z.object({ tenantId: z.string().nullable(), payload: z.object({ which: z.string() }) }))
      .parse(await readJobPayloadsByIdentifier(adminPool, "purgeTestJob"));
    expect(remaining.map((job) => [job.tenantId, job.payload.which])).toEqual([[tenantA, "a"]]);
    expect(await tenantStatus(tenantB)).toBeUndefined();
  });

  it("never touches an active or a suspended tenant", async () => {
    const active = await provisionedTenant();
    const suspended = await provisionedTenant();
    await adminPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [active]);
    await adminPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [suspended]);
    const seededActive = await seedTenant(active);
    const seededSuspended = await seedTenant(suspended);
    await runInTenant(active, () => enqueueJob(pool, "purgeTestJob", { which: "active" }));
    const before = [await rowCounts(active), await rowCounts(suspended)];

    await purge();

    expect([await rowCounts(active), await rowCounts(suspended)]).toEqual(before);
    expect(await tenantStatus(active)).toBe("active");
    expect(await tenantStatus(suspended)).toBe("suspended");
    for (const path of [...seededActive.filePaths, ...seededSuspended.filePaths]) expect(existsSync(path)).toBe(true);
    expect(await readJobPayloadsByIdentifier(adminPool, "purgeTestJob")).toHaveLength(1);
    expect(await tombstones(active)).toHaveLength(0);
    expect(await tombstones(suspended)).toHaveLength(0);
  });

  it("fails the run when a file cannot be deleted, keeps the tenant deleting and finishes on the next run", async () => {
    const tenantB = await provisionedTenant();
    const b = await seedTenant(tenantB);
    await beginDeletion(tenantB);
    const rowsBefore = await rowCounts(tenantB);
    await blockDeletion(b.uploadPath);

    await expect(purge()).rejects.toBeInstanceOf(AggregateError);

    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect(await tombstones(tenantB)).toHaveLength(0);
    expect(await rowCounts(tenantB)).toEqual(rowsBefore);
    for (const databaseId of b.databaseIds) expect(await partitionExists(databaseId)).toBe(true);

    await unblockDeletion(b.uploadPath);
    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await nonEmptyTables(tenantB)).toEqual([]);
  });

  it("purges tenant D completely when tenant C fails, and rethrows C's failure", async () => {
    const tenantC = await provisionedTenant();
    const tenantD = await provisionedTenant();
    const c = await seedTenant(tenantC);
    const d = await seedTenant(tenantD);
    await beginDeletion(tenantC);
    await beginDeletion(tenantD);
    await blockDeletion(c.uploadPath);

    const failure = await purge().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(await tenantStatus(tenantD)).toBeUndefined();
    expect(await tombstones(tenantD)).toHaveLength(1);
    expect(await nonEmptyTables(tenantD)).toEqual([]);
    for (const path of d.filePaths) expect(existsSync(path)).toBe(false);
    expect(await tenantStatus(tenantC)).toBe("deleting");
    expect(await tombstones(tenantC)).toHaveLength(0);
  });

  it("skips a tenant whose purge lock another run holds, and purges it once the lock is free", async () => {
    const tenantB = await provisionedTenant();
    const b = await seedTenant(tenantB);
    await beginDeletion(tenantB);
    const rowsBefore = await rowCounts(tenantB);
    const holder = await adminPool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('semprec_tenant_purge:' || $1::text, 0))", [
        tenantB,
      ]);

      await purge();

      expect(await tenantStatus(tenantB)).toBe("deleting");
      expect(await rowCounts(tenantB)).toEqual(rowsBefore);
      for (const path of b.filePaths) expect(existsSync(path)).toBe(true);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }

    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
  });

  it("finishes without error when two runs start at once, ending in the state of a single run", async () => {
    const tenantB = await provisionedTenant();
    const b = await seedTenant(tenantB);
    await beginDeletion(tenantB);
    const secondPool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      await Promise.all([purge(), purge({}, secondPool)]);
    } finally {
      await secondPool.end();
    }

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await nonEmptyTables(tenantB)).toEqual([]);
    for (const path of b.filePaths) expect(existsSync(path)).toBe(false);
  });

  it("skips a tenant that another run finished between listing it and locking it", async () => {
    const tenantB = await provisionedTenant();
    await seedTenant(tenantB);
    await beginDeletion(tenantB);
    const racing = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const realQuery = racing.query.bind(racing) as (...args: unknown[]) => Promise<unknown>;
      let finishedElsewhere = false;
      // Only this dedicated pool is patched: another run purges the tenant right after the listing returns.
      (racing as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        const result = await realQuery(...args);
        if (!finishedElsewhere && String(args[0]).includes("status = 'deleting'")) {
          finishedElsewhere = true;
          await purge();
        }
        return result;
      };

      await purge({}, racing);
      expect(finishedElsewhere).toBe(true);
    } finally {
      await racing.end();
    }

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
  });

  it("returns normally when aborted mid-purge, keeps the committed progress and finishes on the next run", async () => {
    const tenantB = await provisionedTenant();
    const b = await seedTenant(tenantB);
    await beginDeletion(tenantB);
    // A request already in flight when the deletion began can still create a key afterwards.
    await runInTenant(tenantB, () => withTransaction(pool, (client) => getOrCreateTenantDataKey(client)));
    const controller = new AbortController();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with the instance as `this`
    const originalDelete = LocalFsBlobStorageWriter.prototype.delete;
    vi.spyOn(LocalFsBlobStorageWriter.prototype, "delete").mockImplementation(async function (
      this: LocalFsBlobStorageWriter,
      key: string,
    ) {
      await originalDelete.call(this, key);
      controller.abort();
    });

    await expect(purge({ abortSignal: controller.signal })).resolves.toBeUndefined();

    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect(await tombstones(tenantB)).toHaveLength(0);
    const counts = await rowCounts(tenantB);
    expect(counts["tenant_keys"]).toBe(0);
    expect(counts["items"]).toBeGreaterThan(0);
    for (const databaseId of b.databaseIds) expect(await partitionExists(databaseId)).toBe(true);

    vi.restoreAllMocks();
    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await nonEmptyTables(tenantB)).toEqual([]);
  });

  describe("tenant_deletions", () => {
    it("is classified global and refuses UPDATE and DELETE to semprec_data", async () => {
      const id = randomUUID();
      await adminPool.query("INSERT INTO tenant_deletions (tenant_id, requested_at) VALUES ($1, now())", [id]);
      const { rows } = await adminPool.query<{ comment: string }>(
        "SELECT obj_description('tenant_deletions'::regclass) AS comment",
      );
      expect(rows[0]?.comment).toBe("semprec:tenancy=global");

      await expect(
        pool.query("UPDATE tenant_deletions SET requested_at = now() WHERE tenant_id = $1", [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
      await expect(pool.query("DELETE FROM tenant_deletions WHERE tenant_id = $1", [id])).rejects.toMatchObject({
        code: "42501",
      });
      expect(await tombstones(id)).toHaveLength(1);
    });
  });
});
