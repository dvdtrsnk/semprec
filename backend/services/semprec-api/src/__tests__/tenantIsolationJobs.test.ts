import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";
import { replayApprovedGenericOperation } from "@semprec/application";
import { encryptSecret, openSecret, resolveMasterKeyFromEnv, unwrapDataKey } from "@semprec/credentials";
import {
  CORE_TASK_NAMES,
  TASK_TENANCY,
  enqueueJob,
  ensureQueueSchema,
  grantQueueSchemaPrivileges,
  registerTask,
  runOnce,
  type TaskList,
  type TaskTenancy,
} from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  JOURNAL_MODULE_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  assertTaskListMatchesAffinity,
  beginTenantDeletion,
  createAgentRun,
  createApiCoreTaskList,
  createChokePoint,
  createDocStore,
  createHeartbeat,
  createItemWithClient,
  createPendingApprovalRequest,
  createUser,
  decideAndEnqueueApprovalRequest,
  ensureItemAutomation,
  finishAgentRun,
  getDatabaseByModuleId,
  getOrCreateJournalItem,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  mergeModuleTaskListForAffinity,
  mintMcpRunCredential,
  provisionTenant,
  recordHeartbeatFailure,
  requestTenantExport,
  resolveTaskAffinitySets,
  upsertWebPushSubscription,
  withTransaction,
  writeNotification,
  type ChokePoint,
  type DocStore,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  storeCredential,
} from "@semprec/data/testSupport";
import { createApiActionRegistry } from "../actionRegistryComposition.js";

/**
 * Two-tenant proof that every task of the `api` affinity set keeps its data, notifications and side
 * effects inside the tenant it runs for (issue #1056). The task list is composed exactly as
 * `createApiQueueRuntime` composes it, over a `semprec_data` pool; jobs are enqueued with
 * `enqueueJob` and drained with `runOnce`, under strict tenant-scope enforcement.
 *
 * Fixture writes enqueue jobs of their own (a rollup backfill, a notification fanout, the export a
 * request schedules). They are discarded before the job under test is enqueued, so the queue holds
 * only that job and whatever it enqueues itself.
 */

interface Tenant {
  tenantId: string;
  userId: string;
}

type Payload = Record<string, unknown>;

interface TenantTaskCase {
  tenancy: "tenant";
  /** Seeds `tenant`'s fixture rows and returns the job payload naming them. */
  seed(tenant: Tenant): Promise<Payload>;
  /**
   * Set when this composition root cannot complete the job: the error its run for its own tenant
   * ends with. `mailAccountSync` is the one — `createApiQueueRuntime` wires no mail transport.
   */
  expectedError?: RegExp;
  /** Asserts, inside `tenant`, the effect the job with `payload` had. */
  expectDone(tenant: Tenant, payload: Payload): Promise<void>;
}

/** Asserts, once the job ran, that the work it was returned for was done. */
type Check = () => Promise<void>;

/** Work seeded in one tenant: the ids that identify it, and the check that it was done. */
interface SeededWork {
  /** Ids of the seeded rows (and, for a purge, the tenant); no row of another tenant may contain one. */
  markers: string[];
  check: Check;
}

/** Only UUIDs make markers: a short id such as a bigint event id would match unrelated row text. */
function marked(markers: string[], check: Check): SeededWork {
  const notUuid = markers.filter(
    (marker) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marker),
  );
  if (notUuid.length > 0) throw new Error(`marked: not UUIDs: ${notUuid.join(", ")}`);
  return { markers, check };
}

interface SystemTaskCase {
  tenancy: "system";
  touchesTenantTables: true;
  /** The two tenants the work is due in; A and B unless given. */
  tenants?(): Promise<[Tenant, Tenant]>;
  /** Seeds due work in `tenant`; its check asserts, inside `tenant`, that the work was done. */
  seed(tenant: Tenant): Promise<SeededWork>;
}

interface GlobalSystemTaskCase {
  tenancy: "system";
  touchesTenantTables: false;
  /** Seeds due work outside every tenant table; the returned check asserts it was done. */
  seed(): Promise<Check>;
}

type TaskCase = TenantTaskCase | SystemTaskCase | GlobalSystemTaskCase;

/** One table's share of a tenant fingerprint. */
interface TableFingerprint {
  count: number;
  md5: string;
}
type Fingerprint = Record<string, TableFingerprint>;

interface JobOutcome {
  /** `null` once the job completed and graphile-worker deleted its row. */
  attempts: number | null;
  lastError: string | null;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let previousScope: string | undefined;
let adminPool: Pool;
let pool: Pool;
let taskList: TaskList;
let tenantTables: string[];
let chokePoint: ChokePoint;
let docStore: DocStore;
let blobRoot: string;
const previousEnv = new Map<string, string | undefined>();
let tenantA: Tenant;
let tenantB: Tenant;
let tenantZero: Tenant;

const moduleRegistry = await loadFullModuleRegistry();

async function buildTenant(tenantId: string): Promise<Tenant> {
  await provisionTenant(pool, tenantId);
  const user = await runAsSystem("test:create-user", () =>
    createUser(adminPool, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId }),
  );
  return { tenantId, userId: user.id };
}

