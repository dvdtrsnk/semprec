import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  createBlob,
  createActionQueueAffinity,
  createChokePoint,
  createItemWithClient,
  createRerunTranscriptionRouteHandler,
  createTranscriptDeleteRouteHandler,
  createUser as dataCreateUser,
  findIdempotentReplay,
  createTranscriptionRequeueSweepAction,
  createViewTypeRegistry,
  ForbiddenError,
  getDatabaseByModuleId,
  getItemById,
  getSystemTimezone,
  ingestUploadedFile,
  ingestUploadedFileWithTransaction,
  itemDeleteWithClient,
  LocalFsBlobStorageWriter,
  readRecordingRequest,
  recordRecordingIntake,
  seedSystem,
  TRANSCRIPTION_OWNER_PROCESS,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInboxCardsInvalidationHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
  updateItemWithClient,
  withTransaction,
  writeComputed,
  type BlobStorageWriter,
  type ItemRow,
} from "@semprec/data";
import type { MeetingNotes } from "./transcriptSummary.js";
import { recordingDay } from "./transcriptSummary.js";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { wireRealtimeHooks } from "@semprec/realtime";
import type { AiGatewayClientPort, AiGatewayCompletionInput, AiGatewayCompletionResult } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, registerTask, runOnce } from "@semprec/queue";
import { AiGatewayFailedError } from "@semprec/shared";
import {
  classifyTranscriptionFailure,
  createTranscriptionCreateTask,
  createTranscriptionTask,
} from "./transcriptionTask.js";
import { AudioGatewayBudgetExceededError, AudioGatewayCallError } from "./audioGatewayClient.js";
import { MediaToolError, probeMedia } from "./mediaNormalization.js";
import type {
  AudioGatewayClient,
  DiarizationTurn,
  DiarizeRequest,
  TranscribeRequest,
  TranscriptionResult,
} from "./audioGatewayClient.js";
import {
  FIXTURE_CREATION_TIME,
  generateLateAudioVideoFixture,
  generateMp4Fixture,
  generateOggFixture,
  generateWebmFixture,
  probeAudioStream,
  probeNormalizedAudio,
} from "./__tests__/fixtures/mediaFixtures.js";

const observedLogs = vi.hoisted(() => ({
  chunks: [] as string[],
  restores: [] as Array<() => void>,
  streams: new WeakSet<object>(),
  level: process.env.LOG_LEVEL,
}));
vi.mock("@semprec/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/shared")>();
  process.env.LOG_LEVEL = "info";
  return {
    ...actual,
    createLogger(name: string) {
      const logger = actual.createLogger(name);
      const symbol = Reflect.ownKeys(logger).find(
        (key) => typeof key === "symbol" && key.description === "pino.stream",
      );
      if (typeof symbol !== "symbol") throw new Error("Pino logger destination is unavailable");
      const stream: unknown = Reflect.get(logger, symbol);
      if (typeof stream !== "object" || stream === null) throw new Error("Invalid Pino logger destination");
      if (!observedLogs.streams.has(stream)) {
        const original: unknown = Reflect.get(stream, "write");
        if (typeof original !== "function") throw new Error("Invalid Pino destination writer");
        const descriptor = Object.getOwnPropertyDescriptor(stream, "write");
        if (
          !Reflect.set(stream, "write", function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === "string") observedLogs.chunks.push(args[0]);
            return Reflect.apply(original, this, args);
          })
        )
          throw new Error("Cannot observe Pino destination");
        observedLogs.streams.add(stream);
        observedLogs.restores.push(() => {
          if (descriptor) Object.defineProperty(stream, "write", descriptor);
          else Reflect.deleteProperty(stream, "write");
        });
      }
      return logger;
    },
  };
});
afterAll(() => {
  for (const restore of observedLogs.restores.reverse()) restore();
  if (observedLogs.level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = observedLogs.level;
});

/** Counts calls so resume tests can assert on them. */
class FakeAudioGatewayClient implements AudioGatewayClient {
  diarizeCalls: DiarizeRequest[] = [];
  transcribeCalls: TranscribeRequest[] = [];
  diarizeResult: DiarizationTurn[] = [];
  transcribeResult: (request: TranscribeRequest) => TranscriptionResult = () => ({
    text: "",
    language: "en",
    segments: [],
  });

  async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
    this.diarizeCalls.push(request);
    return this.diarizeResult;
  }

  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    this.transcribeCalls.push(request);
    return this.transcribeResult(request);
  }
}

/** A fake audio gateway whose diarize call first runs `onDiarize`, which may throw instead of answering. */
function diarizingWith(onDiarize: () => Promise<void>): FakeAudioGatewayClient {
  return new (class extends FakeAudioGatewayClient {
    override async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
      await onDiarize();
      return super.diarize(request);
    }
  })();
}

/** Deterministic transport for steps 5-7: fixed answers per request kind, with call counts. */
class FakeSummaryClient implements AiGatewayClientPort {
  calls: AiGatewayCompletionInput[] = [];
  failure: Error | null = null;
  speakerMappings: Array<{ speaker: string; personId: string | null; reason: string }> = [];
  actionItems: MeetingNotes["actionItems"] = [];
  eventRecommendation: { eventId: string | null; reason: string } = { eventId: null, reason: "Cannot tell." };

  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    if (input.operation === "transcript_speaker_suggestion")
      return { content: { mappings: this.speakerMappings }, usage: { inputTokens: 10, outputTokens: 5 } };
    if (input.operation === "transcript_event_match")
      return { content: this.eventRecommendation, usage: { inputTokens: 10, outputTokens: 5 } };
    return { content: { ...FAKE_NOTES, actionItems: this.actionItems }, usage: { inputTokens: 10, outputTokens: 5 } };
  }

  eventMatchCalls(): AiGatewayCompletionInput[] {
    return this.calls.filter((call) => call.operation === "transcript_event_match");
  }

  notesCalls(): AiGatewayCompletionInput[] {
    return this.calls.filter((call) => call.operation === "transcript_summary");
  }

  operations(): string[] {
    return this.calls.map((call) => call.operation);
  }
}

/** A fake summary client that first runs `onCall` for each request of `operation`. */
function summarizingWith(
  operation: string,
  onCall: (input: AiGatewayCompletionInput) => Promise<void>,
): FakeSummaryClient {
  return new (class extends FakeSummaryClient {
    override async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
      if (input.operation === operation) await onCall(input);
      return super.complete(input);
    }
  })();
}

/** Delegates to the shared fake summary client except for `operation`, which `answer` handles. */
function overriding(operation: string, answer: () => Promise<AiGatewayCompletionResult>): AiGatewayClientPort {
  return { complete: (input) => (input.operation === operation ? answer() : summaryClient.complete(input)) };
}

const FAKE_NOTES = {
  title: "Greeting",
  summary: "{SPEAKER_00} greets {SPEAKER_01}.",
  shortSummary: "A greeting.",
  decisions: ["Keep greeting"],
};
const STORED_NOTES = { ...FAKE_NOTES, actionItems: [] };

let pool: Pool;
let tmpBlobDir: string;
let blobStorage: LocalFsBlobStorageWriter;
let gatewayClient: FakeAudioGatewayClient;
let summaryClient: FakeSummaryClient;
let audioFixture: Buffer;

const FIRST_ATTEMPT = { job: { attempts: 1, max_attempts: 3 } };
const FINAL_ATTEMPT = { job: { attempts: 3, max_attempts: 3 } };
const attempt = (attempts: number) => ({ job: { attempts, max_attempts: 3 } });
const TASK_FAILED = { name: "TranscriptionQueueError", message: "Transcription task failed" };
/** Any cutoff after the moment an item was trashed makes it eligible for the purge; no wall-clock wait is involved. */
const purgeCutoff = () => new Date(Date.now() + 60_000);

afterAll(async () => {
  await pool?.end();
});

/** Undo every realtime hook so no later test publishes through this file's pool. */
function resetRealtimeHooks(): void {
  setInvalidationHook(() => {});
  setDocUpdateHook(() => {});
  setNotificationCreatedHook(() => {});
  setNotificationReadStateHook(() => {});
  setSessionRevokedHook(() => {});
  setAgentRunEventHook(() => {});
  setInboxCardsInvalidationHook(() => {});
}

/** Two speakers, each saying one line inside their own diarization turn. */
function speakTwoLines(gateway: FakeAudioGatewayClient): void {
  gateway.diarizeResult = [
    { speaker: "SPEAKER_00", start: 0, end: 0.5 },
    { speaker: "SPEAKER_01", start: 0.5, end: 1 },
  ];
  gateway.transcribeResult = () => ({
    text: "Hello. Hi there.",
    language: "en",
    segments: [
      { start: 0, end: 0.4, text: " Hello." },
      { start: 0.6, end: 0.9, text: " Hi there." },
    ],
  });
}

/**
 * Per test: a reset database (with tenant zero seeded unless `seed` is false), an empty blob directory and fresh
 * fakes; with `speech` the audio gateway answers with two speakers.
 */
function useHarness(options: { seed?: boolean; speech?: boolean } = {}): void {
  beforeAll(async () => {
    audioFixture ??= await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    if (options.seed !== false) await seedSystem(pool, createViewTypeRegistry());
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
    if (options.speech) speakTwoLines(gatewayClient);
  });
  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });
}

type TaskHelpers = Parameters<ReturnType<typeof createTranscriptionTask>>[1];
type QueueTask = Parameters<typeof registerTask>[1];
interface PipelineDeps {
  pool?: Pool;
  storage?: BlobStorageWriter;
  gateway?: AudioGatewayClient;
  summary?: AiGatewayClientPort;
}

/** The pipeline task over this file's pool, blob storage and fakes, each replaceable. */
function pipelineTask(deps: PipelineDeps = {}) {
  return createTranscriptionTask(
    deps.pool ?? pool,
    deps.storage ?? blobStorage,
    deps.gateway ?? gatewayClient,
    deps.summary ?? summaryClient,
  );
}

function runPipeline(fileItemId: string, helpers: TaskHelpers = FIRST_ATTEMPT, deps: PipelineDeps = {}) {
  return pipelineTask(deps)({ fileItemId }, helpers);
}

/** Enqueues the file's pipeline job in tenant zero under its production key, and returns that key. */
async function enqueuePipeline(fileItemId: string, maxAttempts?: number): Promise<string> {
  const jobKey = `transcription-job:${fileItemId}`;
  await inTenantZero(() =>
    enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId }, { jobKey, maxAttempts }),
  );
  return jobKey;
}

/** Runs whatever pipeline job is runnable once, through the real queue wrapper. */
function runPipelineJobs(task: QueueTask = pipelineTask()): Promise<void> {
  return runOnce({
    pgPool: pool,
    taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(CORE_TASK_NAMES.TRANSCRIPTION_JOB, task) },
  });
}

/** The jobs under `key`, read through graphile-worker's view or, with `raw`, from its private table. */
async function readJobs(key: string, raw = false) {
  const { rows } = await pool.query<{ attempts: number; last_error: string | null }>(
    raw
      ? "SELECT attempts, last_error FROM graphile_worker._private_jobs WHERE key = $1"
      : "SELECT attempts, last_error FROM graphile_worker.jobs WHERE key = $1",
    [key],
  );
  return rows;
}

async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`The ${moduleId} database was not seeded`);
  return database.id;
}

function moduleDatabaseId(moduleId: string, db: Pool = pool): Promise<string> {
  return withTransaction(db, (client) => requireDatabaseId(client, moduleId));
}

/** A Files item named `recording` whose file is `bytes`, stored under a fresh key. */
async function createSourceFile(mimeType = "audio/mp4", bytes: Buffer = audioFixture, db: Pool = pool) {
  const filesId = await moduleDatabaseId("files", db);
  const storageKey = `source/${randomUUID()}`;
  await blobStorage.writeStream(storageKey, Readable.from(bytes));
  const blob = await withTransaction(db, (client) =>
    createBlob(client, { mimeType, byteSize: bytes.byteLength, storageKey }),
  );
  const file = await withTransaction(db, (client) =>
    createItemWithClient(client, { databaseId: filesId, properties: { name: "recording", file: { blobId: blob.id } } }),
  );
  return { filesId, file, blob };
}

function readSource(filesId: string, fileId: string): Promise<ItemRow | null> {
  return withTransaction(pool, (client) => getItemById(client, filesId, fileId));
}

const transcriptOutputSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()),
});

/** The transcript step 0 created for the file. */
async function readTranscript(fileId: string) {
  const { rows } = await pool.query<{ id: string; properties: unknown; computed: unknown }>(
    `SELECT t.id, t.properties, t.computed FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
     WHERE f.id = $1`,
    [fileId],
  );
  const row = rows[0];
  if (!row) throw new Error("expected a transcript for the file");
  return { id: row.id, ...transcriptOutputSchema.parse(row) };
}

async function readAutomation(transcriptId: string) {
  const { rows } = await pool.query<{ status: string; error: string | null; attempts: number }>(
    "SELECT status, error, attempts FROM item_automation WHERE item_id = $1",
    [transcriptId],
  );
  return rows[0];
}

async function readAutomationCode(transcriptId: string) {
  const { rows } = await pool.query<{ status: string; error_code: string | null }>(
    "SELECT status, error_code FROM item_automation WHERE item_id = $1",
    [transcriptId],
  );
  return rows[0];
}

async function readNotifications(transcriptId: string) {
  const { rows } = await pool.query(
    `SELECT user_id, kind, link_href, source_table, transition_instance FROM notifications WHERE source_id = $1`,
    [transcriptId],
  );
  return rows;
}

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool, `owner-${randomUUID()}@example.test`)).id;
}

/** Writes the transcript's status through the owner-process write finalize uses. */
async function setTranscriptStatus(transcriptId: string, status: string): Promise<void> {
  await withTransaction(pool, async (client) =>
    updateItemWithClient(
      client,
      { databaseId: await requireDatabaseId(client, "transcripts"), itemId: transcriptId, propertiesPatch: { status } },
      { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
    ),
  );
}

async function lockAutomation(transcriptId: string): Promise<void> {
  await pool.query("UPDATE item_automation SET status = 'locked' WHERE item_id = $1", [transcriptId]);
}

/** Trashes the item and purges it from the Trash at once, in the caller's tenant scope. */
async function purgeItem(databaseId: string, itemId: string, chokePoint = createChokePoint(pool)): Promise<void> {
  await chokePoint.softDeleteItem(databaseId, itemId);
  expect((await chokePoint.purgeExpiredTrashSubtree(itemId, purgeCutoff())).purgedItemIds).toContain(itemId);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A missed barrier fails after `ms` (five seconds) instead of hanging. */
async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Overlap barrier timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `signal`'s value, unless `running` settles first, which fails the barrier with `exitedEarly`. */
function beforeExit<T>(signal: Promise<T>, running: Promise<unknown>, exitedEarly: string): Promise<T> {
  return bounded(
    Promise.race([
      signal,
      running.then(() => {
        throw new Error(exitedEarly);
      }),
    ]),
  );
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  if (!rows[0]) throw new Error("Missing backend PID");
  return rows[0].pid;
}

/** Polls until the backend `waiterPid` waits on a lock `holderPid` holds, and fails if it never does. */
async function expectBlockedBy(holderPid: number, waiterPid: number): Promise<void> {
  let blocked = false;
  for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
    const result = await pool.query<{ blocked: boolean }>(
      "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
      [holderPid, waiterPid],
    );
    blocked = result.rows[0]?.blocked === true;
    if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  expect(blocked).toBe(true);
}

type QueryHook = (sql: string, args: unknown[], connection: PoolClient) => Promise<void> | void;

/**
 * `base` whose checked-out clients call `before` and `after` around every query; `sql` is the text of a
 * string query and empty for a query config. A throwing `before` keeps the query from running.
 */
function interceptQueries(base: Pool, hooks: { before?: QueryHook; after?: QueryHook }): Pool {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key !== "connect") {
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, property, innerReceiver) {
            if (property !== "query") {
              const value: unknown = Reflect.get(connection, property, innerReceiver);
              return typeof value === "function" ? value.bind(connection) : value;
            }
            return async (...args: unknown[]) => {
              const sql = typeof args[0] === "string" ? args[0] : "";
              await hooks.before?.(sql, args, connection);
              const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
              await hooks.after?.(sql, args, connection);
              return result;
            };
          },
        });
      };
    },
  });
}

/** Runs `body`, then every cleanup even after a failure; rethrows the one failure, or all distinct ones together. */
async function settle(label: string, body: () => Promise<void>, ...cleanups: Array<() => unknown>): Promise<void> {
  const failures: unknown[] = [];
  try {
    await body();
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, label);
}

describe("transcription step 0", () => {
  useHarness();

  /** Records the upload's `recording_requests` row; `patch` sets the columns no production writer sets yet. */
  async function recordIntake(
    fileItemId: string,
    recordedAt: string | null = null,
    patch?: { name: string | null; projectItemId: string | null },
  ): Promise<void> {
    await inTenantZero(() =>
      withTransaction(pool, (client) => recordRecordingIntake(client, { fileItemId, eventId: null, recordedAt })),
    );
    if (!patch) return;
    const updated = await pool.query(
      `UPDATE recording_requests SET name = $2, project_item_id = $3
       WHERE tenant_id = app_tenant_default() AND file_item_id = $1`,
      [fileItemId, patch.name, patch.projectItemId],
    );
    expect(updated.rowCount).toBe(1);
  }

  function runCreate(fileItemId: string): Promise<void> {
    return inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId }));
  }

  it("creates one pending transcript without a name and skips its checkpoint on replay", async () => {
    const { filesId, file } = await createSourceFile();
    // Stops each run at step 5, before `done`, so the row still shows step 0's initial values.
    summaryClient.failure = new Error("stop before finalize");
    gatewayClient.transcribeResult = () => ({
      text: "Hello.",
      language: "en",
      segments: [{ start: 0, end: 0.5, text: "Hello." }],
    });

    await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);
    await pool.query("UPDATE items SET properties = '{}'::jsonb WHERE id = $1", [file.id]);
    await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);

    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1",
      [await moduleDatabaseId("transcripts")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toMatchObject({ status: "processing", link: `semprec://items/${file.id}` });
    // The filename is not the transcript's name.
    expect(rows[0]?.properties).not.toHaveProperty("name");
    expect((await readSource(filesId, file.id))?.computed.create).toBe(rows[0]?.id);
    expect(await readAutomation(z.uuid().parse(rows[0]?.id))).toMatchObject({ status: "pending" });
  });

  it.each([null, "2026-01-05T09:00:00.000Z"])(
    "dates a fast-created transcript with the recorded timestamp, else the upload time (recorded: %s)",
    async (recordedAt) => {
      const { file, blob } = await createSourceFile();
      if (recordedAt) await recordIntake(file.id, recordedAt);
      await runCreate(file.id);
      const { properties } = await readTranscript(file.id);
      expect(new Date(z.string().parse(properties.date)).toISOString()).toBe(
        new Date(recordedAt ?? blob.createdAt).toISOString(),
      );
    },
  );

  it.each([false, true])("copies only a live requested project to a fast transcript (trashed: %s)", async (trashed) => {
    const { file } = await createSourceFile();
    const projectsId = await moduleDatabaseId("projects");
    const project = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: projectsId, properties: { name: "Chosen project" } }),
    );
    await recordIntake(file.id, null, { name: null, projectItemId: project.id });
    if (trashed)
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, projectsId, project.id, { queueAffinity: createActionQueueAffinity() }),
      );
    await runCreate(file.id);
    await runCreate(file.id);
    const transcript = await readTranscript(file.id);
    const edges = await pool.query<{ item_a: string; item_b: string }>(
      `SELECT r.item_a, r.item_b FROM item_relations r
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id = d.property_id_b
       WHERE p.key = 'project' AND r.item_b = $1`,
      [transcript.id],
    );
    expect(edges.rows).toEqual(trashed ? [] : [{ item_a: project.id, item_b: transcript.id }]);
    const links = await pool.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'project'", [
      transcript.id,
    ]);
    expect(links.rowCount).toBe(0);
    if (trashed) {
      await inTenantZero(() => runPipeline(file.id));
      expect((await readTranscript(file.id)).properties.status).toBe("done");
    }
  });

  it("converges concurrent fast creates on the same checkpoint and transcript", async () => {
    const { filesId, file } = await createSourceFile();
    const task = createTranscriptionCreateTask(pool);
    await inTenantZero(() => Promise.all([task({ fileItemId: file.id }), task({ fileItemId: file.id })]));
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1",
      [await moduleDatabaseId("transcripts")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toMatchObject({ status: "processing" });
    expect(rows[0]?.properties).not.toHaveProperty("name");
    const source = await readSource(filesId, file.id);
    expect(source?.computed.create).toBe(rows[0]?.id);
    // The filename stays on the Files item.
    expect(source?.properties.name).toBe("recording");
  });

  it.each([
    ["the name the upload set", "Pricing call"],
    ["no name when the upload set none", null],
    ["no name when the upload set an empty one", ""],
  ])("gives the transcript %s in recording_requests, and leaves the Files name alone", async (_label, name) => {
    const { filesId, file } = await createSourceFile();
    await recordIntake(file.id, null, { name, projectItemId: null });
    await runCreate(file.id);
    const { properties } = await readTranscript(file.id);
    if (name) expect(properties).toMatchObject({ name });
    else expect(properties).not.toHaveProperty("name");
    expect((await readSource(filesId, file.id))?.properties.name).toBe("recording");
  });

  it("rejects writing the transcripts 'status'/'link' system properties under the wrong systemOwnerProcess", async () => {
    const transcriptsId = await moduleDatabaseId("transcripts");
    const promise = withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: transcriptsId,
          properties: { name: "recording.mp3", status: "processing", link: "semprec://items/does-not-matter" },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: "wrong-process" },
      ),
    );
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    await expect(promise).rejects.toMatchObject({ code: "owner_violation" });
  });
});

