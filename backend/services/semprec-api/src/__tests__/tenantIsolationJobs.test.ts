import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import * as Y from "yjs";
import { z } from "zod";
import { replayApprovedGenericOperation } from "@semprec/application";
import { REALTIME_CHANNEL, wireRealtimeHooks } from "@semprec/realtime";
import {
  CORE_TASK_NAMES,
  TASK_TENANCY,
  enqueueJob,
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
  CALENDAR_MODULE_ID,
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
  recordPendingSentCopy,
  removeMailbox,
  resolveMailModuleIds,
  recordHeartbeatFailure,
  registerCalendarFeedConsumer,
  requestTenantExport,
  resolveTaskAffinitySets,
  revokeAllPushSubscriptionsForUser,
  sendSempMessage,
  setEventInvitationDelivery,
  setInvalidationHook,
  setInvitationReplyDelivery,
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
  installQueueSchema,
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
import { allowLoopbackOutboundForTests } from "@semprec/data/testSupport/mcpContractServers";
import { createApiActionRegistry } from "../actionRegistryComposition.js";
import { createMailSyncAdapters } from "../mailSyncAdapters.js";
import { runTranscriptionFixture } from "./transcriptionHttpFixture.js";

interface RecordedBackgroundPush {
  deviceToken: string;
  data: unknown;
}

const backgroundPushes = vi.hoisted(() => ({ sent: [] as RecordedBackgroundPush[] }));

// Passthrough spy on the APNs background send: the real adapter answers `not-configured` without a network
// request, and the spy records which registration each run sent to. A string path because this package may not
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
 * Two-tenant proof that every task of the `api` affinity set keeps its data, notifications and side effects
 * inside its own tenant. Tasks are composed as `createApiQueueRuntime` composes them, under strict
 * tenant-scope enforcement. Jobs the fixture writes enqueue are discarded before the job under test runs.
 */

interface Tenant {
  tenantId: string;
  userId: string;
}

type Payload = Record<string, unknown>;

/** The calendar sync's writer identity, which only it may use for account calendars. */
const CALENDAR_SYNC = { writerKind: "system", systemProcess: "calendarSync" } as const;

/** A Graph subscription row of the account; without a push runtime the maintenance only forgets it. */
async function insertPushChannel(tenant: Tenant, accountItemId: string): Promise<void> {
  await inTenant(tenant, () =>
    pool.query(
      `INSERT INTO calendar_push_channels (provider, channel_id, account_item_id, secret, expires_at)
       VALUES ('graph', $1, $2, 'secret', now() + interval '1 day')`,
      [randomUUID(), accountItemId],
    ),
  );
}

interface TenantTaskCase {
  tenancy: "tenant";
  seed(tenant: Tenant): Promise<Payload>;
  /** The error this composition root's run ends with; `createApiQueueRuntime` wires no mail transport. */
  expectedError?: RegExp;
  expectDone(tenant: Tenant, payload: Payload): Promise<void>;
}

type Check = () => Promise<void>;

interface SeededWork {
  /** No row of another tenant may contain one of these ids. */
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
  /** A and B unless given. */
  tenants?(): Promise<[Tenant, Tenant]>;
  seed(tenant: Tenant): Promise<SeededWork>;
  /** Keeps a bystander's own work from falling due during the run; returns what restores it. */
  holdBystander?(tenant: Tenant): Promise<() => Promise<void>>;
}

interface GlobalSystemTaskCase {
  tenancy: "system";
  touchesTenantTables: false;
  seed(): Promise<Check>;
}

type TaskCase = TenantTaskCase | SystemTaskCase | GlobalSystemTaskCase;

type Fingerprint = Record<string, { count: number; md5: string }>;

interface JobOutcome {
  /** `null` once the job completed and graphile-worker deleted its row. */
  attempts: number | null;
  lastError: string | null;
}

const COMPLETED: JobOutcome = { attempts: null, lastError: null };
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let adminPool: Pool;
let pool: Pool;
let taskList: TaskList;
let tenantTables: string[];
let chokePoint: ChokePoint;
let docStore: DocStore;
let blobRoot: string;
const VAPID_ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const APNS_ENV = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY_PATH", "APNS_TOPIC"] as const;
const ENV_OVERRIDES = [
  "SEMPREC_TENANT_SCOPE",
  "AI_GATEWAY_INTERNAL_TOKEN",
  "FILES_STORAGE_DIR",
  "MAIL_ATTACHMENTS_DIR",
  ...VAPID_ENV,
  ...APNS_ENV,
] as const;
const previousEnv = new Map<string, string | undefined>();
let tenantA: Tenant;
let tenantB: Tenant;
let tenantZero: Tenant;
const titlePortCalls: { tenantId: string | null; input: AiGatewayCompletionInput }[] = [];

function scopeTenantId(): string | null {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? scope.tenantId : null;
}

const titlePort: AiGatewayClientPort = {
  async complete(input) {
    titlePortCalls.push({ tenantId: scopeTenantId(), input });
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

/** Tables whose catalog comment classifies them as tenant data (partitions count with their parent). */
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

/** Runs `query` once per tenant table inside the tenant's scope. */
function perTenantTable<T>(tenant: Tenant, query: (client: PoolClient, table: string) => Promise<T>) {
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const result: Array<[string, T]> = [];
      for (const table of tenantTables) result.push([table, await query(client, table)]);
      return result;
    }),
  );
}

async function fingerprint(tenant: Tenant): Promise<Fingerprint> {
  const entries = await perTenantTable(tenant, async (client, table) => {
    // `table` comes from pg_class, never from input; a table name cannot be a bind parameter.
    const { rows } = await client.query<{ count: number; md5: string }>(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS md5
         FROM ${escapeIdentifier(table)} t`,
    );
    const row = rows[0];
    if (!row) throw new Error(`fingerprint: no aggregate row for ${table}`);
    return { count: row.count, md5: row.md5 };
  });
  return Object.fromEntries(entries);
}

async function tablesMentioning(tenant: Tenant, markers: string[]): Promise<string[]> {
  const patterns = markers.map((marker) => `%${marker}%`);
  const entries = await perTenantTable(tenant, async (client, table) => {
    // `table` comes from pg_class, never from input; a table name cannot be a bind parameter.
    const { rows } = await client.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${escapeIdentifier(table)} t WHERE t::text LIKE ANY($1)) AS found`,
      [patterns],
    );
    return rows[0]?.found === true;
  });
  return entries.filter(([, found]) => found).map(([table]) => table);
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

async function expectRows(tenant: Tenant, sql: string, params: unknown[], expected: unknown[]): Promise<void> {
  expect(await rows(tenant, sql, params)).toEqual(expected);
}

async function notifications(tenant: Tenant): Promise<Array<{ id: string; user_id: string; kind: string }>> {
  return rows(tenant, "SELECT id, user_id, kind FROM notifications");
}

async function expectNewNotificationsAddressedTo(tenant: Tenant, before: Array<{ id: string }>): Promise<void> {
  const seen = new Set(before.map((row) => row.id));
  const added = (await notifications(tenant)).filter((row) => !seen.has(row.id));
  expect(added.map((row) => row.user_id).filter((userId) => userId !== tenant.userId)).toEqual([]);
}

async function jobOutcome(jobKey: string): Promise<JobOutcome> {
  const { rows } = await adminPool.query<{ attempts: number; last_error: string | null }>(
    "SELECT attempts, last_error FROM graphile_worker.jobs WHERE key = $1",
    [jobKey],
  );
  const row = rows[0];
  if (!row) return COMPLETED;
  return { attempts: row.attempts, lastError: row.last_error?.replace(UUID_PATTERN, "<id>") ?? null };
}

/** Removes a failed job so it cannot run again in a later case. */
async function removeJob(jobKey: string): Promise<void> {
  await adminPool.query("SELECT graphile_worker.remove_job($1)", [jobKey]);
}

async function queuedJobs(): Promise<Array<{ id: string; key: string | null; task_identifier: string }>> {
  return (
    await adminPool.query<{ id: string; key: string | null; task_identifier: string }>(
      "SELECT id::text AS id, key, task_identifier FROM graphile_worker.jobs",
    )
  ).rows;
}

/** The `jobs` view carries no tenant, so a job any run enqueued anywhere counts. */
async function sideEffectSnapshot(tenant: Tenant) {
  return {
    fingerprint: await fingerprint(tenant),
    notificationIds: new Set((await notifications(tenant)).map((row) => row.id)),
    jobIds: new Set((await queuedJobs()).map((job) => job.id)),
  };
}

/** Stated without ids so two runs naming different ids compare equal; changed tables include in-place updates. */
async function sideEffectsSince(
  tenant: Tenant,
  before: Awaited<ReturnType<typeof sideEffectSnapshot>>,
  ownJobKey: string,
) {
  const after = await fingerprint(tenant);
  const rowCountDeltas = Object.fromEntries(
    Object.entries(after)
      .map(([table, { count }]): [string, number] => [table, count - (before.fingerprint[table]?.count ?? 0)])
      .filter(([, delta]) => delta !== 0),
  );
  const changedTables = Object.entries(after)
    .filter(([table, { md5 }]) => before.fingerprint[table]?.md5 !== md5)
    .map(([table]) => table)
    .sort();
  const notificationKinds = (await notifications(tenant))
    .filter((row) => !before.notificationIds.has(row.id))
    .map((row) => row.kind)
    .sort();
  const queued = (await queuedJobs())
    .filter((job) => !before.jobIds.has(job.id) && job.key !== ownJobKey)
    .map((job) => job.task_identifier)
    .sort();
  return { rowCountDeltas, changedTables, notificationKinds, queuedJobs: queued };
}

const NO_EFFECTS = {
  outcome: COMPLETED,
  effects: { rowCountDeltas: {}, changedTables: [], notificationKinds: [], queuedJobs: [] },
};

async function runInBObserved(name: string, payload: Payload) {
  const before = await sideEffectSnapshot(tenantB);
  const jobKey = await runJobIn(tenantB, name, payload);
  const outcome = await jobOutcome(jobKey);
  const effects = await sideEffectsSince(tenantB, before, jobKey);
  await removeJob(jobKey);
  return { outcome, effects };
}

async function runJobIn(tenant: Tenant, name: string, payload: Payload): Promise<string> {
  const jobKey = randomUUID();
  await inTenant(tenant, () => enqueueJob(pool, name, payload, { jobKey }));
  await runOnce({ pgPool: pool, taskList });
  return jobKey;
}

async function runSystemJob(name: string): Promise<string> {
  const jobKey = randomUUID();
  await runAsSystem("test:enqueue-system-job", () => enqueueJob(pool, name, {}, { jobKey }));
  await runOnce({ pgPool: pool, taskList });
  return jobKey;
}

function withRandomIds(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID_PATTERN, () => randomUUID());
  if (Array.isArray(value)) return value.map(withRandomIds);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withRandomIds(entry)]));
  }
  return value;
}