/** Every table whose catalog comment classifies it as tenant data (partitions count with their parent). */
async function loadTenantTables(): Promise<string[]> {
  const { rows } = await adminPool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY c.relname`,
  );
  return rows.map((row) => row.relname);
}

/** `tenant`'s fingerprint: per tenant table, read inside `runInTenant(tenant)`, its row count and an md5 over its ordered row texts. */
async function fingerprint(tenant: Tenant): Promise<Fingerprint> {
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const result: Fingerprint = {};
      for (const table of tenantTables) {
        // `table` comes from pg_class (see loadTenantTables), never from input, and escapeIdentifier
        // quotes it; a table name cannot be a bind parameter.
        const { rows } = await client.query<{ count: number; md5: string }>(
          `SELECT count(*)::int AS count, md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS md5
             FROM ${escapeIdentifier(table)} t`,
        );
        const row = rows[0];
        if (!row) throw new Error(`fingerprint: no aggregate row for ${table}`);
        result[table] = { count: row.count, md5: row.md5 };
      }
      return result;
    }),
  );
}

/** Ids of every notification visible inside `tenant`, with the user each is addressed to. */
async function notifications(tenant: Tenant): Promise<Map<string, string>> {
  return runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ id: string; user_id: string }>("SELECT id, user_id FROM notifications");
    return new Map(rows.map((row) => [row.id, row.user_id]));
  });
}

/** Asserts every notification `tenant` gained since `before` is addressed to `tenant`'s own user. */
async function expectNewNotificationsAddressedTo(tenant: Tenant, before: Map<string, string>): Promise<void> {
  const after = await notifications(tenant);
  const added = [...after].filter(([id]) => !before.has(id)).map(([, userId]) => userId);
  expect(added.filter((userId) => userId !== tenant.userId)).toEqual([]);
}

/** The job's final state, read through graphile-worker's public `jobs` view. */
async function jobOutcome(jobKey: string): Promise<JobOutcome> {
  const { rows } = await adminPool.query<{ attempts: number; last_error: string | null }>(
    "SELECT attempts, last_error FROM graphile_worker.jobs WHERE key = $1",
    [jobKey],
  );
  const row = rows[0];
  if (!row) return { attempts: null, lastError: null };
  return { attempts: row.attempts, lastError: row.last_error?.replace(UUID_PATTERN, "<id>") ?? null };
}

/** Removes a job a case left failed in the queue, so it cannot run again in a later case. */
async function removeJob(jobKey: string): Promise<void> {
  await adminPool.query("SELECT graphile_worker.remove_job($1)", [jobKey]);
}

/**
 * What a run may change: the tenant's fingerprint and notifications, and the queued jobs of the whole
 * queue — the `jobs` view carries no tenant, so a job any run enqueued anywhere counts.
 */
interface SideEffectSnapshot {
  fingerprint: Fingerprint;
  notificationIds: ReadonlySet<string>;
  jobIds: ReadonlySet<string>;
}

/** What one run changed, stated without ids so two runs naming different ids compare equal. */
interface SideEffects {
  /** Tables whose row count changed, with the change. */
  rowCountDeltas: Record<string, number>;
  /** Tables whose content changed, including rows updated in place, sorted. */
  changedTables: string[];
  /** Kinds of the notifications the run wrote, sorted. */
  notificationKinds: string[];
  /** Task identifiers of the jobs the run left queued anywhere in the queue (its own job excluded), sorted. */
  queuedJobs: string[];
}

async function sideEffectSnapshot(tenant: Tenant): Promise<SideEffectSnapshot> {
  const notificationIds = new Set((await notifications(tenant)).keys());
  const { rows } = await adminPool.query<{ id: string }>("SELECT id::text AS id FROM graphile_worker.jobs");
  return { fingerprint: await fingerprint(tenant), notificationIds, jobIds: new Set(rows.map((row) => row.id)) };
}

async function sideEffectsSince(tenant: Tenant, before: SideEffectSnapshot, ownJobKey: string): Promise<SideEffects> {
  const after = await sideEffectSnapshot(tenant);
  const rowCountDeltas = Object.fromEntries(
    Object.entries(after.fingerprint)
      .map(([table, { count }]): [string, number] => [table, count - (before.fingerprint[table]?.count ?? 0)])
      .filter(([, delta]) => delta !== 0),
  );
  const changedTables = Object.entries(after.fingerprint)
    .filter(([table, { md5 }]) => before.fingerprint[table]?.md5 !== md5)
    .map(([table]) => table)
    .sort();
  const notificationKinds = await runInTenant(tenant.tenantId, async () => {
    const { rows } = await pool.query<{ id: string; kind: string }>("SELECT id, kind FROM notifications");
    return rows
      .filter((row) => !before.notificationIds.has(row.id))
      .map((row) => row.kind)
      .sort();
  });
  const { rows: jobs } = await adminPool.query<{ id: string; key: string | null; task_identifier: string }>(
    "SELECT id::text AS id, key, task_identifier FROM graphile_worker.jobs",
  );
  const queuedJobs = jobs
    .filter((job) => !before.jobIds.has(job.id) && job.key !== ownJobKey)
    .map((job) => job.task_identifier)
    .sort();
  return { rowCountDeltas, changedTables, notificationKinds, queuedJobs };
}

/** Runs `name` in B with `payload` and returns how the job ended and what it changed in B and the queue. */
async function runInBObserved(name: string, payload: Payload): Promise<{ outcome: JobOutcome; effects: SideEffects }> {
  const before = await sideEffectSnapshot(tenantB);
  const jobKey = await runJobIn(tenantB, name, payload);
  const outcome = await jobOutcome(jobKey);
  const effects = await sideEffectsSince(tenantB, before, jobKey);
  await removeJob(jobKey);
  return { outcome, effects };
}

/** Enqueues `name` inside `tenant` under a fresh job key, drains the queue once and returns the key. */
async function runJobIn(tenant: Tenant, name: string, payload: Payload): Promise<string> {
  const jobKey = randomUUID();
  await runInTenant(tenant.tenantId, () => enqueueJob(pool, name, payload, { jobKey }));
  await runOnce({ pgPool: pool, taskList });
  return jobKey;
}

/** `value` with every UUID inside it replaced by a fresh random one. */
function withRandomIds(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID_PATTERN, () => randomUUID());
  if (Array.isArray(value)) return value.map(withRandomIds);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withRandomIds(entry)]));
  }
  return value;
}

function randomizedPayload(payload: Payload): Payload {
  const randomized = withRandomIds(payload);
  if (typeof randomized !== "object" || randomized === null || Array.isArray(randomized)) {
    throw new Error("withRandomIds: expected an object payload");
  }
  return Object.fromEntries(Object.entries(randomized));
}

function tenancyOf(name: string): TaskTenancy {
  const declared: Readonly<Record<string, TaskTenancy>> = TASK_TENANCY;
  return Object.hasOwn(declared, name) ? (declared[name] ?? "tenant") : "tenant";
}

/** Tenant tables of which some row, read inside `tenant`, contains one of `markers` in its text. */
async function tablesMentioning(tenant: Tenant, markers: string[]): Promise<string[]> {
  const patterns = markers.map((marker) => `%${marker}%`);
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const mentioning: string[] = [];
      for (const table of tenantTables) {
        // `table` comes from pg_class (see loadTenantTables), never from input, and escapeIdentifier
        // quotes it; a table name cannot be a bind parameter.
        const { rows } = await client.query<{ found: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${escapeIdentifier(table)} t WHERE t::text LIKE ANY($1)) AS found`,
          [patterns],
        );
        if (rows[0]?.found) mentioning.push(table);
      }
      return mentioning;
    }),
  );
}

