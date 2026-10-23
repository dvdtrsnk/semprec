import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";
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
  runAsSystem,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";
import {
  assertTaskListMatchesAffinity,
  createBlob,
  createItemWithClient,
  createUser,
  getDatabaseByModuleId,
  LocalFsBlobStorageWriter,
  loadFullModuleRegistry,
  provisionTenant,
  resolveTaskAffinitySets,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createTranscriptionTask } from "../transcriptionTask.js";
import type {
  AudioGatewayClient,
  DiarizationTurn,
  DiarizeRequest,
  TranscribeRequest,
  TranscriptionResult,
} from "../audioGatewayClient.js";
import { FIXTURE_CREATION_TIME, generateMp4Fixture } from "./fixtures/mediaFixtures.js";

/**
 * Two-tenant proof that every task of the `transcribe` affinity set keeps its data, notifications
 * and side effects inside the tenant it runs for (issue #1056). The task list is composed as
 * `createTranscribeQueueRuntime` composes it, over a `semprec_data` pool, with fake audio and
 * summary gateways like the other transcribe tests; jobs are enqueued with `enqueueJob` and drained
 * with `runOnce`, under strict tenant-scope enforcement.
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
  /** Asserts, inside `tenant`, the effect a completed job with `payload` had. */
  expectDone(tenant: Tenant, payload: Payload): Promise<void>;
}

type TaskCase = TenantTaskCase;

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
let blobDir: string;
let blobStorage: LocalFsBlobStorageWriter;
let audioFixture: Buffer;
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

/** A fixed two-speaker diarization and transcript, like the other transcribe tests' fake gateway. */
class FakeAudioGateway implements AudioGatewayClient {
  async diarize(_request: DiarizeRequest): Promise<DiarizationTurn[]> {
    return [
      { speaker: "SPEAKER_00", start: 0, end: 0.5 },
      { speaker: "SPEAKER_01", start: 0.5, end: 1 },
    ];
  }

  async transcribe(_request: TranscribeRequest): Promise<TranscriptionResult> {
    return {
      text: "Hello. Hi there.",
      language: "en",
      segments: [
        { start: 0, end: 0.4, text: " Hello." },
        { start: 0.6, end: 0.9, text: " Hi there." },
      ],
    };
  }
}

class FakeSummaryGateway implements AiGatewayClientPort {
  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    if (input.operation === "transcript_speaker_suggestion") {
      return { content: { mappings: [] }, usage: { inputTokens: 10, outputTokens: 5 } };
    }
    return { content: { summary: "a summary" }, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

function requirePayloadString(payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`expected payload field ${field} to be a string`);
  return value;
}

const cases: Record<string, TaskCase> = {
  [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: {
    tenancy: "tenant",
    async seed(tenant) {
      const file = await runInTenant(tenant.tenantId, async () => {
        const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
        if (!files) throw new Error("Files database was not seeded");
        const storageKey = `source/${randomUUID()}`;
        await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
        const blob = await withTransaction(pool, (client) =>
          createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
        );
        return withTransaction(pool, (client) =>
          createItemWithClient(client, {
            databaseId: files.id,
            properties: { name: "recording", file: { blobId: blob.id } },
          }),
        );
      });
      return { fileItemId: file.id };
    },
    async expectDone(tenant, payload) {
      const transcripts = await runInTenant(tenant.tenantId, async () => {
        const { rows } = await pool.query<{ status: string | null }>(
          `SELECT t.properties->>'status' AS status FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
            WHERE f.id = $1`,
          [requirePayloadString(payload, "fileItemId")],
        );
        return rows;
      });
      expect(transcripts).toEqual([{ status: "done" }]);
    },
  },
};

describe("background task isolation across two tenants: transcribe runtime (issue #1056)", () => {
  beforeAll(async () => {
    previousScope = process.env.SEMPREC_TENANT_SCOPE;
    process.env.SEMPREC_TENANT_SCOPE = "strict";

    adminPool = getTestPool();
    await resetDatabase(adminPool);
    await ensureQueueSchema(adminPool);
    await grantQueueSchemaPrivileges(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    tenantTables = await loadTenantTables();
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
    blobDir = await mkdtemp(join(tmpdir(), "semprec-transcribe-isolation-"));
    blobStorage = new LocalFsBlobStorageWriter(blobDir);

    // Composed as createTranscribeQueueRuntime composes it, with the fake gateways in place of HTTP.
    taskList = {
      [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
        CORE_TASK_NAMES.TRANSCRIPTION_JOB,
        createTranscriptionTask(pool, blobStorage, new FakeAudioGateway(), new FakeSummaryGateway()),
      ),
    };
    assertTaskListMatchesAffinity(taskList, (await resolveTaskAffinitySets(moduleRegistry)).transcribe, "transcribe");

    tenantZero = await buildTenant(getTenantZeroId());
    tenantA = await buildTenant(await createTestTenant(adminPool));
    tenantB = await buildTenant(await createTestTenant(adminPool));
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (blobDir !== undefined) await rm(blobDir, { recursive: true, force: true });
    if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = previousScope;
  });

  it("has exactly one case per task of the transcribe affinity set", async () => {
    const set = (await resolveTaskAffinitySets(await loadFullModuleRegistry())).transcribe;
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
    const tenantCases = Object.entries(cases);

    it.each(tenantCases)(
      "%s (a): a job of A naming A's rows completes and changes nothing of B or tenant zero",
      async (name, c) => {
        const payload = await c.seed(tenantA);
        const beforeB = await fingerprint(tenantB);
        const beforeZero = await fingerprint(tenantZero);
        const notificationsBefore = await notifications(tenantA);

        const jobKey = await runJobIn(tenantA, name, payload);

        expect(await jobOutcome(jobKey)).toEqual({ attempts: null, lastError: null });
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
        const beforeA = await fingerprint(tenantA);

        const foreign = await runInBObserved(name, payload);
        const random = await runInBObserved(name, randomizedPayload(payload));

        expect(foreign).toEqual(random);
        expect(await fingerprint(tenantA)).toEqual(beforeA);
      },
    );
  });
});