/** Two seeded tenants; uploads use the recordings route's composition, jobs drain one lane at a time. */
describe("transcription step 0: the upload's Event", () => {
  useHarness({ seed: false, speech: true });
  let runtime: Pool;
  let tenant: string;
  let foreign: string;

  beforeEach(async () => {
    runtime = await createRuntimeRolePool(pool, "semprec_data");
    tenant = await createTestTenant(pool);
    foreign = await createTestTenant(pool);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  });

  afterEach(async () => {
    await runtime.end();
  });

  function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runInTenant(tenantId, () => withTransaction(runtime, fn));
  }

  /** A date-only Event: it has no start, so step 6 never links a recording to it by time. */
  function createEvent(tenantId: string): Promise<string> {
    return inTenant(tenantId, async (client) => {
      const event = await createItemWithClient(client, {
        databaseId: await requireDatabaseId(client, "events"),
        properties: { name: "Planning", type: "meeting", date: "2026-10-22" },
      });
      return event.id;
    });
  }

  /** Adds a person to the Event's `people`, the candidates step 7 suggests speakers from. */
  async function addParticipant(tenantId: string, eventId: string, name: string): Promise<string> {
    const { personId, peoplePropertyId } = await inTenant(tenantId, async (client) => {
      const person = await createItemWithClient(client, {
        databaseId: await requireDatabaseId(client, "people"),
        properties: { name },
      });
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
        [await requireDatabaseId(client, "events")],
      );
      if (!rows[0]) throw new Error("Events 'people' property was not seeded");
      return { personId: person.id, peoplePropertyId: rows[0].id };
    });
    await runInTenant(tenantId, () =>
      createChokePoint(runtime).createRelation({
        relationPropertyId: peoplePropertyId,
        callerItemId: eventId,
        targetItemId: personId,
      }),
    );
    return personId;
  }

  /** Uploads as `POST /api/recordings` does with `X-Event-Id`; returns the Files item id. */
  function uploadRecording(tenantId: string, eventId: string | null, bytes: Buffer = audioFixture): Promise<string> {
    return runInTenant(tenantId, async () => {
      const uploaded = await ingestUploadedFileWithTransaction(
        runtime,
        {
          filesDatabaseId: await moduleDatabaseId("files", runtime),
          filename: "recording.m4a",
          contentType: "audio/mp4",
          source: Readable.from(bytes),
          storageKeyPrefix: "files",
          maxBytes: 2_000_000,
          storage: blobStorage,
        },
        (client, result) => recordRecordingIntake(client, { fileItemId: result.item.id, eventId, recordedAt: null }),
      );
      return uploaded.result.item.id;
    });
  }

  /** Holds step 0's transaction open right after it locked `eventId`; `commit` lets it finish. */
  async function holdStepZeroAtEventLock(fileItemId: string, eventId: string) {
    const gate = deferred();
    const locked = deferred<number>();
    let held = false;
    const workerPool = interceptQueries(runtime, {
      after: async (sql, [, params], connection) => {
        if (held || !sql.includes("FOR UPDATE") || !Array.isArray(params) || params[1] !== eventId) return;
        held = true;
        locked.resolve(await backendPid(connection));
        await gate.promise;
      },
    });
    const worker = runInTenant(tenant, () => createTranscriptionCreateTask(workerPool)({ fileItemId }));
    const commit = async (): Promise<void> => {
      gate.resolve();
      await worker;
    };
    try {
      const workerPid = await beforeExit(locked.promise, worker, "Step 0 finished without a row-locking read");
      return { workerPid, commit };
    } catch (error) {
      gate.resolve();
      const settled = await worker.then(
        () => null,
        (workerError: unknown) => ({ workerError }),
      );
      if (settled && settled.workerError !== error)
        throw new AggregateError([error, settled.workerError], "Step 0 barrier and step 0 both failed", {
          cause: error,
        });
      throw error;
    }
  }

  async function readEventTrashed(eventId: string): Promise<boolean | undefined> {
    const { rows } = await inTenant(tenant, (client) =>
      client.query<{ trashed: boolean }>("SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1", [
        eventId,
      ]),
    );
    return rows[0]?.trashed;
  }

  const runCreateLane = () =>
    runOnce({
      pgPool: pool,
      taskList: {
        [CORE_TASK_NAMES.TRANSCRIPTION_CREATE]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_CREATE,
          createTranscriptionCreateTask(runtime),
        ),
      },
    });
  const runPipelineLane = () => runPipelineJobs(pipelineTask({ pool: runtime }));

  async function queuedJobKeys(keys: string[]): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
      [keys],
    );
    return rows.map((row) => row.key);
  }

  function readRecording(tenantId: string, fileItemId: string) {
    return inTenant(tenantId, async (client) => {
      const transcriptsDatabaseId = await requireDatabaseId(client, "transcripts");
      const { rows: transcripts } = await client.query<{ id: string; status: string | null }>(
        "SELECT id, properties ->> 'status' AS status FROM items WHERE database_id = $1 AND properties ->> 'link' = $2",
        [transcriptsDatabaseId, `semprec://items/${fileItemId}`],
      );
      const { rows: edges } = await client.query<{ event_id: string }>(
        `SELECT CASE WHEN r.item_a = ANY($1::uuid[]) THEN r.item_b ELSE r.item_a END AS event_id
         FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b)
         WHERE p.key = 'event' AND p.database_id = $2
           AND (r.item_a = ANY($1::uuid[]) OR r.item_b = ANY($1::uuid[]))`,
        [transcripts.map((row) => row.id), transcriptsDatabaseId],
      );
      const { rows: cards } = await client.query<{ kind: string | null; role: string | null; status: string | null }>(
        `SELECT properties ->> 'kind' AS kind, properties -> 'context' ->> 'role' AS role,
                properties ->> 'status' AS status
         FROM items WHERE database_id = $1 ORDER BY properties ->> 'status'`,
        [await requireDatabaseId(client, "processingProposals")],
      );
      return {
        statuses: transcripts.map((row) => row.status),
        eventIds: edges.map((edge) => edge.event_id),
        pairingCards: cards.filter((card) => card.role !== "speaker").map((card) => card.kind),
        speakerCards: cards.filter((card) => card.role === "speaker").map((card) => card.status),
      };
    });
  }
  const NOTHING = { statuses: [], eventIds: [], pairingCards: [], speakerCards: [] };
  const PROCESSING = { ...NOTHING, statuses: ["processing"] };

  /** A live Event already has its calendar edge, so tests compare against an earlier count. */
  async function countEdgesOf(tenantId: string, itemId: string): Promise<number> {
    const { rows } = await inTenant(tenantId, (client) =>
      client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM item_relations WHERE item_a = $1 OR item_b = $1",
        [itemId],
      ),
    );
    if (!rows[0]) throw new Error("Missing edge count");
    return rows[0].count;
  }

  it("links the transcript to the upload's live Event while it is still processing, and the pipeline adds no pairing card", async () => {
    const eventId = await createEvent(tenant);
    const aliceId = await addParticipant(tenant, eventId, "Alice");
    summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];
    const fileItemId = await uploadRecording(tenant, eventId);
    const pipelineJobKey = `transcription-job:${fileItemId}`;

    await runCreateLane();

    // The pipeline job has not run: the edge below is step 0's own, written before any media work.
    expect(await queuedJobKeys([`transcription-create:${fileItemId}`, pipelineJobKey])).toEqual([pipelineJobKey]);
    expect(await readRecording(tenant, fileItemId)).toEqual({ ...PROCESSING, eventIds: [eventId] });

    await runPipelineLane();

    expect(await queuedJobKeys([pipelineJobKey])).toEqual([]);
    expect(await readRecording(tenant, fileItemId)).toEqual({
      ...NOTHING,
      statuses: ["done"],
      eventIds: [eventId],
      speakerCards: ["needsClarification", "proposed"],
    });
    // Step 7 took its candidates from the Event step 0 linked.
    const suggestionCalls = summaryClient.calls.filter((call) => call.operation === "transcript_speaker_suggestion");
    expect(suggestionCalls).toHaveLength(1);
    expect(suggestionCalls[0]?.messages[0]?.content).toContain(`${aliceId}: Alice`);
  });

  it.each(["trashed", "purged"] as const)(
    "writes no edge when the Event was %s between the upload and step 0, and the transcript is matched normally",
    async (eventState) => {
      const eventId = await createEvent(tenant);
      const fileItemId = await uploadRecording(tenant, eventId);
      expect((await inTenant(tenant, (client) => readRecordingRequest(client, fileItemId)))?.eventId).toBe(eventId);
      await runInTenant(tenant, async () => {
        const eventsDatabaseId = await moduleDatabaseId("events", runtime);
        const chokePoint = createChokePoint(runtime);
        if (eventState === "purged") await purgeItem(eventsDatabaseId, eventId, chokePoint);
        else await chokePoint.softDeleteItem(eventsDatabaseId, eventId);
      });
      const edgesBefore = await countEdgesOf(tenant, eventId);

      await runCreateLane();

      expect(await queuedJobKeys([`transcription-create:${fileItemId}`])).toEqual([]);
      expect(await readRecording(tenant, fileItemId)).toEqual(PROCESSING);
      expect(await countEdgesOf(tenant, eventId)).toBe(edgesBefore);

      await runPipelineLane();

      // No Event starts inside the recording's window, so the normal match proposes one on a card.
      expect(await readRecording(tenant, fileItemId)).toEqual({
        ...NOTHING,
        statuses: ["done"],
        pairingCards: ["transcript"],
        speakerCards: ["needsClarification", "needsClarification"],
      });
      expect(await countEdgesOf(tenant, eventId)).toBe(edgesBefore);
    },
  );

  it("writes one edge and one transcript when step 0 runs twice", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const task = createTranscriptionCreateTask(runtime);
    const edgesBefore = await countEdgesOf(tenant, eventId);

    await runInTenant(tenant, async () => {
      await task({ fileItemId });
      await task({ fileItemId });
    });

    expect(await readRecording(tenant, fileItemId)).toEqual({ ...PROCESSING, eventIds: [eventId] });
    expect(await countEdgesOf(tenant, eventId)).toBe(edgesBefore + 1);
  });

  it("keeps a concurrent trash of the Event waiting until step 0 has committed its edge", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const eventsDatabaseId = await inTenant(tenant, (client) => requireDatabaseId(client, "events"));
    const stepZero = await holdStepZeroAtEventLock(fileItemId, eventId);
    const trashStarted = deferred<number>();
    let trash: Promise<void> | undefined;
    await settle(
      "Step 0 and trash overlap or its cleanup failed",
      async () => {
        trash = inTenant(tenant, async (client) => {
          trashStarted.resolve(await backendPid(client));
          await itemDeleteWithClient(client, eventsDatabaseId, eventId, { queueAffinity: createActionQueueAffinity() });
        });
        const trashPid = await beforeExit(
          trashStarted.promise,
          trash,
          "The trash finished while step 0 held the Event",
        );
        await expectBlockedBy(stepZero.workerPid, trashPid);
        expect(await readEventTrashed(eventId)).toBe(false);
      },
      () => stepZero.commit(),
      () => trash,
    );

    // The edge was written to a live Event; the trash that waited for it then went through.
    expect((await readRecording(tenant, fileItemId)).eventIds).toEqual([eventId]);
    expect(await readEventTrashed(eventId)).toBe(true);
  });

  it("answers a concurrent upload naming the same Event recording_busy while step 0 holds the Event, and accepts it afterwards", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const secondRecording = Buffer.from("a second recording of the same meeting");
    const stepZero = await holdStepZeroAtEventLock(fileItemId, eventId);
    await settle(
      "Step 0 and upload overlap or its cleanup failed",
      () =>
        expect(uploadRecording(tenant, eventId, secondRecording)).rejects.toMatchObject({
          status: 409,
          code: "recording_busy",
        }),
      () => stepZero.commit(),
    );

    const secondFileItemId = await uploadRecording(tenant, eventId, secondRecording);
    expect(secondFileItemId).not.toBe(fileItemId);
    expect((await inTenant(tenant, (client) => readRecordingRequest(client, secondFileItemId)))?.eventId).toBe(eventId);
  });

  it.each(["another tenant's Event", "an unknown id"] as const)(
    "writes no edge for a request naming %s, and nothing in the other tenant",
    async (requested) => {
      const foreignEventId = await createEvent(foreign);
      const foreignEdgesBefore = await countEdgesOf(foreign, foreignEventId);
      const fileItemId = await uploadRecording(tenant, null);
      // recordRecordingIntake refuses an Event outside the tenant, so only a direct write can leave such an id in the request.
      const planted = await runInTenant(tenant, () =>
        runtime.query(
          "UPDATE recording_requests SET event_item_id = $2 WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
          [fileItemId, requested === "another tenant's Event" ? foreignEventId : randomUUID()],
        ),
      );
      expect(planted.rowCount).toBe(1);

      await runCreateLane();

      expect(await queuedJobKeys([`transcription-create:${fileItemId}`])).toEqual([]);
      expect(await readRecording(tenant, fileItemId)).toEqual(PROCESSING);
      expect(await countEdgesOf(foreign, foreignEventId)).toBe(foreignEdgesBefore);
      expect(await readRecording(foreign, fileItemId)).toEqual(NOTHING);
    },
  );

  it("runs this process's relation-edge hooks for the edge: the Event's search reindex is queued with it", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const reindexKey = `item-search-reindex:item:${eventId}`;
    // The Event's calendar edge queued this job; removing it leaves only the one step 0's edge queued.
    await pool.query("SELECT graphile_worker.remove_job($1)", [reindexKey]);
    expect(await queuedJobKeys([reindexKey])).toEqual([]);

    await runCreateLane();

    expect((await readRecording(tenant, fileItemId)).eventIds).toEqual([eventId]);
    expect(await queuedJobKeys([reindexKey])).toEqual([reindexKey]);
  });

  it.each([
    [
      "Events database",
      "UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'events'",
      "Events database not found",
    ],
    [
      "Transcripts 'event' relation",
      `UPDATE properties SET key = 'eventUnavailable'
       WHERE key = 'event' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')`,
      "Transcript event relation not found",
    ],
  ] as const)(
    "fails and writes nothing when the %s is missing from the catalog",
    async (_label, removeCatalogEntry, message) => {
      const eventId = await createEvent(tenant);
      const fileItemId = await uploadRecording(tenant, eventId);
      // Simulate a missing built-in catalog entry, which normal APIs cannot remove.
      const removed = await runInTenant(tenant, () => runtime.query(removeCatalogEntry));
      expect(removed.rowCount).toBe(1);
      const edgesBefore = await countEdgesOf(tenant, eventId);

      await expect(runInTenant(tenant, () => createTranscriptionCreateTask(runtime)({ fileItemId }))).rejects.toThrow(
        message,
      );

      expect(await readRecording(tenant, fileItemId)).toEqual(NOTHING);
      expect(await countEdgesOf(tenant, eventId)).toBe(edgesBefore);
      const checkpoint = await inTenant(tenant, (client) =>
        client.query<{ created: boolean }>("SELECT computed ? 'create' AS created FROM items WHERE id = $1", [
          fileItemId,
        ]),
      );
      expect(checkpoint.rows).toEqual([{ created: false }]);
    },
  );
});

const prepareCheckpointSchema = z.object({
  normalizedBlobId: z.string(),
  playbackBlobId: z.string().optional(),
  durationSeconds: z.number(),
  creationTime: z.string().nullable(),
});