/** Enqueues `name` as system work under a fresh job key, drains the queue once and returns the key. */
async function runSystemJob(name: string): Promise<string> {
  const jobKey = randomUUID();
  await runAsSystem("test:enqueue-system-job", () => enqueueJob(pool, name, {}, { jobKey }));
  await runOnce({ pgPool: pool, taskList });
  return jobKey;
}

/** Completes every queued job without running it, through graphile-worker's public `complete_jobs`. */
async function discardQueuedJobs(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

function requirePayloadString(payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`expected payload field ${field} to be a string`);
  return value;
}

function inTenant<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant.tenantId, fn);
}

async function rows<T extends Record<string, unknown>>(
  tenant: Tenant,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return inTenant(tenant, async () => (await pool.query<T>(sql, params)).rows);
}

async function requireModuleDatabaseId(tenant: Tenant, moduleId: string): Promise<string> {
  const database = await inTenant(tenant, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`expected the ${moduleId} database to be seeded`);
  return database.id;
}

async function seededSemprecProjectItemId(tenant: Tenant): Promise<string> {
  const found = await rows<{ id: string }>(tenant, "SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'");
  const row = found[0];
  if (!row || found.length !== 1) throw new Error("expected exactly one seeded Semprec project item");
  return row.id;
}

async function createMailbox(tenant: Tenant): Promise<string> {
  const mailboxesId = await requireModuleDatabaseId(tenant, "mailboxes");
  return inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: `Mailbox ${randomUUID()}`, provider: "generic" },
      });
      await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      return mailbox.id;
    }),
  );
}

async function createEmail(tenant: Tenant): Promise<{ emailsDatabaseId: string; itemId: string }> {
  const emailsDatabaseId = await requireModuleDatabaseId(tenant, "emails");
  const item = await inTenant(tenant, () =>
    withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: emailsDatabaseId,
          properties: { name: "Old subject", sender: "Alice <alice@example.com>", recipients: "bob@example.com" },
        },
        { allowedSystemKeys: ["name", "sender", "recipients"] },
      ),
    ),
  );
  return { emailsDatabaseId, itemId: item.id };
}

/**
 * A daily heartbeat on `tenant`'s Semprec project running an api-affinity action that finds nothing
 * to do: the library metadata retry sweep over an empty database of the tenant's own.
 */
async function createRetrySweepHeartbeat(tenant: Tenant): Promise<string> {
  const projectItemId = await seededSemprecProjectItemId(tenant);
  const heartbeat = await inTenant(tenant, async () => {
    const database = await chokePoint.createDatabase({ name: `Library ${randomUUID()}` });
    return withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId,
        name: `Isolation ${randomUUID()}`,
        rule: { kind: "dailyTime", at: "09:00" },
        actionId: LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
        actionConfig: { databaseId: database.id, source: "test", coverKey: "cover" },
      }),
    );
  });
  return heartbeat.id;
}

async function createRollupFixture(
  tenant: Tenant,
): Promise<{ projectsId: string; projectId: string; rollupPropertyId: string }> {
  return inTenant(tenant, async () => {
    const projects = await chokePoint.createDatabase({ name: `Projects ${randomUUID()}` });
    const tasks = await chokePoint.createDatabase({ name: `Tasks ${randomUUID()}` });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });
    const rollup = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "taskCount",
      name: "Task count",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "count" },
    });
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: relation.id,
      callerItemId: project.id,
      targetItemId: task.id,
    });
    return { projectsId: projects.id, projectId: project.id, rollupPropertyId: rollup.id };
  });
}

