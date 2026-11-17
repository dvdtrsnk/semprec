import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DatabaseError, escapeIdentifier, type Pool, type PoolClient } from "pg";
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
import { createDatabase } from "../chokePoint/databasesStore.js";
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
import { logger } from "../tenancy/logger.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { handleTenantExportTask } from "../tenancy/tenantExportJob.js";
import { createMailThread, reassignThread } from "../mail/mailMessageMetaStore.js";
import { requestTenantExport } from "../tenancy/tenantExportsStore.js";
import { handleTenantPurgeTask, type TenantPurgeDirs } from "../tenancy/tenantPurgeJob.js";
import { insertItemOrigins } from "../inbox/itemOriginsStore.js";
import { replaceCoverCandidates } from "../library/coverCandidatesStore.js";
import { raiseProblem } from "../semp/sempProblemsStore.js";
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

interface SeededTenant {
  tenantId: string;
  userId: string;
  email: string;
  databaseIds: string[];
  filePaths: string[];
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

/** Seeds every kind of tenant row the purge must erase, including the user's sessions, tokens and invite. */
async function seedTenant(tenantId: string): Promise<SeededTenant> {
  const email = `${randomUUID()}@example.com`;
  // The invite is addressed to the account's email; the API cannot create it once the account exists.
  const placeholder = await createUser(adminPool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    tenantId: await createTestTenant(adminPool),
  });
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
    await withTransaction(pool, (client) =>
      insertItemOrigins(client, [mailItemId], {
        proposalId: mailItemId,
        inboxItemId: null,
        sourceTranscriptId: null,
        capturedAt: null,
        captureChannel: "inbox",
        captureTimeBasis: "unknown",
      }),
    );
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

async function rowCounts(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [...(await tenantTables()), "agent_run_mcp_credentials"]) {
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT count(*) AS n FROM ${escapeIdentifier(table)} WHERE tenant_id = $1`,
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

/** The purge lists databases with this, in the partitions step and again right before `items`. */
const DATABASE_LISTING = "SELECT id FROM databases WHERE tenant_id = $1";

/** Runs `after` once the `nth` statement containing `sqlFragment` returned: a writer already running when deletion began. */
async function poolRunningAfter(sqlFragment: string, nth: number, after: () => Promise<void>): Promise<Pool> {
  const hooked = await createRuntimeRolePool(adminPool, "semprec_data");
  const realQuery = hooked.query.bind(hooked) as (...args: unknown[]) => Promise<unknown>;
  let seen = 0;
  (hooked as unknown as { query: unknown }).query = async (...args: unknown[]) => {
    const result = await realQuery(...args);
    if (String(args[0]).includes(sqlFragment)) {
      seen += 1;
      if (seen === nth) await after();
    }
    return result;
  };
  return hooked;
}

async function createLateDatabase(tenantId: string, withItem: boolean): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const database = await createDatabase(client, { name: "Late" });
      if (withItem) await createItemWithClient(client, { databaseId: database.id, properties: {} });
      return database.id;
    }),
  );
}

interface QueueRow {
  id: number;
  queue_name: string;
  locked_at: Date | null;
  locked_by: string | null;
}

/** The queue table is private to graphile-worker, so every read of it goes through here. */
async function queueRows(): Promise<QueueRow[]> {
  const { rows } = await adminPool.query<QueueRow>(
    "SELECT id, queue_name, locked_at, locked_by FROM graphile_worker._private_job_queues ORDER BY queue_name",
  );
  return rows;
}

async function laneQueuesOf(tenantId: string): Promise<QueueRow[]> {
  return (await queueRows()).filter((row) => row.queue_name.endsWith(`:${tenantId}`));
}

async function enqueueInQueue(tenantId: string, queueName: string): Promise<void> {
  await runInTenant(tenantId, () => enqueueJob(pool, "purgeTestJob", { which: queueName }, { queueName }));
}

async function enqueueInLane(tenantId: string, lane: string): Promise<string> {
  const queueName = await runInTenant(tenantId, async () => tenantLane(lane));
  if (!queueName) throw new Error("tenantLane returned no queue inside a tenant scope");
  await enqueueInQueue(tenantId, queueName);
  return queueName;
}

async function completeJobsIn(queueName: string): Promise<number> {
  const { rows } = await adminPool.query<{ id: string }>(
    `SELECT id FROM graphile_worker.complete_jobs(ARRAY(
       SELECT j.id FROM graphile_worker._private_jobs AS j
         JOIN graphile_worker._private_job_queues AS q ON q.id = j.job_queue_id
        WHERE q.queue_name = $1))`,
    [queueName],
  );
  return rows.length;
}

async function jobsWithoutQueue(): Promise<number> {
  const { rows } = await adminPool.query<Record<string, unknown>>(
    `SELECT count(*) AS n FROM graphile_worker._private_jobs AS j
      WHERE j.job_queue_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM graphile_worker._private_job_queues AS q WHERE q.id = j.job_queue_id)`,
  );
  return countSchema.parse(rows[0]).n;
}

async function purgeFailureMessages(using: Pool = pool): Promise<string[]> {
  const failure = await purge({}, using).then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(failure instanceof AggregateError)) throw new Error("the purge was expected to fail");
  return failure.errors.map((err: unknown) => (err instanceof Error ? err.message : String(err)));
}

async function addUser(tenantId: string): Promise<string> {
  const user = await createUser(adminPool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    tenantId,
  });
  return user.id;
}

async function userCount(tenantId: string): Promise<number> {
  const { rows } = await adminPool.query<Record<string, unknown>>(
    "SELECT count(*) AS n FROM users WHERE tenant_id = $1",
    [tenantId],
  );
  return countSchema.parse(rows[0]).n;
}

async function purgeLockIsFree(tenantId: string): Promise<boolean> {
  const client = await adminPool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('semprec_tenant_purge:' || $1::text, 0)) AS locked",
      [tenantId],
    );
    if (rows[0]?.locked) await client.query("SELECT pg_advisory_unlock_all()");
    return rows[0]?.locked === true;
  } finally {
    client.release();
  }
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
    for (const seeded of [a, b]) {
      await runInTenant(seeded.tenantId, () =>
        withTransaction(pool, (client) =>
          raiseProblem(client, {
            userId: seeded.userId,
            category: "mail",
            kind: "sync",
            severity: "warning",
            sourceTable: "mail_account_sync_state",
            sourceId: randomUUID(),
            dedupeKey: "purge-receipt",
            occurrenceKey: "job-a",
          }),
        ),
      );
    }
    for (const tenant of [tenantA, tenantB]) {
      await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const from = await createMailThread(client);
          const to = await createMailThread(client);
          await reassignThread(client, from.id, to.id);
        }),
      );
    }
    for (const tenant of [tenantA, tenantB]) {
      // A cover candidate row for an item id of the tenant; the purge deletes it with the tenant's other rows.
      await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          replaceCoverCandidates(client, randomUUID(), [
            { source: "tmdb", title: "Purge me", subtitle: null, imageUrl: "https://covers.example.test/p.jpg" },
          ]),
        ),
      );
    }
    await runInTenant(tenantB, () => enqueueJob(pool, "purgeTestJob", { which: "b" }));
    // Two lanes of the deleted tenant, one idle lane of the other tenant and one that still holds a job.
    const queuesOfB = [
      await enqueueInLane(tenantB, "purgeTestLaneOne"),
      await enqueueInLane(tenantB, "purgeTestLaneTwo"),
    ];
    const idleQueueOfA = await enqueueInLane(tenantA, "purgeTestLaneOne");
    await completeJobsIn(idleQueueOfA);
    const busyQueueOfA = await enqueueInLane(tenantA, "purgeTestLaneTwo");
    // The seeding above already left other lane queues of both tenants (agent runs, value links, mail threads).
    const queueNamesOf = async (tenantId: string): Promise<string[]> =>
      (await laneQueuesOf(tenantId)).map((row) => row.queue_name);
    expect(await queueNamesOf(tenantB)).toEqual(expect.arrayContaining(queuesOfB));
    expect(await queueNamesOf(tenantA)).toEqual(expect.arrayContaining([busyQueueOfA, idleQueueOfA]));
    const queuesOfABefore = await laneQueuesOf(tenantA);
    await beginDeletion(tenantB);
    const { rows: before } = await adminPool.query<{ status_changed_at: Date }>(
      "SELECT status_changed_at FROM tenants WHERE id = $1",
      [tenantB],
    );
    const requestedAt = before[0]?.status_changed_at;
    const countsA = await rowCounts(tenantA);
    expect(countsA.mail_thread_aliases).toBe(1);
    expect((await rowCounts(tenantB)).mail_thread_aliases).toBe(1);
    expect(countsA.item_origins).toBe(1);
    expect(countsA.library_cover_candidates).toBe(1);
    expect((await rowCounts(tenantB)).library_cover_candidates).toBe(1);
    expect(countsA.semp_problem_occurrences).toBe(1);
    expect((await rowCounts(tenantB)).semp_problem_occurrences).toBe(1);
    expect((await rowCounts(tenantB)).item_origins).toBe(1);
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
        `SELECT count(*) AS n FROM ${escapeIdentifier(table)} WHERE ${escapeIdentifier(column)} = $1`,
        [value],
      );
      expect({ table, n: countSchema.parse(rows[0]).n }).toEqual({ table, n: 0 });
    }
    const tables = await adminPool.query<{ relname: string }>(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition",
    );
    for (const { relname } of tables.rows) {
      const { rows } = await adminPool.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM ${escapeIdentifier(relname)} t WHERE t::text LIKE $1`,
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

