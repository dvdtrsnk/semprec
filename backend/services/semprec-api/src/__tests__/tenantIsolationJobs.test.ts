import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { escapeIdentifier, type Pool } from "pg";
import * as Y from "yjs";
import { z } from "zod";
import { replayApprovedGenericOperation } from "@semprec/application";
import { REALTIME_CHANNEL, wireRealtimeHooks } from "@semprec/realtime";
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
import {
  currentTenantScope,
  runAsSystem,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
} from "@semprec/shared";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  JOURNAL_MODULE_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
  assertTaskListMatchesAffinity,
  beginTenantDeletion,
  claimSempMessage,
  createAgentRun,
  createApiCoreTaskList,
  createChokePoint,
  createDocStore,
  createHeartbeat,
  createItemWithClient,
  createPendingApprovalRequest,
  createRelationWithClient,
  createTaskHostEventPutRouteHandler,
  createUser,
  decideAndEnqueueApprovalRequest,
  ensureItemAutomation,
  finishAgentRun,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  getOrCreateJournalItem,
  getSystemTimezone,
  insertAgentRunEvent,
  instantToWallClock,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  mergeModuleTaskListForAffinity,
  mintMcpRunCredential,
  mutateYDoc,
  provisionTenant,
  removeMailbox,
  resolveMailModuleIds,
  recordHeartbeatFailure,
  requestTenantExport,
  resolveTaskAffinitySets,
  revokeAllPushSubscriptionsForUser,
  sendSempMessage,
  setEventInvitationDelivery,
  setInvalidationHook,
  setThreadProjectTriageRuntime,
  setThreadTaskPeopleDelivery,
  startSempMessageTurn,
  SYSTEM_WRITER,
  upsertApnsSubscription,
  upsertWebPushSubscription,
  withTransaction,
  writeNotification,
  type ChokePoint,
  type DocStore,
  type BlobStorageWriter,
  type InvalidationEvent,
  type MailTransportFactory,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  createThreadTask,
  ensureFolderItem,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
  storeCredential,
  upsertMailMessageMeta,
  writePageTextBlocks,
} from "@semprec/data/testSupport";
import { createApiActionRegistry } from "../actionRegistryComposition.js";
import { createMailSyncAdapters } from "../mailSyncAdapters.js";
import { runTranscriptionFixture } from "./transcriptionHttpFixture.js";

/** What the spy on the APNs background send recorded: the device token and the data of one silent push. */
interface RecordedBackgroundPush {
  deviceToken: string;
  data: unknown;
}

const backgroundPushes = vi.hoisted(() => ({ sent: [] as RecordedBackgroundPush[] }));