async function expectRollupCount(tenant: Tenant, projectsId: string, projectId: string): Promise<void> {
  const project = await inTenant(tenant, () => chokePoint.getItem(projectsId, projectId));
  expect(project?.computed.taskCount).toBe(1);
}

async function createReadyExport(tenant: Tenant): Promise<string> {
  const requested = await inTenant(tenant, () =>
    withTransaction(pool, (client) => requestTenantExport(client, tenant.userId)),
  );
  await discardQueuedJobs();
  const jobKey = await runJobIn(tenant, CORE_TASK_NAMES.TENANT_EXPORT, { exportId: requested.export.id });
  expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
  return requested.export.id;
}

/** A Movies-free item with a pending automation row, the minimal input of the metadata job. */
async function createItemWithAutomation(tenant: Tenant): Promise<{ databaseId: string; itemId: string }> {
  return inTenant(tenant, async () => {
    const database = await chokePoint.createDatabase({ name: `Library ${randomUUID()}` });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    return { databaseId: database.id, itemId: item.id };
  });
}

/** A trashed item whose `deleted_at` lies past the 30-day retention. */
async function createExpiredTrash(tenant: Tenant): Promise<SeededWork> {
  const { databaseId, itemId } = await inTenant(tenant, async () => {
    const database = await chokePoint.createDatabase({ name: `Trash ${randomUUID()}` });
    const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
    await chokePoint.softDeleteItem(database.id, item.id);
    // No production writer moves `deleted_at` into the past.
    await pool.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1 AND database_id = $2", [
      item.id,
      database.id,
    ]);
    return { databaseId: database.id, itemId: item.id };
  });
  return marked([itemId, databaseId], async () => {
    expect(await rows(tenant, "SELECT 1 FROM items WHERE id = $1 AND database_id = $2", [itemId, databaseId])).toEqual(
      [],
    );
  });
}

let journalDaysSeeded = 0;