describe("transcription step 1 (prepare)", () => {
  useHarness();
  let videoFixture: Buffer;
  let untaggedAudioFixture: Buffer;
  let transcriptionsPrefix: string;

  beforeAll(async () => {
    [videoFixture, untaggedAudioFixture] = await Promise.all([
      generateMp4Fixture({ withVideo: true, creationTime: FIXTURE_CREATION_TIME }),
      generateMp4Fixture(),
    ]);
  });

  beforeEach(async () => {
    const { rows } = await pool.query<{ tenant_id: string }>("SELECT app_tenant_default()::text AS tenant_id");
    transcriptionsPrefix = `${z.string().parse(rows[0]?.tenant_id)}/transcriptions/`;
  });

  async function readTranscriptDate(source: ItemRow | null): Promise<unknown> {
    const { rows } = await pool.query<Record<string, unknown>>("SELECT properties FROM items WHERE id = $1", [
      z.string().parse(source?.computed.create),
    ]);
    return rows[0]
      ? z.object({ properties: z.record(z.string(), z.unknown()) }).parse(rows[0]).properties.date
      : undefined;
  }

  /** The normalized audio left behind — neither a `blobs` row nor bytes in storage when step 1 discarded it. */
  async function readNormalizedLeftovers(): Promise<{ blobRows: number; storedFiles: string[] }> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM blobs WHERE storage_key LIKE $1", [
      `${transcriptionsPrefix}%`,
    ]);
    return {
      blobRows: Number(rows[0]?.count),
      storedFiles: await readdir(join(tmpBlobDir, transcriptionsPrefix)),
    };
  }
  const NOTHING_LEFT = { blobRows: 0, storedFiles: [] };

  /**
   * Runs `hook` beside the real write of ffmpeg's output, between step 1's two transactions. The write
   * must start first: an unread stdout is dropped when ffmpeg exits, leaving empty audio. The hook's
   * failure is thrown only after the write settled.
   */
  function storageWithMidNormalizationHook(hook: () => Promise<void>): BlobStorageWriter {
    return {
      writeStream: async (storageKey, source, options) => {
        if (!storageKey.startsWith(transcriptionsPrefix)) return blobStorage.writeStream(storageKey, source, options);
        const [written, hooked] = await Promise.allSettled([
          blobStorage.writeStream(storageKey, source, options),
          hook(),
        ]);
        if (hooked.status === "rejected") throw hooked.reason;
        if (written.status === "rejected") throw written.reason;
        return written.value;
      },
      delete: (storageKey) => blobStorage.delete(storageKey),
      readStream: (storageKey, range) => blobStorage.readStream(storageKey, range),
    };
  }

  /** Runs the pipeline over a fresh source of `bytes` and returns its step 1 checkpoint. */
  async function runPrepare(mimeType: string, bytes: Buffer) {
    const { filesId, file, blob } = await createSourceFile(mimeType, bytes);
    await runPipeline(file.id);
    const source = await readSource(filesId, file.id);
    return { prepare: prepareCheckpointSchema.parse(source?.computed.prepare), source, blob };
  }

  async function readBlob(id: string | undefined) {
    const { rows } = await pool.query<{ mime_type: string; storage_key: string }>(
      "SELECT mime_type, storage_key FROM blobs WHERE id = $1",
      [id],
    );
    return rows;
  }

  it.each([
    ["audio", "audio/mp4", () => audioFixture],
    ["video with an audio track", "video/mp4", () => videoFixture],
  ])(
    "normalizes a %s input to 16 kHz mono Opus and checkpoints duration and creation_time",
    async (_label, mimeType, getBytes) => {
      const { prepare, source } = await runPrepare(mimeType, getBytes());
      expect(prepare.durationSeconds).toBeGreaterThan(0.5);
      expect(prepare.durationSeconds).toBeLessThan(2);
      expect(prepare.creationTime).toBe("2024-03-01T12:00:00.000Z");

      const blobRows = await readBlob(prepare.normalizedBlobId);
      expect(blobRows).toEqual([
        { mime_type: "audio/ogg", storage_key: expect.stringMatching(new RegExp(`^${transcriptionsPrefix}`)) },
      ]);
      expect(await probeNormalizedAudio(join(tmpBlobDir, blobRows[0]!.storage_key))).toEqual({
        codecName: "opus",
        channels: 1,
        inputSampleRate: 16_000,
      });
      expect(await readTranscriptDate(source)).toBe("2024-03-01T12:00:00.000Z");
    },
  );

  it("checkpoints the normalized output's own duration when the source container has none", async () => {
    const { prepare } = await runPrepare("audio/webm", await generateWebmFixture());
    expect(prepare.durationSeconds).toBeGreaterThan(2.9);
    expect(prepare.durationSeconds).toBeLessThan(3.5);
  });

  it("falls back to the upload time for date when the recording has no creation_time", async () => {
    const { prepare, source, blob } = await runPrepare("audio/mp4", untaggedAudioFixture);
    expect(prepare.creationTime).toBeNull();
    expect(await readTranscriptDate(source)).toBe(blob.createdAt);
  });

  it("skips step 1 on a replay without invoking ffmpeg/ffprobe again", async () => {
    const { filesId, file } = await createSourceFile();
    await runPipeline(file.id);
    const beforeReplay = await readSource(filesId, file.id);
    expect(beforeReplay?.computed.prepare).toBeDefined();

    // The blobs are gone, so a clean replay proves step 1's checkpoint skip fired.
    await rm(tmpBlobDir, { recursive: true, force: true });

    await expect(runPipeline(file.id)).resolves.toBeUndefined();
    expect((await readSource(filesId, file.id))?.computed.prepare).toEqual(beforeReplay?.computed.prepare);
  });

  it("holds no pooled connection, and so no transaction, while ffmpeg runs", async () => {
    const { filesId, file } = await createSourceFile();
    let checkedOutDuringFfmpeg: number | undefined;
    const storage = storageWithMidNormalizationHook(async () => {
      checkedOutDuringFfmpeg = pool.totalCount - pool.idleCount;
    });

    await runPipeline(file.id, FIRST_ATTEMPT, { storage });

    expect(checkedOutDuringFfmpeg).toBe(0);
    expect((await readSource(filesId, file.id))?.computed.prepare).toBeDefined();
  });

  it("keeps the prepare read at repeatable read and guards the write at read committed without SET TRANSACTION", async () => {
    const { filesId, file } = await createSourceFile();
    const statements: string[] = [];
    const recordingPool = interceptQueries(pool, {
      before: (_sql, [first]) => {
        const parsed = z.object({ text: z.string() }).safeParse(first);
        const sql = typeof first === "string" ? first : parsed.success ? parsed.data.text : undefined;
        if (sql !== undefined) statements.push(sql);
      },
    });

    await runPipeline(file.id, FIRST_ATTEMPT, { pool: recordingPool });

    const firstSnapshot = statements.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const isolationGuard = statements.indexOf("SHOW transaction_isolation");
    expect(firstSnapshot).toBeGreaterThanOrEqual(0);
    expect(isolationGuard).toBeGreaterThan(firstSnapshot);
    expect(statements.slice(firstSnapshot + 1, isolationGuard).lastIndexOf("BEGIN")).toBeGreaterThanOrEqual(0);
    expect(statements.filter((text) => /SET\s+TRANSACTION/i.test(text))).toEqual([]);
    expect((await readSource(filesId, file.id))?.computed.prepare).toBeDefined();
  });

  it("reads an intake committed while prepare waits for an unchanged Files row", async () => {
    const { filesId, file } = await createSourceFile();
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const releaseIntake = deferred();
    const intakeReady = deferred<{ pid: number; file: ItemRow }>();
    const prepareReady = deferred<number>();
    let observedPrepare = false;
    const workerPool = interceptQueries(runtime, {
      after: async (sql, _args, connection) => {
        if (observedPrepare || sql !== "SHOW transaction_isolation") return;
        observedPrepare = true;
        prepareReady.resolve(await backendPid(connection));
      },
    });
    let intake: Promise<void> | undefined;
    const storage = storageWithMidNormalizationHook(async () => {
      if (intake) return;
      intake = runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, async (client) => {
          const pid = await backendPid(client);
          const before = await getItemById(client, filesId, file.id);
          await recordRecordingIntake(client, {
            fileItemId: file.id,
            eventId: null,
            recordedAt: "2026-01-01T10:00:00Z",
          });
          const current = await getItemById(client, filesId, file.id);
          if (!current || !before) throw new Error("Missing Files row");
          expect(current).toEqual(before);
          intakeReady.resolve({ pid, file: current });
          await releaseIntake.promise;
        }),
      );
      await beforeExit(intakeReady.promise, intake, "Intake exited early");
    });
    let worker: Promise<void> | undefined;
    await settle(
      "Prepare overlap or cleanup failed",
      async () => {
        worker = runInTenant(getTenantZeroId(), () =>
          runPipeline(file.id, FIRST_ATTEMPT, { pool: workerPool, storage }),
        );
        const state = await beforeExit(intakeReady.promise, worker, "Worker exited early");
        const workerPid = await beforeExit(prepareReady.promise, worker, "Worker exited early");
        expect(workerPid).not.toBe(state.pid);
        const unchanged = await runInTenant(getTenantZeroId(), () =>
          withTransaction(runtime, (client) => getItemById(client, filesId, file.id)),
        );
        expect(unchanged).toEqual(state.file);
        await expectBlockedBy(state.pid, workerPid);
        releaseIntake.resolve();
        await intake;
        await worker;
        const source = await readSource(filesId, file.id);
        expect(source?.computed.prepare).toBeDefined();
        expect(new Date(String(await readTranscriptDate(source))).toISOString()).toBe("2026-01-01T10:00:00.000Z");
      },
      () => releaseIntake.resolve(),
      () => intake,
      () => worker,
      () => runtime.end(),
    );
  });

  it("rejects overlapping intake when prepare owns Files and keeps the committed prepare date", async () => {
    const filesId = await moduleDatabaseId("files");
    const uploadInput = () => ({
      filesDatabaseId: filesId,
      filename: "recording.mp4",
      contentType: "audio/mp4",
      source: Readable.from(audioFixture),
      storageKeyPrefix: "files",
      maxBytes: 2_000_000,
      storage: blobStorage,
    });
    const file = (await inTenantZero(() => ingestUploadedFile(pool, uploadInput()))).item;
    const intake = { fileItemId: file.id, eventId: null, recordedAt: "2026-01-01T10:00:00Z" };
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const releasePrepare = deferred();
    const locked = deferred<number>();
    let inPrepareWrite = false;
    let held = false;
    const workerPool = interceptQueries(runtime, {
      after: async (sql, _args, connection) => {
        if (sql === "SHOW transaction_isolation") inPrepareWrite = true;
        if (!inPrepareWrite || held || !sql.includes("FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE"))
          return;
        held = true;
        locked.resolve(await backendPid(connection));
        await releasePrepare.promise;
      },
    });
    const inRuntime = <T>(fn: (client: PoolClient) => Promise<T>) =>
      runInTenant(getTenantZeroId(), () => withTransaction(runtime, fn));
    let worker: Promise<void> | undefined;
    await settle(
      "Prepare-first overlap or cleanup failed",
      async () => {
        worker = runInTenant(getTenantZeroId(), () => runPipeline(file.id, FIRST_ATTEMPT, { pool: workerPool }));
        const holderPid = await beforeExit(locked.promise, worker, "Worker exited before prepare lock");
        const counts = () =>
          inRuntime((client) =>
            client.query<{ files: string; blobs: string }>(
              "SELECT (SELECT count(*)::text FROM items WHERE database_id = $1) AS files, (SELECT count(*)::text FROM blobs) AS blobs",
              [filesId],
            ),
          );
        const before = await counts();
        await expect(
          runInTenant(getTenantZeroId(), () =>
            ingestUploadedFileWithTransaction(runtime, uploadInput(), async (client, result) => {
              expect(await backendPid(client)).not.toBe(holderPid);
              expect(result.item.id).toBe(file.id);
              await recordRecordingIntake(client, intake);
            }),
          ),
        ).rejects.toMatchObject({ status: 409, code: "recording_busy" });
        expect((await counts()).rows).toEqual(before.rows);
        expect(await inRuntime((client) => readRecordingRequest(client, file.id))).toBeNull();
        releasePrepare.resolve();
        await worker;
        const prepared = await readSource(filesId, file.id);
        const date = await readTranscriptDate(prepared);
        expect(prepared?.computed.prepare).toBeDefined();
        await inRuntime((client) => recordRecordingIntake(client, intake));
        await runInTenant(getTenantZeroId(), () => runPipeline(file.id, FIRST_ATTEMPT, { pool: workerPool }));
        expect(await readTranscriptDate(await readSource(filesId, file.id))).toEqual(date);
      },
      () => releasePrepare.resolve(),
      () => worker,
      () => runtime.end(),
    );
  });

  it("writes nothing and discards its audio when the source's file is replaced while ffmpeg runs", async () => {
    const { filesId, file } = await createSourceFile();
    let provisionalDate: unknown;
    const replacement = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: 1, storageKey: `source/${randomUUID()}` }),
    );
    const storage = storageWithMidNormalizationHook(async () => {
      provisionalDate = await readTranscriptDate(await readSource(filesId, file.id));
      expect(provisionalDate).toEqual(expect.any(String));
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: filesId,
          itemId: file.id,
          propertiesPatch: { file: { blobId: replacement.id } },
        }),
      );
    });

    await expect(runPipeline(file.id, FIRST_ATTEMPT, { storage })).rejects.toMatchObject({
      name: "TranscriptionQueueError",
      code: "unknown",
    });

    const source = await readSource(filesId, file.id);
    expect(source?.computed).not.toHaveProperty("prepare");
    expect(await readTranscriptDate(source)).toEqual(provisionalDate);
    expect(await readNormalizedLeftovers()).toEqual(NOTHING_LEFT);
  });

  it("keeps the checkpoint of a concurrent run that finished step 1 first and discards its own audio", async () => {
    const { filesId, file } = await createSourceFile();
    // A real blob for diarize/ASR to download, standing in for the concurrent run's output.
    const concurrentStorageKey = `${transcriptionsPrefix}${randomUUID()}`;
    await blobStorage.writeStream(concurrentStorageKey, Readable.from(audioFixture));
    const concurrentBlob = await withTransaction(pool, (client) =>
      createBlob(client, {
        mimeType: "audio/mp4",
        byteSize: audioFixture.byteLength,
        storageKey: concurrentStorageKey,
      }),
    );
    const concurrentCheckpoint = { normalizedBlobId: concurrentBlob.id, durationSeconds: 1, creationTime: null };
    // The concurrent run's own `date`, which it writes in the same transaction as its checkpoint.
    const concurrentDate = "2020-01-01T00:00:00.000Z";
    const storage = storageWithMidNormalizationHook(async () => {
      await withTransaction(pool, async (client) => {
        const source = await getItemById(client, filesId, file.id);
        await updateItemWithClient(
          client,
          {
            databaseId: await requireDatabaseId(client, "transcripts"),
            itemId: z.string().parse(source?.computed.create),
            propertiesPatch: { date: concurrentDate },
          },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await writeComputed(client, filesId, file.id, "prepare", concurrentCheckpoint);
      });
    });

    await runPipeline(file.id, FIRST_ATTEMPT, { storage });

    const source = await readSource(filesId, file.id);
    expect(source?.computed.prepare).toEqual(concurrentCheckpoint);
    expect(await readTranscriptDate(source)).toBe(concurrentDate);
    expect(await readNormalizedLeftovers()).toEqual({
      blobRows: 1,
      storedFiles: [concurrentStorageKey.slice(transcriptionsPrefix.length)],
    });
  });

  it.each(["audio/mp4", "audio/mpeg", "audio/wav"])(
    "plays the original of a %s source and creates no playback blob",
    async (mimeType) => {
      const { prepare, blob } = await runPrepare(mimeType, audioFixture);

      expect(prepare.playbackBlobId).toBe(blob.id);
      // Only the normalized Opus copy is created next to the original.
      expect((await readNormalizedLeftovers()).blobRows).toBe(1);
    },
  );

  it.each([
    ["a video", "video/mp4", null, () => videoFixture],
    ["an Ogg recording", "audio/ogg", 1, () => generateOggFixture()],
    // The audio lasts two seconds but starts one second into the container.
    ["a video whose audio starts late", "video/x-matroska", 2, () => generateLateAudioVideoFixture()],
  ])("renders and checkpoints an AAC m4a playback blob for %s", async (_label, mimeType, audioSeconds, getBytes) => {
    const { prepare, blob } = await runPrepare(mimeType, await getBytes());

    expect(prepare.playbackBlobId).toBeDefined();
    expect(prepare.playbackBlobId).not.toBe(blob.id);
    expect(prepare.playbackBlobId).not.toBe(prepare.normalizedBlobId);
    const rows = await readBlob(prepare.playbackBlobId);
    expect(rows).toEqual([
      { mime_type: "audio/mp4", storage_key: expect.stringMatching(new RegExp(`^${transcriptionsPrefix}.*\\.m4a$`)) },
    ]);
    const path = join(tmpBlobDir, rows[0]!.storage_key);
    expect(await probeAudioStream(path)).toMatchObject({ codecName: "aac", channels: 1 });
    const { durationSeconds } = await probeMedia(path);
    expect(Math.abs((durationSeconds ?? NaN) - prepare.durationSeconds)).toBeLessThan(0.1);
    if (audioSeconds !== null) expect(Math.abs((durationSeconds ?? NaN) - audioSeconds)).toBeLessThan(0.1);
    else expect(durationSeconds).toBeGreaterThan(0);
  });

  it("discards the normalized audio when rendering the playback copy fails", async () => {
    const { file } = await createSourceFile("video/mp4", videoFixture);
    const storage: BlobStorageWriter = {
      writeStream: (storageKey, source, options) => {
        if (storageKey.endsWith(".m4a")) return Promise.reject(new Error("disk full"));
        return blobStorage.writeStream(storageKey, source, options);
      },
      delete: (storageKey) => blobStorage.delete(storageKey),
      readStream: (storageKey, range) => blobStorage.readStream(storageKey, range),
    };

    await expect(runPipeline(file.id, FIRST_ATTEMPT, { storage })).rejects.toMatchObject(TASK_FAILED);

    expect(await readNormalizedLeftovers()).toEqual(NOTHING_LEFT);
  });

  it("rolls back and discards its audio when the write transaction fails", async () => {
    const { filesId, file } = await createSourceFile();
    const storage = storageWithMidNormalizationHook(async () => {
      // A transcript deleted mid-normalization makes the write transaction's `date` patch fail.
      await pool.query(
        "UPDATE items SET deleted_at = now() WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')",
      );
    });

    // A deleted transcript is a clean stop, not a failure.
    await runPipeline(file.id, FIRST_ATTEMPT, { storage });

    expect((await readSource(filesId, file.id))?.computed).not.toHaveProperty("prepare");
    expect(await readNormalizedLeftovers()).toEqual(NOTHING_LEFT);
  });
});

const asrCheckpointSchema = z.object({
  language: z.string().nullable(),
  chunks: z.record(z.string(), z.object({ text: z.string(), segments: z.array(z.any()) })),
});

describe("transcription steps 2 and 3 (diarize, ASR)", () => {
  useHarness();

  /** Fakes a long recording for chunking; `ffmpeg -t` past the real file's end stops at EOF. */
  async function inflateDurationAndResetLaterSteps(fileId: string, durationSeconds: number): Promise<void> {
    await pool.query(
      `UPDATE items
       SET computed = jsonb_set(computed, '{prepare,durationSeconds}', to_jsonb($2::float8)) - 'diarize' - 'asr'
       WHERE id = $1`,
      [fileId, durationSeconds],
    );
  }

  /** A source whose first run finished, then made `minutes` long with no diarize or ASR checkpoint yet. */
  async function createLongRecording(minutes: number) {
    const source = await createSourceFile();
    await runPipeline(source.file.id);
    await inflateDurationAndResetLaterSteps(source.file.id, minutes * 60);
    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    return source;
  }

  async function readAsrChunks(filesId: string, fileId: string) {
    return asrCheckpointSchema.parse((await readSource(filesId, fileId))?.computed.asr);
  }

  /** Answers chunk `n` (counted from `first`) with the text `chunk-n`, in the language it was asked for, else `cs`. */
  function answerChunks(first = 0, onCall?: (index: number) => void) {
    gatewayClient.transcribeResult = (request) => {
      const index = gatewayClient.transcribeCalls.length - 1;
      onCall?.(index);
      return { text: `chunk-${index + first}`, language: request.language ?? "cs", segments: [] };
    };
  }

  it.each([
    [{ exact: 2 }, 2, null],
    [{ min: 3 }, null, 3],
    [undefined, null, null],
  ])("reads recording choices for diarization and first ASR chunk: %s", async (expected, exact, minimum) => {
    const { filesId, file } = await createSourceFile();
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        recordRecordingIntake(client, { fileItemId: file.id, eventId: null, recordedAt: null }),
      ),
    );
    // No writer produces this shape yet; populate it directly.
    const fixture = await inTenantZero(() =>
      pool.query(
        "UPDATE recording_requests SET language = $2, num_speakers_exact = $3, num_speakers_min = $4 WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
        [file.id, "cs", exact, minimum],
      ),
    );
    expect(fixture.rowCount).toBe(1);
    gatewayClient.transcribeResult = () => ({ text: "fixture", language: "en", segments: [] });
    await inTenantZero(() => runPipeline(file.id));
    expect(gatewayClient.diarizeCalls[0]?.numSpeakers).toEqual(expected);
    expect(gatewayClient.transcribeCalls[0]?.language).toBe("cs");
    await inflateDurationAndResetLaterSteps(file.id, 25 * 60);
    await inTenantZero(() => runPipeline(file.id));
    expect(gatewayClient.diarizeCalls[1]?.numSpeakers).toEqual(expected);
    expect(gatewayClient.transcribeCalls[1]?.language).toBe("cs");
    expect(gatewayClient.transcribeCalls[2]?.language).toBe("en");
    expect((await readSource(filesId, file.id))?.computed.diarize).toBeDefined();
  });

  it("diarizes the whole recording exactly once, checkpoints its turns, runs ASR, and skips diarization on a replay", async () => {
    const { filesId, file } = await createSourceFile();
    gatewayClient.diarizeResult = [{ speaker: "SPEAKER_00", start: 0, end: 1 }];

    await runPipeline(file.id);
    await runPipeline(file.id);

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.diarizeCalls[0]?.audioSeconds).toBeGreaterThan(0);
    expect(gatewayClient.transcribeCalls.length).toBeGreaterThan(0);
    expect((await readSource(filesId, file.id))?.computed.diarize).toEqual(gatewayClient.diarizeResult);
  });

  it("splits ASR into one chunk per 20-minute boundary, checkpoints each immediately, and passes chunk 0's detected language to later chunks", async () => {
    const { filesId, file } = await createLongRecording(25);
    answerChunks();

    await runPipeline(file.id);

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls.map((call) => call.language)).toEqual([undefined, "cs"]);
    const asr = await readAsrChunks(filesId, file.id);
    expect(asr.language).toBe("cs");
    expect(Object.keys(asr.chunks)).toEqual(["0", "1"]);
    expect(asr.chunks["0"]?.text).toBe("chunk-0");
    expect(asr.chunks["1"]?.text).toBe("chunk-1");
  });

  it("resumes after a crash mid-ASR: the retried run repeats no already-checkpointed chunk and no diarize call", async () => {
    const { filesId, file } = await createLongRecording(25);
    answerChunks(0, (index) => {
      if (index === 1) throw new Error("simulated crash");
    });

    await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);
    expect(Object.keys((await readAsrChunks(filesId, file.id)).chunks)).toEqual(["0"]);

    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    answerChunks(1);
    await runPipeline(file.id);

    expect(gatewayClient.diarizeCalls).toHaveLength(0);
    expect(gatewayClient.transcribeCalls.map((call) => call.language)).toEqual(["cs"]);
    expect(Object.keys((await readAsrChunks(filesId, file.id)).chunks)).toEqual(["0", "1"]);
  });

  async function readQueuedJobAttempts(fileId: string): Promise<Array<{ attempts: number }>> {
    return (await readJobs(`transcription-job:${fileId}`)).map(({ attempts }) => ({ attempts }));
  }

  it("stops at the next ASR checkpoint when shutdown is requested and re-enqueues itself", async () => {
    const { filesId, file } = await createLongRecording(45);
    const controller = new AbortController();
    answerChunks(0, (index) => {
      if (index === 0) controller.abort();
    });

    await runPipeline(file.id, { ...FIRST_ATTEMPT, abortSignal: controller.signal });

    expect(gatewayClient.transcribeCalls).toHaveLength(1);
    expect(Object.keys((await readAsrChunks(filesId, file.id)).chunks)).toEqual(["0"]);
    expect(await readQueuedJobAttempts(file.id)).toEqual([{ attempts: 0 }]);
    // `status` still reads the earlier "done"; only `item_automation` shows nothing failed.
    const transcript = await readTranscript(file.id);
    expect(await readAutomation(transcript.id)).toMatchObject({ status: "pending", error: null });

    gatewayClient.transcribeCalls = [];
    answerChunks(1);
    await runPipeline(file.id, attempt(2));

    expect(gatewayClient.transcribeCalls).toHaveLength(2);
    expect(Object.keys((await readAsrChunks(filesId, file.id)).chunks)).toEqual(["0", "1", "2"]);
    expect((await readTranscript(file.id)).properties.status).toBe("done");
  });

  it("stops between steps when shutdown is requested", async () => {
    const { filesId, file } = await createSourceFile();
    const controller = new AbortController();
    gatewayClient.transcribeResult = () => {
      controller.abort();
      return { text: "chunk-0", language: "cs", segments: [] };
    };

    await runPipeline(file.id, { ...FIRST_ATTEMPT, abortSignal: controller.signal });

    expect(summaryClient.calls).toHaveLength(0);
    expect(await readQueuedJobAttempts(file.id)).toEqual([{ attempts: 0 }]);
    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("processing");
    expect(transcript.computed.segments).toBeUndefined();
    expect(await readAutomation(transcript.id)).toMatchObject({ status: "pending", error: null });
    expect((await readSource(filesId, file.id))?.computed.asr).toBeDefined();
  });
});