function randomizedPayload(payload: Payload): Payload {
  return z.record(z.string(), z.unknown()).parse(withRandomIds(payload));
}

function tenancyOf(name: string): TaskTenancy {
  const declared: Readonly<Record<string, TaskTenancy>> = TASK_TENANCY;
  return Object.hasOwn(declared, name) ? (declared[name] ?? "tenant") : "tenant";
}

async function discardQueuedJobs(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
}

function str(payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`expected payload field ${field} to be a string`);
  return value;
}

function useVapidConfiguration(): void {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  process.env.VAPID_PUBLIC_KEY = keys.getPublicKey().toString("base64url");
  process.env.VAPID_PRIVATE_KEY = keys.getPrivateKey().toString("base64url");
  process.env.VAPID_SUBJECT = "mailto:ops@example.test";
}

/** With no APNs configuration the default sender answers `not-configured` without a network request. */
function useUnconfiguredApns(): void {
  for (const name of APNS_ENV) delete process.env[name];
}

function restoreEnv(names: readonly string[]): void {
  for (const name of names) {
    const value = previousEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

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

interface FeedFixture {
  server: http.Server;
  port: number;
  restorePolicy: () => void;
  consumed: string[];
}

let feedFixture: FeedFixture | null = null;

async function ensureFeedFixture(): Promise<FeedFixture> {
  if (feedFixture) return feedFixture;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"' });
    res.end("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("The feed server has no port");
  const consumed: string[] = [];
  registerCalendarFeedConsumer(async (_client, feed) => {
    consumed.push(feed.calendarItemId);
  });
  feedFixture = { server, port: address.port, restorePolicy: allowLoopbackOutboundForTests(), consumed };
  return feedFixture;
}

async function stopFeedFixture(): Promise<void> {
  const fixture = feedFixture;
  feedFixture = null;
  if (!fixture) return;
  registerCalendarFeedConsumer(null);
  fixture.restorePolicy();
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}

async function moduleDatabaseId(tenant: Tenant, moduleId: string): Promise<string> {
  const database = await inTenant(tenant, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`expected the ${moduleId} database to be seeded`);
  return database.id;
}

/** Inside a tenant scope. */
async function propertyId(databaseId: string, key: string): Promise<string> {
  const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
  if (!property) throw new Error(`expected the ${key} property to be seeded`);
  return property.id;
}

/** Inside a tenant scope; a user relation through the choke point. */
async function relate(databaseId: string, key: string, callerItemId: string, targetItemId: string): Promise<void> {
  await chokePoint.createRelation({
    relationPropertyId: await propertyId(databaseId, key),
    callerItemId,
    targetItemId,
  });
}

/** The fanout job reads the real clock; with the mute on, a run at night would hold the push until wake time. */
async function switchSleepMuteOff(tenant: Tenant): Promise<void> {
  const databaseId = await moduleDatabaseId(tenant, "sleepSettings");
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

async function createMailbox(tenant: Tenant, options: { calendarsEnabled?: boolean } = {}): Promise<string> {
  const mailboxesId = await moduleDatabaseId(tenant, "mailboxes");
  return inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: {
          name: `Mailbox ${randomUUID()}`,
          provider: "generic",
          ...(options.calendarsEnabled === true ? { calendarsEnabled: true } : {}),
        },
      });
      await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: "s3cr3t" });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      return mailbox.id;
    }),
  );
}

/** A message ingested into the mailbox's Inbox folder as mail sync stores it, with the thread item it joined. */
async function ingestMessage(
  client: PoolClient,
  mailboxItemId: string,
  content: { subject?: string; bodyText?: string } = {},
) {
  const ids = await resolveMailModuleIds(client);
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
    arrival: "live",
    contentState: "full",
    emailsDatabaseId: ids.emailsDatabaseId,
    filesDatabaseId: ids.filesDatabaseId,
    folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
    attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
    folderItemId,
    mailboxItemId,
    messageId: `<${randomUUID()}@example.test>`,
    envelope: { from: { address: "sender@example.test" } },
    ...content,
    attachments: [],
    storage: new LocalFsBlobStorageWriter(join(blobRoot, "mail")),
    storageKeyPrefix: mailboxItemId,
  });
  const { rows: threads } = await client.query<{ item_id: string }>(
    "SELECT t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1",
    [ingested.itemId],
  );
  const threadItemId = threads[0]?.item_id;
  if (!threadItemId) throw new Error("expected the ingested message to have a thread item");
  return { ids, itemId: ingested.itemId, threadItemId };
}

async function createEmail(tenant: Tenant): Promise<string> {
  const emailsDatabaseId = await moduleDatabaseId(tenant, "emails");
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
  return item.id;
}

/** A daily heartbeat running an api-affinity action that finds nothing to do. */
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