const cases: Record<string, TaskCase> = {
  [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const heartbeatId = await createRetrySweepHeartbeat(tenant);
      await inTenant(tenant, () => recordHeartbeatFailure(pool, heartbeatId, "previous failure"));
      const run = await inTenant(tenant, () =>
        createAgentRun(pool, { triggeredBy: "user", task: "fire the heartbeat", userId: tenant.userId }),
      );
      return { heartbeatId, triggeredByRunId: run.id };
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT last_error FROM project_heartbeats WHERE id = $1", [
          requirePayloadString(payload, "heartbeatId"),
        ]),
      ).toEqual([{ last_error: null }]);
    },
  },
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const fixture = await createRollupFixture(tenant);
      return { ...fixture, itemId: fixture.projectId };
    },
    async expectDone(tenant, payload) {
      await expectRollupCount(
        tenant,
        requirePayloadString(payload, "projectsId"),
        requirePayloadString(payload, "projectId"),
      );
    },
  },
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: {
    tenancy: "tenant",
    async seed(tenant) {
      return { ...(await createRollupFixture(tenant)) };
    },
    async expectDone(tenant, payload) {
      await expectRollupCount(
        tenant,
        requirePayloadString(payload, "projectsId"),
        requirePayloadString(payload, "projectId"),
      );
    },
  },
  [CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const database = await chokePoint.createDatabase({ name: `Scores ${randomUUID()}` });
        const property = await chokePoint.createProperty({
          databaseId: database.id,
          key: "score",
          name: "Score",
          type: "text",
        });
        const good = await chokePoint.createItem({ databaseId: database.id, properties: { score: "42" } });
        await chokePoint.createItem({ databaseId: database.id, properties: { score: "not a number" } });
        await chokePoint.changePropertyType(property.id, "number");
        return { propertyId: property.id, fromType: "text", databaseId: database.id, goodItemId: good.id };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT migration_status FROM properties WHERE id = $1", [
          requirePayloadString(payload, "propertyId"),
        ]),
      ).toEqual([{ migration_status: "partial" }]);
      const good = await inTenant(tenant, () =>
        chokePoint.getItem(requirePayloadString(payload, "databaseId"), requirePayloadString(payload, "goodItemId")),
      );
      expect(good?.properties.score).toBe(42);
    },
  },
  // A placeholder handler (worker.ts) that reads no payload and writes nothing yet.
  [CORE_TASK_NAMES.DOC_HISTORY_SQUASH]: {
    tenancy: "tenant",
    async seed() {
      return {};
    },
    async expectDone() {},
  },
  [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS]: {
    tenancy: "tenant",
    async seed(tenant) {
      const { databaseId, itemId } = await createItemWithAutomation(tenant);
      return { itemId, databaseId, config: { source: "test", coverKey: "cover" } };
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT status FROM item_automation WHERE item_id = $1", [
          requirePayloadString(payload, "itemId"),
        ]),
      ).toEqual([{ status: "done" }]);
    },
  },
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: {
    tenancy: "tenant",
    async seed(tenant) {
      return { mailboxItemId: await createMailbox(tenant) };
    },
    expectedError: /^No IMAP adapter configured for this composition root$/,
    async expectDone(tenant, payload) {
      const mailboxItemId = requirePayloadString(payload, "mailboxItemId");
      expect(
        await rows(tenant, "SELECT last_error FROM mail_account_sync_state WHERE item_id = $1", [mailboxItemId]),
      ).toEqual([{ last_error: "No IMAP adapter configured for this composition root" }]);
      expect(
        await rows(tenant, "SELECT user_id FROM notifications WHERE kind = 'mail_sync_error' AND source_id = $1", [
          mailboxItemId,
        ]),
      ).toEqual([{ user_id: tenant.userId }]);
    },
  },
  [CORE_TASK_NAMES.MAIL_LEGACY_EMAIL_MIGRATION]: {
    tenancy: "tenant",
    async seed(tenant) {
      const { emailsDatabaseId, itemId } = await createEmail(tenant);
      return { emailsDatabaseId, itemId };
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT migration_status FROM mail_message_meta WHERE item_id = $1", [
          requirePayloadString(payload, "itemId"),
        ]),
      ).toEqual([{ migration_status: "partial" }]);
    },
  },
  [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const journalId = await requireModuleDatabaseId(tenant, JOURNAL_MODULE_ID);
      // A day of its own per seed, so the computed list cannot predate this case.
      const referenceDate = new Date(Date.UTC(2000, 0, 1 + journalDaysSeeded++));
      const day = await inTenant(tenant, () =>
        withTransaction(pool, (client) =>
          getOrCreateJournalItem(client, journalId, "day", referenceDate, "Europe/Prague"),
        ),
      );
      return { journalDayItemId: day.id };
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT computed -> 'inboxItems' AS inbox_items FROM items WHERE id = $1", [
          requirePayloadString(payload, "journalDayItemId"),
        ]),
      ).toEqual([{ inbox_items: [] }]);
    },
  },
  [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const run = await createAgentRun(pool, { triggeredBy: "user", task: "approve", userId: tenant.userId });
        const request = await createPendingApprovalRequest(pool, {
          agentRunId: run.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        await withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: request.id,
            decision: "approved",
            decidedByUserId: tenant.userId,
          }),
        );
        return { approvalRequestId: request.id };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT execution_status FROM approval_requests WHERE id = $1", [
          requirePayloadString(payload, "approvalRequestId"),
        ]),
      ).toEqual([{ execution_status: "conflict" }]);
    },
  },
  [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        await upsertWebPushSubscription(pool, {
          userId: tenant.userId,
          sessionId: null,
          endpoint: `https://push.example/${randomUUID()}`,
          p256dh: "k",
          authSecret: "s",
        });
        const notificationId = await withTransaction(pool, (client) =>
          writeNotification(client, {
            userId: tenant.userId,
            kind: "heartbeat_error",
            titleParams: { name: "Daily digest" },
            linkHref: null,
            sourceTable: "project_heartbeats",
            sourceId: randomUUID(),
            transitionInstance: randomUUID(),
          }),
        );
        return { notificationId };
      });
    },
    async expectDone(tenant, payload) {
      const deliveries = await rows<{ settled: boolean }>(
        tenant,
        `SELECT (delivered_at IS NOT NULL OR failed_permanently_at IS NOT NULL) AS settled
           FROM push_deliveries WHERE notification_id = $1`,
        [requirePayloadString(payload, "notificationId")],
      );
      expect(deliveries).toEqual([{ settled: true }]);
    },
  },
  [CORE_TASK_NAMES.TENANT_EXPORT]: {
    tenancy: "tenant",
    async seed(tenant) {
      const requested = await inTenant(tenant, () =>
        withTransaction(pool, (client) => requestTenantExport(client, tenant.userId)),
      );
      return { exportId: requested.export.id };
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT status FROM tenant_exports WHERE id = $1", [
          requirePayloadString(payload, "exportId"),
        ]),
      ).toEqual([{ status: "ready" }]);
    },
  },

  [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const heartbeatId = await createRetrySweepHeartbeat(tenant);
      // `createHeartbeat` schedules the next fire in the future; no production writer makes it due now.
      await inTenant(tenant, () =>
        pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
          heartbeatId,
        ]),
      );
      return marked([heartbeatId], async () => {
        expect(
          await rows(tenant, "SELECT status FROM heartbeat_occurrences WHERE heartbeat_id = $1", [heartbeatId]),
        ).toEqual([{ status: "succeeded" }]);
      });
    },
  },
  [CORE_TASK_NAMES.DOC_COMPACTION_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const docId = await inTenant(tenant, async () => {
        const database = await chokePoint.createDatabase({ name: `Docs ${randomUUID()}` });
        const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
        // Exactly the threshold: a read would compact on its own, so nothing reads the doc before the sweep.
        for (let i = 0; i < DEFAULT_COMPACTION_THRESHOLD; i++) {
          await docStore.putBlock(item.id, { id: `b${i}`, flavour: "paragraph" }, "user");
        }
        const found = await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [item.id]);
        const doc = found.rows[0];
        if (!doc) throw new Error("expected the item to have a doc");
        return doc.id;
      });
      return marked([docId], async () => {
        expect(await rows(tenant, "SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1", [docId])).toEqual(
          [{ count: 0 }],
        );
        expect(await rows(tenant, "SELECT 1 AS present FROM doc_snapshots WHERE doc_id = $1", [docId])).toEqual([
          { present: 1 },
        ]);
      });
    },
  },
  [CORE_TASK_NAMES.DOC_HISTORY_CLEANUP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const docId = await inTenant(tenant, async () => {
        const database = await chokePoint.createDatabase({ name: `History ${randomUUID()}` });
        const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
        await docStore.putBlock(item.id, { id: "root", flavour: "page" }, "user");
        const found = await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [item.id]);
        const doc = found.rows[0];
        if (!doc) throw new Error("expected the item to have a doc");
        // History only ages in real time; no production writer moves its baseline into the past.
        await pool.query("UPDATE docs SET history_available_from = now() - interval '40 days' WHERE id = $1", [doc.id]);
        await pool.query(
          `UPDATE doc_snapshot_history SET represented_at = now() - interval '40 days'
            WHERE doc_id = $1 AND through_update_id = 0`,
          [doc.id],
        );
        return doc.id;
      });
      return marked([docId], async () => {
        expect(
          await rows(
            tenant,
            "SELECT history_available_from > now() - interval '39 days' AS rebaselined FROM docs WHERE id = $1",
            [docId],
          ),
        ).toEqual([{ rebaselined: true }]);
      });
    },
  },
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant);
      // The sweep enqueues the mailbox's sync in its tenant; that sync fails for want of a transport.
      return marked([mailboxItemId], async () => {
        expect(
          await rows(tenant, "SELECT last_error FROM mail_account_sync_state WHERE item_id = $1", [mailboxItemId]),
        ).toEqual([{ last_error: "No IMAP adapter configured for this composition root" }]);
      });
    },
  },
  [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const { itemId } = await createEmail(tenant);
      // The sweep exists for an Emails item written past the standard indexing path; this produces one.
      await inTenant(tenant, () => pool.query("DELETE FROM item_search_index WHERE item_id = $1", [itemId]));
      return marked([itemId], async () => {
        expect(await rows(tenant, "SELECT 1 AS present FROM item_search_index WHERE item_id = $1", [itemId])).toEqual([
          { present: 1 },
        ]);
      });
    },
  },
  [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    seed: createExpiredTrash,
  },
  [CORE_TASK_NAMES.TRASH_PURGE]: {
    tenancy: "system",
    touchesTenantTables: true,
    seed: createExpiredTrash,
  },
  [CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      // A syncable mailbox whose sync process never beat is stale.
      const mailboxItemId = await createMailbox(tenant);
      return marked([mailboxItemId], async () => {
        expect(
          await rows(tenant, "SELECT status FROM tenant_observability_checks WHERE check_key = $1", [
            `process:mailsync:${mailboxItemId}`,
          ]),
        ).toEqual([{ status: "alerting" }]);
        expect(
          await rows(
            tenant,
            "SELECT user_id FROM notifications WHERE kind = 'mail_sync_stalled' AND source_id IN (SELECT id::text FROM tenant_observability_checks WHERE check_key = $1)",
            [`process:mailsync:${mailboxItemId}`],
          ),
        ).toEqual([{ user_id: tenant.userId }]);
      });
    },
  },
  [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const projectItemId = await seededSemprecProjectItemId(tenant);
      const runId = await inTenant(tenant, async () => {
        const minted = await withTransaction(pool, (client) =>
          mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId: tenant.userId }),
        );
        // A credential only expires in real time; no production writer backdates it.
        await pool.query(
          "UPDATE agent_run_mcp_credentials SET expires_at = now() - interval '1 minute' WHERE agent_run_id = $1",
          [minted.run.id],
        );
        return minted.run.id;
      });
      return marked([runId], async () => {
        expect(await rows(tenant, "SELECT status FROM agent_runs WHERE id = $1", [runId])).toEqual([
          { status: "done" },
        ]);
      });
    },
  },
  [CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const { runId, messageId } = await inTenant(tenant, async () => {
        const run = await createAgentRun(pool, {
          userId: tenant.userId,
          triggeredBy: "user",
          unit: "session",
          task: "chat",
        });
        const message = await insertAgentRunEvent(pool, run.id, "message", {});
        await insertAgentRunEvent(pool, run.id, "compaction", { kind: "compaction" });
        // Events only age in real time; no production writer backdates them.
        await pool.query("UPDATE agent_run_events SET at = now() - interval '40 days' WHERE agent_run_id = $1", [
          run.id,
        ]);
        await finishAgentRun(pool, run.id, "done", null);
        return { runId: run.id, messageId: message.id };
      });
      return marked([runId], async () => {
        expect(
          await rows(tenant, "SELECT 1 FROM agent_run_events WHERE agent_run_id = $1 AND id = $2", [runId, messageId]),
        ).toEqual([]);
        expect(
          await rows(tenant, "SELECT kind FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'", [
            runId,
          ]),
        ).toEqual([{ kind: "compaction" }]);
      });
    },
  },
  [CORE_TASK_NAMES.TENANT_EXPORT_EXPIRY_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const exportId = await createReadyExport(tenant);
      // An export only expires in real time; no production writer backdates it.
      await adminPool.query(
        `UPDATE tenant_exports
            SET created_at = created_at - interval '8 days',
                completed_at = completed_at - interval '8 days',
                expires_at = expires_at - interval '8 days'
          WHERE id = $1`,
        [exportId],
      );
      return marked([exportId], async () => {
        expect(await rows(tenant, "SELECT 1 FROM tenant_exports WHERE id = $1", [exportId])).toEqual([]);
      });
    },
  },
  [CORE_TASK_NAMES.TENANT_PURGE]: {
    tenancy: "system",
    touchesTenantTables: true,
    // The work is erasing a tenant, so it is due in two tenants of its own; A and B stay bystanders.
    async tenants() {
      return [
        await buildTenant(await createTestTenant(adminPool)),
        await buildTenant(await createTestTenant(adminPool)),
      ];
    },
    async seed(tenant) {
      await inTenant(tenant, () => withTransaction(pool, (client) => beginTenantDeletion(client, tenant.tenantId)));
      return marked([tenant.tenantId], async () => {
        const remaining = Object.entries(await fingerprint(tenant)).filter(([, table]) => table.count > 0);
        expect(remaining).toEqual([]);
        // `tenants` and the `tenant_deletions` tombstone are global tables, outside every fingerprint; read them as admin.
        const { rows: tenantRows } = await adminPool.query<{ present: number }>(
          "SELECT 1 AS present FROM tenants WHERE id = $1",
          [tenant.tenantId],
        );
        expect(tenantRows).toEqual([]);
        const { rows: tombstones } = await adminPool.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM tenant_deletions WHERE tenant_id = $1",
          [tenant.tenantId],
        );
        expect(tombstones).toEqual([{ tenant_id: tenant.tenantId }]);
      });
    },
  },
  [CORE_TASK_NAMES.CREDENTIAL_REENCRYPT_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const seeded = [randomUUID(), randomUUID()].map((itemId) => ({ itemId, plaintext: `secret-${randomUUID()}` }));
      await inTenant(tenant, async () => {
        for (const { itemId, plaintext } of seeded) {
          const sealed = await encryptSecret(plaintext, resolveMasterKeyFromEnv(1));
          // Raw SQL: since #1060 no writer produces a `master` row; the previous release's insert omits `scheme`.
          await pool.query(
            "INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, key_version) VALUES ($1, 'api_key', $2, $3, 1)",
            [itemId, sealed.ciphertext, sealed.nonce],
          );
        }
      });
      return marked(
        seeded.map((s) => s.itemId),
        async () => {
          const keys = await rows<{
            tenant_id: string;
            wrapped_key: Buffer;
            wrap_nonce: Buffer;
            master_key_version: number;
          }>(tenant, "SELECT tenant_id, wrapped_key, wrap_nonce, master_key_version FROM tenant_keys");
          const key = keys[0];
          if (!key || keys.length !== 1) throw new Error("expected exactly one tenant key");
          expect(key.tenant_id).toBe(tenant.tenantId);
          const dataKey = await unwrapDataKey(
            { ciphertext: key.wrapped_key, nonce: key.wrap_nonce },
            resolveMasterKeyFromEnv(key.master_key_version),
            tenant.tenantId,
          );
          for (const { itemId, plaintext } of seeded) {
            const found = await rows<{ tenant_id: string; scheme: string; ciphertext: Buffer; nonce: Buffer }>(
              tenant,
              "SELECT tenant_id, scheme, ciphertext, nonce FROM external_credentials WHERE item_id = $1",
              [itemId],
            );
            const row = found[0];
            if (!row || found.length !== 1) throw new Error(`expected credential ${itemId} in its tenant`);
            expect({ tenantId: row.tenant_id, scheme: row.scheme }).toEqual({
              tenantId: tenant.tenantId,
              scheme: "tenant",
            });
            // Sealed under this tenant's own key and bound to `tenant_id‖item_id`, the documented associated data.
            const opened = await openSecret(
              { ciphertext: row.ciphertext, nonce: row.nonce },
              dataKey,
              Buffer.from(`semprec:external-credential:v1:${tenant.tenantId}:${itemId}`, "utf8"),
            );
            expect(opened.toString("utf8")).toBe(plaintext);
          }
        },
      );
    },
  },
  [CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE]: {
    tenancy: "system",
    touchesTenantTables: false,
    async seed() {
      const identifier = "tenantIsolationFailingProbe";
      const jobKey = randomUUID();
      const failingTaskList: TaskList = {
        [identifier]: registerTask(identifier, async () => {
          throw new Error("probe failure");
        }),
      };
      // A probe outside the task catalogs counts as a tenant task, so it is enqueued in A; it touches no table.
      await runInTenant(tenantA.tenantId, () => enqueueJob(pool, identifier, {}, { jobKey, maxAttempts: 1 }));
      await runOnce({ pgPool: pool }, failingTaskList);
      expect(await jobOutcome(jobKey)).toEqual({ attempts: 1, lastError: "probe failure" });
      // graphile-worker 0.17.3 has no public way to age a failed job past the prune's 7-day retention.
      const aged = await adminPool.query(
        "UPDATE graphile_worker._private_jobs SET updated_at = now() - interval '8 days' WHERE key = $1",
        [jobKey],
      );
      expect(aged.rowCount).toBe(1);
      return async () => {
        expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
      };
    },
  },
};