    expect(await laneQueuesOf(tenantB)).toEqual([]);
    expect((await queueRows()).filter((row) => row.queue_name.includes(tenantB))).toEqual([]);
    expect(await laneQueuesOf(tenantA)).toEqual(queuesOfABefore);
    expect(await jobsWithoutQueue()).toBe(0);

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

  it("keeps a deleting tenant deleting while one of its queues is locked by a running job, and erases the queue once it is idle", async () => {
    const tenantB = await provisionedTenant();
    await addUser(tenantB);
    const queueName = await enqueueInLane(tenantB, "purgeTestLane");
    // Only a running task locks a job and its queue, so the test sets that state directly.
    await adminPool.query(
      "UPDATE graphile_worker._private_job_queues SET locked_at = now(), locked_by = 'purge-test-worker' WHERE queue_name = $1",
      [queueName],
    );
    await adminPool.query(
      `UPDATE graphile_worker._private_jobs SET locked_at = now(), locked_by = 'purge-test-worker'
        WHERE job_queue_id = (SELECT id FROM graphile_worker._private_job_queues WHERE queue_name = $1)`,
      [queueName],
    );
    await beginDeletion(tenantB);

    const messages = await purgeFailureMessages();

    expect(messages).toEqual(["Tenant purge left rows behind in: graphile_worker._private_job_queues"]);
    expect(messages.join()).not.toContain(queueName);
    expect(messages.join()).not.toContain(tenantB);
    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect(await tombstones(tenantB)).toHaveLength(0);
    expect(await userCount(tenantB)).toBe(1);
    expect((await laneQueuesOf(tenantB)).map((row) => row.queue_name)).toEqual([queueName]);

    // The job is gone but the queue is still marked locked: the name and the lock alone must keep the queue.
    await adminPool.query(
      "UPDATE graphile_worker._private_jobs SET locked_at = NULL, locked_by = NULL WHERE job_queue_id IS NOT NULL",
    );
    expect(await completeJobsIn(queueName)).toBe(1);
    expect(await purgeFailureMessages()).toEqual([
      "Tenant purge left rows behind in: graphile_worker._private_job_queues",
    ]);
    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect(await tombstones(tenantB)).toHaveLength(0);
    expect((await laneQueuesOf(tenantB)).map((row) => row.queue_name)).toEqual([queueName]);

    await adminPool.query(
      "UPDATE graphile_worker._private_job_queues SET locked_at = NULL, locked_by = NULL WHERE queue_name = $1",
      [queueName],
    );
    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await userCount(tenantB)).toBe(0);
    expect(await laneQueuesOf(tenantB)).toEqual([]);
  });

  it("keeps a queue that holds a job enqueued after the jobs step, and erases it on the next run", async () => {
    const tenantB = await provisionedTenant();
    await beginDeletion(tenantB);
    let lateQueue: string | undefined;
    // The second catalog read is the finalisation's: a lane producer enqueues just before it.
    const writer = await poolRunningAfter("FROM pg_constraint", 2, async () => {
      lateQueue = await enqueueInLane(tenantB, "purgeTestLane");
    });
    try {
      expect(await purgeFailureMessages(writer)).toEqual([
        "Tenant purge left rows behind in: graphile_worker._private_job_queues",
      ]);
    } finally {
      await writer.end();
    }

    if (!lateQueue) throw new Error("the late producer never ran");
    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect(await tombstones(tenantB)).toHaveLength(0);
    expect((await laneQueuesOf(tenantB)).map((row) => row.queue_name)).toEqual([lateQueue]);

    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await laneQueuesOf(tenantB)).toEqual([]);
    expect(await jobsWithoutQueue()).toBe(0);
  });

  it("does not delete another tenant's idle queue whose name holds the purged id outside the ':<tenantId>' suffix", async () => {
    const tenantB = await provisionedTenant();
    const lookalikes = [`purgeTestLane:${tenantB}:${tenantA}`, `${tenantB}:purgeTestLane`, `purgeTestLane-${tenantB}`];
    for (const queueName of lookalikes) {
      await enqueueInQueue(tenantA, queueName);
      expect(await completeJobsIn(queueName)).toBe(1);
    }
    const ownQueue = await enqueueInLane(tenantB, "purgeTestLane");
    await completeJobsIn(ownQueue);
    const lookalikeRows = (await queueRows()).filter((row) => lookalikes.includes(row.queue_name));
    expect(lookalikeRows).toHaveLength(3);
    await beginDeletion(tenantB);

    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await laneQueuesOf(tenantB)).toEqual([]);
    expect((await queueRows()).filter((row) => lookalikes.includes(row.queue_name))).toEqual(lookalikeRows);
  });

  it("fails finalisation while another transaction has an open enqueue into the tenant's lane, and completes once it has committed", async () => {
    const tenantB = await provisionedTenant();
    await addUser(tenantB);
    // An earlier job leaves the lane's queue row behind, idle: the open enqueue below does not create it.
    const queueName = await enqueueInLane(tenantB, "purgeTestLane");
    expect(await completeJobsIn(queueName)).toBe(1);
    expect((await laneQueuesOf(tenantB)).map((row) => row.queue_name)).toEqual([queueName]);
    await beginDeletion(tenantB);

    const open = await adminPool.connect();
    let committed = false;
    try {
      await open.query("BEGIN");
      await runInTenant(tenantB, () => enqueueJob(open, "purgeTestJob", { which: "open" }, { queueName }));

      const failure = await purge().then(
        () => undefined,
        (err: unknown) => err,
      );

      if (!(failure instanceof AggregateError)) throw new Error("the purge was expected to fail");
      const cause: unknown = failure.errors[0];
      expect(failure.errors).toHaveLength(1);
      expect(cause instanceof DatabaseError ? cause.code : cause).toBe("55P03");
      expect(await tenantStatus(tenantB)).toBe("deleting");
      expect(await tombstones(tenantB)).toHaveLength(0);
      expect(await userCount(tenantB)).toBe(1);
      expect((await laneQueuesOf(tenantB)).map((row) => row.queue_name)).toEqual([queueName]);

      await open.query("COMMIT");
      committed = true;
    } finally {
      try {
        if (!committed) await open.query("ROLLBACK");
      } finally {
        open.release();
      }
    }
    expect(await jobsWithoutQueue()).toBe(0);

    // The job the transaction committed is removed by the next run's jobs step, then its queue is erased.
    await purge();

    expect(await tenantStatus(tenantB)).toBeUndefined();
    expect(await tombstones(tenantB)).toHaveLength(1);
    expect(await userCount(tenantB)).toBe(0);
    expect(await laneQueuesOf(tenantB)).toEqual([]);
    expect(await readJobPayloadsByIdentifier(adminPool, "purgeTestJob")).toEqual([]);
    expect(await jobsWithoutQueue()).toBe(0);
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
      // Only this dedicated pool is patched: another run purges the tenant right after the listing.
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

  it("erases bytes a running writer stores under the tenant's directories after the bytes step", async () => {
    const tenantB = await provisionedTenant();
    await seedTenant(tenantB);
    await beginDeletion(tenantB);
    const latePaths = [
      join(dirs.files, tenantB, "late", "upload.bin"),
      join(dirs.mailAttachments, tenantB, "late.bin"),
    ];
    const writer = await poolRunningAfter(DATABASE_LISTING, 1, async () => {
      for (const path of latePaths) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "late bytes");
      }
    });
    try {
      await purge({}, writer);
    } finally {
      await writer.end();
    }

    for (const path of latePaths) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dirs.files, tenantB))).toBe(false);
    expect(existsSync(join(dirs.mailAttachments, tenantB))).toBe(false);
    expect(await tombstones(tenantB)).toHaveLength(1);
  });

  it("drops the partition of a database a running writer creates after the partitions step", async () => {
    const tenantB = await provisionedTenant();
    await seedTenant(tenantB);
    await beginDeletion(tenantB);
    let lateDatabaseId: string | undefined;
    const writer = await poolRunningAfter(DATABASE_LISTING, 1, async () => {
      lateDatabaseId = await createLateDatabase(tenantB, true);
    });
    try {
      // Resolving proves the predicate delete on `items` found nothing: any row there fails the tenant.
      await purge({}, writer);
    } finally {
      await writer.end();
    }

    if (!lateDatabaseId) throw new Error("the late writer never ran");
    expect(await partitionExists(lateDatabaseId)).toBe(false);
    expect(await nonEmptyTables(tenantB)).toEqual([]);
    expect(await tombstones(tenantB)).toHaveLength(1);
  });

  it("fails the tenant when item rows remain after the partitions were dropped, and drops their partition on the retry", async () => {
    const tenantB = await provisionedTenant();
    await seedTenant(tenantB);
    await beginDeletion(tenantB);
    // Created after the second partition pass, so only the predicate delete on `items` reaches its row.
    let lateDatabaseId: string | undefined;
    const writer = await poolRunningAfter(DATABASE_LISTING, 2, async () => {
      lateDatabaseId = await createLateDatabase(tenantB, true);
    });
    try {
      await expect(purge({}, writer)).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await writer.end();
    }

    if (!lateDatabaseId) throw new Error("the late writer never ran");
    expect(await tenantStatus(tenantB)).toBe("deleting");
    expect(await tombstones(tenantB)).toHaveLength(0);
    expect(await partitionExists(lateDatabaseId)).toBe(true);

    await purge();

    expect(await partitionExists(lateDatabaseId)).toBe(false);
    expect(await nonEmptyTables(tenantB)).toEqual([]);
    expect(await tombstones(tenantB)).toHaveLength(1);
  });

  it("destroys the lock connection when the unlock fails, so the purge lock does not leak", async () => {
    const tenantB = await provisionedTenant();
    await seedTenant(tenantB);
    await beginDeletion(tenantB);
    const errorSpy = vi.spyOn(logger, "error");
    const flaky = await createRuntimeRolePool(adminPool, "semprec_data");
    let releasedWith: unknown = "never released";
    try {
      const realConnect = flaky.connect.bind(flaky) as () => Promise<PoolClient>;
      let patched = false;
      // Only the first connection, the purge's dedicated lock client, refuses the unlock.
      (flaky as unknown as { connect: unknown }).connect = async () => {
        const client = await realConnect();
        if (!patched) {
          patched = true;
          const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
            if (String(args[0]).includes("pg_advisory_unlock")) throw new Error("unlock refused");
            return realQuery(...args);
          };
          const realRelease = client.release.bind(client);
          client.release = (err?: Error | boolean) => {
            releasedWith = err;
            realRelease(err);
          };
        }
        return client;
      };

      await purge({}, flaky);

      expect(releasedWith).toBeInstanceOf(Error);
      // Pool removal is synchronous; PostgreSQL releases session locks after observing the socket close.
      await expect.poll(() => purgeLockIsFree(tenantB), { timeout: 5_000 }).toBe(true);
    } finally {
      await flaky.end();
    }
    expect(errorSpy).toHaveBeenCalledWith({ tenantId: tenantB, errorName: "Error" }, "tenant_purge_unlock_failed");
    expect(await tombstones(tenantB)).toHaveLength(1);
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