async function createRollupFixture(tenant: Tenant) {
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

async function expectRollupCount(tenant: Tenant, payload: Payload): Promise<void> {
  const project = await inTenant(tenant, () =>
    chokePoint.getItem(str(payload, "projectsId"), str(payload, "projectId")),
  );
  expect(project?.computed.taskCount).toBe(1);
}

async function createReadyExport(tenant: Tenant): Promise<string> {
  const requested = await inTenant(tenant, () =>
    withTransaction(pool, (client) => requestTenantExport(client, tenant.userId)),
  );
  await discardQueuedJobs();
  const jobKey = await runJobIn(tenant, CORE_TASK_NAMES.TENANT_EXPORT, { exportId: requested.export.id });
  expect(await jobOutcome(jobKey)).toEqual(COMPLETED);
  return requested.export.id;
}

/**
 * The link queues the person's `lastContact` recompute; it is removed here, so only the job under test can
 * set the value.
 */
async function createPersonWithEvent(tenant: Tenant, date: string, timeFrom?: string) {
  const peopleId = await moduleDatabaseId(tenant, "people");
  const eventsId = await moduleDatabaseId(tenant, "events");
  return inTenant(tenant, async () => {
    const person = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Contact" } });
    const event = await chokePoint.createItem({
      databaseId: eventsId,
      properties: { name: "Meeting", date, ...(timeFrom === undefined ? {} : { timeFrom }) },
    });
    await relate(eventsId, "people", event.id, person.id);
    await removeJob(`people-last-contact:${person.id}`);
    return { personId: person.id, eventId: event.id };
  });
}

async function itemProperty(tenant: Tenant, itemId: string, key: string): Promise<unknown> {
  const found = await rows<{ value: unknown }>(
    tenant,
    "SELECT properties -> $2::text AS value FROM items WHERE id = $1",
    [itemId, key],
  );
  if (found.length !== 1) throw new Error("expected the item to exist");
  return found[0]?.value ?? null;
}

const PAST_EVENT_DATE = "2025-06-15";

/** `null` outside a tenant scope. */
interface RecordedInvalidation {
  tenantId: string | null;
  event: InvalidationEvent;
}

let recordedInvalidations: RecordedInvalidation[] = [];

/** A job that only announces changes no row, so its effect shows nowhere else. */
function recordInvalidations(): void {
  const recorded: RecordedInvalidation[] = [];
  recordedInvalidations = recorded;
  setInvalidationHook((event) => recorded.push({ tenantId: scopeTenantId(), event }));
}

function stopRecordingInvalidations(): RecordedInvalidation[] {
  setInvalidationHook(() => {});
  return recordedInvalidations;
}

/**
 * The stored `hiddenUntil` a task holds once its Event ends. The move is written directly because the choke
 * point would recompute the task at once; in production only the clock reveals it.
 */
async function createTaskHiddenInPassedEvent(tenant: Tenant): Promise<string> {
  const eventsId = await moduleDatabaseId(tenant, "events");
  const tasksId = await moduleDatabaseId(tenant, "tasks");
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
  return marked([itemId, databaseId], () =>
    expectRows(tenant, "SELECT 1 FROM items WHERE id = $1 AND database_id = $2", [itemId, databaseId], []),
  );
}

const CALENDAR_SEND_EVENT_INVITATION_TASK = "calendarSendEventInvitation";
const CALENDAR_SEND_INVITATION_REPLY_TASK = "calendarSendInvitationReply";
const MAIL_SYNC_THREAD_TASK_PEOPLE_TASK = "mailSyncThreadTaskPeople";
const MAIL_TRIAGE_THREAD_PROJECT_TASK = "mailTriageThreadProject";
const SLEEP_RESYNC_TASK = "sleep.resync";

const invitationSends: Array<{
  tenantId: string | null;
  mailboxId: string;
  method: string | null;
  from: string;
  recipients: string[];
}> = [];

/** Records each message with its mailbox and the tenant scope of the sending job instead of sending it. */
const invitationTransports: MailTransportFactory = {
  async forMailbox(mailboxId) {
    return {
      async send(message) {
        invitationSends.push({
          tenantId: scopeTenantId(),
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

/** Seeds and returns by the payload's key what a case's expectDone checks against. */
const seededByKey = new Map<string, Record<string, string>>();

function seeded(payload: Payload, key: string): Record<string, string> {
  const value = seededByKey.get(str(payload, key));
  if (!value) throw new Error(`expected the case to have seeded ${key}`);
  return value;
}

/** A thread with a task made from it, and a person then linked as the message's sender, whom the task's people do not include yet. */
async function seedThreadTaskWithNewPerson(tenant: Tenant) {
  const mailboxItemId = await createMailbox(tenant);
  const peopleDatabaseId = await moduleDatabaseId(tenant, "people");
  return inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const { ids, itemId, threadItemId } = await ingestMessage(client, mailboxItemId);
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
          callerItemId: itemId,
          targetItemId: person.id,
        },
        { ownerProcess: "emails" },
      );
      return { threadItemId, personId: person.id, taskId: task.id };
    }),
  );
}

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

async function activeApnsTokens(tenant: Tenant): Promise<string[]> {
  const found = await rows<{ device_token: string }>(
    tenant,
    "SELECT device_token FROM push_subscriptions WHERE user_id = $1 AND channel = 'apns' AND revoked_at IS NULL",
    [tenant.userId],
  );
  return found.map((row) => row.device_token);
}

/** Every tenant gets an active iOS registration, so a job that pushed for another tenant would have one to send to. */
function resyncCase(kind: string): TenantTaskCase {
  return {
    tenancy: "tenant",
    async seed(tenant) {
      useUnconfiguredApns();
      for (const other of [tenantA, tenantB]) {
        await inTenant(other, async () => {
          await revokeAllPushSubscriptionsForUser(pool, other.userId);
          await upsertApnsSubscription(pool, {
            userId: other.userId,
            sessionId: null,
            platform: "ios",
            deviceToken: randomUUID(),
            apnsEnvironment: "sandbox",
          });
        });
      }
      backgroundPushes.sent.length = 0;
      return { tenantId: tenant.tenantId };
    },
    async expectDone(tenant) {
      const tokens = await activeApnsTokens(tenant);
      expect(tokens).toHaveLength(1);
      expect(backgroundPushes.sent).toEqual([{ deviceToken: tokens[0], data: { kind } }]);
    },
  };
}

/** A mailbox item whose addresses are written through the system key, as mailbox setup writes them. */
async function createAddressedMailbox(client: PoolClient, databaseId: string, addresses: string) {
  return createItemWithClient(
    client,
    { databaseId, properties: { name: `Mailbox ${randomUUID()}`, provider: "generic", addresses } },
    { allowedSystemKeys: ["addresses"] },
  );
}

/** The invitation is stored through the system writer, as the invitation code stores it. */
async function seedInvitation(tenant: Tenant) {
  const mailboxesId = await moduleDatabaseId(tenant, "mailboxes");
  const peopleId = await moduleDatabaseId(tenant, "people");
  const eventsId = await moduleDatabaseId(tenant, "events");
  const attendeeEmail = `attendee-${randomUUID()}@example.test`;
  const mailboxAddress = `organizer-${randomUUID()}@example.test`;
  return inTenant(tenant, async () => {
    const mailboxId = (
      await withTransaction(pool, (client) => createAddressedMailbox(client, mailboxesId, mailboxAddress))
    ).id;
    const person = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Invitee" } });
    const event = await chokePoint.createItem({
      databaseId: eventsId,
      properties: { name: "Isolation meeting", date: "2099-01-15", timeFrom: "09:00", timeTo: "10:00" },
    });
    await chokePoint.createRelation(
      {
        relationPropertyId: await propertyId(eventsId, "people"),
        callerItemId: event.id,
        targetItemId: person.id,
        metadata: { invitation: { status: "pending", email: attendeeEmail, mailboxId } },
      },
      SYSTEM_WRITER,
    );
    return { eventId: event.id, personId: person.id, mailboxId, mailboxAddress, attendeeEmail };
  });
}

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

async function seedAnsweredInvitation(tenant: Tenant) {
  const mailboxesId = await moduleDatabaseId(tenant, "mailboxes");
  const invitationsId = await moduleDatabaseId(tenant, "invitations");
  const organizerEmail = `organizer-${randomUUID()}@example.test`;
  const mailboxAddress = `mailbox-${randomUUID()}@example.test`;
  const respondedAt = new Date().toISOString();
  const mailboxPropertyId = await inTenant(tenant, () => propertyId(invitationsId, "mailbox"));
  const properties = {
    title: "Isolation invitation",
    startsAt: "2099-01-15T09:00:00.000Z",
    endsAt: "2099-01-15T10:00:00.000Z",
    allDay: false,
    organizerEmail,
    status: "accepted",
    kind: "invite",
    uid: `${randomUUID()}@example.test`,
    sequence: 0,
    respondedAt,
  };
  const ids = await inTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const mailbox = await createAddressedMailbox(client, mailboxesId, mailboxAddress);
      const invitation = await createItemWithClient(
        client,
        { databaseId: invitationsId, properties },
        { allowedSystemKeys: Object.keys(properties), systemOwnerProcess: CALENDAR_MODULE_ID },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: mailboxPropertyId, callerItemId: invitation.id, targetItemId: mailbox.id },
        { ownerProcess: CALENDAR_MODULE_ID },
      );
      return { invitationId: invitation.id, mailboxId: mailbox.id };
    }),
  );
  return { ...ids, organizerEmail, mailboxAddress, respondedAt };
}

interface TriageQuestion {
  tenantId: string | null;
  offeredProjectIds: string[];
}

const triageQuestions: TriageQuestion[] = [];

/** The project the latest seed made; earlier cases leave projects behind. */
let triageProjectName = "";

const offeredProjects = z.array(z.object({ id: z.uuid(), name: z.string() }));