function isTenantCase(c: TaskCase): c is TenantTaskCase {
  return c.tenancy === "tenant";
}

function isSystemCase(c: TaskCase): c is SystemTaskCase {
  return c.tenancy === "system" && c.touchesTenantTables;
}

function isGlobalSystemCase(c: TaskCase): c is GlobalSystemTaskCase {
  return c.tenancy === "system" && !c.touchesTenantTables;
}

function casesWhere<T extends TaskCase>(guard: (c: TaskCase) => c is T): Array<[string, T]> {
  return Object.entries(cases).flatMap(([name, c]): Array<[string, T]> => (guard(c) ? [[name, c]] : []));
}

const ENV_OVERRIDES = ["AI_GATEWAY_INTERNAL_TOKEN", "FILES_STORAGE_DIR", "MAIL_ATTACHMENTS_DIR"] as const;

describe("background task isolation across two tenants: api runtime (issue #1056)", () => {
  beforeAll(async () => {
    previousScope = process.env.SEMPREC_TENANT_SCOPE;
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    for (const name of ENV_OVERRIDES) previousEnv.set(name, process.env[name]);
    blobRoot = await mkdtemp(join(tmpdir(), "semprec-api-isolation-"));
    // `createApiActionRegistry` refuses to build without a gateway token; the blob roots default from the env.
    process.env.AI_GATEWAY_INTERNAL_TOKEN = randomUUID();
    process.env.FILES_STORAGE_DIR = join(blobRoot, "files");
    process.env.MAIL_ATTACHMENTS_DIR = join(blobRoot, "mail");

    adminPool = getTestPool();
    await resetDatabase(adminPool);
    await ensureQueueSchema(adminPool);
    await grantQueueSchemaPrivileges(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    tenantTables = await loadTenantTables();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);

    // Composed exactly as createApiQueueRuntime composes it.
    const actionRegistry = createApiActionRegistry(pool, moduleRegistry);
    const coreTaskList = createApiCoreTaskList(
      pool,
      actionRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      moduleRegistry,
      undefined,
      replayApprovedGenericOperation,
    );
    taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "api");
    assertTaskListMatchesAffinity(taskList, (await resolveTaskAffinitySets(moduleRegistry)).api, "api");

    tenantZero = await buildTenant(getTenantZeroId());
    tenantA = await buildTenant(await createTestTenant(adminPool));
    tenantB = await buildTenant(await createTestTenant(adminPool));
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (blobRoot !== undefined) await rm(blobRoot, { recursive: true, force: true });
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = previousScope;
  });

  it("has exactly one case per task of the api affinity set", async () => {
    const set = (await resolveTaskAffinitySets(await loadFullModuleRegistry())).api;
    const withoutCase = [...set].filter((name) => !Object.hasOwn(cases, name)).sort();
    const outsideSet = Object.keys(cases)
      .filter((name) => !set.has(name))
      .sort();
    expect({ withoutCase, outsideSet }).toEqual({ withoutCase: [], outsideSet: [] });
  });

  it.each(Object.keys(cases))("%s: its case matches the task's declared tenancy", (name) => {
    expect(cases[name]?.tenancy).toBe(tenancyOf(name));
  });

  describe("tenant tasks", () => {
    const tenantCases = casesWhere(isTenantCase);

    it.each(tenantCases)(
      "%s (a): a job of A naming A's rows runs and changes nothing of B or tenant zero",
      async (name, c) => {
        const payload = await c.seed(tenantA);
        await discardQueuedJobs();
        const beforeB = await fingerprint(tenantB);
        const beforeZero = await fingerprint(tenantZero);
        const notificationsBefore = await notifications(tenantA);

        const jobKey = await runJobIn(tenantA, name, payload);

        const outcome = await jobOutcome(jobKey);
        await removeJob(jobKey);
        if (c.expectedError) {
          expect(outcome.lastError).toMatch(c.expectedError);
        } else {
          expect(outcome).toEqual({ attempts: null, lastError: null });
        }
        await c.expectDone(tenantA, payload);
        expect(await fingerprint(tenantB)).toEqual(beforeB);
        expect(await fingerprint(tenantZero)).toEqual(beforeZero);
        await expectNewNotificationsAddressedTo(tenantA, notificationsBefore);
      },
    );

    it.each(tenantCases)(
      "%s (b): a job of B naming A's rows ends, and adds to B, like one naming random ids, and leaves A unchanged",
      async (name, c) => {
        const payload = await c.seed(tenantA);
        await discardQueuedJobs();
        const beforeA = await fingerprint(tenantA);

        const foreign = await runInBObserved(name, payload);
        const random = await runInBObserved(name, randomizedPayload(payload));

        expect(foreign).toEqual(random);
        expect(await fingerprint(tenantA)).toEqual(beforeA);
      },
    );
  });

  describe("system tasks", () => {
    it.each(casesWhere(isSystemCase))(
      "%s: with work due in two tenants, one run does each tenant's work in that tenant only",
      async (name, c) => {
        await discardQueuedJobs();
        const [first, second] = c.tenants ? await c.tenants() : [tenantA, tenantB];
        const firstWork = await c.seed(first);
        const secondWork = await c.seed(second);
        const bystanders = [tenantZero, tenantA, tenantB].filter((tenant) => tenant !== first && tenant !== second);
        const bystandersBefore = await Promise.all(bystanders.map((tenant) => fingerprint(tenant)));
        const firstNotificationsBefore = await notifications(first);
        const secondNotificationsBefore = await notifications(second);

        const jobKey = await runSystemJob(name);

        expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
        await firstWork.check();
        await secondWork.check();
        // Each tenant's results stay in it: no row of the other working tenant names its seeded ids.
        expect(await tablesMentioning(second, firstWork.markers)).toEqual([]);
        expect(await tablesMentioning(first, secondWork.markers)).toEqual([]);
        expect(await Promise.all(bystanders.map((tenant) => fingerprint(tenant)))).toEqual(bystandersBefore);
        await expectNewNotificationsAddressedTo(first, firstNotificationsBefore);
        await expectNewNotificationsAddressedTo(second, secondNotificationsBefore);
      },
    );

    it.each(casesWhere(isGlobalSystemCase))(
      "%s: a run touching no tenant table leaves A, B and tenant zero unchanged",
      async (name, c) => {
        await discardQueuedJobs();
        const check = await c.seed();
        const tenants = [tenantA, tenantB, tenantZero];
        const before = await Promise.all(tenants.map((tenant) => fingerprint(tenant)));

        const jobKey = await runSystemJob(name);

        expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
        await check();
        expect(await Promise.all(tenants.map((tenant) => fingerprint(tenant)))).toEqual(before);
      },
    );
  });
});