describe("transcription steps 4-8 (merge, summarize, match, suggest speakers, finalize)", () => {
  useHarness({ speech: true });

  const failOn = (operation: string) => overriding(operation, () => Promise.reject(new Error("gateway refused")));

  it("merges into speaker segments with the language, summarizes, and finalizes done with item_automation done", async () => {
    const announced: string[] = [];
    setInvalidationHook((event) => {
      if (event.scope === "item" && event.itemId) announced.push(event.itemId);
    });
    const { file } = await createSourceFile();

    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([
      { speaker: "SPEAKER_00", text: "Hello.", startsAt: 0, endsAt: 0.4 },
      { speaker: "SPEAKER_01", text: "Hi there.", startsAt: 0.6, endsAt: 0.9 },
    ]);
    expect(transcript.computed.language).toBe("en");
    expect(transcript.computed.durationSeconds).toBeGreaterThan(0);
    expect(announced).toContain(transcript.id);
    expect(transcript.computed.finalizedAt).toEqual(expect.stringMatching(/Z$/));
    await runPipeline(file.id);
    expect((await readTranscript(file.id)).computed).toEqual(transcript.computed);
    // Every notes field is present; no action items is [].
    expect(transcript.computed.meetingNotes).toEqual(STORED_NOTES);
    expect(transcript.computed).not.toHaveProperty("summaryByInstruction");
    expect(transcript.properties.status).toBe("done");
    expect(await readAutomation(transcript.id)).toMatchObject({ status: "done" });

    expect(summaryClient.calls).toHaveLength(1);
    expect(summaryClient.calls[0]).toMatchObject({ operation: "transcript_summary", projectItemId: null });
    expect(summaryClient.calls[0]?.system).toContain("(en)");
    const content = summaryClient.calls[0]?.messages[0]?.content;
    expect(content).toContain("[0] SPEAKER_00: Hello.\n[0.6] SPEAKER_01: Hi there.");
    const recordedAt = z.string().parse(transcript.properties.date);
    const day = recordingDay(recordedAt, await withTransaction(pool, (client) => getSystemTimezone(client)));
    expect(day).not.toBeNull();
    expect(content).toContain(`Recording date: ${day?.date} (${day?.weekday})`);
  });

  it("merges overlapping ASR chunks without duplicating the overlap band", async () => {
    const { file } = await createSourceFile();
    gatewayClient.diarizeResult = [{ speaker: "SPEAKER_00", start: 0, end: 1500 }];
    // Steps 0 and 1 land, then diarization fails before any later checkpoint exists.
    const failingGateway = diarizingWith(() => Promise.reject(new Error("simulated diarize failure")));
    await expect(runPipeline(file.id, FIRST_ATTEMPT, { gateway: failingGateway })).rejects.toMatchObject(TASK_FAILED);
    // 25 minutes: chunk 0 = [0, 1200], chunk 1 = [1170, 1500], cut at 1185.
    await pool.query(
      `UPDATE items SET computed = jsonb_set(computed, '{prepare,durationSeconds}', to_jsonb(1500::float8)) WHERE id = $1`,
      [file.id],
    );
    gatewayClient.transcribeResult = (request) => ({
      text: "",
      language: "cs",
      segments:
        request.filename === "chunk-0.opus"
          ? [
              { start: 1175, end: 1180, text: "early in band" },
              { start: 1188, end: 1196, text: "late in band (chunk 0 copy)" },
            ]
          : [
              { start: 5, end: 10, text: "early in band (chunk 1 copy)" },
              { start: 18, end: 26, text: "late in band" },
            ],
    });

    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([
      { speaker: "SPEAKER_00", text: "early in band", startsAt: 1175, endsAt: 1180 },
      { speaker: "SPEAKER_00", text: "late in band", startsAt: 1188, endsAt: 1196 },
    ]);
    expect(transcript.computed.language).toBe("cs");
  });

  it("stores normalized action items: a known owner, a calendar due and a non-negative start, else null", async () => {
    const { file } = await createSourceFile();
    summaryClient.actionItems = [
      { text: "{SPEAKER_01} sends the pricing", ownerSpeaker: "SPEAKER_01", due: "2026-02-30", startsAt: 0.6 },
      { text: "Book the room", ownerSpeaker: "SPEAKER_09", due: "2026-10-17", startsAt: -3 },
    ];

    await runPipeline(file.id);

    expect((await readTranscript(file.id)).computed.meetingNotes).toEqual({
      ...FAKE_NOTES,
      actionItems: [
        { text: "{SPEAKER_01} sends the pricing", ownerSpeaker: "SPEAKER_01", due: null, startsAt: 0.6 },
        { text: "Book the room", ownerSpeaker: null, due: "2026-10-17", startsAt: null },
      ],
    });
  });

  it("leaves the row processing when the summary fails, then stores the notes once on retry without repeating a paid call, keeping an earlier summaryByInstruction", async () => {
    const { file } = await createSourceFile();
    summaryClient.failure = new Error("simulated gateway failure");
    await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);
    const failed = await readTranscript(file.id);
    expect(failed.computed.segments).toHaveLength(2);
    expect(failed.computed).not.toHaveProperty("meetingNotes");
    expect(failed.properties.status).toBe("processing");
    expect(await readAutomation(failed.id)).toMatchObject({ status: "pending" });
    // A key no current writer produces.
    const legacy = { meetingSummary: "Summary written before structured notes." };
    await withTransaction(pool, async (client) =>
      writeComputed(client, await requireDatabaseId(client, "transcripts"), failed.id, "summaryByInstruction", legacy),
    );
    summaryClient.failure = null;

    await runPipeline(file.id);
    const done = await readTranscript(file.id);
    await runPipeline(file.id);

    expect(done.properties.status).toBe("done");
    expect(await readAutomation(done.id)).toMatchObject({ status: "done" });
    expect(done.computed.segments).toEqual(failed.computed.segments);
    expect(done.computed.meetingNotes).toEqual(STORED_NOTES);
    expect(done.computed.summaryByInstruction).toEqual(legacy);
    expect((await readTranscript(file.id)).computed).toEqual(done.computed);
    // One failed and one successful notes call; the rerun of the done row pays nothing.
    expect(summaryClient.notesCalls()).toHaveLength(2);
    expect(summaryClient.calls).toHaveLength(2);
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
  });

  /**
   * A trigger strips `meetingNotes` from writes to one transcript, so the pipeline reaches finalize
   * without notes. A failed cleanup discards the client and is reported with any primary failure.
   */
  async function withMeetingNotesStripped(transcriptId: string, run: () => Promise<void>): Promise<void> {
    const client = await pool.connect();
    let primary: { error: unknown } | undefined;
    try {
      await client.query("SELECT set_config('semprec_test.fault_item', $1, false)", [transcriptId]);
      await client.query(`CREATE FUNCTION strip_meeting_notes_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.computed := NEW.computed - 'meetingNotes'; RETURN NEW; END $$`);
      await client.query(`DO $$ BEGIN EXECUTE format(
        'CREATE TRIGGER strip_meeting_notes_test BEFORE UPDATE ON items FOR EACH ROW '
        'WHEN (NEW.id = %L::uuid) EXECUTE FUNCTION strip_meeting_notes_test()',
        current_setting('semprec_test.fault_item')); END $$`);
      await run();
    } catch (error) {
      primary = { error };
    }
    let cleanup: { error: unknown } | undefined;
    try {
      await client.query("DROP TRIGGER IF EXISTS strip_meeting_notes_test ON items");
      await client.query("DROP FUNCTION IF EXISTS strip_meeting_notes_test()");
    } catch (error) {
      cleanup = { error };
    }
    client.release(cleanup ? new Error("Fault trigger cleanup failed; the connection is discarded") : undefined);
    if (primary && cleanup)
      throw new AggregateError([primary.error, cleanup.error], "Fault test and its cleanup failed");
    if (primary) throw primary.error;
    if (cleanup) throw cleanup.error;
  }

  it("does not finish a transcript whose meeting notes are missing at finalize, and finishes once they are stored", async () => {
    const { file } = await createSourceFile();
    // A first attempt fails in the summary step, so the transcript row exists for the fault below.
    summaryClient.failure = new Error("simulated gateway failure");
    await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);
    summaryClient.failure = null;
    const transcript = await readTranscript(file.id);

    await withMeetingNotesStripped(transcript.id, () =>
      expect(runPipeline(file.id)).rejects.toMatchObject({ name: "TranscriptionQueueError" }),
    );
    const unfinished = await readTranscript(file.id);
    expect(unfinished.computed).not.toHaveProperty("meetingNotes");
    expect(unfinished.properties.status).toBe("processing");
    // The finalize guard, not an earlier step, refused the attempt.
    const automation = await readAutomation(unfinished.id);
    expect(automation?.status).toBe("pending");
    expect(automation?.error).toContain("has no 'meetingNotes' yet");
    expect(summaryClient.notesCalls()).toHaveLength(2);

    await runPipeline(file.id);
    const finished = await readTranscript(file.id);
    expect(finished.properties.status).toBe("done");
    expect(finished.computed.meetingNotes).toEqual(STORED_NOTES);
    expect(summaryClient.notesCalls()).toHaveLength(3);
  });

  it("keeps the notes a concurrent run stored between the paid call and the locked write", async () => {
    const { file } = await createSourceFile();
    const competitor = {
      title: "Competitor",
      summary: "Stored first.",
      shortSummary: "Stored first.",
      decisions: [],
      actionItems: [],
    };
    // The concurrent run's own deterministic transport: its notes, and no speaker mapping.
    const concurrentClient: AiGatewayClientPort = {
      async complete(input) {
        return {
          content: input.operation === "transcript_speaker_suggestion" ? { mappings: [] } : competitor,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    let concurrentRuns = 0;
    /** Runs a whole second pipeline run of the same file while this run's meeting-notes call is out. */
    const interleaving = summarizingWith("transcript_summary", async () => {
      if (concurrentRuns++ === 0) await runPipeline(file.id, FIRST_ATTEMPT, { summary: concurrentClient });
    });

    await runPipeline(file.id, FIRST_ATTEMPT, { summary: interleaving });

    const done = await readTranscript(file.id);
    expect(concurrentRuns).toBe(1);
    expect(interleaving.notesCalls()).toHaveLength(1);
    expect(done.computed.meetingNotes).toEqual(competitor);
    expect(done.properties.status).toBe("done");
    expect(await readAutomation(done.id)).toMatchObject({ status: "done" });
  });

  it("never rewrites merged segments or their speaker keys on a replay", async () => {
    const { file } = await createSourceFile();
    await runPipeline(file.id);
    const before = await readTranscript(file.id);
    await pool.query(
      `UPDATE items SET computed = jsonb_set(computed, '{diarize}', '[{"speaker":"SPEAKER_09","start":0,"end":1}]')
       WHERE id = $1`,
      [file.id],
    );

    await runPipeline(file.id);

    expect((await readTranscript(file.id)).computed.segments).toEqual(before.computed.segments);
  });

  it("stores empty notes for a transcript with no speech without a gateway call", async () => {
    const { file } = await createSourceFile();
    gatewayClient.transcribeResult = () => ({ text: "", language: null, segments: [] });

    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([]);
    expect(transcript.computed.language).toBeNull();
    expect(transcript.computed.meetingNotes).toEqual({
      title: "",
      summary: "",
      shortSummary: "",
      decisions: [],
      actionItems: [],
    });
    expect(transcript.properties.status).toBe("done");
    expect(summaryClient.calls).toHaveLength(0);
  });

  async function readMatch(transcriptId: string) {
    const { rows: edges } = await pool.query<{ other: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
       FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b)
       WHERE p.key = 'event'
         AND p.database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')
         AND (r.item_a = $1 OR r.item_b = $1)`,
      [transcriptId],
    );
    const { rows: cards } = await pool.query<{ id: string; kind: string }>(
      `SELECT i.id, i.properties ->> 'kind' AS kind FROM items i JOIN databases d ON d.id = i.database_id
       WHERE d.owner_module_id = 'processingProposals'
         AND COALESCE(i.properties -> 'context' ->> 'role', '') <> 'speaker'`,
    );
    return { eventIds: edges.map((edge) => edge.other), cards };
  }
  const linkedTo = (eventId: string) => ({ eventIds: [eventId], cards: [] });
  const UNMATCHED = { eventIds: [], cards: [{ id: expect.any(String), kind: "transcript" }] };

  async function createEvent(date: string, extra: Record<string, unknown> = {}, type = "meeting"): Promise<string> {
    const eventsId = await moduleDatabaseId("events");
    const event = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: eventsId, properties: { name: "Sync", type, date, ...extra } }),
    );
    return event.id;
  }

  async function readEventRecommendationCheckpoint(fileId: string): Promise<unknown> {
    const { rows } = await pool.query<{ checkpoint: unknown }>(
      "SELECT computed -> 'eventRecommendation' AS checkpoint FROM items WHERE id = $1",
      [fileId],
    );
    return rows[0]?.checkpoint;
  }

  async function readEventCards(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      `SELECT i.properties FROM items i JOIN databases d ON d.id = i.database_id
       WHERE d.owner_module_id = 'processingProposals' AND i.properties -> 'context' ->> 'role' = 'event'
       ORDER BY i.id`,
    );
    return rows.map((row) => row.properties);
  }

  it("links the one Event whose interval overlaps the recording before finalizing, without asking the model, and a rerun adds nothing", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);

    await runPipeline(file.id);
    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    expect(await readMatch(transcript.id)).toEqual(linkedTo(eventId));
    expect(summaryClient.eventMatchCalls()).toHaveLength(0);
    expect(await readEventRecommendationCheckpoint(file.id)).toBeNull();
  });

  // The recording starts at FIXTURE_CREATION_TIME (12:00 UTC, 13:00 in the seeded Europe/Prague zone) and
  // lasts a few seconds.
  it("links a meeting that began before the recording and is still running", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent("2024-03-01", { timeFrom: "11:30", timeTo: "14:00" });

    await runPipeline(file.id);

    expect(await readMatch((await readTranscript(file.id)).id)).toEqual(linkedTo(eventId));
  });

  it.each([
    {
      why: "a meeting that ended before the recording started",
      type: "meeting",
      extra: { timeFrom: "12:00", timeTo: "12:50" },
    },
    { why: "an Event of type event", type: "event", extra: { timeFrom: "12:30", timeTo: "14:00" } },
    { why: "an all-day meeting", type: "meeting", extra: {} },
  ])("creates the transcript card and no edge for $why", async ({ type, extra }) => {
    const { file } = await createSourceFile();
    await createEvent("2024-03-01", extra, type);

    await runPipeline(file.id);

    expect(await readMatch((await readTranscript(file.id)).id)).toEqual(UNMATCHED);
  });

  /** Two Events that overlap the recording (13:00 Prague time): a sprint planning of project Apollo with Alice, and a bare call. */
  async function createAmbiguousEvents() {
    const planningId = await createEvent("2024-03-01", { name: "Sprint planning", timeFrom: "12:30", timeTo: "13:30" });
    const callId = await createEvent(
      "2024-03-01",
      { name: "Accountant call", timeFrom: "12:45", timeTo: "13:15" },
      "standup",
    );
    await createParticipant(planningId, "Alice");
    const projectsId = await moduleDatabaseId("projects");
    const project = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: projectsId, properties: { name: "Apollo" } }),
    );
    const projectProperty = await pool.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'project'",
      [await moduleDatabaseId("events")],
    );
    await inTenantZero(() =>
      createChokePoint(pool).createRelation({
        relationPropertyId: projectProperty.rows[0]?.id ?? "",
        callerItemId: planningId,
        targetItemId: project.id,
      }),
    );
    return { planningId, callId, projectId: project.id };
  }

  it("asks the model which of two overlapping Events it was and proposes the recommended one on the card, writing no edge", async () => {
    const { file } = await createSourceFile();
    const { planningId, callId, projectId } = await createAmbiguousEvents();
    summaryClient.eventRecommendation = { eventId: planningId, reason: "It is about the sprint." };

    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    expect(summaryClient.eventMatchCalls()).toHaveLength(1);
    const [call] = summaryClient.eventMatchCalls();
    expect(call).toMatchObject({ projectItemId: null, temperature: 0, operation: "transcript_event_match" });
    expect(call?.system).toContain("(cs)");
    const content = call?.messages[0]?.content;
    expect(content).toContain("Title: Greeting");
    // The tenant has no user, so the notes are rendered in the default locale `cs`.
    expect(content).toContain("Summary: Mluvčí 1 greets Mluvčí 2.");
    expect(content).toContain("Short summary: A greeting.");
    expect(content).toContain(`- id: ${planningId}\n  name: Sprint planning`);
    expect(content).toContain("project: Apollo");
    expect(content).toContain("participants: Alice");
    expect(content).toContain(`- id: ${callId}\n  name: Accountant call`);
    expect(await readMatch(transcript.id)).toMatchObject({ eventIds: [] });
    const cards = await readEventCards();
    expect(cards).toHaveLength(1);
    const proposal = { entityKind: "relation", target: planningId, properties: { propertyKey: "event" } };
    expect(cards[0]).toMatchObject({
      kind: "transcript",
      status: "proposed",
      proposal,
      aiProposal: proposal,
      context: {
        role: "event",
        candidates: [
          expect.objectContaining({ id: planningId, name: "Sprint planning", projectId, projectName: "Apollo" }),
          expect.objectContaining({ id: callId, name: "Accountant call", projectId: null, projectName: null }),
        ],
        reason: "It is about the sprint.",
        recommendedEventId: planningId,
        recording: { durationSeconds: expect.any(Number), speakerCount: 2, quote: null },
      },
    });
    expect(await readEventRecommendationCheckpoint(file.id)).toEqual({
      recommendedEventId: planningId,
      reason: "It is about the sprint.",
    });
  });

  it.each([
    { why: "answers null", answer: () => ({ eventId: null, reason: "Cannot tell." }), reason: "Cannot tell." },
    {
      why: "answers an id that is not a candidate",
      answer: () => ({ eventId: randomUUID(), reason: "It was the other one." }),
      reason: null,
    },
  ])(
    "keeps the create-Event proposal on the card when the model $why, and a rerun asks nothing",
    async ({ answer, reason }) => {
      const { file } = await createSourceFile();
      await createAmbiguousEvents();
      summaryClient.eventRecommendation = answer();

      await runPipeline(file.id);
      const cardsBefore = await readEventCards();
      await runPipeline(file.id);

      expect(summaryClient.eventMatchCalls()).toHaveLength(1);
      expect(cardsBefore).toHaveLength(1);
      expect(cardsBefore[0]).toMatchObject({
        status: "proposed",
        proposal: { entityKind: "database", properties: { type: "meeting", date: "2024-03-01" } },
        context: { role: "event", reason, recommendedEventId: null },
      });
      expect(await readEventCards()).toEqual(cardsBefore);
      expect(await readMatch((await readTranscript(file.id)).id)).toMatchObject({ eventIds: [] });
      expect(await readEventRecommendationCheckpoint(file.id)).toEqual({ recommendedEventId: null, reason });
    },
  );

  it.each([
    ["the recommendation call fails", () => Promise.reject(new Error("gateway refused"))],
    [
      "the answer is malformed",
      () => Promise.resolve({ content: { eventId: 7 }, usage: { inputTokens: 1, outputTokens: 1 } }),
    ],
  ])("fails the step when %s, writes nothing, and a retry asks again and finishes", async (_label, answer) => {
    const { file } = await createSourceFile();
    const { planningId } = await createAmbiguousEvents();
    summaryClient.eventRecommendation = { eventId: planningId, reason: "Sprint." };

    await expect(
      runPipeline(file.id, FIRST_ATTEMPT, { summary: overriding("transcript_event_match", answer) }),
    ).rejects.toMatchObject(TASK_FAILED);
    expect((await readTranscript(file.id)).properties.status).toBe("processing");
    expect(await readEventCards()).toEqual([]);
    expect(await readEventRecommendationCheckpoint(file.id)).toBeNull();

    await runPipeline(file.id);

    expect((await readTranscript(file.id)).properties.status).toBe("done");
    expect(await readEventCards()).toHaveLength(1);
    expect(summaryClient.eventMatchCalls()).toHaveLength(1);
  });

  it("makes no second call and adds no second card when a run is retried after the model answered", async () => {
    const { file } = await createSourceFile();
    const { planningId } = await createAmbiguousEvents();
    summaryClient.eventRecommendation = { eventId: planningId, reason: "Sprint." };
    const controller = new AbortController();
    /** Requests the shutdown while step 6's call is out: the step still commits, and the run stops before step 7. */
    const interrupting: AiGatewayClientPort = {
      complete: (input) => {
        if (input.operation === "transcript_event_match") controller.abort();
        return summaryClient.complete(input);
      },
    };
    await runPipeline(file.id, { ...FIRST_ATTEMPT, abortSignal: controller.signal }, { summary: interrupting });
    expect((await readTranscript(file.id)).properties.status).toBe("processing");
    const cardsBefore = await readEventCards();
    expect(cardsBefore).toHaveLength(1);
    expect(await readEventRecommendationCheckpoint(file.id)).toEqual({
      recommendedEventId: planningId,
      reason: "Sprint.",
    });

    await runPipeline(file.id);

    expect((await readTranscript(file.id)).properties.status).toBe("done");
    expect(summaryClient.eventMatchCalls()).toHaveLength(1);
    expect(await readEventCards()).toEqual(cardsBefore);
  });

  it("makes no second call when the checkpoint exists though the card has since been purged from the Trash", async () => {
    const { file } = await createSourceFile();
    const { planningId } = await createAmbiguousEvents();
    summaryClient.eventRecommendation = { eventId: planningId, reason: "Sprint." };
    await runPipeline(file.id);
    const transcript = await readTranscript(file.id);
    // The card leaves through the Trash and its purge, which frees its idempotency key; the transcript is unfinished again.
    const { rows: cards } = await pool.query<{ id: string; database_id: string }>(
      `SELECT i.id, i.database_id FROM items i JOIN databases d ON d.id = i.database_id
       WHERE d.owner_module_id = 'processingProposals' AND i.properties -> 'context' ->> 'role' = 'event'`,
    );
    expect(cards).toHaveLength(1);
    await inTenantZero(() => purgeItem(cards[0]?.database_id ?? "", cards[0]?.id ?? ""));
    await setTranscriptStatus(transcript.id, "processing");
    const checkpoint = await readEventRecommendationCheckpoint(file.id);
    expect(checkpoint).toEqual({ recommendedEventId: planningId, reason: "Sprint." });

    await runPipeline(file.id);

    expect(summaryClient.eventMatchCalls()).toHaveLength(1);
    expect(await readEventRecommendationCheckpoint(file.id)).toEqual(checkpoint);
    expect(await readEventCards()).toEqual([
      expect.objectContaining({ context: expect.objectContaining({ reason: null, recommendedEventId: null }) }),
    ]);
  });

  it.each([
    ["the transcript is finished", (id: string) => setTranscriptStatus(id, "done"), "done", undefined],
    ["a user locks the transcript", lockAutomation, "processing", "locked"],
  ])(
    "writes no card and no checkpoint when %s while the recommendation call is out",
    async (_label, interrupt, status, automation) => {
      const { file } = await createSourceFile();
      await createAmbiguousEvents();
      const interrupting = summarizingWith("transcript_event_match", async () =>
        interrupt((await readTranscript(file.id)).id),
      );

      await runPipeline(file.id, FIRST_ATTEMPT, { summary: interrupting });

      const transcript = await readTranscript(file.id);
      expect(interrupting.eventMatchCalls()).toHaveLength(1);
      expect(await readEventCards()).toEqual([]);
      expect(await readEventRecommendationCheckpoint(file.id)).toBeNull();
      expect(transcript.properties.status).toBe(status);
      if (automation) expect(await readAutomation(transcript.id)).toMatchObject({ status: automation });
    },
  );

  it("proposes a virtual occurrence of a recurring Event on the card without writing an Event or an edge, and asks no model", async () => {
    const { file } = await createSourceFile();
    // A daily series that began the day before the recording; 12:30-13:30 Prague time overlaps the recording at 13:00.
    const seriesId = await createEvent("2024-02-29", {
      name: "Daily standup",
      timeFrom: "12:30",
      timeTo: "13:30",
      recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
    });

    await runPipeline(file.id);
    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    expect(summaryClient.eventMatchCalls()).toHaveLength(0);
    expect(await readMatch(transcript.id)).toEqual(UNMATCHED);
    const proposal = {
      entityKind: "relation",
      target: `${seriesId}@2024-03-01`,
      properties: { propertyKey: "event" },
    };
    const cards = await readEventCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: "proposed",
      proposal,
      aiProposal: proposal,
      context: { role: "event", candidates: [{ seriesId, occurrenceDate: "2024-03-01" }], recommendedEventId: null },
    });
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = 'events'",
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  async function ownedTranscriptionJobs(fileIds: string[]): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT j.id::text FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1 AND j.payload->'payload'->>'fileItemId' = ANY($2::text[]) ORDER BY j.id`,
      [CORE_TASK_NAMES.TRANSCRIPTION_JOB, fileIds],
    );
    return rows.map((row) => row.id);
  }

  /** Enqueues the files' jobs, runs them on the runtime-role pool through the real queue, and checks both settled done. */
  async function runQueuedOnRuntime(runtime: Pool, fileIds: string[]): Promise<void> {
    const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
      "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
    for (const fileId of fileIds) await enqueuePipeline(fileId);
    const jobIds = await ownedTranscriptionJobs(fileIds);
    expect(jobIds).toHaveLength(fileIds.length);
    await runPipelineJobs(pipelineTask({ pool: runtime }));
    const remaining = await pool.query<{ id: string }>(
      "SELECT id::text FROM graphile_worker.jobs WHERE id = ANY($1::bigint[])",
      [jobIds],
    );
    expect(remaining.rows).toEqual([]);
    const rows = await runInTenant(getTenantZeroId(), () =>
      withTransaction(runtime, (client) =>
        client.query<{ file_id: string; transcript_status: string; automation_status: string }>(
          `SELECT f.id AS file_id, t.properties->>'status' AS transcript_status, a.status AS automation_status
           FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
           JOIN item_automation a ON a.item_id = t.id WHERE f.id = ANY($1::uuid[]) ORDER BY f.id`,
          [fileIds],
        ),
      ),
    );
    expect(rows.rows).toHaveLength(fileIds.length);
    expect(new Set(rows.rows.map((row) => row.file_id))).toEqual(new Set(fileIds));
    for (const row of rows.rows) expect(row).toMatchObject({ transcript_status: "done", automation_status: "done" });
  }

  it("the queued worker links two recordings to one Event without a proposal card", async () => {
    const first = await createSourceFile();
    const second = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    await settle(
      "Transcription worker test or cleanup failed",
      async () => {
        const fileIds = [first.file.id, second.file.id];
        await runQueuedOnRuntime(runtime, fileIds);
        const result = await runInTenant(getTenantZeroId(), () =>
          withTransaction(runtime, async (client) => {
            const { rows } = await client.query<{ file_id: string; transcript_id: string; event_id: string }>(
              `SELECT f.id AS file_id, t.id AS transcript_id,
                 CASE WHEN r.item_a = t.id THEN r.item_b ELSE r.item_a END AS event_id
               FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
               JOIN item_relations r ON r.item_a = t.id OR r.item_b = t.id
               JOIN relation_definitions d ON d.id = r.relation_definition_id
               JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b)
               JOIN databases db ON db.id = p.database_id AND db.owner_module_id = 'transcripts'
               WHERE f.id = ANY($1::uuid[]) AND p.key = 'event' ORDER BY f.id`,
              [fileIds],
            );
            const cards = await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM items i JOIN databases d ON d.id = i.database_id
               WHERE d.owner_module_id = 'processingProposals' AND i.deleted_at IS NULL
                 AND COALESCE(i.properties -> 'context' ->> 'role', '') <> 'speaker'`,
            );
            return { rows, cards: cards.rows };
          }),
        );
        expect(result.rows).toHaveLength(2);
        expect(new Set(result.rows.map((row) => row.file_id))).toEqual(new Set(fileIds));
        expect(new Set(result.rows.map((row) => row.transcript_id)).size).toBe(2);
        expect(result.rows.map((row) => row.event_id)).toEqual([eventId, eventId]);
        expect(result.cards).toEqual([{ n: 0 }]);
      },
      () => runtime.end(),
    );
  });

  it("creates one transcript card when no Event matches, asking no model, and a rerun converges on it", async () => {
    const { filesId, file } = await createSourceFile();

    await runPipeline(file.id);
    // The checkpoint records what was asked: the Event (none here) and the candidate people.
    expect((await readSource(filesId, file.id))?.computed.suggestSpeakers).toEqual({
      proposedSpeakers: expect.any(Array),
      eventId: null,
      candidateIds: [],
    });
    await runPipeline(file.id);

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    expect(await readMatch(transcript.id)).toEqual(UNMATCHED);
    expect(await readEventCards()).toEqual([]);
    expect(await readEventRecommendationCheckpoint(file.id)).toBeNull();
    // No linked Event, so no participants to suggest speakers from: nothing is asked.
    expect(summaryClient.operations()).toEqual(["transcript_summary"]);
    expect(await readSpeakerCards()).toEqual([
      { proposal: null, status: "needsClarification" },
      { proposal: null, status: "needsClarification" },
    ]);
  });

  async function createParticipant(eventId: string, name: string): Promise<string> {
    const { person, peoplePropertyId } = await withTransaction(pool, async (client) => {
      const created = await createItemWithClient(client, {
        databaseId: await requireDatabaseId(client, "people"),
        properties: { name },
      });
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
        [await requireDatabaseId(client, "events")],
      );
      if (!rows[0]) throw new Error("Events 'people' property was not seeded");
      return { person: created, peoplePropertyId: rows[0].id };
    });
    // An Events `people` edge queues a link-rule propagation job, which needs a tenant scope.
    await inTenantZero(() =>
      createChokePoint(pool).createRelation({
        relationPropertyId: peoplePropertyId,
        callerItemId: eventId,
        targetItemId: person.id,
      }),
    );
    return person.id;
  }

  /** A linked Event whose participant Alice the model maps to `speaker`. */
  async function linkEventWithAlice(speaker = "SPEAKER_01") {
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const aliceId = await createParticipant(eventId, "Alice");
    summaryClient.speakerMappings = [{ speaker, personId: aliceId, reason: "Named." }];
    return { eventId, aliceId };
  }

  async function readSpeakerCards() {
    const { rows } = await pool.query<{ proposal: unknown; status: string }>(
      `SELECT i.properties -> 'proposal' AS proposal, i.properties ->> 'status' AS status
       FROM items i JOIN databases d ON d.id = i.database_id
       WHERE d.owner_module_id = 'processingProposals' AND i.properties ->> 'kind' = 'transcript'
         AND i.properties -> 'context' ->> 'role' = 'speaker'`,
    );
    return rows;
  }

  async function countSpeakerEdges(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id = d.property_id_a WHERE p.key = 'speakers'`,
    );
    return rows[0]?.count ?? 0;
  }

  it("suggests speakers from the linked Event's participants as cards, writes no mapping, and a rerun pays once", async () => {
    const { file } = await createSourceFile();
    const { eventId, aliceId } = await linkEventWithAlice();
    await createParticipant(eventId, "Bob");
    const privateText = "PRIVATE_SPEAKER_TEXT_1640 is a real transcript sentence";
    gatewayClient.transcribeResult = () => ({
      text: `${privateText} Hi there.`,
      language: "en",
      segments: [
        { start: 0, end: 0.4, text: privateText },
        { start: 0.6, end: 0.9, text: " Hi there." },
      ],
    });
    observedLogs.chunks.length = 0;

    await runPipeline(file.id);
    await runPipeline(file.id);

    const suggestionCalls = summaryClient.calls.filter((call) => call.operation === "transcript_speaker_suggestion");
    expect(suggestionCalls).toHaveLength(1);
    expect(suggestionCalls[0]).toMatchObject({ projectItemId: null });
    const content = suggestionCalls[0]?.messages[0]?.content ?? "";
    expect(content).toContain(`${aliceId}: Alice`);
    expect(content).toContain(privateText);
    expect(content).toContain("SPEAKER_00\nSPEAKER_01");
    const speakerCards = await readSpeakerCards();
    expect(speakerCards).toHaveLength(2);
    expect(speakerCards).toEqual(
      expect.arrayContaining([
        {
          proposal: {
            entityKind: "relation",
            target: aliceId,
            properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } },
          },
          status: "proposed",
        },
        { proposal: null, status: "needsClarification" },
      ]),
    );
    expect(await countSpeakerEdges()).toBe(0);
    expect(observedLogs.chunks.join("")).not.toContain(privateText);
    expect((await readTranscript(file.id)).properties.status).toBe("done");
  });

  /** Collects every `semprec_events` notification while `run` runs, with this file's pool wired to publish. */
  async function withRealtimeEnvelopes(
    run: (received: Array<{ tenantId: string | null; message: unknown }>) => Promise<void>,
  ): Promise<void> {
    wireRealtimeHooks(pool);
    const listenClient = await pool.connect();
    const received: Array<{ tenantId: string | null; message: unknown }> = [];
    try {
      await listenClient.query("LISTEN semprec_events");
      listenClient.on("notification", (notification) => {
        received.push(
          z
            .object({ tenantId: z.string().uuid().nullable(), message: z.unknown() })
            .parse(JSON.parse(notification.payload ?? "null")),
        );
      });
      await run(received);
    } finally {
      listenClient.release(true);
      resetRealtimeHooks();
    }
  }

  it("publishes an inboxCards invalidation of the tenant for each card the pipeline writes, and for none on a rerun", async () => {
    const { file } = await createSourceFile();
    await withRealtimeEnvelopes(async (received) => {
      await runPipeline(file.id);

      // No Event matched and no participant exists: one transcript card proposes a new Event and the two
      // speaker keys each get a card that needs clarification.
      const { rows: cards } = await pool.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id = 'processingProposals'`,
      );
      expect(cards).toHaveLength(3);
      const inboxCardsMessage = z
        .object({
          type: z.literal("invalidation"),
          scope: z.literal("inboxCards"),
          op: z.literal("created"),
          cardId: z.string().uuid(),
        })
        .strict();
      const announced = () =>
        received.flatMap((envelope) => {
          const parsed = inboxCardsMessage.safeParse(envelope.message);
          return parsed.success ? [{ tenantId: envelope.tenantId, cardId: parsed.data.cardId }] : [];
        });
      await vi.waitFor(() => expect(announced()).toHaveLength(3));
      expect(announced().map((entry) => entry.tenantId)).toEqual(Array(3).fill(getTenantZeroId()));
      expect(
        announced()
          .map((entry) => entry.cardId)
          .sort(),
      ).toEqual(cards.map((card) => card.id).sort());

      // A rerun of the finished transcript writes no card, so it announces none.
      received.length = 0;
      await runPipeline(file.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(announced()).toEqual([]);
    });
  });

  it("the queued runtime worker stores aiProposal and version on Event and speaker cards", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    await settle(
      "Worker card test or cleanup failed",
      async () => {
        await runQueuedOnRuntime(runtime, [(await createSourceFile()).file.id]);
        await linkEventWithAlice();
        await runQueuedOnRuntime(runtime, [(await createSourceFile()).file.id]);
        const cards = await runInTenant(getTenantZeroId(), () =>
          withTransaction(runtime, async (client) => {
            const { rows } = await client.query<{ properties: unknown }>(
              `SELECT i.properties FROM items i JOIN databases d ON d.id = i.database_id
               WHERE d.owner_module_id = 'processingProposals' AND i.deleted_at IS NULL`,
            );
            return rows.map((row) =>
              z.object({ proposal: z.unknown(), aiProposal: z.unknown(), aiVersion: z.number() }).parse(row.properties),
            );
          }),
        );
        expect(cards).toHaveLength(5);
        for (const card of cards) {
          expect(card.aiProposal).toEqual(card.proposal);
          expect(card.aiVersion).toBe(1);
        }
        expect(cards.filter((card) => card.proposal === null)).toHaveLength(3);
        expect(
          cards
            .filter((card) => card.proposal !== null)
            .map((card) => z.object({ entityKind: z.string() }).parse(card.proposal).entityKind)
            .sort(),
        ).toEqual(["database", "relation"]);
      },
      () => runtime.end(),
    );
  });

  it("leaves the row processing when the speaker suggestion fails after the notes were stored, then suggests on retry without a second notes call", async () => {
    const { file } = await createSourceFile();
    await linkEventWithAlice("SPEAKER_00");

    await expect(
      runPipeline(file.id, FIRST_ATTEMPT, { summary: failOn("transcript_speaker_suggestion") }),
    ).rejects.toMatchObject(TASK_FAILED);
    const stored = await readTranscript(file.id);
    expect(stored.properties.status).toBe("processing");
    expect(stored.computed.meetingNotes).toEqual(STORED_NOTES);
    expect(await readSpeakerCards()).toEqual([]);
    expect(summaryClient.notesCalls()).toHaveLength(1);

    await runPipeline(file.id);

    const finished = await readTranscript(file.id);
    expect(finished.properties.status).toBe("done");
    expect(finished.computed.meetingNotes).toEqual(stored.computed.meetingNotes);
    expect(await readSpeakerCards()).toHaveLength(2);
    expect(summaryClient.notesCalls()).toHaveLength(1);
  });

  it("publishes each output write and the done transition on the generic realtime channel", async () => {
    const { file } = await createSourceFile();
    const transcriptsId = await moduleDatabaseId("transcripts");
    await withRealtimeEnvelopes(async (received) => {
      await runPipeline(file.id);
      const transcript = await readTranscript(file.id);
      const update = z.object({
        type: z.literal("invalidation"),
        scope: z.literal("item"),
        op: z.literal("update"),
        itemId: z.literal(transcript.id),
        databaseId: z.literal(transcriptsId),
      });
      // date, durationSeconds, segments, language, summary, finalizedAt, status done.
      await vi.waitFor(() =>
        expect(received.filter(({ message }) => update.safeParse(message).success)).toHaveLength(7),
      );
    });
  });

  describe("retries and permanent failures", () => {
    it("records a transient failure as pending with its code, then resumes from the checkpoints and settles done with both cleared", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const failure = new AiGatewayFailedError("http");
      summaryClient.failure = failure;

      await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);

      const failed = await readTranscript(file.id);
      expect(failed.properties.status).toBe("processing");
      expect(await readAutomation(failed.id)).toEqual({ status: "pending", error: failure.message, attempts: 1 });
      expect(await readAutomationCode(failed.id)).toEqual({ status: "pending", error_code: "providerFailed" });
      expect(await readNotifications(failed.id)).toEqual([]);

      summaryClient.failure = null;
      await runPipeline(file.id, attempt(2));

      const done = await readTranscript(file.id);
      expect(done.properties.status).toBe("done");
      expect(await readAutomation(done.id)).toEqual({ status: "done", error: null, attempts: 2 });
      expect(await readAutomationCode(done.id)).toEqual({ status: "done", error_code: null });
      expect(await readNotifications(done.id)).toEqual([]);
      expect(gatewayClient.diarizeCalls).toHaveLength(1);
      expect(gatewayClient.transcribeCalls).toHaveLength(1);
      expect(summaryClient.calls).toHaveLength(2);
    });

    it("deduplicates a replayed failure transition and emits a later distinct transition", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new Error("Replay fixture failure");
      const created: string[] = [];
      setNotificationCreatedHook((event) => {
        created.push(event.notificationId);
      });
      // The Semp problem's own notification is announced too; this test is about `automation_error`.
      const automationErrorEvents = async (): Promise<string[]> =>
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM notifications WHERE kind = 'automation_error' AND id = ANY($1::uuid[]) ORDER BY created_at, id",
            [created],
          )
        ).rows.map((row) => row.id);
      const readAutomationErrors = async (transcriptId: string) =>
        (
          await pool.query<{ id: string; transition_instance: string }>(
            "SELECT id, transition_instance FROM notifications WHERE source_id = $1 AND kind = 'automation_error' ORDER BY transition_instance",
            [transcriptId],
          )
        ).rows;
      const readFanout = async (notificationId: string) =>
        (
          await pool.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [
            `notification-fanout:${notificationId}`,
          ])
        ).rows;
      try {
        await expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject({ name: "TranscriptionQueueError" });
        const transcript = await readTranscript(file.id);
        const errors = await readAutomationErrors(transcript.id);
        expect(errors).toHaveLength(1);
        const first = errors[0]!;
        const job = await readFanout(first.id);
        expect(job).toHaveLength(1);
        expect(await automationErrorEvents()).toEqual([first.id]);
        // Restore the pre-attempt counter to replay this exact transition identity through the task.
        await pool.query("UPDATE item_automation SET attempts = 0 WHERE item_id = $1", [transcript.id]);
        await expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject({ name: "TranscriptionQueueError" });
        expect(await readAutomationErrors(transcript.id)).toEqual([first]);
        expect(await readFanout(first.id)).toEqual(job);
        expect(await automationErrorEvents()).toEqual([first.id]);
        await expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject({ name: "TranscriptionQueueError" });
        expect(await readNotifications(transcript.id)).toHaveLength(2);
        const events = await automationErrorEvents();
        expect(events).toHaveLength(2);
        expect(events[1]).not.toBe(first.id);
      } finally {
        setNotificationCreatedHook(() => {});
      }
    });

    it.each([
      ["a budget rejection", () => new AiGatewayFailedError("budget_exceeded"), "budgetExceeded"],
      ["an audio gateway budget rejection", () => new AudioGatewayBudgetExceededError(), "budgetExceeded"],
      [
        "an ffmpeg failure",
        () => new MediaToolError("ffmpeg exited with code 1: secret transcript text"),
        "mediaUnreadable",
      ],
      [
        "an audio gateway failure",
        () => new AudioGatewayCallError("Gateway responded with HTTP 500"),
        "providerFailed",
      ],
      ["a completion gateway failure", () => new AiGatewayFailedError("http"), "providerFailed"],
      ["any other error", () => new Error("secret transcript text"), "unknown"],
      ["a thrown non-error", () => "secret transcript text", "unknown"],
    ])("stores the code for %s and keeps its message out of the notification", async (_label, makeFailure, code) => {
      const { file } = await createSourceFile();
      await createUser();
      const failure = makeFailure();
      expect(classifyTranscriptionFailure(failure)).toBe(code);
      if (failure instanceof Error) summaryClient.failure = failure;
      else vi.spyOn(summaryClient, "complete").mockRejectedValue(failure);

      await runPipeline(file.id, FINAL_ATTEMPT).catch(() => undefined);

      const transcript = await readTranscript(file.id);
      expect(await readAutomationCode(transcript.id)).toEqual({ status: "error", error_code: code });
      const notifications = await pool.query("SELECT to_jsonb(n) AS row FROM notifications n WHERE source_id = $1", [
        transcript.id,
      ]);
      expect(notifications.rows).toHaveLength(1);
      expect(JSON.stringify(notifications.rows)).not.toContain("secret transcript text");
    });

    it("sends the permanent-failure automation_error notification to the user of the tenant it ran in, never the earlier-created account", async () => {
      const runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "semprec_data"));
      try {
        const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
        const userA = await runInTenant(getTenantZeroId(), () => createUser());
        const userB = (
          await runInTenant(tenantB, () =>
            dataCreateUser(pool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
          )
        ).id;
        summaryClient.failure = new Error("simulated summary outage");
        const fileId = await runInTenant(tenantB, async () => {
          await seedSystem(runtimePool, createViewTypeRegistry());
          return (await createSourceFile("audio/mp4", audioFixture, runtimePool)).file.id;
        });

        for (const attempts of [1, 2, 3]) {
          await expect(
            runInTenant(tenantB, () => runPipeline(fileId, attempt(attempts), { pool: runtimePool })),
          ).rejects.toMatchObject(TASK_FAILED);
        }

        const { rows } = await pool.query<{ user_id: string; kind: string; tenant_id: string }>(
          `SELECT n.user_id, n.kind, n.tenant_id FROM notifications n
           JOIN items f ON f.id = $1 JOIN items t ON t.id = (f.computed->>'create')::uuid
           WHERE n.source_id = t.id::text`,
          [fileId],
        );
        expect(rows).toEqual([{ user_id: userB, kind: "automation_error", tenant_id: tenantB }]);
        expect(rows[0]?.user_id).not.toBe(userA);
      } finally {
        await runtimePool.end();
      }
    });

    it.each([
      [
        "the audio gateway",
        () => {
          gatewayClient.transcribeResult = () => {
            throw new AudioGatewayBudgetExceededError();
          };
        },
      ],
      [
        "the completion gateway",
        () => {
          summaryClient.failure = new AiGatewayFailedError("budget_exceeded");
        },
      ],
    ])(
      "treats a budget rejection by %s as permanent on any attempt and completes the job instead of retrying",
      async (_label, reject) => {
        await createUser();
        const { file } = await createSourceFile();
        reject();

        await expect(runPipeline(file.id)).resolves.toBeUndefined();

        const transcript = await readTranscript(file.id);
        expect(transcript.properties.status).toBe("error");
        expect(await readAutomation(transcript.id)).toMatchObject({ status: "error", attempts: 1 });
        expect(await readNotifications(transcript.id)).toHaveLength(1);
      },
    );

    /** Runs `body` while a trigger makes every notification insert fail with `PRIVATE_RECORDING_FAILURE_1386`. */
    async function withNotificationInsertsFailing(body: () => Promise<void>): Promise<void> {
      await pool.query(`CREATE FUNCTION test_failure_1386() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'PRIVATE_RECORDING_FAILURE_1386'; END $$`);
      await pool.query(`CREATE TRIGGER test_failure_1386 BEFORE INSERT ON notifications
        FOR EACH ROW EXECUTE FUNCTION test_failure_1386()`);
      try {
        await body();
      } finally {
        await pool.query("DROP TRIGGER test_failure_1386 ON notifications");
        await pool.query("DROP FUNCTION test_failure_1386()");
      }
    }

    it("commits none of a permanent failure's writes when its transaction rolls back, and returns a safe failure", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new Error("simulated summary outage");
      await withNotificationInsertsFailing(() =>
        expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject(TASK_FAILED),
      );

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("processing");
      expect(await readAutomation(transcript.id)).toEqual({ status: "pending", error: null, attempts: 1 });
      expect(await readNotifications(transcript.id)).toEqual([]);
    });

    it("still records a permanent failure when no user exists to notify", async () => {
      const { file } = await createSourceFile();
      summaryClient.failure = new Error("simulated summary outage");

      await expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject(TASK_FAILED);

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("error");
      expect(await readAutomation(transcript.id)).toMatchObject({ status: "error", attempts: 1 });
      expect((await pool.query("SELECT id FROM notifications")).rows).toEqual([]);
    });

    it("clears the error and settles done when a later run succeeds, without duplicate output or edges", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new AiGatewayFailedError("budget_exceeded");
      await runPipeline(file.id);
      const failed = await readTranscript(file.id);
      expect(failed.properties.status).toBe("error");

      summaryClient.failure = null;
      await runPipeline(file.id);

      const done = await readTranscript(file.id);
      expect(done.properties.status).toBe("done");
      expect(done.computed.segments).toEqual(failed.computed.segments);
      expect(await readAutomation(done.id)).toEqual({ status: "done", error: null, attempts: 2 });
      expect(await readMatch(done.id)).toEqual(UNMATCHED);
      expect(await readNotifications(done.id)).toHaveLength(1);
      expect(gatewayClient.diarizeCalls).toHaveLength(1);
      expect(gatewayClient.transcribeCalls).toHaveLength(1);
    });

    it("never processes a row a user locked", async () => {
      const { file } = await createSourceFile();
      summaryClient.failure = new Error("simulated summary outage");
      await expect(runPipeline(file.id)).rejects.toMatchObject(TASK_FAILED);
      const transcript = await readTranscript(file.id);
      await lockAutomation(transcript.id);

      summaryClient.failure = null;
      await runPipeline(file.id, attempt(2));

      expect((await readTranscript(file.id)).properties.status).toBe("processing");
      expect(await readAutomation(transcript.id)).toMatchObject({ status: "locked", attempts: 1 });
      expect(summaryClient.calls).toHaveLength(1);
    });

    /** Locks the file's transcript, the way a user does from the UI. */
    async function lockTranscriptOf(fileItemId: string): Promise<void> {
      await pool.query(
        `UPDATE item_automation SET status = 'locked'
         WHERE item_id = (SELECT (computed ->> 'create')::uuid FROM items WHERE id = $1)`,
        [fileItemId],
      );
    }

    it("keeps the running step's write from landing and stops once a user locks the row mid-run", async () => {
      const { file } = await createSourceFile();

      await runPipeline(file.id, FIRST_ATTEMPT, {
        summary: summarizingWith("transcript_summary", () => lockTranscriptOf(file.id)),
      });

      const stopped = await readTranscript(file.id);
      expect(stopped.properties.status).toBe("processing");
      expect(stopped.computed).not.toHaveProperty("summaryByInstruction");
      expect(await readMatch(stopped.id)).toEqual({ eventIds: [], cards: [] });
      expect(await readAutomation(stopped.id)).toEqual({ status: "locked", error: null, attempts: 1 });
    });

    it("writes no diarize checkpoint and makes no ASR call once a user locks the row during diarization", async () => {
      const { filesId, file } = await createSourceFile();
      const lockingGateway = diarizingWith(() => lockTranscriptOf(file.id));

      await runPipeline(file.id, FIRST_ATTEMPT, { gateway: lockingGateway });

      const computed = (await readSource(filesId, file.id))?.computed;
      expect(computed).toHaveProperty("prepare");
      expect(computed).not.toHaveProperty("diarize");
      expect(lockingGateway.diarizeCalls).toHaveLength(1);
      expect(lockingGateway.transcribeCalls).toEqual([]);
      expect(summaryClient.calls).toEqual([]);
      const transcript = await readTranscript(file.id);
      expect(await readAutomation(transcript.id)).toEqual({ status: "locked", error: null, attempts: 1 });
    });

    it("records nothing of a final failure on a row a user locked mid-run", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const lockingSummary = summarizingWith("transcript_summary", () => lockTranscriptOf(file.id));
      lockingSummary.failure = new Error("simulated summary outage");

      await expect(runPipeline(file.id, FINAL_ATTEMPT, { summary: lockingSummary })).rejects.toMatchObject(TASK_FAILED);

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("processing");
      expect(await readAutomation(transcript.id)).toEqual({ status: "locked", error: null, attempts: 1 });
      expect(await readNotifications(transcript.id)).toEqual([]);
    });

    describe("deleted transcript or source file", () => {
      it("resolves only the canonical tenant and database idempotency reservation, including Trash", async () => {
        const key = `transcription:${randomUUID()}`;
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        const otherTenant = await createTestTenant(pool);
        try {
          const original = await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const transcriptsId = await requireDatabaseId(client, "transcripts");
            const item = await createItemWithClient(client, {
              databaseId: transcriptsId,
              idempotencyKey: key,
              properties: {},
            });
            expect((await findIdempotentReplay(client, transcriptsId, key))?.id).toBe(item.id);
            expect(await findIdempotentReplay(client, await requireDatabaseId(client, "files"), key)).toBeNull();
            expect(await findIdempotentReplay(client, transcriptsId, `transcription:${randomUUID()}`)).toBeNull();
            return { item, transcriptsId };
          });
          await runInTenant(getTenantZeroId(), () =>
            createChokePoint(runtime).softDeleteItem(original.transcriptsId, original.item.id),
          );
          await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const trashed = await findIdempotentReplay(client, original.transcriptsId, key);
            expect(trashed?.id).toBe(original.item.id);
            expect(trashed?.deletedAt).not.toBeNull();
            expect(await findIdempotentReplay(client, original.transcriptsId, key, { requireLive: true })).toBeNull();
          });
          await runInTenant(otherTenant, () => seedSystem(runtime, createViewTypeRegistry()));
          await withTenantTransaction(runtime, otherTenant, async (client) => {
            const transcriptsId = await requireDatabaseId(client, "transcripts");
            expect(await findIdempotentReplay(client, transcriptsId, key)).toBeNull();
            const item = await createItemWithClient(client, {
              databaseId: transcriptsId,
              idempotencyKey: key,
              properties: {},
            });
            expect(item.id).not.toBe(original.item.id);
            expect((await findIdempotentReplay(client, transcriptsId, key))?.id).toBe(item.id);
          });
        } finally {
          await runtime.end();
        }
      });

      /** Soft-deletes the file's transcript directly, like a user emptying it mid-run. */
      async function deleteTranscript(fileItemId: string): Promise<void> {
        await pool.query(
          "UPDATE items SET deleted_at = now() WHERE id = (SELECT (computed ->> 'create')::uuid FROM items WHERE id = $1)",
          [fileItemId],
        );
      }
      async function deleteSource(fileItemId: string): Promise<void> {
        await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [fileItemId]);
      }
      const DELETED = { status: "error", error_code: "deleted" };

      async function expectNoAutomation(transcriptId: string | undefined): Promise<void> {
        expect(
          (await pool.query("SELECT item_id FROM item_automation WHERE item_id = $1", [transcriptId])).rows,
        ).toEqual([]);
      }

      it.each([
        ["transcript", deleteTranscript, 1],
        ["source file", deleteSource, 3],
      ] as const)(
        "stops without ASR or a notification, marks error/deleted and settles the queued job when the %s is deleted during diarization (max attempts %s)",
        async (_label, remove, maxAttempts) => {
          const { file } = await createSourceFile();
          await createUser();
          const gateway = diarizingWith(() => remove(file.id));
          const key = await enqueuePipeline(file.id, maxAttempts);

          await runPipelineJobs(pipelineTask({ gateway }));

          const transcript = await readTranscript(file.id);
          expect(gateway.diarizeCalls).toHaveLength(1);
          expect(gateway.transcribeCalls).toEqual([]);
          expect(summaryClient.calls).toEqual([]);
          expect(await readAutomationCode(transcript.id)).toEqual(DELETED);
          expect(await readNotifications(transcript.id)).toEqual([]);
          expect(await readJobs(key, true)).toEqual([]);
        },
      );

      it("stops without ASR when DELETE /api/transcripts/:id trashes the recording during diarization", async () => {
        const { file } = await createSourceFile();
        const userId = await createUser();
        let response: unknown;
        /** Calls the production DELETE route the moment the diarize call is made, like a user deleting the recording mid-run. */
        const gateway = diarizingWith(async () => {
          const transcriptId = (await readTranscript(file.id)).id;
          response = await runInTenant(getTenantZeroId(), () =>
            createTranscriptDeleteRouteHandler(pool)({
              params: { id: transcriptId },
              identity: { user: { id: userId } },
            }),
          );
        });

        await runPipeline(file.id, FINAL_ATTEMPT, { gateway });

        const transcript = await readTranscript(file.id);
        expect(response).toEqual({ status: 200, body: { id: transcript.id, fileItemId: file.id } });
        expect(gateway.diarizeCalls).toHaveLength(1);
        expect(gateway.transcribeCalls).toEqual([]);
        expect(summaryClient.calls).toEqual([]);
        expect(await readAutomationCode(transcript.id)).toEqual(DELETED);
        expect(await readNotifications(transcript.id)).toEqual([]);
        const { rows } = await pool.query<{ epochs: number; trashed: number }>(
          "SELECT count(DISTINCT deleted_at)::int AS epochs, count(*)::int AS trashed FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
          [[file.id, transcript.id]],
        );
        expect(rows).toEqual([{ epochs: 1, trashed: 2 }]);
      });

      it("settles the queued job when its source was purged before the attempt starts", async () => {
        const { filesId, file } = await createSourceFile();
        await createUser();
        const key = await enqueuePipeline(file.id);
        await inTenantZero(() => purgeItem(filesId, file.id));

        await runPipelineJobs();

        expect(await readJobs(key, true)).toEqual([]);
        expect(gatewayClient.diarizeCalls).toEqual([]);
        expect(gatewayClient.transcribeCalls).toEqual([]);
        expect(summaryClient.calls).toEqual([]);
        expect((await pool.query("SELECT item_id FROM item_automation")).rows).toEqual([]);
        expect((await pool.query("SELECT id FROM notifications WHERE kind = 'automation_error'")).rows).toEqual([]);
      });

      it.each([
        ["purged", false],
        ["trashed", false],
        ["purged", true],
        ["trashed", true],
      ] as const)(
        "settles the earlier transcript after source %s before retry, locked: %s",
        async (sourceState, locked) => {
          const { filesId, file } = await createSourceFile();
          await createUser();
          summaryClient.failure = new Error("transient fixture failure");
          await expect(runPipeline(file.id)).rejects.toMatchObject({ name: "TranscriptionQueueError" });
          const transcript = await readTranscript(file.id);
          expect((await readAutomation(transcript.id))?.status).toBe("pending");
          expect(await readNotifications(transcript.id)).toEqual([]);
          if (locked) await lockAutomation(transcript.id);
          const previousState = await readAutomationCode(transcript.id);
          await inTenantZero(() =>
            sourceState === "purged"
              ? purgeItem(filesId, file.id)
              : createChokePoint(pool)
                  .softDeleteItem(filesId, file.id)
                  .then(() => undefined),
          );
          const key = await enqueuePipeline(file.id);

          await runPipelineJobs();

          expect(await readJobs(key)).toEqual([]);
          expect(await readAutomationCode(transcript.id)).toEqual(locked ? previousState : DELETED);
          expect(await readNotifications(transcript.id)).toEqual([]);
          const reservations = await pool.query<{ item_id: string }>(
            "SELECT item_id FROM idempotency_keys WHERE key = $1",
            [`transcription:${file.id}`],
          );
          expect(reservations.rows).toEqual([{ item_id: transcript.id }]);
        },
      );

      /** Purges the source or the transcript of the file, in tenant zero; returns the transcript's id. */
      async function purgeTarget(targetKind: "source" | "transcript", filesId: string, fileId: string) {
        const transcript = await readTranscript(fileId);
        await inTenantZero(async () =>
          targetKind === "source"
            ? purgeItem(filesId, fileId)
            : purgeItem(await moduleDatabaseId("transcripts"), transcript.id),
        );
        return transcript.id;
      }

      it("settles the queued job when its transcript is purged during diarization", async () => {
        const { filesId, file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const gateway = diarizingWith(async () => {
          transcriptId = await purgeTarget("transcript", filesId, file.id);
        });
        const key = await enqueuePipeline(file.id);

        await runPipelineJobs(pipelineTask({ gateway }));

        expect(transcriptId).toBeDefined();
        expect(await readJobs(key, true)).toEqual([]);
        expect(gateway.transcribeCalls).toEqual([]);
        expect(summaryClient.calls).toEqual([]);
        await expectNoAutomation(transcriptId);
        expect(await readNotifications(z.uuid().parse(transcriptId))).toEqual([]);
      });

      it.each([
        ["source", 1],
        ["source", 3],
        ["transcript", 1],
        ["transcript", 3],
      ] as const)(
        "settles without notification when the %s is purged and in-flight diarization fails, max attempts %s",
        async (targetKind, maxAttempts) => {
          const { filesId, file } = await createSourceFile();
          await createUser();
          let transcriptId: string | undefined;
          const gateway = diarizingWith(async () => {
            transcriptId = await purgeTarget(targetKind, filesId, file.id);
            throw new Error("PRIVATE_PURGED_GATEWAY_FAILURE_1582");
          });
          const key = await enqueuePipeline(file.id, maxAttempts);
          const seenAttempts: unknown[] = [];
          const task = pipelineTask({ gateway });

          await runPipelineJobs(async (payload, helpers) => {
            seenAttempts.push(
              z.object({ attempts: z.number().int(), max_attempts: z.number().int() }).parse(helpers.job),
            );
            await task(payload, helpers);
          });

          expect(seenAttempts).toEqual([{ attempts: 1, max_attempts: maxAttempts }]);
          const id = z.uuid().parse(transcriptId);
          expect(await readJobs(key)).toEqual([]);
          expect(await readNotifications(id)).toEqual([]);
          expect(gateway.transcribeCalls).toEqual([]);
          if (targetKind === "source") expect(await readAutomationCode(id)).toEqual(DELETED);
          else await expectNoAutomation(id);
        },
      );

      it("settles a deleted source after a gateway failure without changing a locked automation", async () => {
        const { filesId, file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const gateway = diarizingWith(async () => {
          transcriptId = (await readTranscript(file.id)).id;
          await lockAutomation(transcriptId);
          await inTenantZero(() => purgeItem(filesId, file.id));
          throw new Error("PRIVATE_LOCKED_DELETED_GATEWAY_1582");
        });
        const key = await enqueuePipeline(file.id, 1);

        await runPipelineJobs(pipelineTask({ gateway }));

        const id = z.uuid().parse(transcriptId);
        expect(await readJobs(key)).toEqual([]);
        expect(await readAutomationCode(id)).toEqual({ status: "locked", error_code: null });
        expect(await readNotifications(id)).toEqual([]);
        expect(gateway.transcribeCalls).toEqual([]);
      });

      it("keeps a missing automation on live targets as a failure rather than a deleted stop", async () => {
        const { file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const gateway = diarizingWith(async () => {
          transcriptId = (await readTranscript(file.id)).id;
          await pool.query("DELETE FROM item_automation WHERE item_id = $1", [transcriptId]);
          throw new Error("PRIVATE_LIVE_AUTOMATION_FAILURE_1582");
        });
        const key = await enqueuePipeline(file.id, 1);

        await runPipelineJobs(pipelineTask({ gateway }));

        const id = z.uuid().parse(transcriptId);
        const jobs = await readJobs(key);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.last_error).toContain("Transcription task failed");
        expect(jobs[0]?.last_error).not.toContain("PRIVATE_LIVE_AUTOMATION_FAILURE_1582");
        expect(await readNotifications(id)).toEqual([]);
        expect((await readTranscript(file.id)).id).toBe(id);
        await expectNoAutomation(id);
      });

      const isItemLock = (sql: string) => sql.includes("FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE");
      const isAutomationLock = (sql: string) => sql.includes("FROM item_automation") && sql.includes("FOR UPDATE");
      const isStatement = (sql: string, statement: string) => sql.trim().toUpperCase() === statement;
      /** Bounds every statement of a barrier test's transactions, so a lock it misjudged fails instead of hanging. */
      const withStatementTimeout: QueryHook = async (sql, _args, connection) => {
        if (isStatement(sql, "BEGIN")) await connection.query("SET LOCAL statement_timeout = '5s'");
      };

      it.each([
        ["source", "deletion-first"],
        ["source", "deletion-rollback"],
        ["source", "failure-first"],
        ["transcript", "deletion-first"],
        ["transcript", "deletion-rollback"],
        ["transcript", "failure-first"],
      ] as const)(
        "settles the owned failure and %s deletion overlap: %s",
        async (targetKind, ordering) => {
          const { filesId, file } = await createSourceFile();
          await createUser();
          const runtime = await createRuntimeRolePool(pool, "semprec_data");
          let transcriptId: string | undefined;
          let failureStarted = false;
          let failurePid: number | undefined;
          let deletionPid: number | undefined;
          const failureBoundary = deferred();
          const deletionBoundary = deferred();
          const deletionCommit = deferred();
          const failureGate = deferred();
          const deletionGate = deferred();
          const marker = new Error("intentional deletion rollback");
          const workerPool = interceptQueries(runtime, {
            before: async (sql, _args, connection) => {
              if (failureStarted && isItemLock(sql) && ordering !== "failure-first" && failurePid === undefined) {
                failurePid = await backendPid(connection);
                failureBoundary.resolve();
              }
            },
            after: async (sql, args, connection) => {
              await withStatementTimeout(sql, args, connection);
              if (failureStarted && isAutomationLock(sql) && ordering === "failure-first") {
                failurePid = await backendPid(connection);
                failureBoundary.resolve();
                await failureGate.promise;
              }
            },
          });
          const deletionPool = interceptQueries(runtime, {
            before: async (sql, _args, connection) => {
              if (isItemLock(sql) && deletionPid === undefined) {
                deletionPid = await backendPid(connection);
                if (ordering === "failure-first") deletionBoundary.resolve();
              }
              if (isStatement(sql, "COMMIT")) {
                if (ordering !== "failure-first") deletionBoundary.resolve();
                else deletionCommit.resolve();
                await deletionGate.promise;
                if (ordering === "deletion-rollback") throw marker;
              }
            },
            after: withStatementTimeout,
          });
          const deletion: { current?: Promise<ItemRow | null> } = {};
          const startDeletion = () => {
            deletion.current = runInTenant(getTenantZeroId(), async () =>
              createChokePoint(deletionPool).softDeleteItem(
                targetKind === "source" ? filesId : await moduleDatabaseId("transcripts"),
                targetKind === "source" ? file.id : z.uuid().parse(transcriptId),
              ),
            );
            deletion.current.catch(() => {});
          };
          const gateway = diarizingWith(async () => {
            transcriptId = (await readTranscript(file.id)).id;
            if (ordering !== "failure-first") {
              startDeletion();
              await bounded(deletionBoundary.promise);
            }
            failureStarted = true;
            throw new Error("PRIVATE_ORDERED_FAILURE_1582");
          });
          let worker: Promise<void> | undefined;
          try {
            await enqueuePipeline(file.id, 1);
            worker = runPipelineJobs(pipelineTask({ pool: workerPool, gateway }));
            worker.catch(() => {});
            await bounded(failureBoundary.promise);
            if (ordering === "failure-first") {
              startDeletion();
              await bounded(deletionBoundary.promise);
            }
            if (!failurePid || !deletionPid) throw new Error("Missing competing backend PID");
            if (ordering === "failure-first") await expectBlockedBy(failurePid, deletionPid);
            else await expectBlockedBy(deletionPid, failurePid);
            const deleting = deletion.current;
            if (!deleting) throw new Error("Deletion did not start");
            if (ordering === "failure-first") {
              failureGate.resolve();
              await bounded(worker);
              await bounded(deletionCommit.promise);
              expect(await readNotifications(z.uuid().parse(transcriptId))).toHaveLength(1);
              deletionGate.resolve();
              await bounded(deleting);
            } else {
              deletionGate.resolve();
              const outcome = await deleting.then(
                () => null,
                (error: unknown) => error,
              );
              expect(outcome).toBe(ordering === "deletion-rollback" ? marker : null);
              await bounded(worker);
              const id = z.uuid().parse(transcriptId);
              if (ordering === "deletion-first") {
                expect(await readAutomationCode(id)).toEqual(DELETED);
                expect(await readNotifications(id)).toEqual([]);
              } else {
                expect(await readNotifications(id)).toHaveLength(1);
              }
            }
          } finally {
            failureGate.resolve();
            deletionGate.resolve();
            await Promise.allSettled([worker, deletion.current]);
            await runtime.end();
          }
        },
        20000,
      );

      it("settles a queued worker overlapping the real rerun transaction", async () => {
        const { file } = await createSourceFile();
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        let transcriptId: string | undefined;
        let workerPid: number | undefined;
        let rerunPid: number | undefined;
        let afterGateway = false;
        const gatewayAtBoundary = deferred();
        const gatewayGate = deferred();
        const rerunAtCommit = deferred();
        const rerunGate = deferred();
        const workerAtLock = deferred();
        const workerPool = interceptQueries(runtime, {
          before: async (sql, _args, connection) => {
            if (afterGateway && isAutomationLock(sql) && workerPid === undefined) {
              workerPid = await backendPid(connection);
              workerAtLock.resolve();
            }
          },
          after: withStatementTimeout,
        });
        const rerunPool = interceptQueries(runtime, {
          before: async (sql, _args, connection) => {
            if (!isStatement(sql, "COMMIT")) return;
            rerunPid = await backendPid(connection);
            rerunAtCommit.resolve();
            await rerunGate.promise;
          },
          after: withStatementTimeout,
        });
        let first = true;
        const gateway = diarizingWith(async () => {
          if (!first) return;
          first = false;
          transcriptId = (await readTranscript(file.id)).id;
          gatewayAtBoundary.resolve();
          await gatewayGate.promise;
          afterGateway = true;
        });
        let worker: Promise<void> | undefined;
        let rerun: ReturnType<ReturnType<typeof createRerunTranscriptionRouteHandler>> | undefined;
        try {
          await enqueuePipeline(file.id, 3);
          worker = runPipelineJobs(pipelineTask({ pool: workerPool, gateway }));
          worker.catch(() => {});
          await bounded(gatewayAtBoundary.promise);
          const id = z.uuid().parse(transcriptId);
          rerun = inTenantZero(() =>
            createRerunTranscriptionRouteHandler(rerunPool)({ params: { id }, body: undefined }),
          );
          rerun.catch(() => {});
          await bounded(rerunAtCommit.promise);
          gatewayGate.resolve();
          await bounded(workerAtLock.promise);
          if (!rerunPid || !workerPid) throw new Error("Missing competing backend PID");
          await expectBlockedBy(rerunPid, workerPid);
          rerunGate.resolve();
          expect((await bounded(rerun)).status).toBe(202);
          await bounded(worker);
          expect((await readAutomation(id))?.status).toBe("done");
        } finally {
          gatewayGate.resolve();
          rerunGate.resolve();
          await Promise.allSettled([worker, rerun]);
          await runtime.end();
        }
      }, 20000);

      /** A pool that runs `purge` once, right after the transaction that wrote the `checkpoint` checkpoint commits. */
      function purgingAfterCommitOf(checkpoint: string, purge: () => Promise<void>) {
        let checkpointWritten = false;
        const state = { purged: false };
        const purgingPool = interceptQueries(pool, {
          after: async (sql, [, params]) => {
            const parameters = z.array(z.unknown()).safeParse(params);
            if (sql.includes("UPDATE items SET computed") && parameters.success && parameters.data[2] === checkpoint)
              checkpointWritten = true;
            if (checkpointWritten && !state.purged && isStatement(sql, "COMMIT")) {
              state.purged = true;
              await purge();
            }
          },
        });
        return { purgingPool, state };
      }

      it.each(["source", "transcript"] as const)(
        "settles the queued job when the %s is purged between creation and attempt start",
        async (targetKind) => {
          const { filesId, file } = await createSourceFile();
          await createUser();
          let transcriptId: string | undefined;
          const { purgingPool, state } = purgingAfterCommitOf("create", async () => {
            transcriptId = await purgeTarget(targetKind, filesId, file.id);
          });
          const key = await enqueuePipeline(file.id);

          await runPipelineJobs(pipelineTask({ pool: purgingPool }));

          expect(state.purged).toBe(true);
          expect(await readJobs(key, true)).toEqual([]);
          expect(gatewayClient.diarizeCalls).toEqual([]);
          expect(gatewayClient.transcribeCalls).toEqual([]);
          expect(summaryClient.calls).toEqual([]);
          const id = z.uuid().parse(transcriptId);
          expect(await readNotifications(id)).toEqual([]);
          if (targetKind === "source") expect(await readAutomationCode(id)).toEqual(DELETED);
          else await expectNoAutomation(id);
        },
      );

      it("stops cleanly when the source is purged after diarization commits and before ASR starts", async () => {
        const { filesId, file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const { purgingPool, state } = purgingAfterCommitOf("diarize", async () => {
          transcriptId = await purgeTarget("source", filesId, file.id);
        });

        await runPipeline(file.id, FINAL_ATTEMPT, { pool: purgingPool });

        expect(state.purged).toBe(true);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toEqual([]);
        const id = z.uuid().parse(transcriptId);
        expect(await readAutomationCode(id)).toEqual(DELETED);
        expect(await readNotifications(id)).toEqual([]);
      });

      it("falls back to the deleted stop instead of rolling back when the last attempt fails on a trashed transcript", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const trashingSummary = new (class extends FakeSummaryClient {
          override async complete(): Promise<AiGatewayCompletionResult> {
            await deleteTranscript(file.id);
            throw new Error("simulated summary outage");
          }
        })();

        await runPipeline(file.id, FINAL_ATTEMPT, { summary: trashingSummary });

        const transcript = await readTranscript(file.id);
        expect(await readAutomationCode(transcript.id)).toEqual(DELETED);
        expect(await readNotifications(transcript.id)).toEqual([]);
      });

      it("runs again after the transcript is restored and the job is rerun", async () => {
        const { file } = await createSourceFile();
        let deleting = true;
        const gateway = diarizingWith(async () => {
          if (deleting) await deleteTranscript(file.id);
        });
        await runPipeline(file.id, FIRST_ATTEMPT, { gateway });
        const transcript = await readTranscript(file.id);
        const transcriptsId = await moduleDatabaseId("transcripts");
        await inTenantZero(() => createChokePoint(pool).restoreItem(transcriptsId, transcript.id));
        deleting = false;

        const requested = await inTenantZero(() =>
          createRerunTranscriptionRouteHandler(pool)({ params: { id: transcript.id }, body: undefined }),
        );
        expect(requested).toEqual({ status: 202, body: { id: transcript.id, fileItemId: file.id } });
        await runPipelineJobs(pipelineTask({ gateway }));

        expect(await readAutomationCode(transcript.id)).toEqual({ status: "done", error_code: null });
        expect(gateway.diarizeCalls).toHaveLength(2);
        expect(gateway.transcribeCalls).toHaveLength(1);
      });
    });

    it("retries through graphile-worker at most three times with growing backoff, then records the failure once with exactly one automation_error notification", async () => {
      const { file } = await createSourceFile();
      const userId = await createUser();
      const failure = new Error("simulated summary outage");
      summaryClient.failure = failure;
      const jobKey = await enqueuePipeline(file.id, 3);

      async function runDueJob(): Promise<{ attempts: number; delaySeconds: number }> {
        await pool.query("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1", [jobKey]);
        await runPipelineJobs();
        const { rows } = await pool.query<{ attempts: number; delay_seconds: number }>(
          `SELECT attempts, EXTRACT(EPOCH FROM run_at - now())::float8 AS delay_seconds
           FROM graphile_worker._private_jobs WHERE key = $1`,
          [jobKey],
        );
        if (!rows[0]) throw new Error("expected the failed job to remain queued");
        return { attempts: rows[0].attempts, delaySeconds: rows[0].delay_seconds };
      }

      const first = await runDueJob();
      const second = await runDueJob();
      const third = await runDueJob();
      expect([first.attempts, second.attempts, third.attempts]).toEqual([1, 2, 3]);
      expect(first.delaySeconds).toBeGreaterThan(1);
      expect(second.delaySeconds).toBeGreaterThan(first.delaySeconds);

      // Exhausted: graphile-worker runs it no more.
      expect((await runDueJob()).attempts).toBe(3);
      expect(summaryClient.calls).toHaveLength(3);
      expect(gatewayClient.diarizeCalls).toHaveLength(1);
      expect(gatewayClient.transcribeCalls).toHaveLength(1);

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("error");
      expect(await readAutomation(transcript.id)).toEqual({ status: "error", error: failure.message, attempts: 3 });
      expect(await readNotifications(transcript.id)).toEqual([
        {
          user_id: userId,
          kind: "automation_error",
          link_href: `?page=transcript&id=${transcript.id}`,
          source_table: "item_automation",
          transition_instance: "attempt:3",
        },
      ]);
    });

    /** Runs the file's queued job once, capturing what the app logger and graphile-worker print; returns its queue row. */
    async function runObservedJob(fileItemId: string, maxAttempts: number, task: QueueTask = pipelineTask()) {
      const key = await enqueuePipeline(fileItemId, maxAttempts);
      observedLogs.chunks.length = 0;
      const graphile = vi.spyOn(console, "error");
      let workerOutput: string;
      try {
        await runPipelineJobs(task);
        workerOutput = inspect(graphile.mock.calls, { depth: 8 });
      } finally {
        graphile.mockRestore();
      }
      return { job: (await readJobs(key))[0], appOutput: observedLogs.chunks.join(""), workerOutput };
    }

    it.each([
      [1, "error", 1],
      [3, "pending", 0],
    ] as const)(
      "keeps the provider's diagnostic out of worker output, application logs and queue state, max attempts %s",
      async (maxAttempts, status, notifications) => {
        const { file } = await createSourceFile();
        await createUser();
        const sentinel = "PRIVATE_PROVIDER_SENTINEL_1386";
        summaryClient.failure = new Error(sentinel);

        const { job, appOutput, workerOutput } = await runObservedJob(file.id, maxAttempts);

        expect(job?.attempts).toBe(1);
        expect(job?.last_error).toContain("Transcription task failed");
        expect(workerOutput).toContain("Transcription task failed");
        for (const output of [job?.last_error, appOutput, workerOutput]) expect(output).not.toContain(sentinel);
        // The diagnostic stays only on the automation row.
        const transcript = await readTranscript(file.id);
        expect(await readAutomation(transcript.id)).toMatchObject({ status, error: sentinel });
        expect(await readNotifications(transcript.id)).toHaveLength(notifications);
      },
    );

    it("passes a safe failure to the real queue wrapper when the running task is superseded", async () => {
      const { file } = await createSourceFile();
      const sentinel = "PRIVATE_SUPERSEDED_SENTINEL_1386";
      const gate = deferred();
      const reached = deferred();
      let first = true;
      const summary: AiGatewayClientPort = {
        async complete(input) {
          if (first) {
            first = false;
            reached.resolve();
            await gate.promise;
            throw new Error(sentinel);
          }
          return summaryClient.complete(input);
        },
      };
      const task = pipelineTask({ summary });
      let outward: unknown;
      let worker: Promise<void> | undefined;
      observedLogs.chunks.length = 0;
      try {
        await enqueuePipeline(file.id, 3);
        worker = runPipelineJobs(async (payload, helpers) => {
          try {
            await task(payload, helpers);
          } catch (error) {
            outward = error;
            throw error;
          }
        });
        await bounded(reached.promise, 10_000);
        await enqueuePipeline(file.id, 3);
        gate.resolve();
        await worker;
      } finally {
        gate.resolve();
        await worker;
      }
      expect(outward).toMatchObject({ ...TASK_FAILED, code: "unknown" });
      expect(outward).not.toHaveProperty("cause");
      expect(inspect(outward)).not.toContain(sentinel);
      expect(observedLogs.chunks.join("")).toContain("Job was superseded by a re-enqueue");
      expect(observedLogs.chunks.join("")).not.toContain(sentinel);
      const queueRecords = observedLogs.chunks
        .flatMap((chunk) => chunk.split("\n").filter(Boolean))
        .map((line) =>
          z
            .object({ msg: z.string(), err: z.record(z.string(), z.unknown()).optional() })
            .passthrough()
            .parse(JSON.parse(line)),
        );
      const superseded = queueRecords.find((record) => record.msg.startsWith("Job was superseded by a re-enqueue"));
      expect(superseded?.err).toBeDefined();
      expect(superseded?.err).not.toHaveProperty("cause");
      expect(summaryClient.calls.length).toBeGreaterThan(0);
    });

    it("preserves a safe worker failure when diagnostic recording itself fails", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new Error("PRIVATE_ORIGINAL_RECORD_FAILURE_1386");
      // The trigger injects an otherwise unavailable notification persistence failure.
      await withNotificationInsertsFailing(async () => {
        const { job, appOutput, workerOutput } = await runObservedJob(file.id, 1);
        expect(job?.last_error).toContain("Transcription task failed");
        expect(appOutput).toContain("Failed to record a transcription failure");
        expect(workerOutput).toContain("Transcription task failed");
        for (const sentinel of ["PRIVATE_ORIGINAL_RECORD_FAILURE_1386", "PRIVATE_RECORDING_FAILURE_1386"])
          for (const output of [job?.last_error, appOutput, workerOutput]) expect(output).not.toContain(sentinel);
        const transcript = await readTranscript(file.id);
        expect((await readAutomation(transcript.id))?.status).toBe("pending");
        expect(await readNotifications(transcript.id)).toEqual([]);
      });
    });

    it("reports a safe worker failure after storage and cleanup failures", async () => {
      const { file } = await createSourceFile();
      const storage: BlobStorageWriter = {
        async writeStream(_key, stream) {
          for await (const _chunk of stream) {
            /* drain ffmpeg before the injected failure */
          }
          throw new Error("PRIVATE_STORAGE_FAILURE_1386");
        },
        async delete() {
          throw new Error("PRIVATE_CLEANUP_FAILURE_1386");
        },
        readStream: (key, range) => blobStorage.readStream(key, range),
      };

      const { job, appOutput, workerOutput } = await runObservedJob(file.id, 1, pipelineTask({ storage }));

      expect(job?.last_error).toContain("Transcription task failed");
      expect(appOutput).toContain("Failed to delete normalized audio that no blob references");
      expect(workerOutput).toContain("Transcription task failed");
      for (const sentinel of ["PRIVATE_STORAGE_FAILURE_1386", "PRIVATE_CLEANUP_FAILURE_1386"])
        for (const output of [job?.last_error, appOutput, workerOutput]) expect(output).not.toContain(sentinel);
    });

    it.each([
      ["files", "Files database not found"],
      ["transcripts", "Transcripts database not found"],
    ])(
      "reports a safe worker failure when the %s catalog is unavailable before a transcript exists",
      async (moduleId, original) => {
        const { file } = await createSourceFile();
        // Simulate a missing built-in catalog entry, which normal APIs cannot remove.
        await pool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = $1", [moduleId]);

        const { job, appOutput, workerOutput } = await runObservedJob(file.id, 1);

        expect(job?.last_error).toContain("Transcription task failed");
        expect(workerOutput).toContain("Transcription task failed");
        for (const output of [job?.last_error, appOutput, workerOutput]) expect(output).not.toContain(original);
        const automations = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM item_automation");
        expect(automations.rows[0]?.count).toBe(0);
      },
    );

    async function runRequeueSweep(): Promise<void> {
      const transcriptsDatabaseId = await moduleDatabaseId("transcripts");
      await inTenantZero(() =>
        createTranscriptionRequeueSweepAction(pool)(
          { transcriptsDatabaseId },
          { heartbeatId: randomUUID(), projectItemId: randomUUID() },
        ),
      );
    }

    function rerunByHand(transcriptId: string) {
      return inTenantZero(() =>
        createRerunTranscriptionRouteHandler(pool)({ params: { id: transcriptId }, body: undefined }),
      );
    }

    describe("daily requeue and manual rerun", () => {
      /** Makes every queued transcription job due now and runs whatever is runnable once. */
      async function runDueJobs(): Promise<void> {
        await pool.query(
          "UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key LIKE 'transcription-job:%'",
        );
        await runPipelineJobs();
      }

      async function readRunnableJobs(): Promise<Array<{ key: string; attempts: number }>> {
        const { rows } = await pool.query<{ key: string; attempts: number }>(
          "SELECT key, attempts FROM graphile_worker.jobs WHERE key LIKE 'transcription-job:%' AND attempts < max_attempts",
        );
        return rows;
      }

      async function countTranscripts(): Promise<number> {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM items i JOIN databases d ON d.id = i.database_id
           WHERE d.owner_module_id = 'transcripts'`,
        );
        return rows[0]?.count ?? 0;
      }

      /** Runs the file's job through all three attempts, each failing at the summary, so the row ends `error`. */
      async function failPermanently(fileItemId: string): Promise<string> {
        summaryClient.failure = new Error("simulated summary outage");
        await enqueuePipeline(fileItemId, 3);
        for (let attempt = 0; attempt < 3; attempt += 1) await runDueJobs();
        const transcript = await readTranscript(fileItemId);
        expect(await readAutomation(transcript.id)).toMatchObject({ status: "error", attempts: 3 });
        summaryClient.failure = null;
        return transcript.id;
      }

      const paidCalls = () => [
        gatewayClient.diarizeCalls.length,
        gatewayClient.transcribeCalls.length,
        summaryClient.calls.length,
      ];

      it("requeues an error row daily under its key and resumes the same row without repeating a paid stage", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const transcriptId = await failPermanently(file.id);

        await runRequeueSweep();
        await runRequeueSweep();
        expect(await readRunnableJobs()).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);
        await runDueJobs();

        const done = await readTranscript(file.id);
        expect(done.id).toBe(transcriptId);
        expect(done.properties.status).toBe("done");
        expect(await readAutomation(transcriptId)).toEqual({ status: "done", error: null, attempts: 4 });
        expect(await countTranscripts()).toBe(1);
        // Three failed summary attempts, then the one that succeeded — never a repeat of a cached summary.
        expect(paidCalls()).toEqual([1, 1, 4]);

        await runRequeueSweep();
        expect(await readRunnableJobs()).toEqual([]);
      });

      it("reruns a done row by hand on the same row and key without any paid call", async () => {
        const { file } = await createSourceFile();
        await runPipeline(file.id);
        const transcript = await readTranscript(file.id);
        const paidBefore = paidCalls();

        expect((await rerunByHand(transcript.id)).status).toBe(202);
        expect(await readRunnableJobs()).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);
        await runDueJobs();

        expect(await readRunnableJobs()).toEqual([]);
        expect((await readTranscript(file.id)).properties.status).toBe("done");
        expect(await readAutomation(transcript.id)).toMatchObject({ status: "done", attempts: 2 });
        expect(await countTranscripts()).toBe(1);
        expect(paidCalls()).toEqual(paidBefore);
      });

      it("reruns an error row by hand from its checkpoints", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const transcriptId = await failPermanently(file.id);

        await rerunByHand(transcriptId);
        await runDueJobs();

        expect((await readTranscript(file.id)).properties.status).toBe("done");
        expect(await countTranscripts()).toBe(1);
        expect(paidCalls()).toEqual([1, 1, 4]);
      });

      it("never reruns a locked row by either path", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const transcriptId = await failPermanently(file.id);
        await lockAutomation(transcriptId);

        await runRequeueSweep();
        await expect(rerunByHand(transcriptId)).rejects.toMatchObject({ status: 403, code: "transcription_locked" });
        await runDueJobs();

        expect(await readRunnableJobs()).toEqual([]);
        expect(await readAutomation(transcriptId)).toMatchObject({ status: "locked", attempts: 3 });
        expect(summaryClient.calls).toHaveLength(3);
      });
    });

    describe("rerun of a finished transcript without meeting notes", () => {
      /** A `done` transcript without `meetingNotes`; no production write removes it, so the row is edited directly. */
      async function finishWithoutNotes(fileItemId: string) {
        await runPipeline(fileItemId);
        const finished = await readTranscript(fileItemId);
        expect(finished.properties.status).toBe("done");
        const stripped = await pool.query("UPDATE items SET computed = computed - 'meetingNotes' WHERE id = $1", [
          finished.id,
        ]);
        expect(stripped.rowCount).toBe(1);
        return readTranscript(fileItemId);
      }

      /**
       * `finishWithoutNotes` plus no `suggestSpeakers` checkpoint and no speaker card. Cards are purged
       * through the Trash so their idempotency keys are free again.
       */
      async function finishWithoutNotesOrSpeakerProposals(fileItemId: string) {
        const transcript = await finishWithoutNotes(fileItemId);
        const { rows: speakerCards } = await pool.query<{ id: string; database_id: string }>(
          `SELECT i.id, i.database_id FROM items i JOIN databases d ON d.id = i.database_id
           WHERE d.owner_module_id = 'processingProposals' AND i.properties -> 'context' ->> 'role' = 'speaker'
           ORDER BY i.id`,
        );
        // One card per speaker of the fixture's two.
        expect(speakerCards).toHaveLength(2);
        for (const card of speakerCards) await inTenantZero(() => purgeItem(card.database_id, card.id));
        const stripped = await pool.query("UPDATE items SET computed = computed - 'suggestSpeakers' WHERE id = $1", [
          fileItemId,
        ]);
        expect(stripped.rowCount).toBe(1);
        return transcript;
      }

      /** Every Processing proposals card, the Event pairing card and the speaker cards alike. */
      async function readCardIds(): Promise<string[]> {
        const { rows } = await pool.query<{ id: string }>(
          `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
           WHERE d.owner_module_id = 'processingProposals' ORDER BY i.id`,
        );
        return rows.map((row) => row.id);
      }

      async function readSourceComputed(filesDatabaseId: string, fileItemId: string) {
        const source = await readSource(filesDatabaseId, fileItemId);
        if (!source) throw new Error("expected the source Files item");
        return source.computed;
      }

      async function countNotifications(): Promise<number> {
        const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM notifications");
        return rows[0]?.count ?? 0;
      }

      it("pays only the summarize call, keeps status done while it runs and adds no card", async () => {
        const { filesId, file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        const sourceBefore = await readSourceComputed(filesId, file.id);
        const matchBefore = await readMatch(before.id);
        const cardsBefore = await readCardIds();
        // No Event matched: the first run left the pairing card and one card per speaker.
        expect(matchBefore.cards).toHaveLength(1);
        expect(cardsBefore).toHaveLength(3);
        const observed: Array<{ status: unknown; automation: string | undefined }> = [];
        /** Reads the row's visible state while the paid call of the rerun is out. */
        const observing = summarizingWith("transcript_summary", async () => {
          observed.push({
            status: (await readTranscript(file.id)).properties.status,
            automation: (await readAutomation(before.id))?.status,
          });
        });

        await runPipeline(file.id, FIRST_ATTEMPT, { summary: observing });

        expect(observing.operations()).toEqual(["transcript_summary"]);
        expect(observed).toEqual([{ status: "done", automation: "pending" }]);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toHaveLength(1);
        const after = await readTranscript(file.id);
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual({ ...before.computed, meetingNotes: STORED_NOTES });
        expect(await readSourceComputed(filesId, file.id)).toEqual(sourceBefore);
        expect(await readMatch(after.id)).toEqual(matchBefore);
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 2 });
        expect(await countNotifications()).toBe(0);
      });

      it("makes no second speaker suggestion call and keeps the Event edge and the speaker cards", async () => {
        const { file } = await createSourceFile();
        const { eventId } = await linkEventWithAlice();
        const before = await finishWithoutNotes(file.id);
        expect(summaryClient.operations()).toEqual(["transcript_summary", "transcript_speaker_suggestion"]);
        const cardsBefore = await readCardIds();
        expect(cardsBefore).toHaveLength(2);
        expect(await readMatch(before.id)).toEqual(linkedTo(eventId));

        await runPipeline(file.id);

        expect(summaryClient.operations()).toEqual([
          "transcript_summary",
          "transcript_speaker_suggestion",
          "transcript_summary",
        ]);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toHaveLength(1);
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed.meetingNotes).toEqual(STORED_NOTES);
        expect(await readMatch(after.id)).toEqual(linkedTo(eventId));
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await countSpeakerEdges()).toBe(0);
      });

      it("adds no speaker card and no checkpoint for a transcript an earlier pipeline finished without them", async () => {
        const { filesId, file } = await createSourceFile();
        const before = await finishWithoutNotesOrSpeakerProposals(file.id);
        const sourceBefore = await readSourceComputed(filesId, file.id);
        expect(sourceBefore).not.toHaveProperty("suggestSpeakers");
        const cardsBefore = await readCardIds();
        // No Event matched: only the pairing card of the first run is left.
        expect(cardsBefore).toHaveLength(1);
        expect(await readSpeakerCards()).toEqual([]);

        await runPipeline(file.id);

        const after = await readTranscript(file.id);
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual({ ...before.computed, meetingNotes: STORED_NOTES });
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await readSpeakerCards()).toEqual([]);
        expect(await readSourceComputed(filesId, file.id)).toEqual(sourceBefore);
        // The first run's notes call and the rerun's; nothing else was asked.
        expect(summaryClient.operations()).toEqual(["transcript_summary", "transcript_summary"]);
        expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 2 });
      });

      it("pays no speaker suggestion call for such a transcript whose Event has a named participant", async () => {
        const { filesId, file } = await createSourceFile();
        const { eventId } = await linkEventWithAlice();
        // The state of a transcript whose Event got its named participant only after it was finished.
        const before = await finishWithoutNotesOrSpeakerProposals(file.id);
        const sourceBefore = await readSourceComputed(filesId, file.id);
        expect(sourceBefore).not.toHaveProperty("suggestSpeakers");
        // The linked Event left no pairing card, and the speaker cards are gone.
        expect(await readCardIds()).toEqual([]);
        const callsBefore = summaryClient.calls.length;

        await runPipeline(file.id);

        // Alice is still an unmapped participant: an unfinished transcript would be asked about here.
        expect(summaryClient.operations().slice(callsBefore)).toEqual(["transcript_summary"]);
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed).toEqual({ ...before.computed, meetingNotes: STORED_NOTES });
        expect(await readCardIds()).toEqual([]);
        expect(await readSourceComputed(filesId, file.id)).toEqual(sourceBefore);
        expect(await readMatch(after.id)).toEqual(linkedTo(eventId));
        expect(await countSpeakerEdges()).toBe(0);
      });

      it("neither links nor proposes an Event again after the user removed the transcript's Event edge", async () => {
        const { file } = await createSourceFile();
        const eventId = await createEvent(FIXTURE_CREATION_TIME);
        const before = await finishWithoutNotes(file.id);
        expect(await readMatch(before.id)).toEqual(linkedTo(eventId));
        const { rows: eventProperty } = await pool.query<{ id: string }>(
          `SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id
           WHERE d.owner_module_id = 'transcripts' AND p.key = 'event'`,
        );
        const relationPropertyId = eventProperty[0]?.id;
        if (!relationPropertyId) throw new Error("Transcripts 'event' property was not seeded");
        // The relation is the user's: removed the way the relation endpoint removes it.
        const removed = await createChokePoint(pool).deleteRelation({
          relationPropertyId,
          callerItemId: before.id,
          targetItemId: eventId,
        });
        expect(removed).not.toBeNull();
        expect(await readMatch(before.id)).toEqual({ eventIds: [], cards: [] });
        const cardsBefore = await readCardIds();

        await runPipeline(file.id);

        // The Event still starts inside the recording's window: an unfinished transcript would be linked to it.
        expect(await readMatch(before.id)).toEqual({ eventIds: [], cards: [] });
        expect(await readCardIds()).toEqual(cardsBefore);
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed.meetingNotes).toEqual(STORED_NOTES);
      });

      it("still converges on the Event edge and the speaker checkpoint when an unfinished run resumes", async () => {
        const { filesId, file } = await createSourceFile();
        const { eventId } = await linkEventWithAlice();
        const controller = new AbortController();
        /** Requests the shutdown while step 7's call is out: the step still commits, and the run stops before finalize. */
        const interrupting: AiGatewayClientPort = {
          complete: (input) => {
            if (input.operation === "transcript_speaker_suggestion") controller.abort();
            return summaryClient.complete(input);
          },
        };
        await runPipeline(file.id, { ...FIRST_ATTEMPT, abortSignal: controller.signal }, { summary: interrupting });
        const interrupted = await readTranscript(file.id);
        expect(interrupted.properties.status).toBe("processing");
        expect(await readMatch(interrupted.id)).toEqual(linkedTo(eventId));
        const cardsBefore = await readCardIds();
        expect(cardsBefore).toHaveLength(2);
        const sourceBefore = await readSourceComputed(filesId, file.id);
        expect(sourceBefore).toHaveProperty("suggestSpeakers");

        await runPipeline(file.id);

        expect((await readTranscript(file.id)).properties.status).toBe("done");
        expect(summaryClient.operations()).toEqual(["transcript_summary", "transcript_speaker_suggestion"]);
        expect(await readMatch(interrupted.id)).toEqual(linkedTo(eventId));
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await readSourceComputed(filesId, file.id)).toEqual(sourceBefore);
      });

      it("writes no speaker card and no checkpoint when the transcript is finished while the suggestion call is out", async () => {
        const { filesId, file } = await createSourceFile();
        const { eventId, aliceId } = await linkEventWithAlice();
        /**
         * Finishes the transcript while this run's suggestion call is out, through the owner-process
         * write finalize uses. It stands in for a concurrent run that had nobody left to ask about and so
         * finished the transcript without the checkpoint.
         */
        const finishing = summarizingWith("transcript_speaker_suggestion", async () =>
          setTranscriptStatus((await readTranscript(file.id)).id, "done"),
        );
        finishing.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];

        await runPipeline(file.id, FIRST_ATTEMPT, { summary: finishing });

        // The call was already out and is paid; its answer is dropped.
        expect(finishing.operations()).toEqual(["transcript_summary", "transcript_speaker_suggestion"]);
        expect(await readCardIds()).toEqual([]);
        expect(await readSourceComputed(filesId, file.id)).not.toHaveProperty("suggestSpeakers");
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(await readMatch(after.id)).toEqual(linkedTo(eventId));
        expect(await readAutomation(after.id)).toMatchObject({ status: "done", attempts: 1 });
      });

      it("leaves status done and writes no notification when its last attempt fails", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        const cardsBefore = await readCardIds();
        const failure = new Error("simulated summary outage");
        summaryClient.failure = failure;

        await expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject(TASK_FAILED);

        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual(before.computed);
        expect(await readAutomation(after.id)).toEqual({ status: "error", error: failure.message, attempts: 2 });
        expect(await readAutomationCode(after.id)).toEqual({ status: "error", error_code: "unknown" });
        expect(await countNotifications()).toBe(0);
        expect(await readCardIds()).toEqual(cardsBefore);
      });

      it("leaves status done and writes no notification when the gateway budget rejects it", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        summaryClient.failure = new AiGatewayFailedError("budget_exceeded");

        await expect(runPipeline(file.id)).resolves.toBeUndefined();

        const after = await readTranscript(file.id);
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual(before.computed);
        expect(await readAutomation(after.id)).toMatchObject({ status: "error", attempts: 2 });
        expect(await readAutomationCode(after.id)).toEqual({ status: "error", error_code: "budgetExceeded" });
        expect(await countNotifications()).toBe(0);
      });

      it("is finished by the daily requeue sweep after such a failure, still without a notification", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        summaryClient.failure = new Error("simulated summary outage");
        await expect(runPipeline(file.id, FINAL_ATTEMPT)).rejects.toMatchObject({ name: "TranscriptionQueueError" });
        expect(await readAutomation(before.id)).toMatchObject({ status: "error", attempts: 2 });
        summaryClient.failure = null;

        await runRequeueSweep();
        const { rows: jobs } = await pool.query<{ key: string | null; attempts: number }>(
          "SELECT key, attempts FROM graphile_worker.jobs WHERE task_identifier = $1",
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB],
        );
        expect(jobs).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);
        await runPipelineJobs();

        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed.meetingNotes).toEqual(STORED_NOTES);
        expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 3 });
        expect(await countNotifications()).toBe(0);
      });
    });
  });
});