// Passthrough spy on the APNs background send the `sleep.resync` and `remindersResync` tasks call by default: a call still reaches the
// real adapter, which answers `not-configured` without a network request while no APNs configuration is set, so
// the job's own wiring runs and the case observes which registration each run sent to. The path is the module
// the task imports (`packages/data/src/push/apnsAdapter.ts`), given as a string because this package may not
// import another package's source.
vi.mock("../../../../packages/data/src/push/apnsAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<{
    sendApnsBackgroundPush(target: { deviceToken: string }, data: Record<string, unknown>): Promise<unknown>;
  }>();
  return {
    ...actual,
    async sendApnsBackgroundPush(target: { deviceToken: string }, data: Record<string, unknown>) {
      backgroundPushes.sent.push({ deviceToken: target.deviceToken, data });
      return actual.sendApnsBackgroundPush(target, data);
    },
  };
});

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
const VAPID_ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const APNS_ENV = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY_PATH", "APNS_TOPIC"] as const;
let tenantA: Tenant;
let tenantB: Tenant;
let tenantZero: Tenant;
const titlePortCalls: { tenantId: string | null; input: AiGatewayCompletionInput }[] = [];
const titlePort: AiGatewayClientPort = {
  async complete(input) {
    const scope = currentTenantScope();
    titlePortCalls.push({ tenantId: scope?.kind === "tenant" ? scope.tenantId : null, input });
    return { content: { title: "Tenant title" }, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

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

/** Sets a VAPID configuration with a freshly generated key pair; `restoreVapidConfiguration` puts the previous one back. */
function useVapidConfiguration(): void {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  process.env.VAPID_PUBLIC_KEY = keys.getPublicKey().toString("base64url");
  process.env.VAPID_PRIVATE_KEY = keys.getPrivateKey().toString("base64url");
  process.env.VAPID_SUBJECT = "mailto:ops@example.test";
}

/** Unsets the APNs configuration, so the default APNs sender answers `not-configured` without a network request; `restoreApnsConfiguration` puts the previous one back. */
function useUnconfiguredApns(): void {
  for (const name of APNS_ENV) delete process.env[name];
}

function restoreApnsConfiguration(): void {
  for (const name of APNS_ENV) {
    const value = previousEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function restoreVapidConfiguration(): void {
  for (const name of VAPID_ENV) {
    const value = previousEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Whether the newest of `tenant`'s user's loopback Web Push registrations, the one `pushDismiss`'s case seeds, is revoked. */
async function pushRegistrationRevoked(tenant: Tenant): Promise<boolean> {
  const found = await rows<{ revoked: boolean }>(
    tenant,
    `SELECT revoked_at IS NOT NULL AS revoked FROM push_subscriptions
     WHERE user_id = $1 AND endpoint LIKE 'https://127.0.0.1:9/%' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenant.userId],
  );
  if (found.length !== 1) throw new Error("expected a loopback push registration");
  return found[0]?.revoked === true;
}

async function requireModuleDatabaseId(tenant: Tenant, moduleId: string): Promise<string> {
  const database = await inTenant(tenant, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`expected the ${moduleId} database to be seeded`);
  return database.id;
}

/**
 * Switches `muteSemp` of `tenant`'s sleep settings off. The fanout job reads the real clock, and with the
 * mute on a run at night would hold the push until the wake time instead of delivering it (issue #1794).
 */
async function switchSleepMuteOff(tenant: Tenant): Promise<void> {
  const databaseId = await requireModuleDatabaseId(tenant, "sleepSettings");
  await inTenant(tenant, async () => {
    const { items } = await chokePoint.listItems(databaseId, { limit: 2 });
    const settings = items[0];
    if (!settings || items.length !== 1) throw new Error("expected exactly one seeded sleep settings item");
    await chokePoint.updateItem({ databaseId, itemId: settings.id, propertiesPatch: { muteSemp: false } });
  });
}

async function seededSemprecProjectItemId(tenant: Tenant): Promise<string> {
  const found = await rows<{ id: string }>(tenant, "SELECT id FROM items WHERE properties ->> 'name' = 'Semprec'");
  const row = found[0];
  if (!row || found.length !== 1) throw new Error("expected exactly one seeded Semprec project item");
  return row.id;
}

async function createMailbox(tenant: Tenant, syncMode: "imap" | "gmail_api" = "imap"): Promise<string> {
  const mailboxesId = await requireModuleDatabaseId(tenant, "mailboxes");
  return inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: `Mailbox ${randomUUID()}`, provider: "generic" },
      });
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: syncMode === "gmail_api" ? "oauth2_refresh_token" : "app_password",
        plaintext: "s3cr3t",
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode });
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
        actionConfig: { databaseId: database.id, source: "tmdb", coverKey: "cover" },
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
/**
 * A person of `tenant` linked to an Event dated `date` (and starting at `timeFrom`, when given) through
 * `Events.people`, through the choke point. The link queues the person's `lastContact` recompute; it is
 * removed here, so only the job under test can set the value.
 */
async function createPersonWithEvent(
  tenant: Tenant,
  date: string,
  timeFrom?: string,
): Promise<{ personId: string; eventId: string }> {
  const peopleId = await requireModuleDatabaseId(tenant, "people");
  const eventsId = await requireModuleDatabaseId(tenant, "events");
  return inTenant(tenant, async () => {
    const person = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Contact" } });
    const event = await chokePoint.createItem({
      databaseId: eventsId,
      properties: { name: "Meeting", date, ...(timeFrom === undefined ? {} : { timeFrom }) },
    });
    const peopleProperty = (await chokePoint.listProperties(eventsId)).find((property) => property.key === "people");
    if (!peopleProperty) throw new Error("expected Events.people to be seeded");
    await chokePoint.createRelation({
      relationPropertyId: peopleProperty.id,
      callerItemId: event.id,
      targetItemId: person.id,
    });
    await removeJob(`people-last-contact:${person.id}`);
    return { personId: person.id, eventId: event.id };
  });
}

async function lastContactOf(tenant: Tenant, personId: string): Promise<unknown> {
  const found = await rows<{ last_contact: unknown }>(
    tenant,
    "SELECT properties -> 'lastContact' AS last_contact FROM items WHERE id = $1",
    [personId],
  );
  return found[0]?.last_contact;
}

async function hiddenUntilOf(tenant: Tenant, taskId: string): Promise<unknown> {
  const found = await rows<{ hidden_until: unknown }>(
    tenant,
    "SELECT properties -> 'hiddenUntil' AS hidden_until FROM items WHERE id = $1",
    [taskId],
  );
  if (found.length !== 1) throw new Error("expected the task to exist");
  return found[0]?.hidden_until ?? null;
}

/** A date with a fixed past value, so the case does not depend on the wall clock. */
const PAST_EVENT_DATE = "2025-06-15";

/** A realtime invalidation with the tenant scope its hook was called in; `null` outside a tenant scope. */
interface RecordedInvalidation {
  tenantId: string | null;
  event: InvalidationEvent;
}

let recordedInvalidations: RecordedInvalidation[] = [];

/**
 * Records every realtime invalidation announced from now on, through the in-process hook `wireRealtimeHooks`
 * publishes as NOTIFYs. A job that only announces changes no row, so its effect shows nowhere else.
 */
function recordInvalidations(): void {
  const recorded: RecordedInvalidation[] = [];
  recordedInvalidations = recorded;
  setInvalidationHook((event) => {
    const scope = currentTenantScope();
    recorded.push({ tenantId: scope?.kind === "tenant" ? scope.tenantId : null, event });
  });
}

/** Removes the recording hook and returns what it recorded. */
function stopRecordingInvalidations(): RecordedInvalidation[] {
  setInvalidationHook(() => {});
  return recordedInvalidations;
}

/** A project of `tenant` with one task linked to it through `Tasks.project`, through the choke point. */
async function createProjectWithTask(tenant: Tenant): Promise<string> {
  const projectsId = await requireModuleDatabaseId(tenant, "projects");
  const tasksId = await requireModuleDatabaseId(tenant, "tasks");
  return inTenant(tenant, async () => {
    const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Project" } });
    const task = await chokePoint.createItem({ databaseId: tasksId, properties: { name: "Project task" } });
    const projectProperty = (await chokePoint.listProperties(tasksId)).find((property) => property.key === "project");
    if (!projectProperty) throw new Error("expected Tasks.project to be seeded");
    await chokePoint.createRelation({
      relationPropertyId: projectProperty.id,
      callerItemId: task.id,
      targetItemId: project.id,
    });
    return project.id;
  });
}

/**
 * A task hidden in an Event, through the choke point, and then the Event moved into the past: the stored `hiddenUntil`
 * is what a task holds when the end of its Event passes (issue #1782). The move is written directly because the
 * choke point recomputes the task at once, and nothing but the clock reveals it in production.
 */
async function createTaskHiddenInPassedEvent(tenant: Tenant): Promise<string> {
  const eventsId = await requireModuleDatabaseId(tenant, "events");
  const tasksId = await requireModuleDatabaseId(tenant, "tasks");
  return inTenant(tenant, async () => {
    const hostEvent = await chokePoint.createItem({
      databaseId: eventsId,
      properties: { name: "Workshop", date: "2099-01-01" },
    });
    const task = await chokePoint.createItem({ databaseId: tasksId, properties: { name: "Prepare the workshop" } });
    await createTaskHostEventPutRouteHandler(pool)({
      params: { id: task.id, eventId: hostEvent.id },
      body: {},
      identity: { user: { id: tenant.userId } },
    });
    await pool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
      hostEvent.id,
      JSON.stringify({ date: PAST_EVENT_DATE }),
    ]);
    return task.id;
  });
}

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

/** The queue name of the calendar module's invitation task (`calendarModuleManifest.ts`). */
const CALENDAR_SEND_EVENT_INVITATION_TASK = "calendarSendEventInvitation";

/** One message the recording transport was asked to send, with the tenant scope the send ran in. */
interface InvitationSend {
  tenantId: string | null;
  mailboxId: string;
  method: string | null;
  from: string;
  recipients: string[];
}

const invitationSends: InvitationSend[] = [];

/**
 * The transports `createApiQueueRuntime` binds for the invitation task, replaced by one that sends nothing and
 * records each message with the mailbox it was asked for and the tenant scope of the job that sent it.
 */
const invitationTransports: MailTransportFactory = {
  async forMailbox(mailboxId) {
    return {
      async send(message) {
        const scope = currentTenantScope();
        invitationSends.push({
          tenantId: scope?.kind === "tenant" ? scope.tenantId : null,
          mailboxId,
          method: /^Content-Type: text\/calendar; method=(\w+)/im.exec(message.raw.toString("utf8"))?.[1] ?? null,
          from: message.envelope.from,
          recipients: message.envelope.recipients,
        });
        return {};
      },
    };
  },
};

/** The task each seeded person of the thread task people case is to be added to, by person id. */
const threadTaskPeopleTasks = new Map<string, string>();

/** The queue name of the mail module's thread task people task (`mailModuleManifest.ts`, issue gh-1923). */
const MAIL_SYNC_THREAD_TASK_PEOPLE_TASK = "mailSyncThreadTaskPeople";

/**
 * A mail thread with one message and a task made from it, in `tenant`, and a person who is then linked to the message
 * as its sender, which is the change the task's people have not followed yet. Returns the thread's Threads item, the
 * person and the task.
 */
async function seedThreadTaskWithNewPerson(
  tenant: Tenant,
): Promise<{ threadItemId: string; personId: string; taskId: string }> {
  const mailboxItemId = await createMailbox(tenant);
  const peopleDatabaseId = await requireModuleDatabaseId(tenant, "people");
  return inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const propertyId = async (databaseId: string, key: string): Promise<string> => {
        const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
        if (!property) throw new Error(`expected the ${key} property to be seeded`);
        return property.id;
      };
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId,
        mailboxRelationPropertyId: await propertyId(ids.foldersDatabaseId, "mailbox"),
        providerId: "INBOX",
        name: "Inbox",
        behavior: "folder",
        specialPurpose: "inbox",
      });
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
        attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
        folderItemId,
        mailboxItemId,
        messageId: `<${randomUUID()}@example.test>`,
        envelope: { from: { address: "sender@example.test" } },
        attachments: [],
        storage: new LocalFsBlobStorageWriter(join(blobRoot, "mail")),
        storageKeyPrefix: mailboxItemId,
      });
      const thread = await client.query<{ item_id: string }>(
        `SELECT t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1`,
        [ingested.itemId],
      );
      const threadItemId = thread.rows[0]?.item_id;
      if (!threadItemId) throw new Error("expected the ingested message to have a thread item");
      const task = await createThreadTask(
        client,
        { threadItemId, name: `Task ${randomUUID()}` },
        { writer: { writerKind: "user" } },
      );
      const person = await createItemWithClient(client, {
        databaseId: peopleDatabaseId,
        properties: { name: "Joined later" },
      });
      await createRelationWithClient(
        client,
        {
          relationPropertyId: await propertyId(ids.emailsDatabaseId, "senderPeople"),
          callerItemId: ingested.itemId,
          targetItemId: person.id,
        },
        { ownerProcess: "emails" },
      );
      return { threadItemId, personId: person.id, taskId: task.id };
    }),
  );
}

/** The ids of the tasks that have `personId` among their people, in `tenant`. */
async function tasksWithPerson(tenant: Tenant, personId: string): Promise<string[]> {
  const found = await rows<{ task_id: string }>(
    tenant,
    `SELECT r.item_a AS task_id FROM item_relations r
     JOIN relation_definitions d ON d.id = r.relation_definition_id
     JOIN properties p ON p.id = d.property_id_a AND p.key = 'people'
     JOIN databases db ON db.id = p.database_id AND db.owner_module_id = 'tasks'
     WHERE r.item_b = $1`,
    [personId],
  );
  return found.map((row) => row.task_id);
}

/** The queue name of the sleep module's resync task (`sleepModuleManifest.ts`, issue gh-1838). */
const SLEEP_RESYNC_TASK = "sleep.resync";

/** Revokes `tenant`'s user's registrations and gives the user one active iOS APNs registration; returns its device token. */
async function seedIosRegistration(tenant: Tenant): Promise<string> {
  const deviceToken = randomUUID();
  await inTenant(tenant, async () => {
    // The registrations other cases left for this user are not this job's business.
    await revokeAllPushSubscriptionsForUser(pool, tenant.userId);
    await upsertApnsSubscription(pool, {
      userId: tenant.userId,
      sessionId: null,
      platform: "ios",
      deviceToken,
      apnsEnvironment: "sandbox",
    });
  });
  return deviceToken;
}

/** The device tokens of `tenant`'s user's active APNs registrations. */
async function activeApnsTokens(tenant: Tenant): Promise<string[]> {
  const found = await rows<{ device_token: string }>(
    tenant,
    "SELECT device_token FROM push_subscriptions WHERE user_id = $1 AND channel = 'apns' AND revoked_at IS NULL",
    [tenant.userId],
  );
  return found.map((row) => row.device_token);
}

/** The silent pushes sent since the last `seed` of the `sleep.resync` or the `remindersResync` case. */
function sleepResyncSends(): RecordedBackgroundPush[] {
  return [...backgroundPushes.sent];
}

/** The invitation of `tenant`'s Event to its person, as the system writer stores it: pending, naming the mailbox. */
interface SeededInvitation {
  eventId: string;
  personId: string;
  mailboxId: string;
  organizerEmail: string;
  attendeeEmail: string;
}

/**
 * A mailbox of `tenant` with an address of its own, an Event with a UID, and a person invited to it through the
 * system writer, the way the invitation code stores it. The link queues a message of its own; it is discarded by the
 * caller before the job under test is enqueued, as for every case.
 */
async function seedInvitation(tenant: Tenant): Promise<SeededInvitation> {
  const mailboxesId = await requireModuleDatabaseId(tenant, "mailboxes");
  const peopleId = await requireModuleDatabaseId(tenant, "people");
  const eventsId = await requireModuleDatabaseId(tenant, "events");
  const organizerEmail = `organizer-${randomUUID()}@example.test`;
  const attendeeEmail = `attendee-${randomUUID()}@example.test`;
  const mailboxId = await inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(
        client,
        {
          databaseId: mailboxesId,
          properties: { name: `Mailbox ${randomUUID()}`, provider: "generic", addresses: organizerEmail },
        },
        { allowedSystemKeys: ["addresses"] },
      );
      return mailbox.id;
    }),
  );
  return inTenant(tenant, async () => {
    const person = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Invitee" } });
    const event = await chokePoint.createItem({
      databaseId: eventsId,
      properties: { name: "Isolation meeting", date: "2099-01-15", timeFrom: "09:00", timeTo: "10:00" },
    });
    const peopleProperty = (await chokePoint.listProperties(eventsId)).find((property) => property.key === "people");
    if (!peopleProperty) throw new Error("expected Events.people to be seeded");
    await chokePoint.createRelation(
      {
        relationPropertyId: peopleProperty.id,
        callerItemId: event.id,
        targetItemId: person.id,
        metadata: { invitation: { status: "pending", email: attendeeEmail, mailboxId } },
      },
      SYSTEM_WRITER,
    );
    return { eventId: event.id, personId: person.id, mailboxId, organizerEmail, attendeeEmail };
  });
}

/** The `sentAt` stored on the invitation of the Event's edge to the person in `tenant`, or `null` when none is. */
async function invitationSentAt(tenant: Tenant, eventId: string, personId: string): Promise<unknown> {
  const found = await rows<{ sent_at: unknown }>(
    tenant,
    `SELECT metadata -> 'invitation' -> 'sentAt' AS sent_at FROM item_relations
     WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)`,
    [eventId, personId],
  );
  if (found.length !== 1) throw new Error("expected exactly one edge between the Event and the person");
  return found[0]?.sent_at ?? null;
}

/** The queue name of the mail module's thread project task (`mailModuleManifest.ts`, issue gh-1872). */
const MAIL_TRIAGE_THREAD_PROJECT_TASK = "mailTriageThreadProject";

/** One question the triage gateway was asked, with the tenant scope the job asked it in and the project ids it offered. */
interface TriageQuestion {
  tenantId: string | null;
  offeredProjectIds: string[];
}

const triageQuestions: TriageQuestion[] = [];

/** The project the triage case seeded, by the id of the thread it belongs to. */
const triageProjects = new Map<string, string>();

/** The name of the project the gateway chooses: the one the latest seed made, since earlier cases leave projects behind. */
let triageProjectName = "";

const offeredProjects = z.array(z.object({ id: z.uuid(), name: z.string() }));

/** A gateway that records what the job offered and chooses the offered project named `triageProjectName`. */
const triageGateway: AiGatewayClientPort = {
  async complete(input) {
    const scope = currentTenantScope();
    const message = input.messages[0];
    const text = typeof message?.content === "string" ? message.content : "";
    const offered = offeredProjects.parse(
      JSON.parse(text.slice(text.indexOf("Candidate projects: ") + "Candidate projects: ".length)),
    );
    triageQuestions.push({
      tenantId: scope?.kind === "tenant" ? scope.tenantId : null,
      offeredProjectIds: offered.map((project) => project.id),
    });
    const chosen = offered.find((project) => project.name === triageProjectName);
    return {
      content: { projectId: chosen?.id ?? null, confidence: 0.95 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};

/** A thread of `tenant` with one inbound message and no project, and one active project the gateway will choose. */
async function seedTriageThread(tenant: Tenant): Promise<{ threadItemId: string }> {
  const mailboxItemId = await createMailbox(tenant);
  const projectsDatabaseId = await requireModuleDatabaseId(tenant, "projects");
  triageProjectName = `Isolation project ${randomUUID()}`;
  const projectId = (
    await inTenant(tenant, () =>
      chokePoint.createItem({
        databaseId: projectsDatabaseId,
        properties: { name: triageProjectName, status: "inProgress" },
      }),
    )
  ).id;
  const threadItemId = await inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const propertyId = async (databaseId: string, key: string): Promise<string> => {
        const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
        if (!property) throw new Error(`expected the ${key} property to be seeded`);
        return property.id;
      };
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId,
        mailboxRelationPropertyId: await propertyId(ids.foldersDatabaseId, "mailbox"),
        providerId: "INBOX",
        name: "Inbox",
        behavior: "folder",
        specialPurpose: "inbox",
      });
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
        attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
        folderItemId,
        mailboxItemId,
        messageId: `<${randomUUID()}@example.test>`,
        subject: "Question about the isolation project",
        envelope: { from: { address: "sender@example.test" } },
        bodyText: "Please advise.",
        attachments: [],
        storage: new LocalFsBlobStorageWriter(join(blobRoot, "mail")),
        storageKeyPrefix: mailboxItemId,
      });
      const { rows: threads } = await client.query<{ item_id: string }>(
        "SELECT t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1",
        [ingested.itemId],
      );
      const row = threads[0];
      if (!row) throw new Error("expected the ingested message to have a thread item");
      return row.item_id;
    }),
  );
  triageProjects.set(threadItemId, projectId);
  return { threadItemId };
}

let journalDaysSeeded = 0;

const cases: Record<string, TaskCase> = {
  [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: {
    tenancy: "tenant",
    async seed(tenant) {
      titlePortCalls.length = 0;
      return runInTenant(tenant.tenantId, () =>
        withTransaction(pool, async (client) => {
          const turn = await sendSempMessage(client, { text: "Tenant question", context: [], hasContext: false });
          expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
          const run = await createAgentRun(client, {
            triggeredBy: "user",
            unit: "session",
            task: "Tenant question",
            threadId: turn.threadId,
          });
          const event = await insertAgentRunEvent(client, run.id, "message", {
            kind: "message",
            text: "Tenant answer",
          });
          await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
          expect(
            await finishSempMessageTurn(client, turn.assistantMessageId, {
              status: "done",
              text: "Tenant answer",
              lastEventId: event.id,
            }),
          ).toBe(true);
          return { threadId: turn.threadId };
        }),
      );
    },
    async expectDone(tenant, payload) {
      expect(
        await rows(tenant, "SELECT title FROM semp_threads WHERE id = $1", [requirePayloadString(payload, "threadId")]),
      ).toEqual([{ title: "Tenant title" }]);
      expect(titlePortCalls).toHaveLength(1);
      expect(titlePortCalls[0]).toMatchObject({
        tenantId: tenant.tenantId,
        input: {
          operation: "semp_thread_title",
          projectItemId: null,
          messages: [
            { role: "user", content: "Tenant question" },
            { role: "assistant", content: "Tenant answer" },
          ],
        },
      });
      titlePortCalls.length = 0;
    },
  },
  // The production catalog has no configured link rules: this exercises registered refusal,
  // not successful propagation (covered by the configured-rule data tests).
  [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: {
    tenancy: "tenant",
    expectedError: /Value link rule is unavailable/,
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const areas = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
        if (!areas) throw new Error("Areas database was not seeded");
        const source = await chokePoint.createItem({ databaseId: areas.id, properties: { name: "Link source" } });
        return { ruleKey: "unconfigured.fixture", sourceItemId: source.id, hop: 1 };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows<{ name: string }>(tenant, "SELECT properties->>'name' AS name FROM items WHERE id = $1", [
          requirePayloadString(payload, "sourceItemId"),
        ]),
      ).toEqual([{ name: "Link source" }]);
    },
  },
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
  [CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const database = await chokePoint.createDatabase({ name: `Search ${randomUUID()}` });
        await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
        const item = await chokePoint.createItem({
          databaseId: database.id,
          properties: { title: "Legacy searchable" },
        });
        // Simulate an item predating indexing; production writes now create this row automatically.
        const removed = await pool.query("DELETE FROM item_search_index WHERE item_id = $1", [item.id]);
        expect(removed.rowCount).toBe(1);
        return { databaseId: database.id, onlyMissing: true };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows<{ title: string; matches: boolean }>(
          tenant,
          `SELECT i.properties ->> 'title' AS title,
             s.search_vector @@ plainto_tsquery('czech', 'Legacy searchable') AS matches
           FROM items i JOIN item_search_index s ON s.item_id = i.id
           WHERE i.database_id = $1`,
          [requirePayloadString(payload, "databaseId")],
        ),
      ).toEqual([{ title: "Legacy searchable", matches: true }]);
    },
  },
  [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const projectsId = await requireModuleDatabaseId(tenant, "projects");
        const tasksId = await requireModuleDatabaseId(tenant, "tasks");
        const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Původní" } });
        const task = await chokePoint.createItem({ databaseId: tasksId, properties: { name: "Závislý úkol" } });
        const projectProperty = (await chokePoint.listProperties(tasksId)).find((p) => p.key === "project");
        if (!projectProperty) throw new Error("expected Tasks.project");
        await chokePoint.createRelation({
          relationPropertyId: projectProperty.id,
          callerItemId: task.id,
          targetItemId: project.id,
        });
        // A project title that changed while its dependents' documents were not rebuilt yet: written
        // directly, so the task's document is stale until this job runs.
        const renamed = await pool.query(
          "UPDATE items SET properties = properties || jsonb_build_object('name', 'Přejmenovaný') WHERE id = $1",
          [project.id],
        );
        expect(renamed.rowCount).toBe(1);
        return { kind: "referrers", itemId: project.id };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows<{ matches: boolean }>(
          tenant,
          `SELECT s.search_vector @@ plainto_tsquery('czech_simple', 'Přejmenovaný') AS matches
           FROM item_relations r JOIN item_search_index s ON s.item_id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END
           WHERE r.item_a = $1 OR r.item_b = $1`,
          [requirePayloadString(payload, "itemId")],
        ),
      ).toEqual([{ matches: true }]);
    },
  },
  [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const databaseId = await requireModuleDatabaseId(tenant, "tasks");
        const item = await chokePoint.createItem({ databaseId, properties: { name: "Isolated page" } });
        await writePageTextBlocks(pool, item.id, ["Stránka tenanta A"]);
        return { itemId: item.id };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows<{ page_text: string | null }>(tenant, "SELECT page_text FROM item_search_index WHERE item_id = $1", [
          requirePayloadString(payload, "itemId"),
        ]),
      ).toEqual([{ page_text: "Stránka tenanta A" }]);
    },
  },
  [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: {
    tenancy: "tenant",
    async seed(tenant) {
      return inTenant(tenant, async () => {
        const databaseId = await requireModuleDatabaseId(tenant, "tasks");
        const host = await chokePoint.createItem({ databaseId, properties: { name: "Mirror host" } });
        const docStore = createDocStore(pool);
        const created = await docStore.createSubpage({ parent: { itemId: host.id }, title: "Before" }, "user");
        const blockId = created.pages[0]?.blockId;
        const doc = await docStore.getDoc(host.id);
        if (!blockId || !doc) throw new Error("expected a subpage block in the host document");
        // A title typed into the parent document, as a sync client writes it; the Pages item still holds the old one.
        await mutateYDoc(pool, doc.id, "user", (ydoc) => {
          const title = ydoc.getMap<Y.Map<unknown>>("blocks").get(blockId)?.get("text");
          if (!(title instanceof Y.Text)) throw new Error("expected the page block title to be a Y.Text");
          title.delete(0, title.length);
          title.insert(0, "Stránka tenanta A");
        });
        return { itemId: host.id };
      });
    },
    async expectDone(tenant, payload) {
      expect(
        await rows<{ title: string }>(
          tenant,
          `SELECT i.properties ->> 'title' AS title FROM items i JOIN databases d ON d.id = i.database_id
           WHERE d.owner_module_id = 'pages' AND i.properties ->> 'parentItemId' = $1`,
          [requirePayloadString(payload, "itemId")],
        ),
      ).toEqual([{ title: "Stránka tenanta A" }]);
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
      return { itemId, databaseId, config: { source: "tmdb", coverKey: "cover" } };
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
  [CORE_TASK_NAMES.MAILBOX_REMOVAL]: {
    tenancy: "tenant",
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant);
      await inTenant(tenant, async () => {
        await withTransaction(pool, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const propertyId = async (databaseId: string, key: string): Promise<string> => {
            const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
            if (!property) throw new Error(`expected the ${key} property to be seeded`);
            return property.id;
          };
          const folderItemId = await ensureFolderItem(client, {
            foldersDatabaseId: ids.foldersDatabaseId,
            mailboxItemId,
            mailboxRelationPropertyId: await propertyId(ids.foldersDatabaseId, "mailbox"),
            providerId: "INBOX",
            name: "Inbox",
            behavior: "folder",
            specialPurpose: "inbox",
          });
          await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
            attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
            folderItemId,
            mailboxItemId,
            messageId: `<${randomUUID()}@example.test>`,
            envelope: { from: { address: "sender@example.test" } },
            attachments: [],
            storage: new LocalFsBlobStorageWriter(join(blobRoot, "mail")),
            storageKeyPrefix: mailboxItemId,
          });
        });
        // The removal queues this job itself; the driver discards that one and enqueues its own. An empty
        // affinity map routes the removal's heartbeats to the default queue.
        if (!(await removeMailbox(pool, mailboxItemId, { queueAffinity: new Map() }))) {
          throw new Error("expected the seeded mailbox to be removed");
        }
      });
      return { mailboxItemId };
    },
    async expectDone(tenant, payload) {
      // The mailbox's one folder and one message carry the mailbox's own deletion time.
      expect(
        await rows(
          tenant,
          `SELECT d.owner_module_id AS module FROM items i JOIN databases d ON d.id = i.database_id
            WHERE i.id <> $1 AND i.deleted_at = (SELECT m.deleted_at FROM items m WHERE m.id = $1)
            ORDER BY d.owner_module_id`,
          [requirePayloadString(payload, "mailboxItemId")],
        ),
      ).toEqual([{ module: "emails" }, { module: "folders" }]);
    },
  },
  [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: {
    tenancy: "tenant",
    async seed(tenant) {
      const address = `${randomUUID()}@example.test`;
      const peopleDatabaseId = await requireModuleDatabaseId(tenant, "people");
      const { itemId } = await createEmail(tenant);
      const personId = await inTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const role = await client.query<{ name: string; bypass: boolean; superuser: boolean }>(
            "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
          );
          expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
          const person = await createItemWithClient(client, {
            databaseId: peopleDatabaseId,
            properties: { name: "Mail person", emails: address },
          });
          await upsertMailMessageMeta(client, {
            itemId,
            mailboxItemId: null,
            messageId: `<${randomUUID()}@example.test>`,
            envelope: { from: { address }, to: [{ address }] },
            migrationStatus: "partial",
          });
          return person.id;
        }),
      );
      const action = createApiActionRegistry(pool, moduleRegistry).get(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID);
      if (!action) throw new Error("Missing person email reindex action");
      await inTenant(tenant, () =>
        action({ peopleDatabaseId }, { heartbeatId: "test", projectItemId: "test", itemId: personId }),
      );
      expect(await rows(tenant, "SELECT item_id FROM person_email_index WHERE email = $1", [address])).toEqual([
        { item_id: personId },
      ]);
      expect(
        await rows(tenant, "SELECT id FROM item_relations WHERE item_a = $1 AND item_b = $2", [itemId, personId]),
      ).toEqual([]);
      return { personId, addresses: [address] };
    },
    async expectDone(tenant, payload) {
      const personId = requirePayloadString(payload, "personId");
      const parsed = z.object({ addresses: z.array(z.string()).length(1) }).parse(payload);
      expect(
        await rows(
          tenant,
          `SELECT p.key FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
           JOIN properties p ON p.id = d.property_id_a JOIN mail_message_meta m ON m.item_id = r.item_a
           WHERE r.item_b = $1 AND m.envelope @> $2::jsonb ORDER BY p.key`,
          [personId, JSON.stringify({ from: { address: parsed.addresses[0] } })],
        ),
      ).toEqual([{ key: "recipientsPeople" }, { key: "senderPeople" }]);
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
      await switchSleepMuteOff(tenant);
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
            // A critical Semp problem: the default preferences push it, a warning would not be pushed
            // (issues #1443 and #1466).
            kind: "semp_problem",
            linkHref: null,
            sourceTable: "semp_problems",
            sourceId: randomUUID(),
            transitionInstance: randomUUID(),
            payload: { severity: "critical" },
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
  [CORE_TASK_NAMES.PUSH_DISMISS]: {
    tenancy: "tenant",
    async seed(tenant) {
      // The default senders reach the registration for real: a VAPID configuration and a registration with
      // valid keys let the Web Push send build its request. Its endpoint is a loopback address, which the
      // outbound address policy refuses at connect time without any network, so the provider verdict is
      // "dead registration" and the job revokes it. Restored after each test.
      useVapidConfiguration();
      return inTenant(tenant, async () => {
        // The registrations other cases left for this user would be sent to for real.
        await revokeAllPushSubscriptionsForUser(pool, tenant.userId);
        await upsertWebPushSubscription(pool, {
          userId: tenant.userId,
          sessionId: null,
          endpoint: `https://127.0.0.1:9/${randomUUID()}`,
          p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
          authSecret: randomBytes(16).toString("base64url"),
        });
        return { userId: tenant.userId, notificationIds: [randomUUID()] };
      });
    },
    async expectDone(tenant) {
      expect(await pushRegistrationRevoked(tenant)).toBe(true);
    },
  },
  [CORE_TASK_NAMES.PUSH_BADGE_REFRESH]: {
    tenancy: "tenant",
    async seed(tenant) {
      // The default sender is the real APNs adapter. With no APNs configuration it answers `not-configured`
      // without a network request, which the job accepts, so the run neither fails nor revokes. What the job
      // sends, and that it sends nothing for another tenant's user, is proven with a fake sender in
      // `pushBadgeRefresh.test.ts`; this case proves the job runs for its own tenant and leaves the others alone.
      useUnconfiguredApns();
      return inTenant(tenant, async () => {
        // The registrations other cases left for this user are not this job's business.
        await revokeAllPushSubscriptionsForUser(pool, tenant.userId);
        await upsertApnsSubscription(pool, {
          userId: tenant.userId,
          sessionId: null,
          platform: "ios",
          deviceToken: randomUUID(),
          apnsEnvironment: "sandbox",
        });
        return { userId: tenant.userId };
      });
    },
    async expectDone(tenant) {
      // `not-configured` does not revoke: the registration the seed created is still active.
      expect(
        await rows(
          tenant,
          "SELECT count(*)::int AS active FROM push_subscriptions WHERE user_id = $1 AND channel = 'apns' AND revoked_at IS NULL",
          [tenant.userId],
        ),
      ).toEqual([{ active: 1 }]);
    },
  },
  [SLEEP_RESYNC_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      // The default sender is the real APNs adapter behind the spy above. With no APNs configuration it answers
      // `not-configured` without a network request, which the job accepts, so the run neither fails nor revokes.
      // Every tenant gets an active iOS registration of its own, so a job that read or pushed for a tenant other
      // than its own would have a registration to send to; the spy shows which one each run sent to.
      useUnconfiguredApns();
      for (const other of [tenantA, tenantB]) await seedIosRegistration(other);
      backgroundPushes.sent.length = 0;
      return { tenantId: tenant.tenantId };
    },
    async expectDone(tenant) {
      // Exactly one silent push, to the one registration of this tenant's user and to none of another tenant's;
      // `not-configured` does not revoke, so that registration is still active.
      const tokens = await activeApnsTokens(tenant);
      expect(tokens).toHaveLength(1);
      expect(sleepResyncSends()).toEqual([{ deviceToken: tokens[0], data: { kind: "sleepResync" } }]);
    },
  },
  [CORE_TASK_NAMES.REMINDERS_RESYNC]: {
    tenancy: "tenant",
    async seed(tenant) {
      // As for `sleep.resync`: the real APNs adapter behind the spy answers `not-configured` without a network request,
      // and every tenant has an active iOS registration of its own, so a job that pushed for a tenant other than its
      // own would have a registration to send to; the spy shows which one each run sent to.
      useUnconfiguredApns();
      for (const other of [tenantA, tenantB]) await seedIosRegistration(other);
      backgroundPushes.sent.length = 0;
      return { tenantId: tenant.tenantId };
    },
    async expectDone(tenant) {
      // Exactly one silent push, to the one registration of this tenant's user and to none of another tenant's.
      const tokens = await activeApnsTokens(tenant);
      expect(tokens).toHaveLength(1);
      expect(sleepResyncSends()).toEqual([{ deviceToken: tokens[0], data: { kind: "remindersResync" } }]);
    },
  },
  [MAIL_SYNC_THREAD_TASK_PEOPLE_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      const { threadItemId, personId, taskId } = await seedThreadTaskWithNewPerson(tenant);
      // The task has not got the person yet: the job is what adds them.
      expect(await tasksWithPerson(tenant, personId)).toEqual([]);
      threadTaskPeopleTasks.set(personId, taskId);
      return { threadItemId, personId };
    },
    async expectDone(tenant, payload) {
      const personId = requirePayloadString(payload, "personId");
      expect(await tasksWithPerson(tenant, personId)).toEqual([threadTaskPeopleTasks.get(personId)]);
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
  [CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const { itemId } = await createEmail(tenant);
      // A row from before preview_text/ingested_at existed: no production path writes one without them.
      await inTenant(tenant, () =>
        pool.query(`INSERT INTO mail_message_meta (item_id, message_id, envelope) VALUES ($1, $2, '{}'::jsonb)`, [
          itemId,
          `<${randomUUID()}@example.com>`,
        ]),
      );
      return marked([itemId], async () => {
        expect(
          await rows(
            tenant,
            "SELECT preview_text IS NOT NULL AS has_preview, ingested_at IS NOT NULL AS has_time FROM mail_message_meta WHERE item_id = $1",
            [itemId],
          ),
        ).toEqual([{ has_preview: true, has_time: true }]);
      });
    },
  },
  [CORE_TASK_NAMES.MAIL_THREAD_BACKFILL]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const itemId = randomUUID();
      // A sent message stored before #1474 gave sends a thread. No production writer leaves thread_id NULL now.
      await inTenant(tenant, () =>
        pool.query(`INSERT INTO mail_message_meta (item_id, message_id, envelope) VALUES ($1, $2, '{}'::jsonb)`, [
          itemId,
          `<${randomUUID()}@example.com>`,
        ]),
      );
      return marked([itemId], async () => {
        expect(
          await rows(tenant, "SELECT thread_id IS NOT NULL AS threaded FROM mail_message_meta WHERE item_id = $1", [
            itemId,
          ]),
        ).toEqual([{ threaded: true }]);
      });
    },
  },
  [CORE_TASK_NAMES.MAIL_GMAIL_PSEUDO_FOLDER_CLEANUP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant, "gmail_api");
      // The folder an earlier Gmail sync created for a label that is not a real folder.
      const folderItemId = await inTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const moduleIds = await resolveMailModuleIds(client);
          const { rows } = await client.query<{ id: string }>(
            "SELECT id FROM properties WHERE database_id = $1 AND key = 'mailbox'",
            [moduleIds.foldersDatabaseId],
          );
          const mailboxRelationPropertyId = rows[0]?.id;
          if (!mailboxRelationPropertyId) throw new Error("expected the Folders mailbox relation property");
          return ensureFolderItem(client, {
            foldersDatabaseId: moduleIds.foldersDatabaseId,
            mailboxItemId,
            mailboxRelationPropertyId,
            providerId: "UNREAD",
            name: "Unread",
            behavior: "label",
            specialPurpose: "none",
          });
        }),
      );
      return marked([folderItemId], async () => {
        expect(
          await rows(tenant, "SELECT 1 AS present FROM items WHERE id = $1 AND deleted_at IS NULL", [folderItemId]),
        ).toEqual([]);
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
  [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const stateId = randomUUID();
      // The row is inserted already expired; production only creates states valid for ten minutes.
      await inTenant(tenant, () =>
        pool.query(
          `INSERT INTO mail_oauth_states
             (id, user_id, provider, state_hash, code_verifier_ciphertext, code_verifier_nonce, expires_at)
           VALUES ($1, $2, 'gmail', $3, $4, $5, now() - interval '1 minute')`,
          [stateId, tenant.userId, randomUUID(), Buffer.from("ciphertext"), Buffer.from("nonce")],
        ),
      );
      return marked([stateId], async () => {
        expect(await rows(tenant, "SELECT 1 FROM mail_oauth_states WHERE id = $1", [stateId])).toEqual([]);
      });
    },
  },
  [CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const { itemId } = await createEmail(tenant);
      return marked([itemId], async () => {
        expect(await rows(tenant, "SELECT 1 AS present FROM item_search_index WHERE item_id = $1", [itemId])).toEqual([
          { present: 1 },
        ]);
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
  [CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const blobId = randomUUID();
      // A standalone upload (`<tenantId>/blobs/...`) nothing references; only its age is back-dated,
      // because the sweep leaves anything younger than 24 hours alone.
      await inTenant(tenant, () =>
        pool.query(
          `INSERT INTO blobs (id, mime_type, byte_size, storage_key, created_at)
           VALUES ($1, 'image/png', 1, $2, now() - interval '25 hours')`,
          [blobId, `${tenant.tenantId}/blobs/${randomUUID()}`],
        ),
      );
      return marked([blobId], async () => {
        expect(await rows(tenant, "SELECT 1 FROM blobs WHERE id = $1", [blobId])).toEqual([]);
      });
    },
  },
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const { personId } = await createPersonWithEvent(tenant, PAST_EVENT_DATE);
      return { personId };
    },
    async expectDone(tenant, payload) {
      expect(await lastContactOf(tenant, requirePayloadString(payload, "personId"))).toBe(PAST_EVENT_DATE);
    },
  },
  [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const projectItemId = await createProjectWithTask(tenant);
      // Started after the fixture's own writes, so only the job under test is recorded.
      recordInvalidations();
      return { projectItemId };
    },
    async expectDone(tenant, payload) {
      const announced = stopRecordingInvalidations();
      // `Tasks.project` is the inverse side of its definition: the project is `item_a`, its task `item_b`.
      const tasks = await rows<{ id: string; database_id: string; updated_at: Date }>(
        tenant,
        `SELECT i.id, i.database_id, i.updated_at FROM item_relations r JOIN items i ON i.id = r.item_b
         WHERE r.item_a = $1`,
        [requirePayloadString(payload, "projectItemId")],
      );
      expect(tasks).toHaveLength(1);
      expect(announced).toEqual(
        tasks.map((task) => ({
          tenantId: tenant.tenantId,
          event: {
            scope: "item",
            databaseId: task.database_id,
            itemId: task.id,
            op: "update",
            updatedAt: task.updated_at.toISOString(),
          },
        })),
      );
    },
  },
  [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: {
    tenancy: "tenant",
    async seed(tenant) {
      const taskId = await createTaskHiddenInPassedEvent(tenant);
      expect(await hiddenUntilOf(tenant, taskId)).not.toBeNull();
      return { taskId };
    },
    async expectDone(tenant, payload) {
      expect(await hiddenUntilOf(tenant, requirePayloadString(payload, "taskId"))).toBeNull();
    },
  },
  [CORE_TASK_NAMES.AI_BUDGET_RESET]: {
    tenancy: "tenant",
    async seed() {
      // The job takes nothing from its payload. Recording starts after the fixture, so only the job is recorded.
      recordInvalidations();
      return {};
    },
    async expectDone(tenant) {
      expect(stopRecordingInvalidations()).toEqual([{ tenantId: tenant.tenantId, event: { scope: "sempStatus" } }]);
    },
  },
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      // An Event that started an hour ago, inside the sweep's last 24 hours.
      const zone = await inTenant(tenant, () => withTransaction(pool, getSystemTimezone));
      const start = instantToWallClock(new Date(Date.now() - 60 * 60 * 1000), zone);
      const { personId, eventId } = await createPersonWithEvent(tenant, start.date, start.time);
      return marked([personId, eventId], async () => {
        expect(await lastContactOf(tenant, personId)).toBe(start.date);
      });
    },
  },
  [CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const hostItemId = await seededSemprecProjectItemId(tenant);
      const pageItemId = await inTenant(tenant, async () => {
        const created = await docStore.createSubpage({ parent: { itemId: hostItemId }, title: "Orphan" }, "user");
        const page = created.pages[0];
        if (!page) throw new Error("expected the subpage to be created");
        // An editor deletes the page block over the sync socket, which runs no domain code.
        await docStore.deleteBlock(hostItemId, page.blockId, "user");
        // Documents only age in real time; no production writer back-dates the last edit.
        await pool.query("UPDATE docs SET last_edited_at = now() - interval '2 hours' WHERE item_id = $1", [
          hostItemId,
        ]);
        return page.pageItemId;
      });
      return marked([pageItemId], async () => {
        expect(
          await rows(tenant, "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1", [pageItemId]),
        ).toEqual([{ trashed: true }]);
      });
    },
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
  [CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const problemId = randomUUID();
      await adminPool.query(
        `INSERT INTO semp_problems (id, tenant_id, user_id, category, kind, severity, source_table, source_id,
                                    dedupe_key, resolved_at, resolution_kind)
         VALUES ($1, $2, $3, 'mail', 'mailSyncFailed', 'warning', 'mail_account_sync_state', $4, $5,
                 now() - interval '31 days', 'recovered')`,
        [problemId, tenant.tenantId, tenant.userId, randomUUID(), `mail:sync:${problemId}`],
      );
      return marked([problemId], async () => {
        expect(await rows(tenant, "SELECT 1 FROM semp_problems WHERE id = $1", [problemId])).toEqual([]);
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
  [CALENDAR_SEND_EVENT_INVITATION_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      invitationSends.length = 0;
      const { eventId, personId, mailboxId, attendeeEmail } = await seedInvitation(tenant);
      return { method: "REQUEST", eventId, personId, mailboxId, attendeeEmail };
    },
    async expectDone(tenant, payload) {
      const eventId = requirePayloadString(payload, "eventId");
      const personId = requirePayloadString(payload, "personId");
      const mailboxId = requirePayloadString(payload, "mailboxId");
      const mailbox = await rows<{ addresses: string }>(
        tenant,
        "SELECT properties ->> 'addresses' AS addresses FROM items WHERE id = $1",
        [mailboxId],
      );
      // One message left, from the mailbox of the job's own tenant, to the invited address, in that tenant's scope.
      expect(invitationSends).toEqual([
        {
          tenantId: tenant.tenantId,
          mailboxId,
          method: "REQUEST",
          from: mailbox[0]?.addresses,
          recipients: [requirePayloadString(payload, "attendeeEmail")],
        },
      ]);
      expect(typeof (await invitationSentAt(tenant, eventId, personId))).toBe("string");
      invitationSends.length = 0;
    },
  },
  [MAIL_TRIAGE_THREAD_PROJECT_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      triageQuestions.length = 0;
      return seedTriageThread(tenant);
    },
    async expectDone(tenant, payload) {
      const threadItemId = requirePayloadString(payload, "threadItemId");
      const projectId = triageProjects.get(threadItemId);
      // The thread of the tenant holds the project of that tenant as its own value, written by Semp.
      expect(
        await rows(
          tenant,
          `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS project_id
             FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
             JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b) AND p.key = 'project'
             JOIN databases db ON db.id = p.database_id AND db.owner_module_id = 'threads'
            WHERE r.item_a = $1 OR r.item_b = $1`,
          [threadItemId],
        ),
      ).toEqual([{ project_id: projectId }]);
      expect(await rows(tenant, "SELECT 1 FROM value_links WHERE item_id = $1", [threadItemId])).toEqual([]);
      // The gateway was asked once, in this tenant's scope, and every project it was offered is a row of this tenant.
      expect(triageQuestions).toHaveLength(1);
      const [question] = triageQuestions;
      expect(question?.tenantId).toBe(tenant.tenantId);
      expect(question?.offeredProjectIds).toContain(projectId);
      expect(
        await rows(tenant, "SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id", [
          question?.offeredProjectIds,
        ]),
      ).toHaveLength(question?.offeredProjectIds.length ?? -1);
      triageQuestions.length = 0;
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

const ENV_OVERRIDES = [
  "AI_GATEWAY_INTERNAL_TOKEN",
  "FILES_STORAGE_DIR",
  "MAIL_ATTACHMENTS_DIR",
  ...VAPID_ENV,
  ...APNS_ENV,
] as const;

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
    const role = await runAsSystem("test:title-registry-role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenantTables = await loadTenantTables();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);

    // Composed exactly as createApiQueueRuntime composes it.
    const actionRegistry = createApiActionRegistry(pool, moduleRegistry);
    const gmailAdapters = createMailSyncAdapters({
      pool,
      env: { GMAIL_OAUTH_CLIENT_ID: "test-client", GMAIL_OAUTH_CLIENT_SECRET: "test-secret" },
      fetchImpl: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "test-access", expires_in: 3600, token_type: "Bearer" });
        }
        if (url === "https://gmail.googleapis.com/gmail/v1/users/me/labels") {
          return Response.json({ labels: [{ id: "UNREAD", name: "Unread", type: "system" }] });
        }
        throw new Error("Unexpected fake provider request");
      },
    });
    const coreTaskList = createApiCoreTaskList(
      pool,
      actionRegistry,
      undefined,
      { loadGmailLabels: gmailAdapters.loadGmailLabels },
      undefined,
      undefined,
      moduleRegistry,
      undefined,
      replayApprovedGenericOperation,
      undefined,
      undefined,
      titlePort,
    );
    // The calendar's invitation task reads its pool and transports from the binding `createApiQueueRuntime` sets.
    setEventInvitationDelivery({ pool, transports: invitationTransports });
    // The mail module's thread project task reads its pool and gateway from the binding `createApiQueueRuntime` sets.
    setThreadProjectTriageRuntime({ pool, gateway: triageGateway });
    // The mail module's thread task people task reads its pool from the same kind of binding.
    setThreadTaskPeopleDelivery({ pool });
    taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "api");
    assertTaskListMatchesAffinity(taskList, (await resolveTaskAffinitySets(moduleRegistry)).api, "api");

    tenantZero = await buildTenant(getTenantZeroId());
    tenantA = await buildTenant(await createTestTenant(adminPool));
    tenantB = await buildTenant(await createTestTenant(adminPool));
  });

  afterEach(() => {
    restoreVapidConfiguration();
    restoreApnsConfiguration();
  });

  afterAll(async () => {
    setEventInvitationDelivery(null);
    setThreadProjectTriageRuntime(null);
    setThreadTaskPeopleDelivery(null);
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

  it("purges rendered audio through the queued tenant sweep while preserving another tenant's live bytes", async () => {
    const first = await buildTenant(await createTestTenant(adminPool));
    const second = await buildTenant(await createTestTenant(adminPool));
    const root = join(blobRoot, "files");
    let primary: unknown;
    let failed = false;
    try {
      const a = await runTranscriptionFixture(
        { mode: "failure", source: "ogg", tenantId: first.tenantId, storageRoot: root },
        adminPool,
      );
      const b = await runTranscriptionFixture(
        { mode: "failure", source: "ogg", tenantId: second.tenantId, storageRoot: root },
        adminPool,
      );
      const inspect = async (tenant: Tenant, itemId: string) =>
        inTenant(tenant, async () => {
          const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
          if (!files) throw new Error("Missing Files database");
          const item = await chokePoint.getItem(files.id, itemId);
          if (!item) throw new Error("Missing rendered source");
          const original = z.object({ blobId: z.uuid() }).parse(item.properties.file).blobId;
          const prepare = z
            .object({ normalizedBlobId: z.uuid(), playbackBlobId: z.uuid() })
            .parse(item.computed.prepare);
          const ids = [original, prepare.normalizedBlobId, prepare.playbackBlobId];
          expect(new Set(ids).size).toBe(3);
          const found = await withTransaction(pool, (client) =>
            client.query<Record<string, unknown>>(
              "SELECT id, storage_key FROM blobs WHERE id = ANY($1::uuid[]) ORDER BY id",
              [ids],
            ),
          );
          const blobs = z.array(z.object({ id: z.uuid(), storage_key: z.string() })).parse(found.rows);
          expect(blobs).toHaveLength(3);
          for (const blob of blobs) {
            expect(blob.storage_key.startsWith(`${tenant.tenantId}/`)).toBe(true);
            expect((await readFile(join(root, blob.storage_key))).length).toBeGreaterThan(0);
          }
          return { filesId: files.id, ids, blobs };
        });
      const aBefore = await inspect(first, a.result.fileItemId);
      const bBefore = await inspect(second, b.result.fileItemId);
      expect(aBefore.ids).toContain(a.result.playbackBlobId);
      expect(bBefore.ids).toContain(b.result.playbackBlobId);
      await inTenant(first, async () => {
        await chokePoint.softDeleteItem(aBefore.filesId, a.result.fileItemId);
        await pool.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1", [
          a.result.fileItemId,
        ]);
      });
      await discardQueuedJobs();
      const actualStorage = new LocalFsBlobStorageWriter(root);
      const observed: Array<{ key: string; remaining: number }> = [];
      const storage: BlobStorageWriter = {
        writeStream: (key, source, options) => actualStorage.writeStream(key, source, options),
        readStream: (key, range) => actualStorage.readStream(key, range),
        async delete(key) {
          const rows = await adminPool.query("SELECT id FROM blobs WHERE storage_key = $1", [key]);
          observed.push({ key, remaining: rows.rows.length });
          await actualStorage.delete(key);
        },
      };
      const registry = createApiActionRegistry(pool, moduleRegistry);
      const tasks = createApiCoreTaskList(
        pool,
        registry,
        undefined,
        undefined,
        undefined,
        undefined,
        moduleRegistry,
        undefined,
        replayApprovedGenericOperation,
        storage,
      );
      const key = randomUUID();
      await runAsSystem("test:enqueue-rendered-purge", () =>
        enqueueJob(pool, CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, {}, { jobKey: key }),
      );
      await runOnce({ pgPool: pool, taskList: tasks });
      expect(await jobOutcome(key)).toEqual({ attempts: null, lastError: null });
      for (const blob of aBefore.blobs) {
        expect(observed).toContainEqual({ key: blob.storage_key, remaining: 0 });
        await expect(readFile(join(root, blob.storage_key))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await inTenant(first, () => chokePoint.getItem(aBefore.filesId, a.result.fileItemId))).toBeNull();
      expect(
        await inTenant(first, () =>
          withTransaction(pool, (client) =>
            client.query("SELECT id FROM blobs WHERE id = ANY($1::uuid[])", [aBefore.ids]),
          ),
        ).then((result) => result.rows),
      ).toEqual([]);
      const bAfter = await inspect(second, b.result.fileItemId);
      expect(bAfter.blobs).toEqual(bBefore.blobs);
      expect(observed.some((entry) => bBefore.blobs.some((blob) => blob.storage_key === entry.key))).toBe(false);
    } catch (error) {
      primary = error;
      failed = true;
    }
    try {
      await adminPool.query("UPDATE tenants SET status = 'suspended' WHERE id = ANY($1::uuid[])", [
        [first.tenantId, second.tenantId],
      ]);
    } catch (error) {
      if (failed) process.stderr.write(`Could not suspend fixture tenants: ${String(error)}\n`);
      else {
        primary = error;
        failed = true;
      }
    }
    if (failed) {
      if (primary instanceof Error) throw primary;
      throw new Error("Rendered purge scenario failed with a non-error value", { cause: primary });
    }
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
        const beforeA = name === CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE ? await fingerprint(tenantA) : undefined;
        const beforeB = await fingerprint(tenantB);
        const beforeZero = await fingerprint(tenantZero);
        const notificationsBefore = await notifications(tenantA);

        const jobKey = await runJobIn(tenantA, name, payload);

        const outcome = await jobOutcome(jobKey);
        await removeJob(jobKey);
        if (c.expectedError) {
          expect(outcome.lastError).toMatch(c.expectedError);
          if (name === CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE) expect(outcome.attempts).toBe(1);
        } else {
          expect(outcome).toEqual({ attempts: null, lastError: null });
        }
        await c.expectDone(tenantA, payload);
        if (beforeA) expect(await fingerprint(tenantA)).toEqual(beforeA);
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
        if (name === CORE_TASK_NAMES.SEMP_THREAD_TITLE) {
          expect(titlePortCalls).toEqual([]);
          expect(foreign).toEqual({
            outcome: { attempts: null, lastError: null },
            effects: { rowCountDeltas: {}, changedTables: [], notificationKinds: [], queuedJobs: [] },
          });
          titlePortCalls.length = 0;
        }
        if (name === CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS) {
          expect(foreign).toEqual({
            outcome: { attempts: null, lastError: null },
            effects: { rowCountDeltas: {}, changedTables: [], notificationKinds: [], queuedJobs: [] },
          });
        }
        if (name === CALENDAR_SEND_EVENT_INVITATION_TASK) {
          // The Event and the mailbox are A's: B's job reads neither, so it sends no message, for A's ids or random ones.
          expect(invitationSends).toEqual([]);
          expect(foreign).toEqual({
            outcome: { attempts: null, lastError: null },
            effects: { rowCountDeltas: {}, changedTables: [], notificationKinds: [], queuedJobs: [] },
          });
        }
        if (name === MAIL_TRIAGE_THREAD_PROJECT_TASK) {
          // The thread is A's: B's job finds no such Threads item, so it asks the gateway nothing, for A's id or a random one.
          expect(triageQuestions).toEqual([]);
          expect(foreign).toEqual({
            outcome: { attempts: null, lastError: null },
            effects: { rowCountDeltas: {}, changedTables: [], notificationKinds: [], queuedJobs: [] },
          });
        }
        if (name === SLEEP_RESYNC_TASK) {
          // Both tenants have an active iOS registration, and the payload names A: only the scope check keeps B's
          // job from pushing to its own registration for A's change, or to A's. Neither run sent anything, and
          // both registrations are still active.
          expect(sleepResyncSends()).toEqual([]);
          expect(await activeApnsTokens(tenantA)).toHaveLength(1);
          expect(await activeApnsTokens(tenantB)).toHaveLength(1);
        }
        if (name === CORE_TASK_NAMES.PUSH_DISMISS) {
          // The registration of A's user is global data; only the user check keeps B's job from reaching it.
          expect(await pushRegistrationRevoked(tenantA)).toBe(false);
        }
        if (name === CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE) {
          // The job only announces, which no fingerprint shows: neither run in B announced anything.
          expect(stopRecordingInvalidations()).toEqual([]);
          expect(foreign).toEqual({
            outcome: { attempts: null, lastError: null },
            effects: { rowCountDeltas: {}, changedTables: [], notificationKinds: [], queuedJobs: [] },
          });
        }
        if (name === CORE_TASK_NAMES.AI_BUDGET_RESET) {
          // The job announces for the tenant it runs in, whatever its payload names: both runs in B announced for B.
          const bStatus = { tenantId: tenantB.tenantId, event: { scope: "sempStatus" } };
          expect(stopRecordingInvalidations()).toEqual([bStatus, bStatus]);
        }
        expect(await fingerprint(tenantA)).toEqual(beforeA);
      },
    );
  });

  it("publishes the title registry case's committed invalidation for its tenant", async () => {
    const titleCase = cases[CORE_TASK_NAMES.SEMP_THREAD_TITLE];
    if (!titleCase || !isTenantCase(titleCase)) throw new Error("Missing title tenant case");
    const payload = await titleCase.seed(tenantA);
    await discardQueuedJobs();
    const listener = await adminPool.connect();
    const observed: { tenantId: string; threadId: string }[] = [];
    listener.on("notification", (notification) => {
      if (notification.channel !== REALTIME_CHANNEL || !notification.payload) return;
      const parsed: unknown = JSON.parse(notification.payload);
      const envelope = z
        .object({
          tenantId: z.string(),
          message: z.object({ type: z.literal("invalidation"), scope: z.literal("sempThread"), threadId: z.string() }),
        })
        .safeParse(parsed);
      if (envelope.success)
        observed.push({ tenantId: envelope.data.tenantId, threadId: envelope.data.message.threadId });
    });
    let failure: { error: unknown } | undefined;
    try {
      await listener.query(`LISTEN ${REALTIME_CHANNEL}`);
      wireRealtimeHooks(pool);
      const jobKey = await runJobIn(tenantA, CORE_TASK_NAMES.SEMP_THREAD_TITLE, payload);
      expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
      await titleCase.expectDone(tenantA, payload);
      const threadId = requirePayloadString(payload, "threadId");
      const repeatedKey = await runJobIn(tenantA, CORE_TASK_NAMES.SEMP_THREAD_TITLE, payload);
      expect(await jobOutcome(repeatedKey)).toEqual({ attempts: null, lastError: null });
      expect(titlePortCalls).toEqual([]);
      expect(await rows(tenantA, "SELECT title FROM semp_threads WHERE id = $1", [threadId])).toEqual([
        { title: "Tenant title" },
      ]);
      const deadline = Date.now() + 5_000;
      while (
        !observed.some((event) => event.tenantId === tenantA.tenantId && event.threadId === threadId) &&
        Date.now() < deadline
      )
        await sleep(25);
      expect(observed).toContainEqual({ tenantId: tenantA.tenantId, threadId });
      expect(observed.filter((event) => event.tenantId === tenantB.tenantId)).toEqual([]);
    } catch (error) {
      failure = { error };
    }
    try {
      listener.release(true);
    } catch (error) {
      if (failure) {
        // Keep the assertion failure primary while retaining the cleanup failure.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([failure.error, error], "Title invalidation cleanup failed", { cause: failure.error });
      }
      throw error;
    }
    if (failure) throw failure.error;
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