const triageGateway: AiGatewayClientPort = {
  async complete(input) {
    const message = input.messages[0];
    const text = typeof message?.content === "string" ? message.content : "";
    const offered = offeredProjects.parse(
      JSON.parse(text.slice(text.indexOf("Candidate projects: ") + "Candidate projects: ".length)),
    );
    triageQuestions.push({ tenantId: scopeTenantId(), offeredProjectIds: offered.map((project) => project.id) });
    const chosen = offered.find((project) => project.name === triageProjectName);
    return { content: { projectId: chosen?.id ?? null, confidence: 0.95 }, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

let journalDaysSeeded = 0;

const cases: Record<string, TaskCase> = {
  [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: {
    tenancy: "tenant",
    async seed(tenant) {
      titlePortCalls.length = 0;
      return inTenant(tenant, () =>
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
      await expectRows(
        tenant,
        "SELECT title FROM semp_threads WHERE id = $1",
        [str(payload, "threadId")],
        [{ title: "Tenant title" }],
      );
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
  // No configured link rules: this exercises registered refusal, not successful propagation.
  [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: {
    tenancy: "tenant",
    expectedError: /Value link rule is unavailable/,
    async seed(tenant) {
      const companiesId = await moduleDatabaseId(tenant, "companies");
      const source = await inTenant(tenant, () =>
        chokePoint.createItem({ databaseId: companiesId, properties: { name: "Link source" } }),
      );
      return { ruleKey: "unconfigured.fixture", sourceItemId: source.id, hop: 1 };
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT properties->>'name' AS name FROM items WHERE id = $1",
        [str(payload, "sourceItemId")],
        [{ name: "Link source" }],
      );
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
      await expectRows(
        tenant,
        "SELECT last_error FROM project_heartbeats WHERE id = $1",
        [str(payload, "heartbeatId")],
        [{ last_error: null }],
      );
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
        // Simulate an item predating indexing.
        const removed = await pool.query("DELETE FROM item_search_index WHERE item_id = $1", [item.id]);
        expect(removed.rowCount).toBe(1);
        return { databaseId: database.id };
      });
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        `SELECT i.properties ->> 'title' AS title,
           s.search_vector @@ plainto_tsquery('czech', 'Legacy searchable') AS matches
         FROM items i JOIN item_search_index s ON s.item_id = i.id
         WHERE i.database_id = $1`,
        [str(payload, "databaseId")],
        [{ title: "Legacy searchable", matches: true }],
      );
    },
  },
  [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: {
    tenancy: "tenant",
    async seed(tenant) {
      const projectsId = await moduleDatabaseId(tenant, "projects");
      const tasksId = await moduleDatabaseId(tenant, "tasks");
      return inTenant(tenant, async () => {
        const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Původní" } });
        const task = await chokePoint.createItem({ databaseId: tasksId, properties: { name: "Závislý úkol" } });
        await relate(tasksId, "project", task.id, project.id);
        // A stale dependent document: the title is written directly so only this job rebuilds it.
        const renamed = await pool.query(
          "UPDATE items SET properties = properties || jsonb_build_object('name', 'Přejmenovaný') WHERE id = $1",
          [project.id],
        );
        expect(renamed.rowCount).toBe(1);
        return { kind: "referrers", itemId: project.id };
      });
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        `SELECT s.search_vector @@ plainto_tsquery('czech_simple', 'Přejmenovaný') AS matches
         FROM item_relations r JOIN item_search_index s ON s.item_id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END
         WHERE r.item_a = $1 OR r.item_b = $1`,
        [str(payload, "itemId")],
        [{ matches: true }],
      );
    },
  },
  [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: {
    tenancy: "tenant",
    async seed(tenant) {
      const databaseId = await moduleDatabaseId(tenant, "tasks");
      return inTenant(tenant, async () => {
        const item = await chokePoint.createItem({ databaseId, properties: { name: "Isolated page" } });
        await writePageTextBlocks(pool, item.id, ["Stránka tenanta A"]);
        return { itemId: item.id };
      });
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT page_text FROM item_search_index WHERE item_id = $1",
        [str(payload, "itemId")],
        [{ page_text: "Stránka tenanta A" }],
      );
    },
  },
  [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: {
    tenancy: "tenant",
    async seed(tenant) {
      const databaseId = await moduleDatabaseId(tenant, "tasks");
      return inTenant(tenant, async () => {
        const host = await chokePoint.createItem({ databaseId, properties: { name: "Mirror host" } });
        const created = await docStore.createSubpage({ parent: { itemId: host.id }, title: "Before" }, "user");
        const blockId = created.pages[0]?.blockId;
        const doc = await docStore.getDoc(host.id);
        if (!blockId || !doc) throw new Error("expected a subpage block in the host document");
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
      await expectRows(
        tenant,
        `SELECT i.properties ->> 'title' AS title FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id = 'pages' AND i.properties ->> 'parentItemId' = $1`,
        [str(payload, "itemId")],
        [{ title: "Stránka tenanta A" }],
      );
    },
  },
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const fixture = await createRollupFixture(tenant);
      return { ...fixture, itemId: fixture.projectId };
    },
    expectDone: expectRollupCount,
  },
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: {
    tenancy: "tenant",
    seed: createRollupFixture,
    expectDone: expectRollupCount,
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
      await expectRows(
        tenant,
        "SELECT migration_status FROM properties WHERE id = $1",
        [str(payload, "propertyId")],
        [{ migration_status: "partial" }],
      );
      const good = await inTenant(tenant, () =>
        chokePoint.getItem(str(payload, "databaseId"), str(payload, "goodItemId")),
      );
      expect(good?.properties.score).toBe(42);
    },
  },
  // A placeholder handler that reads no payload and writes nothing yet.
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
      return inTenant(tenant, async () => {
        const database = await chokePoint.createDatabase({ name: `Library ${randomUUID()}` });
        const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
        await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
        return { itemId: item.id, databaseId: database.id, config: { source: "tmdb", coverKey: "cover" } };
      });
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT status FROM item_automation WHERE item_id = $1",
        [str(payload, "itemId")],
        [{ status: "done" }],
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: {
    tenancy: "tenant",
    async seed(tenant) {
      return { mailboxItemId: await createMailbox(tenant) };
    },
    expectedError: /^No IMAP adapter configured for this composition root$/,
    async expectDone(tenant, payload) {
      const mailboxItemId = str(payload, "mailboxItemId");
      await expectRows(
        tenant,
        "SELECT last_error FROM mail_account_sync_state WHERE item_id = $1",
        [mailboxItemId],
        [{ last_error: "No IMAP adapter configured for this composition root" }],
      );
      await expectRows(
        tenant,
        "SELECT user_id FROM notifications WHERE kind = 'mail_sync_error' AND source_id = $1",
        [mailboxItemId],
        [{ user_id: tenant.userId }],
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_SENT_COPY]: {
    tenancy: "tenant",
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant);
      // Recording queues this job itself; the driver discards it.
      const copyId = await inTenant(tenant, () =>
        withTransaction(pool, (client) =>
          recordPendingSentCopy(client, {
            mailboxItemId,
            messageId: `<${randomUUID()}@example.test>`,
            raw: Buffer.from("Subject: Sent\r\n\r\nHello\r\n"),
          }),
        ),
      );
      return { copyId };
    },
    // The fixture mailbox has no folders, so the job finds no Sent folder after its tenant-scoped reads.
    expectedError: /^The mailbox has no Sent folder yet$/,
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT failed_at IS NULL AS pending FROM mail_sent_copies WHERE id = $1",
        [str(payload, "copyId")],
        [{ pending: true }],
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC]: {
    tenancy: "tenant",
    async seed(tenant) {
      return { accountItemId: await createMailbox(tenant, { calendarsEnabled: true }) };
    },
    // The fixture mailbox has no server settings, so the CalDAV adapter refuses it after the tenant-scoped reads.
    expectedError: /^Account <id> has no mail server settings$/,
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT status, last_error_code FROM calendar_account_sync_state WHERE account_item_id = $1",
        [str(payload, "accountItemId")],
        [{ status: "error", last_error_code: "unexpected" }],
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_CLEANUP]: {
    tenancy: "tenant",
    async seed(tenant) {
      const accountItemId = await createMailbox(tenant, { calendarsEnabled: true });
      const calendarsId = await moduleDatabaseId(tenant, "calendars");
      const accountProperty = await inTenant(tenant, () => propertyId(calendarsId, "account"));
      // An account calendar without remote state is one the sync no longer tracks.
      const calendarItemId = await inTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const calendar = await createItemWithClient(
            client,
            {
              databaseId: calendarsId,
              properties: { kind: "account", name: null, color: null, remoteName: "Work", readOnly: false },
            },
            {
              writer: CALENDAR_SYNC,
              allowedSystemKeys: ["kind", "remoteName", "readOnly"],
              systemOwnerProcess: CALENDAR_MODULE_ID,
            },
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: accountProperty, callerItemId: calendar.id, targetItemId: accountItemId },
            { ownerProcess: CALENDAR_MODULE_ID },
            CALENDAR_SYNC,
          );
          return calendar.id;
        }),
      );
      seededByKey.set(accountItemId, { calendarItemId });
      return { accountItemId };
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1",
        [seeded(payload, "accountItemId").calendarItemId],
        [{ trashed: true }],
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_EVENT_PUSH]: {
    tenancy: "tenant",
    async seed(tenant) {
      const eventsId = await moduleDatabaseId(tenant, "events");
      const eventItemId = await inTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const event = await createItemWithClient(client, {
            databaseId: eventsId,
            properties: { name: "Dinner", date: "2026-11-27" },
          });
          // An Event outside account calendars records no push itself; the row stands for a change since moved out.
          await client.query("INSERT INTO calendar_event_push_state (event_item_id, operation) VALUES ($1, 'update')", [
            event.id,
          ]);
          return event.id;
        }),
      );
      return { eventItemId };
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT status FROM calendar_event_push_state WHERE event_item_id = $1",
        [str(payload, "eventItemId")],
        [{ status: "sent" }],
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_INVITATION_RESPOND]: {
    tenancy: "tenant",
    async seed(tenant) {
      // No synced Event is linked, so the answer cannot reach a provider and the invitation is pending again.
      const { invitationId, respondedAt } = await seedAnsweredInvitation(tenant);
      return { invitationId, response: "accepted", respondedAt };
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT properties->>'status' AS status FROM items WHERE id = $1",
        [str(payload, "invitationId")],
        [{ status: "pending" }],
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS]: {
    tenancy: "tenant",
    async seed(tenant) {
      const accountItemId = await createMailbox(tenant);
      await insertPushChannel(tenant, accountItemId);
      return { accountItemId };
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        "SELECT channel_id FROM calendar_push_channels WHERE account_item_id = $1",
        [str(payload, "accountItemId")],
        [],
      );
    },
  },
  [CORE_TASK_NAMES.MAILBOX_REMOVAL]: {
    tenancy: "tenant",
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant);
      await inTenant(tenant, async () => {
        await withTransaction(pool, (client) => ingestMessage(client, mailboxItemId));
        // The removal queues this job itself; the driver discards it. An empty affinity map routes the
        // removal's heartbeats to the default queue.
        if (!(await removeMailbox(pool, mailboxItemId, { queueAffinity: new Map() }))) {
          throw new Error("expected the seeded mailbox to be removed");
        }
      });
      return { mailboxItemId };
    },
    async expectDone(tenant, payload) {
      await expectRows(
        tenant,
        `SELECT d.owner_module_id AS module FROM items i JOIN databases d ON d.id = i.database_id
          WHERE i.id <> $1 AND i.deleted_at = (SELECT m.deleted_at FROM items m WHERE m.id = $1)
          ORDER BY d.owner_module_id`,
        [str(payload, "mailboxItemId")],
        [{ module: "emails" }, { module: "folders" }],
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: {
    tenancy: "tenant",
    async seed(tenant) {
      const address = `${randomUUID()}@example.test`;
      const peopleDatabaseId = await moduleDatabaseId(tenant, "people");
      const itemId = await createEmail(tenant);
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
            arrival: "live",
            contentState: "full",
            itemId,
            mailboxItemId: null,
            messageId: `<${randomUUID()}@example.test>`,
            envelope: { from: { address }, to: [{ address }] },
          });
          return person.id;
        }),
      );
      const action = createApiActionRegistry(pool, moduleRegistry).get(MAIL_REINDEX_PERSON_EMAILS_ACTION_ID);
      if (!action) throw new Error("Missing person email reindex action");
      await inTenant(tenant, () =>
        action({ peopleDatabaseId }, { heartbeatId: "test", projectItemId: "test", itemId: personId }),
      );
      await expectRows(
        tenant,
        "SELECT item_id FROM person_email_index WHERE email = $1",
        [address],
        [{ item_id: personId }],
      );
      await expectRows(
        tenant,
        "SELECT id FROM item_relations WHERE item_a = $1 AND item_b = $2",
        [itemId, personId],
        [],
      );
      return { personId, addresses: [address] };
    },
    async expectDone(tenant, payload) {
      const parsed = z.object({ addresses: z.array(z.string()).length(1) }).parse(payload);
      await expectRows(
        tenant,
        `SELECT p.key FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id = d.property_id_a JOIN mail_message_meta m ON m.item_id = r.item_a
         WHERE r.item_b = $1 AND m.envelope @> $2::jsonb ORDER BY p.key`,
        [str(payload, "personId"), JSON.stringify({ from: { address: parsed.addresses[0] } })],
        [{ key: "recipientsPeople" }, { key: "senderPeople" }],
      );
    },
  },
  [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const journalId = await moduleDatabaseId(tenant, JOURNAL_MODULE_ID);
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
      await expectRows(
        tenant,
        "SELECT computed -> 'inboxItems' AS inbox_items FROM items WHERE id = $1",
        [str(payload, "journalDayItemId")],
        [{ inbox_items: [] }],
      );
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
      await expectRows(
        tenant,
        "SELECT execution_status FROM approval_requests WHERE id = $1",
        [str(payload, "approvalRequestId")],
        [{ execution_status: "conflict" }],
      );
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
            // Critical, so the default preferences push it; a warning would not be pushed.
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
      await expectRows(
        tenant,
        `SELECT (delivered_at IS NOT NULL OR failed_permanently_at IS NOT NULL) AS settled
           FROM push_deliveries WHERE notification_id = $1`,
        [str(payload, "notificationId")],
        [{ settled: true }],
      );
    },
  },
  [CORE_TASK_NAMES.PUSH_DISMISS]: {
    tenancy: "tenant",
    async seed(tenant) {
      // A VAPID configuration and valid keys let the real Web Push send build its request; the loopback
      // endpoint is refused by the outbound address policy without network, so the job revokes it as dead.
      useVapidConfiguration();
      return inTenant(tenant, async () => {
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
      // With no APNs configuration the real adapter answers `not-configured`, which the job accepts. What the job
      // sends is proven with a fake sender in `pushBadgeRefresh.test.ts`.
      useUnconfiguredApns();
      return inTenant(tenant, async () => {
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
      // `not-configured` does not revoke.
      expect(await activeApnsTokens(tenant)).toHaveLength(1);
    },
  },
  [SLEEP_RESYNC_TASK]: resyncCase("sleepResync"),
  [CORE_TASK_NAMES.REMINDERS_RESYNC]: resyncCase("remindersResync"),
  [CORE_TASK_NAMES.MCP_SERVER_SYNC]: {
    tenancy: "tenant",
    async seed(tenant) {
      const databaseId = await moduleDatabaseId(tenant, "mcpServers");
      // No connection config: the sync stops at the connection factory without network and records
      // `syncStatus: error`, which the job accepts.
      const server = await inTenant(tenant, () =>
        withTransaction(pool, (client) =>
          createItemWithClient(client, { databaseId, properties: { name: "Isolation server", active: true } }),
        ),
      );
      return { mcpServerItemId: server.id, actingUserId: tenant.userId };
    },
    async expectDone(tenant, payload) {
      expect(await itemProperty(tenant, str(payload, "mcpServerItemId"), "syncStatus")).toBe("error");
    },
  },
  [MAIL_SYNC_THREAD_TASK_PEOPLE_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      const { threadItemId, personId, taskId } = await seedThreadTaskWithNewPerson(tenant);
      expect(await tasksWithPerson(tenant, personId)).toEqual([]);
      seededByKey.set(personId, { taskId });
      return { threadItemId, personId };
    },
    async expectDone(tenant, payload) {
      expect(await tasksWithPerson(tenant, str(payload, "personId"))).toEqual([seeded(payload, "personId").taskId]);
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
      await expectRows(
        tenant,
        "SELECT status FROM tenant_exports WHERE id = $1",
        [str(payload, "exportId")],
        [{ status: "ready" }],
      );
    },
  },

  [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const heartbeatId = await createRetrySweepHeartbeat(tenant);
      // No production writer makes a heartbeat due now.
      await inTenant(tenant, () =>
        pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
          heartbeatId,
        ]),
      );
      return marked([heartbeatId], () =>
        expectRows(
          tenant,
          "SELECT status FROM heartbeat_occurrences WHERE heartbeat_id = $1",
          [heartbeatId],
          [{ status: "succeeded" }],
        ),
      );
    },
    // A bystander's own heartbeat falls due whenever the wall clock passes its next_fire_at, and the sweep then rightly
    // fires it in that tenant. With all of them deferred for the run, any change to a bystander is a write the sweep
    // should not have made. Raw SQL: production writers only ever recompute next_fire_at from the rule.
    async holdBystander(tenant) {
      const deferred = await inTenant(tenant, async () =>
        z.array(z.object({ id: z.uuid(), next_fire_at: z.date() })).parse(
          (
            await pool.query(
              `WITH held AS (SELECT id, next_fire_at FROM project_heartbeats WHERE next_fire_at IS NOT NULL FOR UPDATE)
                 UPDATE project_heartbeats h SET next_fire_at = now() + interval '1 day' FROM held
                  WHERE h.id = held.id RETURNING h.id, held.next_fire_at`,
            )
          ).rows,
        ),
      );
      return async () => {
        await inTenant(tenant, () =>
          pool.query(
            `UPDATE project_heartbeats h SET next_fire_at = held.next_fire_at
               FROM unnest($1::uuid[], $2::timestamptz[]) AS held(id, next_fire_at) WHERE h.id = held.id`,
            [deferred.map((row) => row.id), deferred.map((row) => row.next_fire_at)],
          ),
        );
      };
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
        return requireDocId(item.id);
      });
      return marked([docId], async () => {
        await expectRows(
          tenant,
          "SELECT count(*)::int AS count FROM doc_updates WHERE doc_id = $1",
          [docId],
          [{ count: 0 }],
        );
        await expectRows(tenant, "SELECT 1 AS present FROM doc_snapshots WHERE doc_id = $1", [docId], [{ present: 1 }]);
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
        const id = await requireDocId(item.id);
        // No production writer moves the history baseline into the past.
        await pool.query("UPDATE docs SET history_available_from = now() - interval '40 days' WHERE id = $1", [id]);
        await pool.query(
          `UPDATE doc_snapshot_history SET represented_at = now() - interval '40 days'
            WHERE doc_id = $1 AND through_update_id = 0`,
          [id],
        );
        return id;
      });
      return marked([docId], () =>
        expectRows(
          tenant,
          "SELECT history_available_from > now() - interval '39 days' AS rebaselined FROM docs WHERE id = $1",
          [docId],
          [{ rebaselined: true }],
        ),
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant);
      // The sweep enqueues the mailbox's sync, which fails for want of a transport.
      return marked([mailboxItemId], () =>
        expectRows(
          tenant,
          "SELECT last_error FROM mail_account_sync_state WHERE item_id = $1",
          [mailboxItemId],
          [{ last_error: "No IMAP adapter configured for this composition root" }],
        ),
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const accountItemId = await createMailbox(tenant, { calendarsEnabled: true });
      // The sweep enqueues the account's calendar sync, which fails for want of an adapter.
      return marked([accountItemId], () =>
        expectRows(
          tenant,
          "SELECT status, last_error_code FROM calendar_account_sync_state WHERE account_item_id = $1",
          [accountItemId],
          [{ status: "error", last_error_code: "unexpected" }],
        ),
      );
    },
  },
  [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const accountItemId = await createMailbox(tenant);
      await insertPushChannel(tenant, accountItemId);
      // The sweep queues the account's maintenance, which forgets the channel of an account with Calendars off.
      return marked([accountItemId], () =>
        expectRows(
          tenant,
          "SELECT channel_id FROM calendar_push_channels WHERE account_item_id = $1",
          [accountItemId],
          [],
        ),
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_CONTENT_CACHE_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const itemId = await inTenant(tenant, async () => {
        const database = await chokePoint.createDatabase({ name: `Cached ${randomUUID()}` });
        const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
        // Production only writes rows valid for seven days.
        await pool.query(
          `INSERT INTO mail_message_content_cache (item_id, body_text, fetched_at, expires_at)
           VALUES ($1, 'cached', now() - interval '8 days', now() - interval '1 day')`,
          [item.id],
        );
        return item.id;
      });
      return marked([itemId], () =>
        expectRows(tenant, "SELECT 1 FROM mail_message_content_cache WHERE item_id = $1", [itemId], []),
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const stateId = randomUUID();
      // Production only creates states valid for ten minutes.
      await inTenant(tenant, () =>
        pool.query(
          `INSERT INTO mail_oauth_states
             (id, user_id, provider, state_hash, code_verifier_ciphertext, code_verifier_nonce, expires_at, services)
           VALUES ($1, $2, 'gmail', $3, $4, $5, now() - interval '1 minute', '{mail}')`,
          [stateId, tenant.userId, randomUUID(), Buffer.from("ciphertext"), Buffer.from("nonce")],
        ),
      );
      return marked([stateId], () =>
        expectRows(tenant, "SELECT 1 FROM mail_oauth_states WHERE id = $1", [stateId], []),
      );
    },
  },
  [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const itemId = await createEmail(tenant);
      await inTenant(tenant, () => pool.query("DELETE FROM item_search_index WHERE item_id = $1", [itemId]));
      return marked([itemId], () =>
        expectRows(tenant, "SELECT 1 AS present FROM item_search_index WHERE item_id = $1", [itemId], [{ present: 1 }]),
      );
    },
  },
  [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: { tenancy: "system", touchesTenantTables: true, seed: createExpiredTrash },
  [CORE_TASK_NAMES.TRASH_PURGE]: { tenancy: "system", touchesTenantTables: true, seed: createExpiredTrash },
  [CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const blobId = randomUUID();
      // An unreferenced standalone upload, back-dated because the sweep skips anything younger than 24 hours.
      await inTenant(tenant, () =>
        pool.query(
          `INSERT INTO blobs (id, mime_type, byte_size, storage_key, created_at)
           VALUES ($1, 'image/png', 1, $2, now() - interval '25 hours')`,
          [blobId, `${tenant.tenantId}/blobs/${randomUUID()}`],
        ),
      );
      return marked([blobId], () => expectRows(tenant, "SELECT 1 FROM blobs WHERE id = $1", [blobId], []));
    },
  },
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const { personId } = await createPersonWithEvent(tenant, PAST_EVENT_DATE);
      return { personId };
    },
    async expectDone(tenant, payload) {
      expect(await itemProperty(tenant, str(payload, "personId"), "lastContact")).toBe(PAST_EVENT_DATE);
    },
  },
  [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: {
    tenancy: "tenant",
    async seed(tenant) {
      const projectsId = await moduleDatabaseId(tenant, "projects");
      const eventsId = await moduleDatabaseId(tenant, "events");
      const projectItemId = await inTenant(tenant, async () => {
        const project = await chokePoint.createItem({ databaseId: projectsId, properties: { name: "Project" } });
        const event = await chokePoint.createItem({
          databaseId: eventsId,
          properties: { name: "Project event", date: "2026-10-16" },
        });
        await relate(eventsId, "project", event.id, project.id);
        return project.id;
      });
      // Started after the fixture's own writes, so only the job under test is recorded.
      recordInvalidations();
      return { projectItemId };
    },
    async expectDone(tenant, payload) {
      const announced = stopRecordingInvalidations();
      // Only an Event reads a value through its project.
      const events = await rows<{ id: string; database_id: string; updated_at: Date }>(
        tenant,
        `SELECT i.id, i.database_id, i.updated_at FROM item_relations r
         JOIN items i ON i.id IN (r.item_a, r.item_b) AND i.id <> $1
         JOIN databases d ON d.id = i.database_id AND d.owner_module_id = 'events'
         WHERE $1 IN (r.item_a, r.item_b)`,
        [str(payload, "projectItemId")],
      );
      expect(events).toHaveLength(1);
      expect(announced).toEqual(
        events.map((event) => ({
          tenantId: tenant.tenantId,
          event: {
            scope: "item",
            databaseId: event.database_id,
            itemId: event.id,
            op: "update",
            updatedAt: event.updated_at.toISOString(),
          },
        })),
      );
    },
  },
  [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: {
    tenancy: "tenant",
    async seed(tenant) {
      const taskId = await createTaskHiddenInPassedEvent(tenant);
      expect(await itemProperty(tenant, taskId, "hiddenUntil")).not.toBeNull();
      return { taskId };
    },
    async expectDone(tenant, payload) {
      expect(await itemProperty(tenant, str(payload, "taskId"), "hiddenUntil")).toBeNull();
    },
  },
  [CORE_TASK_NAMES.AI_BUDGET_RESET]: {
    tenancy: "tenant",
    async seed() {
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
      const zone = await inTenant(tenant, () => withTransaction(pool, getSystemTimezone));
      const start = instantToWallClock(new Date(Date.now() - 60 * 60 * 1000), zone);
      const { personId, eventId } = await createPersonWithEvent(tenant, start.date, start.time);
      return marked([personId, eventId], async () => {
        expect(await itemProperty(tenant, personId, "lastContact")).toBe(start.date);
      });
    },
  },
  [CORE_TASK_NAMES.CALENDAR_SUBSCRIPTION_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const feed = await ensureFeedFixture();
      const databaseId = await moduleDatabaseId(tenant, "calendars");
      const calendar = await inTenant(tenant, () =>
        withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            {
              databaseId,
              properties: {
                name: "Feed",
                color: "#8E8E93",
                kind: "subscription",
                subscriptionUrl: "https://feed.example.test/a.ics",
              },
            },
            { allowedSystemKeys: ["kind"], systemOwnerProcess: CALENDAR_MODULE_ID },
          ),
        ),
      );
      // As the superuser: the write rule refuses an `http` address with a port, which a local server is.
      await adminPool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{subscriptionUrl}', to_jsonb($2::text)) WHERE id = $1",
        [calendar.id, `http://127.0.0.1:${feed.port}/${calendar.id}.ics`],
      );
      return marked([calendar.id], async () => {
        expect(feed.consumed).toContain(calendar.id);
        await expectRows(
          tenant,
          "SELECT calendar_item_id, etag, last_status FROM calendar_feed_state",
          [],
          [{ calendar_item_id: calendar.id, etag: '"v1"', last_status: 200 }],
        );
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
        // A sync-socket delete runs no domain code.
        await docStore.deleteBlock(hostItemId, page.blockId, "user");
        await pool.query("UPDATE docs SET last_edited_at = now() - interval '2 hours' WHERE item_id = $1", [
          hostItemId,
        ]);
        return page.pageItemId;
      });
      return marked([pageItemId], () =>
        expectRows(
          tenant,
          "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1",
          [pageItemId],
          [{ trashed: true }],
        ),
      );
    },
  },
  [CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const mailboxItemId = await createMailbox(tenant);
      const checkKey = `process:mailsync:${mailboxItemId}`;
      return marked([mailboxItemId], async () => {
        await expectRows(
          tenant,
          "SELECT status FROM tenant_observability_checks WHERE check_key = $1",
          [checkKey],
          [{ status: "alerting" }],
        );
        await expectRows(
          tenant,
          "SELECT user_id FROM notifications WHERE kind = 'mail_sync_stalled' AND source_id IN (SELECT id::text FROM tenant_observability_checks WHERE check_key = $1)",
          [checkKey],
          [{ user_id: tenant.userId }],
        );
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
        await pool.query(
          "UPDATE agent_run_mcp_credentials SET expires_at = now() - interval '1 minute' WHERE agent_run_id = $1",
          [minted.run.id],
        );
        return minted.run.id;
      });
      return marked([runId], () =>
        expectRows(tenant, "SELECT status FROM agent_runs WHERE id = $1", [runId], [{ status: "done" }]),
      );
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
        await pool.query("UPDATE agent_run_events SET at = now() - interval '40 days' WHERE agent_run_id = $1", [
          run.id,
        ]);
        await finishAgentRun(pool, run.id, "done", null);
        return { runId: run.id, messageId: message.id };
      });
      return marked([runId], async () => {
        await expectRows(
          tenant,
          "SELECT 1 FROM agent_run_events WHERE agent_run_id = $1 AND id = $2",
          [runId, messageId],
          [],
        );
        await expectRows(
          tenant,
          "SELECT kind FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'compaction'",
          [runId],
          [{ kind: "compaction" }],
        );
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
      return marked([problemId], () =>
        expectRows(tenant, "SELECT 1 FROM semp_problems WHERE id = $1", [problemId], []),
      );
    },
  },
  [CORE_TASK_NAMES.TENANT_EXPORT_EXPIRY_SWEEP]: {
    tenancy: "system",
    touchesTenantTables: true,
    async seed(tenant) {
      const exportId = await createReadyExport(tenant);
      await adminPool.query(
        `UPDATE tenant_exports
            SET created_at = created_at - interval '8 days',
                completed_at = completed_at - interval '8 days',
                expires_at = expires_at - interval '8 days'
          WHERE id = $1`,
        [exportId],
      );
      return marked([exportId], () => expectRows(tenant, "SELECT 1 FROM tenant_exports WHERE id = $1", [exportId], []));
    },
  },
  [CORE_TASK_NAMES.TENANT_PURGE]: {
    tenancy: "system",
    touchesTenantTables: true,
    // Erasing a tenant needs two tenants of its own; A and B stay bystanders.
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
        // Global tables, outside every fingerprint.
        const global = async (sql: string) => (await adminPool.query(sql, [tenant.tenantId])).rows;
        expect(await global("SELECT 1 AS present FROM tenants WHERE id = $1")).toEqual([]);
        expect(await global("SELECT tenant_id FROM tenant_deletions WHERE tenant_id = $1")).toEqual([
          { tenant_id: tenant.tenantId },
        ]);
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
      // A probe outside the task catalogs counts as a tenant task; it touches no table.
      await inTenant(tenantA, () => enqueueJob(pool, identifier, {}, { jobKey, maxAttempts: 1 }));
      await runOnce({ pgPool: pool }, failingTaskList);
      expect(await jobOutcome(jobKey)).toEqual({ attempts: 1, lastError: "probe failure" });
      // graphile-worker 0.17.3 has no public way to age a failed job past the prune's 7-day retention.
      const aged = await adminPool.query(
        "UPDATE graphile_worker._private_jobs SET updated_at = now() - interval '8 days' WHERE key = $1",
        [jobKey],
      );
      expect(aged.rowCount).toBe(1);
      return async () => {
        expect(await jobOutcome(jobKey)).toEqual(COMPLETED);
      };
    },
  },
  [CALENDAR_SEND_EVENT_INVITATION_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      invitationSends.length = 0;
      const { eventId, personId, mailboxId, mailboxAddress, attendeeEmail } = await seedInvitation(tenant);
      seededByKey.set(eventId, { mailboxAddress });
      return { method: "REQUEST", eventId, personId, mailboxId, attendeeEmail };
    },
    async expectDone(tenant, payload) {
      expect(invitationSends).toEqual([
        {
          tenantId: tenant.tenantId,
          mailboxId: str(payload, "mailboxId"),
          method: "REQUEST",
          from: seeded(payload, "eventId").mailboxAddress,
          recipients: [str(payload, "attendeeEmail")],
        },
      ]);
      expect(typeof (await invitationSentAt(tenant, str(payload, "eventId"), str(payload, "personId")))).toBe("string");
      invitationSends.length = 0;
    },
  },
  [CALENDAR_SEND_INVITATION_REPLY_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      invitationSends.length = 0;
      const { invitationId, respondedAt, ...rest } = await seedAnsweredInvitation(tenant);
      seededByKey.set(invitationId, rest);
      return { invitationId, response: "accepted", respondedAt };
    },
    async expectDone(tenant, payload) {
      const reply = seeded(payload, "invitationId");
      expect(invitationSends).toEqual([
        {
          tenantId: tenant.tenantId,
          mailboxId: reply.mailboxId,
          method: "REPLY",
          from: reply.mailboxAddress,
          recipients: [reply.organizerEmail],
        },
      ]);
      invitationSends.length = 0;
    },
  },
  [MAIL_TRIAGE_THREAD_PROJECT_TASK]: {
    tenancy: "tenant",
    async seed(tenant) {
      triageQuestions.length = 0;
      const mailboxItemId = await createMailbox(tenant);
      const projectsDatabaseId = await moduleDatabaseId(tenant, "projects");
      triageProjectName = `Isolation project ${randomUUID()}`;
      const project = await inTenant(tenant, () =>
        chokePoint.createItem({
          databaseId: projectsDatabaseId,
          properties: { name: triageProjectName, status: "inProgress" },
        }),
      );
      const { threadItemId } = await inTenant(tenant, () =>
        withTransaction(pool, (client) =>
          ingestMessage(client, mailboxItemId, {
            subject: "Question about the isolation project",
            bodyText: "Please advise.",
          }),
        ),
      );
      seededByKey.set(threadItemId, { projectId: project.id });
      return { threadItemId };
    },
    async expectDone(tenant, payload) {
      const threadItemId = str(payload, "threadItemId");
      const { projectId } = seeded(payload, "threadItemId");
      await expectRows(
        tenant,
        `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS project_id
           FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
           JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b) AND p.key = 'project'
           JOIN databases db ON db.id = p.database_id AND db.owner_module_id = 'threads'
          WHERE r.item_a = $1 OR r.item_b = $1`,
        [threadItemId],
        [{ project_id: projectId }],
      );
      await expectRows(tenant, "SELECT 1 FROM value_links WHERE item_id = $1", [threadItemId], []);
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

/** Inside a tenant scope. */
async function requireDocId(itemId: string): Promise<string> {
  const found = await pool.query<{ id: string }>("SELECT id FROM docs WHERE item_id = $1", [itemId]);
  const doc = found.rows[0];
  if (!doc) throw new Error("expected the item to have a doc");
  return doc.id;
}

function casesWhere<T extends TaskCase>(guard: (c: TaskCase) => c is T): Array<[string, T]> {
  return Object.entries(cases).flatMap(([name, c]): Array<[string, T]> => (guard(c) ? [[name, c]] : []));
}

/**
 * For the B-side run of a job naming A's rows, what besides A's unchanged fingerprint shows that nothing of A was
 * reached: `quiet` jobs end with no effect in B at all, and the recorder or registration they would have reached
 * stays untouched.
 */
const FOREIGN_RUN_CHECKS: Record<string, { quiet?: boolean; check?: () => Promise<void> }> = {
  [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: {
    quiet: true,
    async check() {
      expect(titlePortCalls).toEqual([]);
      titlePortCalls.length = 0;
    },
  },
  [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: { quiet: true },
  [CALENDAR_SEND_EVENT_INVITATION_TASK]: { quiet: true, check: async () => expect(invitationSends).toEqual([]) },
  [CALENDAR_SEND_INVITATION_REPLY_TASK]: { quiet: true, check: async () => expect(invitationSends).toEqual([]) },
  [MAIL_TRIAGE_THREAD_PROJECT_TASK]: { quiet: true, check: async () => expect(triageQuestions).toEqual([]) },
  [SLEEP_RESYNC_TASK]: {
    // Both tenants have an active iOS registration and the payload names A: only the scope check keeps B's job
    // from pushing.
    async check() {
      expect(backgroundPushes.sent).toEqual([]);
      expect(await activeApnsTokens(tenantA)).toHaveLength(1);
      expect(await activeApnsTokens(tenantB)).toHaveLength(1);
    },
  },
  // A's registration is global data; only the user check keeps B's job from reaching it.
  [CORE_TASK_NAMES.PUSH_DISMISS]: { check: async () => expect(await pushRegistrationRevoked(tenantA)).toBe(false) },
  // No fingerprint shows announcements.
  [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: {
    quiet: true,
    check: async () => expect(stopRecordingInvalidations()).toEqual([]),
  },
  [CORE_TASK_NAMES.AI_BUDGET_RESET]: {
    // The job announces for the tenant it runs in, whatever its payload names.
    async check() {
      const bStatus = { tenantId: tenantB.tenantId, event: { scope: "sempStatus" } };
      expect(stopRecordingInvalidations()).toEqual([bStatus, bStatus]);
    },
  },
};

/** Settles `cleanup` after `body`, keeping a failure of `body` primary over one of `cleanup`. */
async function settled(body: () => Promise<void>, cleanup: () => Promise<void> | void): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  try {
    await cleanup();
  } catch (error) {
    if (failure) {
      // eslint-disable-next-line preserve-caught-error
      throw new AggregateError([failure.error, error], "Scenario cleanup failed", { cause: failure.error });
    }
    throw error;
  }
  if (failure) throw failure.error;
}

describe("background task isolation across two tenants: api runtime", () => {
  beforeAll(async () => {
    for (const name of ENV_OVERRIDES) previousEnv.set(name, process.env[name]);
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    blobRoot = await mkdtemp(join(tmpdir(), "semprec-api-isolation-"));
    // `createApiActionRegistry` refuses to build without a gateway token.
    process.env.AI_GATEWAY_INTERNAL_TOKEN = randomUUID();
    process.env.FILES_STORAGE_DIR = join(blobRoot, "files");
    process.env.MAIL_ATTACHMENTS_DIR = join(blobRoot, "mail");

    adminPool = getTestPool();
    await resetDatabase(adminPool);
    await installQueueSchema(adminPool);
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
      createApiActionRegistry(pool, moduleRegistry),
      undefined,
      { loadGmailLabels: gmailAdapters.loadGmailLabels },
      undefined,
      moduleRegistry,
      undefined,
      replayApprovedGenericOperation,
      undefined,
      undefined,
      titlePort,
    );
    // These tasks read their pool, transports and gateway from bindings `createApiQueueRuntime` sets.
    setEventInvitationDelivery({ pool, transports: invitationTransports });
    setInvitationReplyDelivery({ pool, transports: invitationTransports });
    setThreadProjectTriageRuntime({ pool, gateway: triageGateway });
    setThreadTaskPeopleDelivery({ pool });
    taskList = await mergeModuleTaskListForAffinity(coreTaskList, moduleRegistry, "api");
    assertTaskListMatchesAffinity(taskList, (await resolveTaskAffinitySets(moduleRegistry)).api, "api");

    tenantZero = await buildTenant(getTenantZeroId());
    tenantA = await buildTenant(await createTestTenant(adminPool));
    tenantB = await buildTenant(await createTestTenant(adminPool));
  });

  afterEach(async () => {
    restoreEnv([...VAPID_ENV, ...APNS_ENV]);
    await stopFeedFixture();
  });

  afterAll(async () => {
    setEventInvitationDelivery(null);
    setInvitationReplyDelivery(null);
    setThreadProjectTriageRuntime(null);
    setThreadTaskPeopleDelivery(null);
    await pool?.end();
    await adminPool?.end();
    if (blobRoot !== undefined) await rm(blobRoot, { recursive: true, force: true });
    restoreEnv(ENV_OVERRIDES);
  });

  it("purges rendered audio through the queued tenant sweep while preserving another tenant's live bytes", async () => {
    const first = await buildTenant(await createTestTenant(adminPool));
    const second = await buildTenant(await createTestTenant(adminPool));
    const root = join(blobRoot, "files");
    const blobsOf = (tenant: Tenant, ids: string[]) =>
      inTenant(tenant, async () =>
        z
          .array(z.object({ id: z.uuid(), storage_key: z.string() }))
          .parse(
            (await pool.query("SELECT id, storage_key FROM blobs WHERE id = ANY($1::uuid[]) ORDER BY id", [ids])).rows,
          ),
      );
    const inspect = async (tenant: Tenant, itemId: string) => {
      const filesId = await moduleDatabaseId(tenant, "files");
      const item = await inTenant(tenant, () => chokePoint.getItem(filesId, itemId));
      if (!item) throw new Error("Missing rendered source");
      const original = z.object({ blobId: z.uuid() }).parse(item.properties.file).blobId;
      const prepare = z.object({ normalizedBlobId: z.uuid(), playbackBlobId: z.uuid() }).parse(item.computed.prepare);
      const ids = [original, prepare.normalizedBlobId, prepare.playbackBlobId];
      expect(new Set(ids).size).toBe(3);
      const blobs = await blobsOf(tenant, ids);
      expect(blobs).toHaveLength(3);
      for (const blob of blobs) {
        expect(blob.storage_key.startsWith(`${tenant.tenantId}/`)).toBe(true);
        expect((await readFile(join(root, blob.storage_key))).length).toBeGreaterThan(0);
      }
      return { filesId, ids, blobs };
    };
    await settled(
      async () => {
        const [a, b] = [
          await runTranscriptionFixture(
            { mode: "failure", source: "ogg", tenantId: first.tenantId, storageRoot: root },
            adminPool,
          ),
          await runTranscriptionFixture(
            { mode: "failure", source: "ogg", tenantId: second.tenantId, storageRoot: root },
            adminPool,
          ),
        ];
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
            const found = await adminPool.query("SELECT id FROM blobs WHERE storage_key = $1", [key]);
            observed.push({ key, remaining: found.rows.length });
            await actualStorage.delete(key);
          },
        };
        const tasks = createApiCoreTaskList(
          pool,
          createApiActionRegistry(pool, moduleRegistry),
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
        expect(await jobOutcome(key)).toEqual(COMPLETED);
        for (const blob of aBefore.blobs) {
          expect(observed).toContainEqual({ key: blob.storage_key, remaining: 0 });
          await expect(readFile(join(root, blob.storage_key))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await inTenant(first, () => chokePoint.getItem(aBefore.filesId, a.result.fileItemId))).toBeNull();
        expect(await blobsOf(first, aBefore.ids)).toEqual([]);
        expect((await inspect(second, b.result.fileItemId)).blobs).toEqual(bBefore.blobs);
        expect(observed.some((entry) => bBefore.blobs.some((blob) => blob.storage_key === entry.key))).toBe(false);
      },
      async () => {
        await adminPool.query("UPDATE tenants SET status = 'suspended' WHERE id = ANY($1::uuid[])", [
          [first.tenantId, second.tenantId],
        ]);
      },
    );
  });

  it("has exactly one case per task of the api affinity set, each with the task's declared tenancy", async () => {
    const set = (await resolveTaskAffinitySets(await loadFullModuleRegistry())).api;
    const withoutCase = [...set].filter((name) => !Object.hasOwn(cases, name)).sort();
    const outsideSet = Object.keys(cases)
      .filter((name) => !set.has(name))
      .sort();
    expect({ withoutCase, outsideSet }).toEqual({ withoutCase: [], outsideSet: [] });
    const mismatched = Object.entries(cases).filter(([name, c]) => c.tenancy !== tenancyOf(name));
    expect(mismatched.map(([name]) => name)).toEqual([]);
  });

  describe("tenant tasks", () => {
    const tenantCases = casesWhere((c): c is TenantTaskCase => c.tenancy === "tenant");

    it.each(tenantCases)(
      "%s (a): a job of A naming A's rows runs and changes nothing of B or tenant zero",
      async (name, c) => {
        const payload = await c.seed(tenantA);
        await discardQueuedJobs();
        const refusesWithoutWrites = name === CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
        const beforeA = refusesWithoutWrites ? await fingerprint(tenantA) : undefined;
        const beforeB = await fingerprint(tenantB);
        const beforeZero = await fingerprint(tenantZero);
        const notificationsBefore = await notifications(tenantA);

        const jobKey = await runJobIn(tenantA, name, payload);

        const outcome = await jobOutcome(jobKey);
        await removeJob(jobKey);
        if (c.expectedError) {
          expect(outcome.lastError).toMatch(c.expectedError);
          if (refusesWithoutWrites) expect(outcome.attempts).toBe(1);
        } else {
          expect(outcome).toEqual(COMPLETED);
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
        const extra = FOREIGN_RUN_CHECKS[name];
        if (extra?.quiet) expect(foreign).toEqual(NO_EFFECTS);
        await extra?.check?.();
        expect(await fingerprint(tenantA)).toEqual(beforeA);
      },
    );
  });

  it("publishes the title registry case's committed invalidation for its tenant", async () => {
    const titleCase = cases[CORE_TASK_NAMES.SEMP_THREAD_TITLE];
    if (titleCase?.tenancy !== "tenant") throw new Error("Missing title tenant case");
    const payload = await titleCase.seed(tenantA);
    await discardQueuedJobs();
    const listener = await adminPool.connect();
    const observed: { tenantId: string; threadId: string }[] = [];
    const envelope = z.object({
      tenantId: z.string(),
      message: z.object({ type: z.literal("invalidation"), scope: z.literal("sempThread"), threadId: z.string() }),
    });
    listener.on("notification", (notification) => {
      if (notification.channel !== REALTIME_CHANNEL || !notification.payload) return;
      const parsed = envelope.safeParse(JSON.parse(notification.payload));
      if (parsed.success) observed.push({ tenantId: parsed.data.tenantId, threadId: parsed.data.message.threadId });
    });
    await settled(
      async () => {
        await listener.query(`LISTEN ${REALTIME_CHANNEL}`);
        wireRealtimeHooks(pool);
        expect(await jobOutcome(await runJobIn(tenantA, CORE_TASK_NAMES.SEMP_THREAD_TITLE, payload))).toEqual(
          COMPLETED,
        );
        await titleCase.expectDone(tenantA, payload);
        const threadId = str(payload, "threadId");
        expect(await jobOutcome(await runJobIn(tenantA, CORE_TASK_NAMES.SEMP_THREAD_TITLE, payload))).toEqual(
          COMPLETED,
        );
        expect(titlePortCalls).toEqual([]);
        await expectRows(
          tenantA,
          "SELECT title FROM semp_threads WHERE id = $1",
          [threadId],
          [{ title: "Tenant title" }],
        );
        const deadline = Date.now() + 5_000;
        while (
          !observed.some((event) => event.tenantId === tenantA.tenantId && event.threadId === threadId) &&
          Date.now() < deadline
        )
          await sleep(25);
        expect(observed).toContainEqual({ tenantId: tenantA.tenantId, threadId });
        expect(observed.filter((event) => event.tenantId === tenantB.tenantId)).toEqual([]);
      },
      () => listener.release(true),
    );
  });

  describe("system tasks", () => {
    it.each(casesWhere((c): c is SystemTaskCase => c.tenancy === "system" && c.touchesTenantTables))(
      "%s: with work due in two tenants, one run does each tenant's work in that tenant only",
      async (name, c) => {
        await discardQueuedJobs();
        const [first, second] = c.tenants ? await c.tenants() : [tenantA, tenantB];
        const firstWork = await c.seed(first);
        const secondWork = await c.seed(second);
        const bystanders = [tenantZero, tenantA, tenantB].filter((tenant) => tenant !== first && tenant !== second);
        const releases: Array<() => Promise<void>> = [];
        await settled(
          async () => {
            for (const tenant of bystanders) if (c.holdBystander) releases.push(await c.holdBystander(tenant));
            const bystandersBefore = await Promise.all(bystanders.map((tenant) => fingerprint(tenant)));
            const firstNotificationsBefore = await notifications(first);
            const secondNotificationsBefore = await notifications(second);

            expect(await jobOutcome(await runSystemJob(name))).toEqual(COMPLETED);

            await firstWork.check();
            await secondWork.check();
            expect(await tablesMentioning(second, firstWork.markers)).toEqual([]);
            expect(await tablesMentioning(first, secondWork.markers)).toEqual([]);
            expect(await Promise.all(bystanders.map((tenant) => fingerprint(tenant)))).toEqual(bystandersBefore);
            await expectNewNotificationsAddressedTo(first, firstNotificationsBefore);
            await expectNewNotificationsAddressedTo(second, secondNotificationsBefore);
          },
          async () => {
            for (const release of releases) await release();
          },
        );
      },
    );

    it.each(casesWhere((c): c is GlobalSystemTaskCase => c.tenancy === "system" && !c.touchesTenantTables))(
      "%s: a run touching no tenant table leaves A, B and tenant zero unchanged",
      async (name, c) => {
        await discardQueuedJobs();
        const check = await c.seed();
        const tenants = [tenantA, tenantB, tenantZero];
        const before = await Promise.all(tenants.map((tenant) => fingerprint(tenant)));

        expect(await jobOutcome(await runSystemJob(name))).toEqual(COMPLETED);

        await check();
        expect(await Promise.all(tenants.map((tenant) => fingerprint(tenant)))).toEqual(before);
      },
    );
  });
});
