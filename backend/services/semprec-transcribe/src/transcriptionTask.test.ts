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
  runTenantCutoverMigrations,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
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

let pool: Pool;

/** A job's first of three attempts: a failure in it is transient, so it is retried rather than recorded as permanent. */
const FIRST_ATTEMPT = { job: { attempts: 1, max_attempts: 3 } };

/** A fake `AudioGatewayClient` for steps 0/1's tests, which do not exercise diarization/ASR themselves but still run through them as later pipeline steps. Counts calls so resume tests can assert on them. */
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

/**
 * A fake `AiGatewayClientPort` for steps 5 and 7, a deterministic transport, not a model: answers
 * every meeting-notes request with fixed notes carrying `actionItems`, every speaker-suggestion
 * request with `speakerMappings`, and counts calls.
 */
class FakeSummaryClient implements AiGatewayClientPort {
  calls: AiGatewayCompletionInput[] = [];
  failure: Error | null = null;
  speakerMappings: Array<{ speaker: string; personId: string | null; reason: string }> = [];
  actionItems: MeetingNotes["actionItems"] = [];

  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    if (input.operation === "transcript_speaker_suggestion")
      return { content: { mappings: this.speakerMappings }, usage: { inputTokens: 10, outputTokens: 5 } };
    return { content: { ...FAKE_NOTES, actionItems: this.actionItems }, usage: { inputTokens: 10, outputTokens: 5 } };
  }

  /** The meeting-notes calls, the paid step 5 requests. */
  notesCalls(): AiGatewayCompletionInput[] {
    return this.calls.filter((call) => call.operation === "transcript_summary");
  }
}

const FAKE_NOTES = {
  title: "Greeting",
  summary: "{SPEAKER_00} greets {SPEAKER_01}.",
  shortSummary: "A greeting.",
  decisions: ["Keep greeting"],
};

let summaryClient: FakeSummaryClient;

/** `wireRealtimeHooks` installs every hook; undo all of them so no later test publishes through this file's pool. */
function resetRealtimeHooks(): void {
  setInvalidationHook(() => {});
  setDocUpdateHook(() => {});
  setNotificationCreatedHook(() => {});
  setNotificationReadStateHook(() => {});
  setSessionRevokedHook(() => {});
  setAgentRunEventHook(() => {});
}

afterAll(async () => {
  await pool?.end();
});

describe("transcription step 0", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
  let audioFixture: Buffer;

  beforeAll(async () => {
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  it("creates one pending transcript with the source values and skips its checkpoint on replay", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}.m4a`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording.mp3", file: { blobId: blob.id } },
      }),
    );
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
    // Stops each run at step 5, before `done`, so the row still shows step 0's initial values.
    summaryClient.failure = new Error("stop before finalize");
    gatewayClient.transcribeResult = () => ({
      text: "Hello.",
      language: "en",
      segments: [{ start: 0, end: 0.5, text: "Hello." }],
    });

    await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).rejects.toMatchObject({
      name: "TranscriptionQueueError",
      message: "Transcription task failed",
    });
    await pool.query("UPDATE items SET properties = '{}'::jsonb WHERE id = $1", [file.id]);
    await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).rejects.toMatchObject({
      name: "TranscriptionQueueError",
      message: "Transcription task failed",
    });

    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!transcripts) throw new Error("Transcripts database was not seeded");
    const raw = await pool.query<Record<string, unknown>>("SELECT id, properties FROM items WHERE database_id = $1", [
      transcripts.id,
    ]);
    const rows = z.array(z.object({ id: z.uuid(), properties: z.record(z.string(), z.unknown()) })).parse(raw.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toMatchObject({
      name: "recording.mp3",
      status: "processing",
      link: `semprec://items/${file.id}`,
    });
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    expect(source?.computed.create).toBe(rows[0]?.id);
    const { rows: automationRows } = await pool.query<{ status: string }>(
      "SELECT status FROM item_automation WHERE item_id = $1",
      [rows[0]?.id],
    );
    expect(automationRows).toEqual([{ status: "pending" }]);
  });

  it("gives the fast transcript the existing upload timestamp", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!files || !transcripts) throw new Error("Transcription databases were not seeded");
    const storageKey = `source/${randomUUID()}.m4a`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, {
        mimeType: "audio/mp4",
        byteSize: audioFixture.byteLength,
        storageKey,
      }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "Fast recording", file: { blobId: blob.id } },
      }),
    );
    await inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId: file.id }));
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    const id = z.uuid().parse(source?.computed.create);
    const transcript = await withTransaction(pool, (client) => getItemById(client, transcripts.id, id));
    expect(transcript?.properties.date).toBe(blob.createdAt);
  });

  it("uses the recorded timestamp on a fast-created transcript", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!files || !transcripts) throw new Error("Transcription databases were not seeded");
    const storageKey = `source/${randomUUID()}.m4a`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, {
        mimeType: "audio/mp4",
        byteSize: audioFixture.byteLength,
        storageKey,
      }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "Fast recording", file: { blobId: blob.id } },
      }),
    );
    const recordedAt = "2026-01-05T09:00:00.000Z";
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        recordRecordingIntake(client, {
          fileItemId: file.id,
          eventId: null,
          recordedAt,
        }),
      ),
    );
    await inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId: file.id }));
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    const id = z.uuid().parse(source?.computed.create);
    const transcript = await withTransaction(pool, (client) => getItemById(client, transcripts.id, id));
    expect(new Date(z.string().parse(transcript?.properties.date)).toISOString()).toBe(recordedAt);
  });

  it.each([false, true])("copies only a live requested project to a fast transcript (trashed: %s)", async (trashed) => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!files || !projects) throw new Error("Recording databases were not seeded");
    const storageKey = `source/${randomUUID()}.m4a`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, {
        mimeType: "audio/mp4",
        byteSize: audioFixture.byteLength,
        storageKey,
      }),
    );
    const [file, project] = await withTransaction(pool, async (client) => [
      await createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "Recording", file: { blobId: blob.id } },
      }),
      await createItemWithClient(client, { databaseId: projects.id, properties: { name: "Chosen project" } }),
    ]);
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        recordRecordingIntake(client, { fileItemId: file.id, eventId: null, recordedAt: null }),
      ),
    );
    const updated = await pool.query(
      "UPDATE recording_requests SET project_item_id = $2 WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
      [file.id, project.id],
    );
    expect(updated.rowCount).toBe(1);
    if (trashed)
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, projects.id, project.id, { queueAffinity: createActionQueueAffinity() }),
      );
    const task = createTranscriptionCreateTask(pool);
    await inTenantZero(async () => {
      await task({ fileItemId: file.id });
      await task({ fileItemId: file.id });
    });
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    const transcriptId = z.uuid().parse(source?.computed.create);
    const edges = await pool.query<{ item_a: string; item_b: string }>(
      `SELECT r.item_a, r.item_b FROM item_relations r
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id = d.property_id_b
       WHERE p.key = 'project' AND r.item_b = $1`,
      [transcriptId],
    );
    expect(edges.rows).toEqual(trashed ? [] : [{ item_a: project.id, item_b: transcriptId }]);
    const links = await pool.query("SELECT id FROM value_links WHERE item_id = $1 AND property_key = 'project'", [
      transcriptId,
    ]);
    expect(links.rowCount).toBe(0);
    if (trashed) {
      await inTenantZero(() =>
        createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT),
      );
      const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
      if (!transcripts) throw new Error("Transcripts missing");
      expect(
        (await withTransaction(pool, (client) => getItemById(client, transcripts.id, transcriptId)))?.properties.status,
      ).toBe("done");
    }
  });

  it("converges concurrent fast creates on the same checkpoint and transcript", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!files || !transcripts) throw new Error("Transcription databases were not seeded");
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "Fast recording" },
      }),
    );
    const task = createTranscriptionCreateTask(pool);
    await inTenantZero(() => Promise.all([task({ fileItemId: file.id }), task({ fileItemId: file.id })]));
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1",
      [transcripts.id],
    );
    expect(rows).toHaveLength(1);
    expect(source?.computed.create).toBe(rows[0]?.id);
    expect(rows[0]?.properties).toMatchObject({ name: "Fast recording", status: "processing" });
  });

  it("rejects writing the transcripts 'status'/'link' system properties under the wrong systemOwnerProcess", async () => {
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!transcripts) throw new Error("Transcripts database was not seeded");

    const promise = withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: transcripts.id,
          properties: { name: "recording.mp3", status: "processing", link: "semprec://items/does-not-matter" },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: "wrong-process" },
      ),
    );

    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    try {
      await promise;
      expect.unreachable("expected an owner_violation ForbiddenError");
    } catch (err) {
      if (!(err instanceof ForbiddenError)) throw err;
      expect(err.code).toBe("owner_violation");
    }
  });
});

/**
 * Issue #1644: step 0 links the transcript to the Event its upload named. Two seeded tenants on a
 * `semprec_data` pool. An upload is the recordings route's composition: the shared Files upload with
 * `recordRecordingIntake` in its transaction. The jobs it enqueues are drained one lane at a time
 * with the tasks `createTranscribeQueueRuntime` registers, the fake gateways in place of HTTP.
 */
describe("transcription step 0: the upload's Event (issue #1644)", () => {
  let runtime: Pool;
  let tenant: string;
  let foreign: string;
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
  let audioFixture: Buffer;

  beforeAll(async () => {
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    runtime = await createRuntimeRolePool(pool, "semprec_data");
    tenant = await createTestTenant(pool);
    foreign = await createTestTenant(pool);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
    const role = await inTenant(tenant, (client) =>
      client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
    gatewayClient.diarizeResult = [
      { speaker: "SPEAKER_00", start: 0, end: 0.5 },
      { speaker: "SPEAKER_01", start: 0.5, end: 1 },
    ];
    gatewayClient.transcribeResult = () => ({
      text: "Hello. Hi there.",
      language: "en",
      segments: [
        { start: 0, end: 0.4, text: " Hello." },
        { start: 0.6, end: 0.9, text: " Hi there." },
      ],
    });
  });

  afterEach(async () => {
    await runtime.end();
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  /** Runs `fn` in one transaction of the runtime-role pool, inside `tenantId`. */
  function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runInTenant(tenantId, () => withTransaction(runtime, fn));
  }

  async function requireDatabaseId(client: PoolClient, moduleId: string): Promise<string> {
    const database = await getDatabaseByModuleId(client, moduleId);
    if (!database) throw new Error(`The ${moduleId} database was not seeded`);
    return database.id;
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

  /**
   * Uploads a recording as `POST /api/recordings` does, naming `eventId` as its `X-Event-Id`; returns
   * the Files item id. `bytes` defaults to the audio fixture; other bytes make another Files item.
   */
  function uploadRecording(tenantId: string, eventId: string | null, bytes: Buffer = audioFixture): Promise<string> {
    return runInTenant(tenantId, async () => {
      const filesDatabaseId = await withTransaction(runtime, (client) => requireDatabaseId(client, "files"));
      const uploaded = await ingestUploadedFileWithTransaction(
        runtime,
        {
          filesDatabaseId,
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

  /** Rejects when `promise` has not settled within five seconds, so a missed barrier fails instead of hanging. */
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Step 0 overlap barrier timed out")), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Starts step 0 for `fileItemId` on its own connection and holds its transaction open right after
   * its row-locking read of `eventId` returned. Resolves with that transaction's backend pid;
   * `commit` lets step 0 run on to its commit and waits for it.
   */
  async function holdStepZeroAtEventLock(
    fileItemId: string,
    eventId: string,
  ): Promise<{ workerPid: number; commit: () => Promise<void> }> {
    let release!: () => void;
    let signalLocked!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      signalLocked = resolve;
    });
    let held = false;
    const workerPool = new Proxy(runtime, {
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
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                const [sql, params] = args;
                if (
                  !held &&
                  typeof sql === "string" &&
                  sql.includes("FOR UPDATE") &&
                  Array.isArray(params) &&
                  params[1] === eventId
                ) {
                  held = true;
                  const pid = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                  if (!pid.rows[0]) throw new Error("Missing step 0 backend PID");
                  signalLocked(pid.rows[0].pid);
                  await gate;
                }
                return result;
              };
            },
          });
        };
      },
    });
    const worker = runInTenant(tenant, () => createTranscriptionCreateTask(workerPool)({ fileItemId }));
    const commit = async (): Promise<void> => {
      release();
      await worker;
    };
    try {
      const workerPid = await bounded(
        Promise.race([
          locked,
          worker.then(() => {
            throw new Error("Step 0 finished without a row-locking read of the Event");
          }),
        ]),
      );
      return { workerPid, commit };
    } catch (error) {
      release();
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

  /** Drains the queued jobs of the fast create lane; the pipeline lane's jobs stay queued. */
  async function runCreateLane(): Promise<void> {
    await runOnce({
      pgPool: pool,
      taskList: {
        [CORE_TASK_NAMES.TRANSCRIPTION_CREATE]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_CREATE,
          createTranscriptionCreateTask(runtime),
        ),
      },
    });
  }

  /** Drains the queued jobs of the pipeline lane, with the fake gateways in place of HTTP. */
  async function runPipelineLane(): Promise<void> {
    await runOnce({
      pgPool: pool,
      taskList: {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(runtime, blobStorage, gatewayClient, summaryClient),
        ),
      },
    });
  }

  /** The keys among `keys` that still have a queued job, read through graphile-worker's public `jobs` view. */
  async function queuedJobKeys(keys: string[]): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
      [keys],
    );
    return rows.map((row) => row.key);
  }

  /**
   * What step 0 and the pipeline left for the recording, read inside `tenantId`: the transcripts
   * created for the file with their status, the Events those transcripts are linked to, the
   * tenant's pairing cards (every Processing proposal that is not a speaker card) and the statuses
   * of its speaker cards.
   */
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

  /**
   * How many relation edges of any kind end at `itemId`, read inside `tenantId`. A live Event has one from
   * its create, to its calendar (issue #1761), so a test compares the count with the one it read before.
   */
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
    expect(await readRecording(tenant, fileItemId)).toEqual({
      statuses: ["processing"],
      eventIds: [eventId],
      pairingCards: [],
      speakerCards: [],
    });

    await runPipelineLane();

    expect(await queuedJobKeys([pipelineJobKey])).toEqual([]);
    expect(await readRecording(tenant, fileItemId)).toEqual({
      statuses: ["done"],
      eventIds: [eventId],
      pairingCards: [],
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
        const eventsDatabaseId = await withTransaction(runtime, (client) => requireDatabaseId(client, "events"));
        const chokePoint = createChokePoint(runtime);
        await chokePoint.softDeleteItem(eventsDatabaseId, eventId);
        if (eventState === "purged")
          expect(
            (await chokePoint.purgeExpiredTrashSubtree(eventId, new Date(Date.now() + 60_000))).purgedItemIds,
          ).toEqual([eventId]);
      });
      const edgesBefore = await countEdgesOf(tenant, eventId);

      await runCreateLane();

      expect(await queuedJobKeys([`transcription-create:${fileItemId}`])).toEqual([]);
      expect(await readRecording(tenant, fileItemId)).toEqual({
        statuses: ["processing"],
        eventIds: [],
        pairingCards: [],
        speakerCards: [],
      });
      expect(await countEdgesOf(tenant, eventId)).toBe(edgesBefore);

      await runPipelineLane();

      // No Event starts inside the recording's window, so the normal match proposes one on a card.
      expect(await readRecording(tenant, fileItemId)).toEqual({
        statuses: ["done"],
        eventIds: [],
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

    expect(await readRecording(tenant, fileItemId)).toEqual({
      statuses: ["processing"],
      eventIds: [eventId],
      pairingCards: [],
      speakerCards: [],
    });
    expect(await countEdgesOf(tenant, eventId)).toBe(edgesBefore + 1);
  });

  it("keeps a concurrent trash of the Event waiting until step 0 has committed its edge", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const eventsDatabaseId = await inTenant(tenant, (client) => requireDatabaseId(client, "events"));
    const stepZero = await holdStepZeroAtEventLock(fileItemId, eventId);
    let signalTrash!: (pid: number) => void;
    const trashStarted = new Promise<number>((resolve) => {
      signalTrash = resolve;
    });
    let trash: Promise<void> | undefined;
    const failures: unknown[] = [];
    try {
      trash = inTenant(tenant, async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (!pid.rows[0]) throw new Error("Missing trash backend PID");
        signalTrash(pid.rows[0].pid);
        await itemDeleteWithClient(client, eventsDatabaseId, eventId, { queueAffinity: createActionQueueAffinity() });
      });
      const trashPid = await bounded(
        Promise.race([
          trashStarted,
          trash.then(() => {
            throw new Error("The trash finished while step 0 held the Event");
          }),
        ]),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [stepZero.workerPid, trashPid],
        );
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      expect(await readEventTrashed(eventId)).toBe(false);
    } catch (error) {
      failures.push(error);
    }
    for (const pending of [stepZero.commit(), trash])
      if (pending) {
        try {
          await pending;
        } catch (error) {
          if (!failures.includes(error)) failures.push(error);
        }
      }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Step 0 and trash overlap or its cleanup failed");

    // The edge was written to a live Event; the trash that waited for it then went through.
    expect((await readRecording(tenant, fileItemId)).eventIds).toEqual([eventId]);
    expect(await readEventTrashed(eventId)).toBe(true);
  });

  it("answers a concurrent upload naming the same Event recording_busy while step 0 holds the Event, and accepts it afterwards", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const secondRecording = Buffer.from("a second recording of the same meeting");
    const stepZero = await holdStepZeroAtEventLock(fileItemId, eventId);
    const failures: unknown[] = [];
    try {
      await expect(uploadRecording(tenant, eventId, secondRecording)).rejects.toMatchObject({
        status: 409,
        code: "recording_busy",
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await stepZero.commit();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Step 0 and upload overlap or its cleanup failed");

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
      expect(await readRecording(tenant, fileItemId)).toEqual({
        statuses: ["processing"],
        eventIds: [],
        pairingCards: [],
        speakerCards: [],
      });
      expect(await countEdgesOf(foreign, foreignEventId)).toBe(foreignEdgesBefore);
      expect(await readRecording(foreign, fileItemId)).toEqual({
        statuses: [],
        eventIds: [],
        pairingCards: [],
        speakerCards: [],
      });
    },
  );

  it("runs this process's relation-edge hooks for the edge: the Event's search reindex is queued with it", async () => {
    const eventId = await createEvent(tenant);
    const fileItemId = await uploadRecording(tenant, eventId);
    const reindexKey = `item-search-reindex:item:${eventId}`;
    // The Event's create queued this job through its calendar edge (issue #1761). It is removed with
    // graphile-worker's public remove_job, so the job found below is the one step 0's edge queued.
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

      expect(await readRecording(tenant, fileItemId)).toEqual({
        statuses: [],
        eventIds: [],
        pairingCards: [],
        speakerCards: [],
      });
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
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
  let audioFixture: Buffer;
  let videoFixture: Buffer;
  let untaggedAudioFixture: Buffer;
  /** Where step 1 stores normalized audio: under the tenant in scope (sole tenant zero here). */
  let transcriptionsPrefix: string;

  beforeAll(async () => {
    [audioFixture, videoFixture, untaggedAudioFixture] = await Promise.all([
      generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME }),
      generateMp4Fixture({ withVideo: true, creationTime: FIXTURE_CREATION_TIME }),
      generateMp4Fixture(),
    ]);
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows: tenantRows } = await pool.query<{ tenant_id: string }>(
      "SELECT app_tenant_default()::text AS tenant_id",
    );
    transcriptionsPrefix = `${z.string().parse(tenantRows[0]?.tenant_id)}/transcriptions/`;
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function createSourceFile(mimeType: string, bytes: Buffer) {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(bytes));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType, byteSize: bytes.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return { files, file, blob };
  }

  function readSource(filesId: string, fileId: string): Promise<ItemRow | null> {
    return withTransaction(pool, (client) => getItemById(client, filesId, fileId));
  }

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

  /** `blobStorage`, except that `hook` runs as step 1 starts storing ffmpeg's output: after its read transaction, before its write transaction. */
  function storageWithMidNormalizationHook(hook: () => Promise<void>): BlobStorageWriter {
    return {
      writeStream: async (storageKey, source, options) => {
        if (storageKey.startsWith(transcriptionsPrefix)) await hook();
        return blobStorage.writeStream(storageKey, source, options);
      },
      delete: (storageKey) => blobStorage.delete(storageKey),
      readStream: (storageKey, range) => blobStorage.readStream(storageKey, range),
    };
  }

  it.each([
    ["audio", "audio/mp4", () => audioFixture],
    ["video with an audio track", "video/mp4", () => videoFixture],
  ])(
    "normalizes a %s input to 16 kHz mono Opus and checkpoints duration and creation_time",
    async (_label, mimeType, getBytes) => {
      const { files, file } = await createSourceFile(mimeType, getBytes());

      await createTranscriptionTask(
        pool,
        blobStorage,
        gatewayClient,
        summaryClient,
      )({ fileItemId: file.id }, FIRST_ATTEMPT);

      const source = await readSource(files.id, file.id);
      const prepare = prepareCheckpointSchema.parse(source?.computed.prepare);
      expect(prepare.durationSeconds).toBeGreaterThan(0.5);
      expect(prepare.durationSeconds).toBeLessThan(2);
      expect(prepare.creationTime).toBe("2024-03-01T12:00:00.000Z");

      const { rows: blobRows } = await pool.query<{ mime_type: string; storage_key: string }>(
        "SELECT mime_type, storage_key FROM blobs WHERE id = $1",
        [prepare.normalizedBlobId],
      );
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
    const { files, file } = await createSourceFile("audio/webm", await generateWebmFixture());

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    const source = await readSource(files.id, file.id);
    const prepare = prepareCheckpointSchema.parse(source?.computed.prepare);
    expect(prepare.durationSeconds).toBeGreaterThan(2.9);
    expect(prepare.durationSeconds).toBeLessThan(3.5);
  });

  it("falls back to the upload time for date when the recording has no creation_time", async () => {
    const { files, file, blob } = await createSourceFile("audio/mp4", untaggedAudioFixture);

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    const source = await readSource(files.id, file.id);
    expect(prepareCheckpointSchema.parse(source?.computed.prepare).creationTime).toBeNull();
    expect(await readTranscriptDate(source)).toBe(blob.createdAt);
  });

  it("skips step 1 on a replay without invoking ffmpeg/ffprobe again", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id }, FIRST_ATTEMPT);
    const beforeReplay = await readSource(files.id, file.id);
    expect(beforeReplay?.computed.prepare).toBeDefined();

    // Every blob byte on disk is gone: if step 1 ran ffmpeg/ffprobe again it would fail to read
    // the (now-missing) source file, so a clean replay proves the checkpoint skip actually fired.
    await rm(tmpBlobDir, { recursive: true, force: true });

    await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).resolves.toBeUndefined();
    const afterReplay = await readSource(files.id, file.id);
    expect(afterReplay?.computed.prepare).toEqual(beforeReplay?.computed.prepare);
  });

  it("holds no pooled connection, and so no transaction, while ffmpeg runs", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    let checkedOutDuringFfmpeg: number | undefined;
    const storage = storageWithMidNormalizationHook(async () => {
      checkedOutDuringFfmpeg = pool.totalCount - pool.idleCount;
    });

    await createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect(checkedOutDuringFfmpeg).toBe(0);
    expect((await readSource(files.id, file.id))?.computed.prepare).toBeDefined();
  });

  it("keeps the prepare read at repeatable read and guards the write at read committed without SET TRANSACTION", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const statements: string[] = [];
    async function connectAndRecord(): Promise<PoolClient> {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query")
            return (...args: unknown[]) => {
              const first = args[0];
              const parsed = z.object({ text: z.string() }).safeParse(first);
              const sql = typeof first === "string" ? first : parsed.success ? parsed.data.text : undefined;
              if (sql !== undefined) statements.push(sql);
              return Reflect.apply(target.query.bind(target), undefined, args);
            };
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    const recordingPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "connect") return connectAndRecord;
        return Reflect.get(target, prop, receiver);
      },
    });

    await createTranscriptionTask(
      recordingPool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    const firstSnapshot = statements.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const isolationGuard = statements.indexOf("SHOW transaction_isolation");
    expect(firstSnapshot).toBeGreaterThanOrEqual(0);
    expect(isolationGuard).toBeGreaterThan(firstSnapshot);
    expect(statements.slice(firstSnapshot + 1, isolationGuard).lastIndexOf("BEGIN")).toBeGreaterThanOrEqual(0);
    expect(statements.filter((text) => /SET\s+TRANSACTION/i.test(text))).toEqual([]);
    expect((await readSource(files.id, file.id))?.computed.prepare).toBeDefined();
  });

  it("reads an intake committed while prepare waits for an unchanged Files row", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let releaseIntake!: () => void;
    let signalIntake!: (state: { pid: number; file: ItemRow }) => void;
    let signalPrepare!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      releaseIntake = resolve;
    });
    const intakeReady = new Promise<{ pid: number; file: ItemRow }>((resolve) => {
      signalIntake = resolve;
    });
    const prepareReady = new Promise<number>((resolve) => {
      signalPrepare = resolve;
    });
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Prepare overlap barrier timed out")), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    let intake: Promise<void> | undefined;
    let observedPrepare = false;
    const workerPool = new Proxy(runtime, {
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
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                if (!observedPrepare && args[0] === "SHOW transaction_isolation") {
                  observedPrepare = true;
                  const pid = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                  if (!pid.rows[0]) throw new Error("Missing prepare backend PID");
                  signalPrepare(pid.rows[0].pid);
                }
                return result;
              };
            },
          });
        };
      },
    });
    const storage = storageWithMidNormalizationHook(async () => {
      if (intake) return;
      intake = runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, async (client) => {
          const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const before = await getItemById(client, files.id, file.id);
          await recordRecordingIntake(client, {
            fileItemId: file.id,
            eventId: null,
            recordedAt: "2026-01-01T10:00:00Z",
          });
          const current = await getItemById(client, files.id, file.id);
          if (!pid.rows[0] || !current || !before) throw new Error("Missing intake backend or Files row");
          expect(current).toEqual(before);
          signalIntake({ pid: pid.rows[0].pid, file: current });
          await gate;
        }),
      );
      await bounded(
        Promise.race([
          intakeReady,
          intake.then(() => {
            throw new Error("Intake exited early");
          }),
        ]),
      );
    });
    let worker: Promise<void> | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, (client) =>
          client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          ),
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      worker = runInTenant(getTenantZeroId(), () =>
        createTranscriptionTask(
          workerPool,
          storage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT),
      );
      const state = await bounded(
        Promise.race([
          intakeReady,
          worker.then(() => {
            throw new Error("Worker exited early");
          }),
        ]),
      );
      const workerPid = await bounded(
        Promise.race([
          prepareReady,
          worker.then(() => {
            throw new Error("Worker exited early");
          }),
        ]),
      );
      expect(workerPid).not.toBe(state.pid);
      const unchanged = await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, (client) => getItemById(client, files.id, file.id)),
      );
      expect(unchanged).toEqual(state.file);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [state.pid, workerPid],
        );
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      releaseIntake();
      if (!intake) throw new Error("Intake did not start");
      await intake;
      await worker;
      const source = await readSource(files.id, file.id);
      expect(source?.computed.prepare).toBeDefined();
      expect(new Date(String(await readTranscriptDate(source))).toISOString()).toBe("2026-01-01T10:00:00.000Z");
    } catch (error) {
      failures.push(error);
    }
    releaseIntake();
    for (const pending of [intake, worker])
      if (pending) {
        try {
          await pending;
        } catch (error) {
          if (!failures.includes(error)) failures.push(error);
        }
      }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Prepare overlap or cleanup failed");
  });

  it("rejects overlapping intake when prepare owns Files and keeps the committed prepare date", async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Missing Files database");
    const uploadInput = () => ({
      filesDatabaseId: files.id,
      filename: "recording.mp4",
      contentType: "audio/mp4",
      source: Readable.from(audioFixture),
      storageKeyPrefix: "files",
      maxBytes: 2_000_000,
      storage: blobStorage,
    });
    const file = (await inTenantZero(() => ingestUploadedFile(pool, uploadInput()))).item;
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let releasePrepare!: () => void;
    let prepareLocked!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      prepareLocked = resolve;
    });
    let inPrepareWrite = false;
    let held = false;
    const workerPool = new Proxy(runtime, {
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
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                if (sql === "SHOW transaction_isolation") inPrepareWrite = true;
                if (
                  inPrepareWrite &&
                  !held &&
                  sql.includes("FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE")
                ) {
                  held = true;
                  const pid = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
                  if (!pid.rows[0]) throw new Error("Missing prepare backend PID");
                  prepareLocked(pid.rows[0].pid);
                  await gate;
                }
                return result;
              };
            },
          });
        };
      },
    });
    let worker: Promise<void> | undefined;
    const failures: unknown[] = [];
    try {
      const role = await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, (client) =>
          client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          ),
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      worker = runInTenant(getTenantZeroId(), () =>
        createTranscriptionTask(
          workerPool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let holderPid: number;
      try {
        holderPid = await Promise.race([
          locked,
          worker.then(() => {
            throw new Error("Worker exited before prepare lock");
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Prepare overlap barrier timed out")), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      await runInTenant(getTenantZeroId(), async () => {
        const counts = () =>
          withTransaction(runtime, (client) =>
            client.query<{ files: string; blobs: string }>(
              "SELECT (SELECT count(*)::text FROM items WHERE database_id = $1) AS files, (SELECT count(*)::text FROM blobs) AS blobs",
              [files.id],
            ),
          );
        const before = await counts();
        await expect(
          ingestUploadedFileWithTransaction(runtime, uploadInput(), async (client, result) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            expect(pid.rows[0]?.pid).not.toBe(holderPid);
            expect(result.item.id).toBe(file.id);
            await recordRecordingIntake(client, {
              fileItemId: file.id,
              eventId: null,
              recordedAt: "2026-01-01T10:00:00Z",
            });
          }),
        ).rejects.toMatchObject({ status: 409, code: "recording_busy" });
        expect((await counts()).rows).toEqual(before.rows);
        expect(await withTransaction(runtime, (client) => readRecordingRequest(client, file.id))).toBeNull();
      });
      releasePrepare();
      await worker;
      const prepared = await readSource(files.id, file.id);
      const date = await readTranscriptDate(prepared);
      expect(prepared?.computed.prepare).toBeDefined();
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(runtime, (client) =>
          recordRecordingIntake(client, { fileItemId: file.id, eventId: null, recordedAt: "2026-01-01T10:00:00Z" }),
        ),
      );
      await runInTenant(getTenantZeroId(), () =>
        createTranscriptionTask(
          workerPool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT),
      );
      expect(await readTranscriptDate(await readSource(files.id, file.id))).toEqual(date);
    } catch (error) {
      failures.push(error);
    }
    releasePrepare();
    if (worker)
      try {
        await worker;
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Prepare-first overlap or cleanup failed");
  });

  it("writes nothing and discards its audio when the source's file is replaced while ffmpeg runs", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    let provisionalDate: unknown;
    const replacement = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: 1, storageKey: `source/${randomUUID()}` }),
    );
    const storage = storageWithMidNormalizationHook(async () => {
      provisionalDate = await readTranscriptDate(await readSource(files.id, file.id));
      expect(provisionalDate).toEqual(expect.any(String));
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: files.id,
          itemId: file.id,
          propertiesPatch: { file: { blobId: replacement.id } },
        }),
      );
    });

    await expect(
      createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError", code: "unknown" });

    const source = await readSource(files.id, file.id);
    expect(source?.computed).not.toHaveProperty("prepare");
    expect(await readTranscriptDate(source)).toEqual(provisionalDate);
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });

  it("keeps the checkpoint of a concurrent run that finished step 1 first and discards its own audio", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    // A real blob, so the later diarize/ASR steps (which now run unconditionally after step 1) have
    // something to download — simulating the concurrent run's own normalized output, not this run's.
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
        const source = await getItemById(client, files.id, file.id);
        const transcripts = await getDatabaseByModuleId(client, "transcripts");
        if (!transcripts) throw new Error("Transcripts database was not seeded");
        await updateItemWithClient(
          client,
          {
            databaseId: transcripts.id,
            itemId: z.string().parse(source?.computed.create),
            propertiesPatch: { date: concurrentDate },
          },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await writeComputed(client, files.id, file.id, "prepare", concurrentCheckpoint);
      });
    });

    await createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT);

    const source = await readSource(files.id, file.id);
    expect(source?.computed.prepare).toEqual(concurrentCheckpoint);
    expect(await readTranscriptDate(source)).toBe(concurrentDate);
    expect(await readNormalizedLeftovers()).toEqual({
      blobRows: 1,
      storedFiles: [concurrentStorageKey.slice(transcriptionsPrefix.length)],
    });
  });

  async function countTranscriptionBlobs(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM blobs WHERE storage_key LIKE $1", [
      `${transcriptionsPrefix}%`,
    ]);
    return Number(rows[0]?.count);
  }

  async function runPrepare(mimeType: string, bytes: Buffer) {
    const { files, file, blob } = await createSourceFile(mimeType, bytes);
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    const prepare = prepareCheckpointSchema.parse((await readSource(files.id, file.id))?.computed.prepare);
    return { prepare, blob };
  }

  it.each(["audio/mp4", "audio/mpeg", "audio/wav"])(
    "plays the original of a %s source and creates no playback blob",
    async (mimeType) => {
      const { prepare, blob } = await runPrepare(mimeType, audioFixture);

      expect(prepare.playbackBlobId).toBe(blob.id);
      // Only the normalized Opus copy is created next to the original.
      expect(await countTranscriptionBlobs()).toBe(1);
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
    const { rows } = await pool.query<{ mime_type: string; storage_key: string }>(
      "SELECT mime_type, storage_key FROM blobs WHERE id = $1",
      [prepare.playbackBlobId],
    );
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

    await expect(
      createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });

    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });

  it("rolls back and discards its audio when the write transaction fails", async () => {
    const { files, file } = await createSourceFile("audio/mp4", audioFixture);
    const storage = storageWithMidNormalizationHook(async () => {
      // A transcript deleted mid-normalization makes the write transaction's `date` patch fail.
      await pool.query(
        "UPDATE items SET deleted_at = now() WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')",
      );
    });

    // Issue #1582: a deleted transcript is a clean stop, not a failure.
    await createTranscriptionTask(pool, storage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect((await readSource(files.id, file.id))?.computed).not.toHaveProperty("prepare");
    expect(await readNormalizedLeftovers()).toEqual({ blobRows: 0, storedFiles: [] });
  });
});

const asrCheckpointSchema = z.object({
  language: z.string().nullable(),
  chunks: z.record(z.string(), z.object({ text: z.string(), segments: z.array(z.any()) })),
});

describe("transcription steps 2 and 3 (diarize, ASR)", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
  let audioFixture: Buffer;

  beforeAll(async () => {
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function createSourceFile(bytes: Buffer) {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(bytes));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: bytes.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return { files, file };
  }

  function readSource(filesId: string, fileId: string): Promise<ItemRow | null> {
    return withTransaction(pool, (client) => getItemById(client, filesId, fileId));
  }

  /**
   * Inflates step 1's checkpointed duration and clears steps 2/3's checkpoints, so a replay
   * exercises multiple ASR chunk boundaries against the fixture's real (sub-second) audio without
   * generating a 20+ minute fixture file: `ffmpeg -t` past the real file's end simply stops at EOF.
   */
  async function inflateDurationAndResetLaterSteps(fileId: string, durationSeconds: number): Promise<void> {
    await pool.query(
      `UPDATE items
       SET computed = jsonb_set(computed, '{prepare,durationSeconds}', to_jsonb($2::float8)) - 'diarize' - 'asr'
       WHERE id = $1`,
      [fileId, durationSeconds],
    );
  }

  it.each([
    [{ exact: 2 }, 2, null],
    [{ min: 3 }, null, 3],
    [undefined, null, null],
  ])("reads recording choices for diarization and first ASR chunk: %s", async (expected, exact, minimum) => {
    const { files, file } = await createSourceFile(audioFixture);
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        recordRecordingIntake(client, {
          fileItemId: file.id,
          eventId: null,
          recordedAt: null,
        }),
      ),
    );
    // The future confirmation writer is not in this batch; populate its bounded stored shape.
    const fixture = await inTenantZero(() =>
      pool.query(
        "UPDATE recording_requests SET language = $2, num_speakers_exact = $3, num_speakers_min = $4 WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
        [file.id, "cs", exact, minimum],
      ),
    );
    expect(fixture.rowCount).toBe(1);
    gatewayClient.transcribeResult = () => ({ text: "fixture", language: "en", segments: [] });
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
    await inTenantZero(() => task({ fileItemId: file.id }, FIRST_ATTEMPT));
    expect(gatewayClient.diarizeCalls[0]?.numSpeakers).toEqual(expected);
    expect(gatewayClient.transcribeCalls[0]?.language).toBe("cs");
    await inflateDurationAndResetLaterSteps(file.id, 25 * 60);
    await inTenantZero(() => task({ fileItemId: file.id }, FIRST_ATTEMPT));
    expect(gatewayClient.diarizeCalls[1]?.numSpeakers).toEqual(expected);
    expect(gatewayClient.transcribeCalls[1]?.language).toBe("cs");
    expect(gatewayClient.transcribeCalls[2]?.language).toBe("en");
    expect((await readSource(files.id, file.id))?.computed.diarize).toBeDefined();
  });

  it("diarizes the whole recording exactly once, checkpoints its turns, and also runs ASR", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    gatewayClient.diarizeResult = [{ speaker: "SPEAKER_00", start: 0, end: 1 }];

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.diarizeCalls[0]?.audioSeconds).toBeGreaterThan(0);
    expect(gatewayClient.transcribeCalls.length).toBeGreaterThan(0);
    const source = await readSource(files.id, file.id);
    expect(source?.computed.diarize).toEqual(gatewayClient.diarizeResult);
  });

  it("skips diarization on replay without calling the gateway again", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id }, FIRST_ATTEMPT);
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    const beforeReplay = await readSource(files.id, file.id);

    await task({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    const afterReplay = await readSource(files.id, file.id);
    expect(afterReplay?.computed.diarize).toEqual(beforeReplay?.computed.diarize);
  });

  it("splits ASR into one chunk per 20-minute boundary, checkpoints each immediately, and passes chunk 0's detected language to later chunks", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    await inflateDurationAndResetLaterSteps(file.id, 25 * 60);
    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    gatewayClient.transcribeResult = (request) => ({
      text: `chunk-${gatewayClient.transcribeCalls.length - 1}`,
      language: request.language ?? "cs",
      segments: [],
    });

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(2);
    expect(gatewayClient.transcribeCalls[0]?.language).toBeUndefined();
    expect(gatewayClient.transcribeCalls[1]?.language).toBe("cs");
    const source = await readSource(files.id, file.id);
    const asr = asrCheckpointSchema.parse(source?.computed.asr);
    expect(asr.language).toBe("cs");
    expect(Object.keys(asr.chunks)).toEqual(["0", "1"]);
    expect(asr.chunks["0"]?.text).toBe("chunk-0");
    expect(asr.chunks["1"]?.text).toBe("chunk-1");
  });

  it("resumes after a crash mid-ASR: the retried run repeats no already-checkpointed chunk and no diarize call", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    await inflateDurationAndResetLaterSteps(file.id, 25 * 60);
    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    let callCount = 0;
    gatewayClient.transcribeResult = () => {
      callCount += 1;
      if (callCount === 2) throw new Error("simulated crash");
      return { text: "chunk-0", language: "cs", segments: [] };
    };

    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });

    const midSource = await readSource(files.id, file.id);
    expect(Object.keys(asrCheckpointSchema.parse(midSource?.computed.asr).chunks)).toEqual(["0"]);

    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];
    gatewayClient.transcribeResult = (request) => ({
      text: "chunk-1",
      language: request.language ?? "cs",
      segments: [],
    });

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect(gatewayClient.diarizeCalls).toHaveLength(0);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls[0]?.language).toBe("cs");
    const finalSource = await readSource(files.id, file.id);
    const asr = asrCheckpointSchema.parse(finalSource?.computed.asr);
    expect(Object.keys(asr.chunks)).toEqual(["0", "1"]);
  });

  async function readTranscriptStatus(fileId: string): Promise<{ id: string; status: unknown }> {
    const { rows } = await pool.query<{ id: string; status: unknown }>(
      `SELECT t.id, t.properties->>'status' AS status FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
       WHERE f.id = $1`,
      [fileId],
    );
    const row = rows[0];
    if (!row) throw new Error("expected a transcript for the file");
    return row;
  }

  async function readAutomation(transcriptId: string) {
    const { rows } = await pool.query<{ status: string; error: string | null; attempts: number }>(
      "SELECT status, error, attempts FROM item_automation WHERE item_id = $1",
      [transcriptId],
    );
    const row = rows[0];
    if (!row) throw new Error("expected an item_automation row");
    return row;
  }

  async function readQueuedJobAttempts(fileId: string): Promise<Array<{ attempts: number }>> {
    const { rows } = await pool.query<{ attempts: number }>(
      "SELECT attempts FROM graphile_worker.jobs WHERE key = $1",
      [`transcription-job:${fileId}`],
    );
    return rows;
  }

  it("stops at the next ASR checkpoint when shutdown is requested and re-enqueues itself", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    await inflateDurationAndResetLaterSteps(file.id, 45 * 60);
    gatewayClient.diarizeCalls = [];
    gatewayClient.transcribeCalls = [];

    const controller = new AbortController();
    gatewayClient.transcribeResult = (request) => {
      const index = gatewayClient.transcribeCalls.length - 1;
      if (index === 0) controller.abort();
      return { text: `chunk-${index}`, language: request.language ?? "cs", segments: [] };
    };

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, { job: { attempts: 1, max_attempts: 3 }, abortSignal: controller.signal });

    expect(gatewayClient.transcribeCalls).toHaveLength(1);
    const midSource = await readSource(files.id, file.id);
    expect(Object.keys(asrCheckpointSchema.parse(midSource?.computed.asr).chunks)).toEqual(["0"]);

    expect(await readQueuedJobAttempts(file.id)).toEqual([{ attempts: 0 }]);

    // The recording already finalized once before duration/checkpoints were reset for this test
    // (`inflateDurationAndResetLaterSteps` needs step 1's checkpoint), so `properties.status` still
    // reads its prior "done" — only `item_automation`, re-opened by this attempt, shows the
    // interruption left nothing failed.
    const transcript = await readTranscriptStatus(file.id);
    const automation = await readAutomation(transcript.id);
    expect(automation.status).toBe("pending");
    expect(automation.error).toBeNull();

    gatewayClient.transcribeCalls = [];
    gatewayClient.transcribeResult = (request) => {
      const index = gatewayClient.transcribeCalls.length - 1;
      return { text: `chunk-${index + 1}`, language: request.language ?? "cs", segments: [] };
    };

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, { job: { attempts: 2, max_attempts: 3 } });

    expect(gatewayClient.transcribeCalls).toHaveLength(2);
    const finalSource = await readSource(files.id, file.id);
    expect(Object.keys(asrCheckpointSchema.parse(finalSource?.computed.asr).chunks)).toEqual(["0", "1", "2"]);
    expect((await readTranscriptStatus(file.id)).status).toBe("done");
  });

  it("stops between steps when shutdown is requested", async () => {
    const { files, file } = await createSourceFile(audioFixture);
    const controller = new AbortController();
    gatewayClient.transcribeResult = () => {
      controller.abort();
      return { text: "chunk-0", language: "cs", segments: [] };
    };

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, { job: { attempts: 1, max_attempts: 3 }, abortSignal: controller.signal });

    expect(summaryClient.calls).toHaveLength(0);
    expect(await readQueuedJobAttempts(file.id)).toEqual([{ attempts: 0 }]);
    const transcript = await readTranscriptStatus(file.id);
    expect(transcript.status).toBe("processing");
    const automation = await readAutomation(transcript.id);
    expect(automation.status).toBe("pending");
    expect(automation.error).toBeNull();
    const source = await readSource(files.id, file.id);
    expect(source?.computed.asr).toBeDefined();
    const { rows: transcriptRows } = await pool.query<Record<string, unknown>>(
      "SELECT computed FROM items WHERE id = $1",
      [transcript.id],
    );
    expect(
      z.object({ computed: z.record(z.string(), z.unknown()) }).parse(transcriptRows[0]).computed.segments,
    ).toBeUndefined();
  });
});

const transcriptOutputSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()),
});

describe("transcription steps 4-8 (merge, summarize, match, suggest speakers, finalize)", () => {
  let tmpBlobDir: string;
  let blobStorage: LocalFsBlobStorageWriter;
  let gatewayClient: FakeAudioGatewayClient;
  let audioFixture: Buffer;

  beforeAll(async () => {
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    gatewayClient = new FakeAudioGatewayClient();
    summaryClient = new FakeSummaryClient();
    gatewayClient.diarizeResult = [
      { speaker: "SPEAKER_00", start: 0, end: 0.5 },
      { speaker: "SPEAKER_01", start: 0.5, end: 1 },
    ];
    gatewayClient.transcribeResult = () => ({
      text: "Hello. Hi there.",
      language: "en",
      segments: [
        { start: 0, end: 0.4, text: " Hello." },
        { start: 0.6, end: 0.9, text: " Hi there." },
      ],
    });
  });

  afterEach(async () => {
    await rm(tmpBlobDir, { recursive: true, force: true });
  });

  async function createSourceFile() {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    if (!files) throw new Error("Files database was not seeded");
    const storageKey = `source/${randomUUID()}`;
    await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
    const blob = await withTransaction(pool, (client) =>
      createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
    );
    const file = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: files.id,
        properties: { name: "recording", file: { blobId: blob.id } },
      }),
    );
    return { files, file };
  }

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

  async function readAutomationStatus(transcriptId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM item_automation WHERE item_id = $1", [
      transcriptId,
    ]);
    return rows[0]?.status;
  }

  it("merges into speaker segments with the language, summarizes, and finalizes done with item_automation done", async () => {
    const announced: string[] = [];
    setInvalidationHook((event) => {
      if (event.scope === "item" && event.itemId) announced.push(event.itemId);
    });
    const { file } = await createSourceFile();

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    const transcript = await readTranscript(file.id);
    expect(transcript.computed.segments).toEqual([
      { speaker: "SPEAKER_00", text: "Hello.", startsAt: 0, endsAt: 0.4 },
      { speaker: "SPEAKER_01", text: "Hi there.", startsAt: 0.6, endsAt: 0.9 },
    ]);
    expect(transcript.computed.language).toBe("en");
    expect(transcript.computed.durationSeconds).toBeGreaterThan(0);
    expect(announced).toContain(transcript.id);
    expect(transcript.computed.finalizedAt).toEqual(expect.stringMatching(/Z$/));
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    expect((await readTranscript(file.id)).computed).toEqual(transcript.computed);
    // Issue #1695: the finished transcript has every notes field; no action items is [].
    expect(transcript.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
    expect(transcript.computed).not.toHaveProperty("summaryByInstruction");
    expect(transcript.properties.status).toBe("done");
    expect(await readAutomationStatus(transcript.id)).toBe("done");

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
    const diarizeFailure = new Error("simulated diarize failure");
    const failingGateway = new FakeAudioGatewayClient();
    failingGateway.diarize = async () => {
      throw diarizeFailure;
    };
    await expect(
      createTranscriptionTask(pool, blobStorage, failingGateway, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });
    // 25 minutes: chunk 0 = [0, 1200], chunk 1 = [1170, 1500], cut at 1185.
    await pool.query(
      `UPDATE items SET computed = jsonb_set(computed, '{prepare,durationSeconds}', to_jsonb(1500::float8)) WHERE id = $1`,
      [file.id],
    );
    gatewayClient.transcribeResult = (request) =>
      request.filename === "chunk-0.opus"
        ? {
            text: "",
            language: "cs",
            segments: [
              { start: 1175, end: 1180, text: "early in band" },
              { start: 1188, end: 1196, text: "late in band (chunk 0 copy)" },
            ],
          }
        : {
            text: "",
            language: "cs",
            segments: [
              { start: 5, end: 10, text: "early in band (chunk 1 copy)" },
              { start: 18, end: 26, text: "late in band" },
            ],
          };

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

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

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect((await readTranscript(file.id)).computed.meetingNotes).toEqual({
      ...FAKE_NOTES,
      actionItems: [
        { text: "{SPEAKER_01} sends the pricing", ownerSpeaker: "SPEAKER_01", due: null, startsAt: 0.6 },
        { text: "Book the room", ownerSpeaker: null, due: "2026-10-17", startsAt: null },
      ],
    });
  });

  it("stores the notes once, and an earlier summaryByInstruction stays as it was", async () => {
    const { file } = await createSourceFile();
    summaryClient.failure = new Error("simulated gateway failure");
    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError" });
    const halfway = await readTranscript(file.id);
    expect(halfway.computed).not.toHaveProperty("meetingNotes");
    // A summary only the pipeline before issue #1695 wrote; no current writer produces this key.
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!transcripts) throw new Error("Transcripts database was not seeded");
    const legacy = { meetingSummary: "Summary written before structured notes." };
    await withTransaction(pool, (client) =>
      writeComputed(client, transcripts.id, halfway.id, "summaryByInstruction", legacy),
    );
    summaryClient.failure = null;

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    const done = await readTranscript(file.id);
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect(done.properties.status).toBe("done");
    expect(done.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
    expect(done.computed.summaryByInstruction).toEqual(legacy);
    expect((await readTranscript(file.id)).computed).toEqual(done.computed);
    // One failed and one successful notes call; the rerun of the done row pays nothing.
    expect(summaryClient.notesCalls()).toHaveLength(2);
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
  });

  it("leaves the row processing when the summary fails, then finalizes on retry without repeating a paid call", async () => {
    const { file } = await createSourceFile();
    const summaryFailure = new Error("simulated gateway failure");
    summaryClient.failure = summaryFailure;

    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });

    const failed = await readTranscript(file.id);
    expect(failed.computed.segments).toHaveLength(2);
    expect(failed.computed).not.toHaveProperty("meetingNotes");
    expect(failed.properties.status).toBe("processing");
    expect(await readAutomationStatus(failed.id)).toBe("pending");

    summaryClient.failure = null;
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    const finalized = await readTranscript(file.id);
    expect(finalized.computed.segments).toEqual(failed.computed.segments);
    expect(finalized.properties.status).toBe("done");
    expect(await readAutomationStatus(finalized.id)).toBe("done");
    expect(gatewayClient.diarizeCalls).toHaveLength(1);
    expect(gatewayClient.transcribeCalls).toHaveLength(1);
    expect(summaryClient.calls).toHaveLength(2);
  });

  /**
   * Fault/transform injection (R1 P1, parent D5): strips `meetingNotes` from every write to exactly one
   * transcript row, so the real pipeline reaches finalize without stored notes, which no production
   * input can arrange. The id reaches the trigger's WHEN clause as a literal quoted by Postgres
   * (`format('%L')` in a DO block, read from a session setting). Cleanup runs after `run` settled, on
   * the same dedicated client; a failed cleanup discards that client and is reported with any primary
   * failure.
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

  it("does not finish a transcript whose meeting notes are missing at finalize, and finishes once they are stored (R1 P1)", async () => {
    const { file } = await createSourceFile();
    // A first attempt fails in the summary step, so the transcript row exists for the fault below.
    summaryClient.failure = new Error("simulated gateway failure");
    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError" });
    summaryClient.failure = null;
    const transcript = await readTranscript(file.id);

    await withMeetingNotesStripped(transcript.id, async () => {
      await expect(
        createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT),
      ).rejects.toMatchObject({ name: "TranscriptionQueueError" });
    });
    const unfinished = await readTranscript(file.id);
    expect(unfinished.computed).not.toHaveProperty("meetingNotes");
    expect(unfinished.properties.status).toBe("processing");
    expect(await readAutomationStatus(unfinished.id)).toBe("pending");
    // The finalize guard, not an earlier step, refused the attempt.
    const failure = await pool.query<{ error: string | null }>("SELECT error FROM item_automation WHERE item_id = $1", [
      unfinished.id,
    ]);
    expect(failure.rows[0]?.error).toContain("has no 'meetingNotes' yet");
    expect(summaryClient.notesCalls()).toHaveLength(2);

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    const finished = await readTranscript(file.id);
    expect(finished.properties.status).toBe("done");
    expect(finished.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
    expect(summaryClient.notesCalls()).toHaveLength(3);
  });

  it("keeps the notes a concurrent run stored between the paid call and the locked write (R1 P1)", async () => {
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
    class InterleavingSummaryClient extends FakeSummaryClient {
      override async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
        if (input.operation === "transcript_summary" && concurrentRuns === 0) {
          concurrentRuns++;
          await createTranscriptionTask(
            pool,
            blobStorage,
            gatewayClient,
            concurrentClient,
          )({ fileItemId: file.id }, FIRST_ATTEMPT);
        }
        return super.complete(input);
      }
    }
    const interleaving = new InterleavingSummaryClient();

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      interleaving,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    const done = await readTranscript(file.id);
    expect(concurrentRuns).toBe(1);
    expect(interleaving.notesCalls()).toHaveLength(1);
    expect(done.computed.meetingNotes).toEqual(competitor);
    expect(done.properties.status).toBe("done");
    expect(await readAutomationStatus(done.id)).toBe("done");
  });

  it("never rewrites merged segments or their speaker keys on a replay", async () => {
    const { file } = await createSourceFile();
    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);
    const before = await readTranscript(file.id);
    await pool.query(
      `UPDATE items SET computed = jsonb_set(computed, '{diarize}', '[{"speaker":"SPEAKER_09","start":0,"end":1}]')
       WHERE id = $1`,
      [file.id],
    );

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect((await readTranscript(file.id)).computed.segments).toEqual(before.computed.segments);
  });

  it("stores empty notes for a transcript with no speech without a gateway call", async () => {
    const { file } = await createSourceFile();
    gatewayClient.transcribeResult = () => ({ text: "", language: null, segments: [] });

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

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

  async function createEvent(date: string): Promise<string> {
    const events = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "events"));
    if (!events) throw new Error("Events database was not seeded");
    const event = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: events.id, properties: { name: "Sync", type: "meeting", date } }),
    );
    return event.id;
  }

  it("links the one Event in the recording's window before finalizing, and a rerun adds nothing", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id }, FIRST_ATTEMPT);
    await task({ fileItemId: file.id }, FIRST_ATTEMPT);

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    expect(await readMatch(transcript.id)).toEqual({ eventIds: [eventId], cards: [] });
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

  async function assertTranscriptionsSettled(runtime: Pool, fileIds: string[], jobIds: string[]): Promise<void> {
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
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
        "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
      const task = registerTask(
        CORE_TASK_NAMES.TRANSCRIPTION_JOB,
        createTranscriptionTask(runtime, blobStorage, gatewayClient, summaryClient),
      );
      await inTenantZero(async () => {
        await enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: first.file.id });
        await enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: second.file.id });
      });
      const fileIds = [first.file.id, second.file.id];
      const jobIds = await ownedTranscriptionJobs(fileIds);
      expect(jobIds).toHaveLength(2);
      await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: task } });
      await assertTranscriptionsSettled(runtime, fileIds, jobIds);
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
            [[first.file.id, second.file.id]],
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
      expect(new Set(result.rows.map((row) => row.file_id))).toEqual(new Set([first.file.id, second.file.id]));
      expect(new Set(result.rows.map((row) => row.transcript_id)).size).toBe(2);
      expect(result.rows.map((row) => row.event_id)).toEqual([eventId, eventId]);
      expect(result.cards).toEqual([{ n: 0 }]);
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Transcription worker test or cleanup failed");
  });

  it("creates one transcript card when no Event matches, and a rerun converges on it", async () => {
    const { files, file } = await createSourceFile();
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id }, FIRST_ATTEMPT);
    const source = await withTransaction(pool, (client) => getItemById(client, files.id, file.id));
    expect(source?.computed.suggestSpeakers).toBeDefined();
    await task({ fileItemId: file.id }, FIRST_ATTEMPT);

    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
    const match = await readMatch(transcript.id);
    expect(match.eventIds).toEqual([]);
    expect(match.cards).toEqual([{ id: expect.any(String), kind: "transcript" }]);
    // No linked Event, so no participants to suggest speakers from: nothing is asked.
    expect(summaryClient.calls.map((call) => call.operation)).toEqual(["transcript_summary"]);
    expect(await readSpeakerCards()).toEqual([
      { proposal: null, status: "needsClarification" },
      { proposal: null, status: "needsClarification" },
    ]);
  });

  async function createParticipant(eventId: string, name: string): Promise<string> {
    const { person, peoplePropertyId } = await withTransaction(pool, async (client) => {
      const people = await getDatabaseByModuleId(client, "people");
      const events = await getDatabaseByModuleId(client, "events");
      if (!people || !events) throw new Error("People/Events databases were not seeded");
      const created = await createItemWithClient(client, { databaseId: people.id, properties: { name } });
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
        [events.id],
      );
      if (!rows[0]) throw new Error("Events 'people' property was not seeded");
      return { person: created, peoplePropertyId: rows[0].id };
    });
    // An Events `people` edge is a link-rule source (issue #1697): its write queues a propagation job, which
    // needs a tenant scope.
    await inTenantZero(() =>
      createChokePoint(pool).createRelation({
        relationPropertyId: peoplePropertyId,
        callerItemId: eventId,
        targetItemId: person.id,
      }),
    );
    return person.id;
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
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const aliceId = await createParticipant(eventId, "Alice");
    await createParticipant(eventId, "Bob");
    summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];
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
    const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

    await task({ fileItemId: file.id }, FIRST_ATTEMPT);
    await task({ fileItemId: file.id }, FIRST_ATTEMPT);

    const suggestionCalls = summaryClient.calls.filter((call) => call.operation === "transcript_speaker_suggestion");
    expect(suggestionCalls).toHaveLength(1);
    expect(suggestionCalls[0]).toMatchObject({ projectItemId: null });
    const content = suggestionCalls[0]?.messages[0]?.content ?? "";
    expect(content).toContain(`${aliceId}: Alice`);
    expect(content).toContain(privateText);
    expect(content).toContain("SPEAKER_00\nSPEAKER_01");
    expect(await readSpeakerCards()).toEqual(
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
    expect(await readSpeakerCards()).toHaveLength(2);
    expect(await countSpeakerEdges()).toBe(0);
    expect(observedLogs.chunks.join("")).not.toContain(privateText);
    const transcript = await readTranscript(file.id);
    expect(transcript.properties.status).toBe("done");
  });

  it("the queued runtime worker stores aiProposal and version on Event and speaker cards", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const failures: unknown[] = [];
    try {
      const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
        "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
      const first = await createSourceFile();
      const task = registerTask(
        CORE_TASK_NAMES.TRANSCRIPTION_JOB,
        createTranscriptionTask(runtime, blobStorage, gatewayClient, summaryClient),
      );
      await inTenantZero(() => enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: first.file.id }));
      const firstJobs = await ownedTranscriptionJobs([first.file.id]);
      expect(firstJobs).toHaveLength(1);
      await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: task } });
      await assertTranscriptionsSettled(runtime, [first.file.id], firstJobs);
      const eventId = await createEvent(FIXTURE_CREATION_TIME);
      const aliceId = await createParticipant(eventId, "Alice");
      summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];
      const second = await createSourceFile();
      await inTenantZero(() => enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: second.file.id }));
      const secondJobs = await ownedTranscriptionJobs([second.file.id]);
      expect(secondJobs).toHaveLength(1);
      await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: task } });
      await assertTranscriptionsSettled(runtime, [second.file.id], secondJobs);
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
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Worker card test or cleanup failed");
  });

  it("leaves the row processing when the speaker suggestion fails, then suggests on retry", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const aliceId = await createParticipant(eventId, "Alice");
    summaryClient.speakerMappings = [{ speaker: "SPEAKER_00", personId: aliceId, reason: "Named." }];
    const failing: AiGatewayClientPort = {
      complete: (input) =>
        input.operation === "transcript_speaker_suggestion"
          ? Promise.reject(new Error("gateway refused"))
          : summaryClient.complete(input),
    };

    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, failing)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });
    expect((await readTranscript(file.id)).properties.status).toBe("processing");
    expect(await readSpeakerCards()).toEqual([]);

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    expect((await readTranscript(file.id)).properties.status).toBe("done");
    expect(await readSpeakerCards()).toHaveLength(2);
  });

  it("makes no second paid notes call when a retry follows a failure after the notes were stored", async () => {
    const { file } = await createSourceFile();
    const eventId = await createEvent(FIXTURE_CREATION_TIME);
    const aliceId = await createParticipant(eventId, "Alice");
    summaryClient.speakerMappings = [{ speaker: "SPEAKER_00", personId: aliceId, reason: "Named." }];
    // Step 7 fails after step 5 committed the notes, so finalize is never reached on the first run.
    const failing: AiGatewayClientPort = {
      complete: (input) =>
        input.operation === "transcript_speaker_suggestion"
          ? Promise.reject(new Error("gateway refused"))
          : summaryClient.complete(input),
    };
    await expect(
      createTranscriptionTask(pool, blobStorage, gatewayClient, failing)({ fileItemId: file.id }, FIRST_ATTEMPT),
    ).rejects.toMatchObject({ name: "TranscriptionQueueError" });
    const stored = await readTranscript(file.id);
    expect(stored.properties.status).toBe("processing");
    expect(stored.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
    expect(summaryClient.notesCalls()).toHaveLength(1);

    await createTranscriptionTask(
      pool,
      blobStorage,
      gatewayClient,
      summaryClient,
    )({ fileItemId: file.id }, FIRST_ATTEMPT);

    const finished = await readTranscript(file.id);
    expect(finished.properties.status).toBe("done");
    expect(finished.computed.meetingNotes).toEqual(stored.computed.meetingNotes);
    expect(summaryClient.notesCalls()).toHaveLength(1);
  });

  it("publishes each output write and the done transition on the generic realtime channel", async () => {
    const { file } = await createSourceFile();
    wireRealtimeHooks(pool);
    const listenClient = await pool.connect();
    const received: unknown[] = [];
    try {
      await listenClient.query("LISTEN semprec_events");
      listenClient.on("notification", (message) => {
        const envelope = z
          .object({ tenantId: z.string().uuid(), message: z.unknown() })
          .parse(JSON.parse(message.payload ?? "null"));
        received.push(envelope.message);
      });

      await createTranscriptionTask(
        pool,
        blobStorage,
        gatewayClient,
        summaryClient,
      )({ fileItemId: file.id }, FIRST_ATTEMPT);
      const transcript = await readTranscript(file.id);
      const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));

      // Step 1 (date), prepare's durationSeconds (issue #1469), step 4 (segments, then language), step 5 (summary),
      // finalize's finalizedAt (issue #1469) and step 8 (status done).
      await vi.waitFor(() => {
        const updates = received.filter(
          (message) =>
            z
              .object({ type: z.literal("invalidation"), scope: z.literal("item"), op: z.literal("update") })
              .safeParse(message).success &&
            z.object({ itemId: z.literal(transcript.id), databaseId: z.literal(transcripts?.id) }).safeParse(message)
              .success,
        );
        expect(updates).toHaveLength(7);
      });
    } finally {
      listenClient.release(true);
      resetRealtimeHooks();
    }
  });

  describe("retries and permanent failures (issue #248)", () => {
    const FINAL_ATTEMPT = { job: { attempts: 3, max_attempts: 3 } };

    async function createUser(): Promise<string> {
      return (await createTenantZeroUser(pool, `owner-${randomUUID()}@example.test`)).id;
    }

    async function readAutomation(transcriptId: string) {
      const { rows } = await pool.query<{ status: string; error: string | null; attempts: number }>(
        "SELECT status, error, attempts FROM item_automation WHERE item_id = $1",
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

    it("records a transient failure as pending, then resumes from the checkpoints and settles done", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const failure = new Error("simulated summary outage");
      summaryClient.failure = failure;
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

      await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).rejects.toMatchObject({
        name: "TranscriptionQueueError",
        message: "Transcription task failed",
      });

      const failed = await readTranscript(file.id);
      expect(failed.properties.status).toBe("processing");
      expect(await readAutomation(failed.id)).toEqual({ status: "pending", error: failure.message, attempts: 1 });
      expect(await readNotifications(failed.id)).toEqual([]);

      summaryClient.failure = null;
      await task({ fileItemId: file.id }, { job: { attempts: 2, max_attempts: 3 } });

      const done = await readTranscript(file.id);
      expect(done.properties.status).toBe("done");
      expect(await readAutomation(done.id)).toEqual({ status: "done", error: null, attempts: 2 });
      expect(await readNotifications(done.id)).toEqual([]);
      expect(gatewayClient.diarizeCalls).toHaveLength(1);
      expect(gatewayClient.transcribeCalls).toHaveLength(1);
      expect(summaryClient.calls).toHaveLength(2);
    });

    it("records the last attempt's failure as permanent, with exactly one automation_error notification", async () => {
      const { file } = await createSourceFile();
      const userId = await createUser();
      const failure = new Error("simulated summary outage");
      summaryClient.failure = failure;
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

      for (const attempts of [1, 2, 3]) {
        await expect(task({ fileItemId: file.id }, { job: { attempts, max_attempts: 3 } })).rejects.toMatchObject({
          name: "TranscriptionQueueError",
          message: "Transcription task failed",
        });
      }

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
      expect(gatewayClient.diarizeCalls).toHaveLength(1);
      expect(gatewayClient.transcribeCalls).toHaveLength(1);
    });

    it("deduplicates a replayed failure transition and emits a later distinct transition", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new Error("Replay fixture failure");
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
      const events: string[] = [];
      setNotificationCreatedHook((event) => {
        events.push(event.notificationId);
      });
      try {
        await expect(task({ fileItemId: file.id }, FINAL_ATTEMPT)).rejects.toMatchObject({
          name: "TranscriptionQueueError",
        });
        const transcript = await readTranscript(file.id);
        const rows = await pool.query<{ id: string; transition_instance: string }>(
          "SELECT id, transition_instance FROM notifications WHERE source_id = $1 AND kind = 'automation_error' ORDER BY transition_instance",
          [transcript.id],
        );
        expect(rows.rows).toHaveLength(1);
        const first = rows.rows[0]!;
        const job = await pool.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [
          `notification-fanout:${first.id}`,
        ]);
        expect(job.rows).toHaveLength(1);
        expect(events).toEqual([first.id]);
        // Restore the pre-attempt counter to replay this exact transition identity through the task.
        await pool.query("UPDATE item_automation SET attempts = 0 WHERE item_id = $1", [transcript.id]);
        await expect(task({ fileItemId: file.id }, FINAL_ATTEMPT)).rejects.toMatchObject({
          name: "TranscriptionQueueError",
        });
        expect(
          (
            await pool.query(
              "SELECT id, transition_instance FROM notifications WHERE source_id = $1 AND kind = 'automation_error'",
              [transcript.id],
            )
          ).rows,
        ).toEqual([first]);
        expect(
          (await pool.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [`notification-fanout:${first.id}`]))
            .rows,
        ).toEqual(job.rows);
        expect(events).toEqual([first.id]);
        await expect(task({ fileItemId: file.id }, FINAL_ATTEMPT)).rejects.toMatchObject({
          name: "TranscriptionQueueError",
        });
        expect(await readNotifications(transcript.id)).toHaveLength(2);
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
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);

      await task({ fileItemId: file.id }, FINAL_ATTEMPT).catch(() => undefined);

      const transcript = await readTranscript(file.id);
      const { rows } = await pool.query<{ status: string; error_code: string | null }>(
        "SELECT status, error_code FROM item_automation WHERE item_id = $1",
        [transcript.id],
      );
      expect(rows).toEqual([{ status: "error", error_code: code }]);
      const notifications = await pool.query("SELECT to_jsonb(n) AS row FROM notifications n WHERE source_id = $1", [
        transcript.id,
      ]);
      expect(notifications.rows).toHaveLength(1);
      expect(JSON.stringify(notifications.rows)).not.toContain("secret transcript text");
    });

    it("clears the error code together with the error when a retry succeeds", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new AiGatewayFailedError("http");
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
      await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).rejects.toMatchObject({
        name: "TranscriptionQueueError",
        message: "Transcription task failed",
      });
      const transcript = await readTranscript(file.id);
      const readCode = async () =>
        (
          await pool.query<{ error_code: string | null; error: string | null }>(
            "SELECT error, error_code FROM item_automation WHERE item_id = $1",
            [transcript.id],
          )
        ).rows[0];
      expect((await readCode())?.error_code).toBe("providerFailed");

      summaryClient.failure = null;
      await task({ fileItemId: file.id }, { job: { attempts: 2, max_attempts: 3 } });

      expect(await readCode()).toEqual({ error: null, error_code: null });
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
        const failure = new Error("simulated summary outage");
        summaryClient.failure = failure;
        const task = createTranscriptionTask(runtimePool, blobStorage, gatewayClient, summaryClient);

        const fileId = await runInTenant(tenantB, async () => {
          await seedSystem(runtimePool, createViewTypeRegistry());
          const files = await withTransaction(runtimePool, (client) => getDatabaseByModuleId(client, "files"));
          if (!files) throw new Error("Files database was not seeded");
          const storageKey = `source/${randomUUID()}`;
          await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
          const blob = await withTransaction(runtimePool, (client) =>
            createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
          );
          const file = await withTransaction(runtimePool, (client) =>
            createItemWithClient(client, {
              databaseId: files.id,
              properties: { name: "recording", file: { blobId: blob.id } },
            }),
          );
          return file.id;
        });

        for (const attempts of [1, 2, 3]) {
          await expect(
            runInTenant(tenantB, () => task({ fileItemId: fileId }, { job: { attempts, max_attempts: 3 } })),
          ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });
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

    it("treats a gateway budget rejection as permanent on any attempt and completes the job instead of retrying", async () => {
      await createUser();
      const speech = gatewayClient.transcribeResult;
      const rejections: Array<() => void> = [
        () => {
          gatewayClient.transcribeResult = () => {
            throw new AudioGatewayBudgetExceededError();
          };
          summaryClient.failure = null;
        },
        () => {
          gatewayClient.transcribeResult = speech;
          summaryClient.failure = new AiGatewayFailedError("budget_exceeded");
        },
      ];

      for (const reject of rejections) {
        const { file } = await createSourceFile();
        reject();

        await expect(
          createTranscriptionTask(
            pool,
            blobStorage,
            gatewayClient,
            summaryClient,
          )({ fileItemId: file.id }, FIRST_ATTEMPT),
        ).resolves.toBeUndefined();

        const transcript = await readTranscript(file.id);
        expect(transcript.properties.status).toBe("error");
        expect(await readAutomation(transcript.id)).toMatchObject({ status: "error", attempts: 1 });
        expect(await readNotifications(transcript.id)).toHaveLength(1);
      }
    });

    it("commits none of a permanent failure's writes when its transaction rolls back, and returns a safe failure", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const failure = new Error("simulated summary outage");
      summaryClient.failure = failure;
      await pool.query(`CREATE FUNCTION test_reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated notification failure'; END $$`);
      await pool.query(`CREATE TRIGGER test_reject_notification BEFORE INSERT ON notifications
        FOR EACH ROW EXECUTE FUNCTION test_reject_notification()`);
      try {
        await expect(
          createTranscriptionTask(
            pool,
            blobStorage,
            gatewayClient,
            summaryClient,
          )({ fileItemId: file.id }, FINAL_ATTEMPT),
        ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });
      } finally {
        await pool.query("DROP TRIGGER test_reject_notification ON notifications");
        await pool.query("DROP FUNCTION test_reject_notification()");
      }

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("processing");
      expect(await readAutomation(transcript.id)).toEqual({ status: "pending", error: null, attempts: 1 });
      expect(await readNotifications(transcript.id)).toEqual([]);
    });

    it("still records a permanent failure when no user exists to notify", async () => {
      const { file } = await createSourceFile();
      summaryClient.failure = new Error("simulated summary outage");

      await expect(
        createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FINAL_ATTEMPT),
      ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("error");
      expect(await readAutomation(transcript.id)).toMatchObject({ status: "error", attempts: 1 });
      const { rows } = await pool.query("SELECT id FROM notifications");
      expect(rows).toEqual([]);
    });

    it("clears the error and settles done when a later run succeeds, without duplicate output or edges", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new AiGatewayFailedError("budget_exceeded");
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
      await task({ fileItemId: file.id }, FIRST_ATTEMPT);
      const failed = await readTranscript(file.id);
      expect(failed.properties.status).toBe("error");

      summaryClient.failure = null;
      await task({ fileItemId: file.id }, FIRST_ATTEMPT);

      const done = await readTranscript(file.id);
      expect(done.properties.status).toBe("done");
      expect(done.computed.segments).toEqual(failed.computed.segments);
      expect(await readAutomation(done.id)).toEqual({ status: "done", error: null, attempts: 2 });
      expect(await readMatch(done.id)).toEqual({
        eventIds: [],
        cards: [{ id: expect.any(String), kind: "transcript" }],
      });
      expect(await readNotifications(done.id)).toHaveLength(1);
      expect(gatewayClient.diarizeCalls).toHaveLength(1);
      expect(gatewayClient.transcribeCalls).toHaveLength(1);
    });

    it("never processes a row a user locked", async () => {
      const { file } = await createSourceFile();
      summaryClient.failure = new Error("simulated summary outage");
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
      await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).rejects.toMatchObject({
        name: "TranscriptionQueueError",
        message: "Transcription task failed",
      });
      const transcript = await readTranscript(file.id);
      await pool.query("UPDATE item_automation SET status = 'locked' WHERE item_id = $1", [transcript.id]);

      summaryClient.failure = null;
      await task({ fileItemId: file.id }, { job: { attempts: 2, max_attempts: 3 } });

      expect((await readTranscript(file.id)).properties.status).toBe("processing");
      expect(await readAutomation(transcript.id)).toMatchObject({ status: "locked", attempts: 1 });
      expect(summaryClient.calls).toHaveLength(1);
    });

    /** A summary client that locks the file's transcript while its call is in flight, then answers or fails. */
    class LockingSummaryClient extends FakeSummaryClient {
      constructor(private readonly fileItemId: string) {
        super();
      }

      override async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
        await pool.query(
          `UPDATE item_automation SET status = 'locked'
           WHERE item_id = (SELECT (computed ->> 'create')::uuid FROM items WHERE id = $1)`,
          [this.fileItemId],
        );
        return super.complete(input);
      }
    }

    it("keeps the running step's write from landing and stops once a user locks the row mid-run", async () => {
      const { file } = await createSourceFile();

      await createTranscriptionTask(
        pool,
        blobStorage,
        gatewayClient,
        new LockingSummaryClient(file.id),
      )({ fileItemId: file.id }, FIRST_ATTEMPT);

      const stopped = await readTranscript(file.id);
      expect(stopped.properties.status).toBe("processing");
      expect(stopped.computed).not.toHaveProperty("summaryByInstruction");
      expect(await readMatch(stopped.id)).toEqual({ eventIds: [], cards: [] });
      expect(await readAutomation(stopped.id)).toEqual({ status: "locked", error: null, attempts: 1 });
    });

    it("writes no diarize checkpoint and makes no ASR call once a user locks the row during diarization", async () => {
      const { file } = await createSourceFile();
      const lockingGateway = new (class extends FakeAudioGatewayClient {
        override async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
          await pool.query(
            `UPDATE item_automation SET status = 'locked'
             WHERE item_id = (SELECT (computed ->> 'create')::uuid FROM items WHERE id = $1)`,
            [file.id],
          );
          return super.diarize(request);
        }
      })();

      await createTranscriptionTask(
        pool,
        blobStorage,
        lockingGateway,
        summaryClient,
      )({ fileItemId: file.id }, FIRST_ATTEMPT);

      const { rows } = await pool.query<Record<string, unknown>>("SELECT computed FROM items WHERE id = $1", [file.id]);
      const computed = z.object({ computed: z.record(z.string(), z.unknown()) }).parse(rows[0]).computed;
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
      const lockingSummary = new LockingSummaryClient(file.id);
      lockingSummary.failure = new Error("simulated summary outage");

      await expect(
        createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          lockingSummary,
        )({ fileItemId: file.id }, FINAL_ATTEMPT),
      ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });

      const transcript = await readTranscript(file.id);
      expect(transcript.properties.status).toBe("processing");
      expect(await readAutomation(transcript.id)).toEqual({ status: "locked", error: null, attempts: 1 });
      expect(await readNotifications(transcript.id)).toEqual([]);
    });

    describe("deleted transcript or source file (issue #1582)", () => {
      it("resolves only the canonical tenant and database idempotency reservation, including Trash", async () => {
        const key = `transcription:${randomUUID()}`;
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        const otherTenant = await createTestTenant(pool);
        try {
          const original = await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const transcripts = await getDatabaseByModuleId(client, "transcripts");
            const files = await getDatabaseByModuleId(client, "files");
            if (!transcripts || !files) throw new Error("Missing built-in databases");
            const item = await createItemWithClient(client, {
              databaseId: transcripts.id,
              idempotencyKey: key,
              properties: {},
            });
            expect((await findIdempotentReplay(client, transcripts.id, key))?.id).toBe(item.id);
            expect(await findIdempotentReplay(client, files.id, key)).toBeNull();
            expect(await findIdempotentReplay(client, transcripts.id, `transcription:${randomUUID()}`)).toBeNull();
            return { item, transcripts };
          });
          await runInTenant(getTenantZeroId(), () =>
            createChokePoint(runtime).softDeleteItem(original.transcripts.id, original.item.id),
          );
          await withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const trashed = await findIdempotentReplay(client, original.transcripts.id, key);
            expect(trashed?.id).toBe(original.item.id);
            expect(trashed?.deletedAt).not.toBeNull();
            expect(await findIdempotentReplay(client, original.transcripts.id, key, { requireLive: true })).toBeNull();
          });
          await runInTenant(otherTenant, () => seedSystem(runtime, createViewTypeRegistry()));
          await withTenantTransaction(runtime, otherTenant, async (client) => {
            const transcripts = await getDatabaseByModuleId(client, "transcripts");
            if (!transcripts) throw new Error("Missing foreign Transcripts database");
            expect(await findIdempotentReplay(client, transcripts.id, key)).toBeNull();
            const item = await createItemWithClient(client, {
              databaseId: transcripts.id,
              idempotencyKey: key,
              properties: {},
            });
            expect(item.id).not.toBe(original.item.id);
            expect((await findIdempotentReplay(client, transcripts.id, key))?.id).toBe(item.id);
          });
        } finally {
          await runtime.end();
        }
      });

      async function readStoppedState(transcriptId: string) {
        const { rows } = await pool.query<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM item_automation WHERE item_id = $1",
          [transcriptId],
        );
        return rows[0];
      }

      /** Soft-deletes `itemId` the moment the diarize call is made, like a user emptying it mid-run. */
      class DeletingGateway extends FakeAudioGatewayClient {
        constructor(public deleteWhere: (fileItemId: string) => string) {
          super();
        }

        fileItemId = "";

        override async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
          await pool.query(this.deleteWhere(this.fileItemId));
          return super.diarize(request);
        }
      }

      const deleteTranscriptSql = (fileItemId: string) =>
        `UPDATE items SET deleted_at = now() WHERE id = (SELECT (computed ->> 'create')::uuid FROM items WHERE id = '${fileItemId}')`;
      const deleteSourceSql = (fileItemId: string) => `UPDATE items SET deleted_at = now() WHERE id = '${fileItemId}'`;

      for (const [label, sql] of [
        ["transcript", deleteTranscriptSql],
        ["source file", deleteSourceSql],
      ] as const) {
        it(`stops without ASR or a notification and marks error/deleted when the ${label} is deleted during diarization`, async () => {
          const { file } = await createSourceFile();
          await createUser();
          const gateway = new DeletingGateway(sql);
          gateway.fileItemId = file.id;

          await createTranscriptionTask(
            pool,
            blobStorage,
            gateway,
            summaryClient,
          )({ fileItemId: file.id }, FINAL_ATTEMPT);

          const transcript = await readTranscript(file.id);
          expect(gateway.diarizeCalls).toHaveLength(1);
          expect(gateway.transcribeCalls).toEqual([]);
          expect(summaryClient.calls).toEqual([]);
          expect(await readStoppedState(transcript.id)).toEqual({ status: "error", error_code: "deleted" });
          expect(await readNotifications(transcript.id)).toEqual([]);
        });
      }

      it("stops without ASR when DELETE /api/transcripts/:id trashes the recording during diarization (issue #1642)", async () => {
        const { file } = await createSourceFile();
        const userId = await createUser();
        let response: unknown;
        /** Calls the production DELETE route the moment the diarize call is made, like a user deleting the recording mid-run. */
        class RouteDeletingGateway extends FakeAudioGatewayClient {
          override async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
            const { rows } = await pool.query<{ id: string }>(
              "SELECT (computed ->> 'create') AS id FROM items WHERE id = $1",
              [file.id],
            );
            const transcriptId = rows[0]?.id;
            if (!transcriptId) throw new Error("Step 0 created no transcript");
            response = await runInTenant(getTenantZeroId(), () =>
              createTranscriptDeleteRouteHandler(pool)({
                params: { id: transcriptId },
                identity: { user: { id: userId } },
              }),
            );
            return super.diarize(request);
          }
        }
        const gateway = new RouteDeletingGateway();

        await createTranscriptionTask(
          pool,
          blobStorage,
          gateway,
          summaryClient,
        )({ fileItemId: file.id }, FINAL_ATTEMPT);

        const transcript = await readTranscript(file.id);
        expect(response).toEqual({ status: 200, body: { id: transcript.id, fileItemId: file.id } });
        expect(gateway.diarizeCalls).toHaveLength(1);
        expect(gateway.transcribeCalls).toEqual([]);
        expect(summaryClient.calls).toEqual([]);
        expect(await readStoppedState(transcript.id)).toEqual({ status: "error", error_code: "deleted" });
        expect(await readNotifications(transcript.id)).toEqual([]);
        const { rows } = await pool.query<{ epochs: number; trashed: number }>(
          "SELECT count(DISTINCT deleted_at)::int AS epochs, count(*)::int AS trashed FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
          [[file.id, transcript.id]],
        );
        expect(rows).toEqual([{ epochs: 1, trashed: 2 }]);
      });

      for (const [label, sql] of [
        ["transcript", deleteTranscriptSql],
        ["source file", deleteSourceSql],
      ] as const) {
        it(`settles the actual queued job successfully when the ${label} is deleted during diarization`, async () => {
          const { file } = await createSourceFile();
          await createUser();
          const deleting = new DeletingGateway(sql);
          deleting.fileItemId = file.id;
          const key = `transcription-job:${file.id}`;
          const taskList = {
            [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              createTranscriptionTask(pool, blobStorage, deleting, summaryClient),
            ),
          };
          await inTenantZero(() =>
            enqueueJob(
              pool,
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              { fileItemId: file.id },
              { jobKey: key, maxAttempts: 3 },
            ),
          );
          await runOnce({ pgPool: pool, taskList });
          const transcript = await readTranscript(file.id);
          expect(deleting.diarizeCalls).toHaveLength(1);
          expect(deleting.transcribeCalls).toEqual([]);
          expect(summaryClient.calls).toEqual([]);
          expect(await readStoppedState(transcript.id)).toEqual({ status: "error", error_code: "deleted" });
          expect(await readNotifications(transcript.id)).toEqual([]);
          const jobs = await pool.query<Record<string, unknown>>(
            "SELECT attempts, last_error FROM graphile_worker._private_jobs WHERE key = $1",
            [key],
          );
          expect(jobs.rows).toEqual([]);
        });
      }

      it("settles the queued job when its source was purged before the attempt starts", async () => {
        const { files, file } = await createSourceFile();
        await createUser();
        const key = `transcription-job:${file.id}`;
        const taskList = {
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
            CORE_TASK_NAMES.TRANSCRIPTION_JOB,
            createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
          ),
        };
        await inTenantZero(async () => {
          await enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key });
          const cp = createChokePoint(pool);
          await cp.softDeleteItem(files.id, file.id);
          expect((await cp.purgeExpiredTrashSubtree(file.id, new Date(Date.now() + 60_000))).purgedItemIds).toContain(
            file.id,
          );
        });
        await runOnce({ pgPool: pool, taskList });
        const jobs = await pool.query("SELECT id FROM graphile_worker._private_jobs WHERE key = $1", [key]);
        expect(jobs.rows).toEqual([]);
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
          const { files, file } = await createSourceFile();
          await createUser();
          summaryClient.failure = new Error("transient fixture failure");
          const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
          await expect(task({ fileItemId: file.id }, FIRST_ATTEMPT)).rejects.toMatchObject({
            name: "TranscriptionQueueError",
          });
          const transcript = await readTranscript(file.id);
          expect((await readAutomation(transcript.id))?.status).toBe("pending");
          expect(await readNotifications(transcript.id)).toEqual([]);
          if (locked)
            await pool.query("UPDATE item_automation SET status = 'locked' WHERE item_id = $1", [transcript.id]);
          const previousState = await readStoppedState(transcript.id);
          await inTenantZero(async () => {
            const cp = createChokePoint(pool);
            await cp.softDeleteItem(files.id, file.id);
            if (sourceState === "purged")
              expect(
                (await cp.purgeExpiredTrashSubtree(file.id, new Date(Date.now() + 60_000))).purgedItemIds,
              ).toContain(file.id);
          });
          const key = `transcription-job:${file.id}`;
          await inTenantZero(() =>
            enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key }),
          );
          await runOnce({
            pgPool: pool,
            taskList: {
              [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(CORE_TASK_NAMES.TRANSCRIPTION_JOB, task),
            },
          });
          expect((await pool.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [key])).rows).toEqual([]);
          expect(await readStoppedState(transcript.id)).toEqual(
            locked ? previousState : { status: "error", error_code: "deleted" },
          );
          expect(await readNotifications(transcript.id)).toEqual([]);
          const reservations = await pool.query<{ item_id: string }>(
            "SELECT item_id FROM idempotency_keys WHERE key = $1",
            [`transcription:${file.id}`],
          );
          expect(reservations.rows).toEqual([{ item_id: transcript.id }]);
        },
      );

      it("settles the queued job when its transcript is purged during diarization", async () => {
        const { file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const purgingGateway = new (class extends FakeAudioGatewayClient {
          override async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
            const transcript = await readTranscript(file.id);
            transcriptId = transcript.id;
            await inTenantZero(async () => {
              const cp = createChokePoint(pool);
              const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
              if (!transcripts) throw new Error("Missing Transcripts database");
              await cp.softDeleteItem(transcripts.id, transcript.id);
              expect(
                (await cp.purgeExpiredTrashSubtree(transcript.id, new Date(Date.now() + 60_000))).purgedItemIds,
              ).toContain(transcript.id);
            });
            return super.diarize(request);
          }
        })();
        const key = `transcription-job:${file.id}`;
        const taskList = {
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
            CORE_TASK_NAMES.TRANSCRIPTION_JOB,
            createTranscriptionTask(pool, blobStorage, purgingGateway, summaryClient),
          ),
        };
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key }),
        );
        await runOnce({ pgPool: pool, taskList });
        expect(transcriptId).toBeDefined();
        const jobs = await pool.query("SELECT id FROM graphile_worker._private_jobs WHERE key = $1", [key]);
        expect(jobs.rows).toEqual([]);
        expect(purgingGateway.transcribeCalls).toEqual([]);
        expect(summaryClient.calls).toEqual([]);
        const automation = await pool.query("SELECT item_id FROM item_automation WHERE item_id = $1", [transcriptId]);
        expect(automation.rows).toEqual([]);
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
          const { files, file } = await createSourceFile();
          await createUser();
          let transcriptId: string | undefined;
          const purgingGateway = new (class extends FakeAudioGatewayClient {
            override async diarize(_request: DiarizeRequest): Promise<DiarizationTurn[]> {
              const transcript = await readTranscript(file.id);
              transcriptId = transcript.id;
              await inTenantZero(async () => {
                const transcripts = await withTransaction(pool, (client) =>
                  getDatabaseByModuleId(client, "transcripts"),
                );
                if (!transcripts) throw new Error("Missing Transcripts database");
                const cp = createChokePoint(pool);
                const id = targetKind === "source" ? file.id : transcript.id;
                await cp.softDeleteItem(targetKind === "source" ? files.id : transcripts.id, id);
                expect((await cp.purgeExpiredTrashSubtree(id, new Date(Date.now() + 60_000))).purgedItemIds).toContain(
                  id,
                );
              });
              throw new Error("PRIVATE_PURGED_GATEWAY_FAILURE_1582");
            }
          })();
          const key = `transcription-job:${file.id}`;
          const seenAttempts: Array<{ attempts: number; max_attempts: number }> = [];
          const task = createTranscriptionTask(pool, blobStorage, purgingGateway, summaryClient);
          const taskList = {
            [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              async (payload, helpers) => {
                const job = z.object({ attempts: z.number().int(), max_attempts: z.number().int() }).parse(helpers.job);
                seenAttempts.push(job);
                expect(job).toEqual({ attempts: 1, max_attempts: maxAttempts });
                await task(payload, helpers);
              },
            ),
          };
          await inTenantZero(() =>
            enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts }),
          );
          await runOnce({ pgPool: pool, taskList });
          expect(seenAttempts).toEqual([{ attempts: 1, max_attempts: maxAttempts }]);
          const id = z.uuid().parse(transcriptId);
          expect((await pool.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [key])).rows).toEqual([]);
          expect(await readNotifications(id)).toEqual([]);
          expect(purgingGateway.transcribeCalls).toEqual([]);
          if (targetKind === "source")
            expect(await readStoppedState(id)).toEqual({ status: "error", error_code: "deleted" });
          else
            expect((await pool.query("SELECT item_id FROM item_automation WHERE item_id = $1", [id])).rows).toEqual([]);
        },
      );

      it("settles a deleted source after a gateway failure without changing a locked automation", async () => {
        const { files, file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const gateway = new (class extends FakeAudioGatewayClient {
          override async diarize(_request: DiarizeRequest): Promise<DiarizationTurn[]> {
            const transcript = await readTranscript(file.id);
            transcriptId = transcript.id;
            await pool.query("UPDATE item_automation SET status = 'locked' WHERE item_id = $1", [transcript.id]);
            await inTenantZero(async () => {
              const cp = createChokePoint(pool);
              await cp.softDeleteItem(files.id, file.id);
              expect(
                (await cp.purgeExpiredTrashSubtree(file.id, new Date(Date.now() + 60_000))).purgedItemIds,
              ).toContain(file.id);
            });
            throw new Error("PRIVATE_LOCKED_DELETED_GATEWAY_1582");
          }
        })();
        const key = `transcription-job:${file.id}`;
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 1 }),
        );
        await runOnce({
          pgPool: pool,
          taskList: {
            [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              createTranscriptionTask(pool, blobStorage, gateway, summaryClient),
            ),
          },
        });
        const id = z.uuid().parse(transcriptId);
        expect((await pool.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [key])).rows).toEqual([]);
        expect(await readStoppedState(id)).toEqual({ status: "locked", error_code: null });
        expect(await readNotifications(id)).toEqual([]);
        expect(gateway.transcribeCalls).toEqual([]);
      });

      it("keeps a missing automation on live targets as a failure rather than a deleted stop", async () => {
        const { file } = await createSourceFile();
        await createUser();
        let transcriptId: string | undefined;
        const gateway = new (class extends FakeAudioGatewayClient {
          override async diarize(_request: DiarizeRequest): Promise<DiarizationTurn[]> {
            transcriptId = (await readTranscript(file.id)).id;
            await pool.query("DELETE FROM item_automation WHERE item_id = $1", [transcriptId]);
            throw new Error("PRIVATE_LIVE_AUTOMATION_FAILURE_1582");
          }
        })();
        const key = `transcription-job:${file.id}`;
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 1 }),
        );
        await runOnce({
          pgPool: pool,
          taskList: {
            [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              createTranscriptionTask(pool, blobStorage, gateway, summaryClient),
            ),
          },
        });
        const id = z.uuid().parse(transcriptId);
        const jobs = await pool.query<{ last_error: string | null }>(
          "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
          [key],
        );
        expect(jobs.rows).toHaveLength(1);
        expect(jobs.rows[0]?.last_error).toContain("Transcription task failed");
        expect(jobs.rows[0]?.last_error).not.toContain("PRIVATE_LIVE_AUTOMATION_FAILURE_1582");
        expect(await readNotifications(id)).toEqual([]);
        const transcript = await readTranscript(file.id);
        expect(transcript.id).toBe(id);
        expect((await pool.query("SELECT item_id FROM item_automation WHERE item_id = $1", [id])).rows).toEqual([]);
      });

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
          const { files, file } = await createSourceFile();
          await createUser();
          const runtime = await createRuntimeRolePool(pool, "semprec_data");
          let transcriptId: string | undefined;
          let failureStarted = false;
          let failurePid: number | undefined;
          let deletionPid: number | undefined;
          let failureReady = () => {};
          let deletionReady = () => {};
          let deletionCommitReady = () => {};
          let releaseFailure = () => {};
          let releaseDeletion = () => {};
          const failureBoundary = new Promise<void>((resolve) => {
            failureReady = resolve;
          });
          const deletionBoundary = new Promise<void>((resolve) => {
            deletionReady = resolve;
          });
          const deletionCommit = new Promise<void>((resolve) => {
            deletionCommitReady = resolve;
          });
          const failureGate = new Promise<void>((resolve) => {
            releaseFailure = resolve;
          });
          const deletionGate = new Promise<void>((resolve) => {
            releaseDeletion = resolve;
          });
          const marker = new Error("intentional deletion rollback");
          async function bounded<T>(promise: Promise<T>): Promise<T> {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("Transcription overlap barrier timed out")), 5000);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
          const observe = (kind: "failure" | "deletion") =>
            new Proxy(runtime, {
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
                        const itemLock = sql.includes("FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE");
                        const automationLock = sql.includes("FROM item_automation") && sql.includes("FOR UPDATE");
                        if (kind === "deletion" && itemLock && deletionPid === undefined) {
                          deletionPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
                            .rows[0]?.pid;
                          if (ordering === "failure-first") deletionReady();
                        }
                        if (
                          kind === "failure" &&
                          failureStarted &&
                          itemLock &&
                          ordering !== "failure-first" &&
                          failurePid === undefined
                        ) {
                          failurePid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
                            .rows[0]?.pid;
                          failureReady();
                        }
                        if (kind === "deletion" && sql.trim().toUpperCase() === "COMMIT") {
                          if (ordering !== "failure-first") deletionReady();
                          else deletionCommitReady();
                          await deletionGate;
                          if (ordering === "deletion-rollback") throw marker;
                        }
                        const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                        if (sql.trim().toUpperCase() === "BEGIN")
                          await connection.query("SET LOCAL statement_timeout = '5s'");
                        if (kind === "failure" && failureStarted && automationLock && ordering === "failure-first") {
                          failurePid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
                            .rows[0]?.pid;
                          failureReady();
                          await failureGate;
                        }
                        return result;
                      };
                    },
                  });
                };
              },
            });
          const workerPool = observe("failure");
          const deletionPool = observe("deletion");
          const deletionState: { current?: Promise<ItemRow | null> } = {};
          const startDeletion = () => {
            deletionState.current = runInTenant(getTenantZeroId(), async () => {
              const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
              if (!transcripts) throw new Error("Missing Transcripts database");
              return createChokePoint(deletionPool).softDeleteItem(
                targetKind === "source" ? files.id : transcripts.id,
                targetKind === "source" ? file.id : z.uuid().parse(transcriptId),
              );
            });
            deletionState.current.catch(() => {});
          };
          const gateway = new (class extends FakeAudioGatewayClient {
            override async diarize(_request: DiarizeRequest): Promise<DiarizationTurn[]> {
              transcriptId = (await readTranscript(file.id)).id;
              if (ordering !== "failure-first") {
                startDeletion();
                await bounded(deletionBoundary);
              }
              failureStarted = true;
              throw new Error("PRIVATE_ORDERED_FAILURE_1582");
            }
          })();
          const key = `transcription-job:${file.id}`;
          let worker: Promise<void> | undefined;
          try {
            await inTenantZero(() =>
              enqueueJob(
                pool,
                CORE_TASK_NAMES.TRANSCRIPTION_JOB,
                { fileItemId: file.id },
                { jobKey: key, maxAttempts: 1 },
              ),
            );
            worker = runOnce({
              pgPool: pool,
              taskList: {
                [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
                  CORE_TASK_NAMES.TRANSCRIPTION_JOB,
                  createTranscriptionTask(workerPool, blobStorage, gateway, summaryClient),
                ),
              },
            });
            worker.catch(() => {});
            await bounded(failureBoundary);
            if (ordering === "failure-first") {
              startDeletion();
              await bounded(deletionBoundary);
            }
            if (!failurePid || !deletionPid) throw new Error("Missing competing backend PID");
            const holder = ordering === "failure-first" ? failurePid : deletionPid;
            const competitor = ordering === "failure-first" ? deletionPid : failurePid;
            let blocked = false;
            for (let n = 0; n < 100 && !blocked; n++) {
              const result = await pool.query<{ blocked: boolean }>(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [holder, competitor],
              );
              blocked = result.rows[0]?.blocked === true;
              if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(blocked).toBe(true);
            const deletion = deletionState.current;
            if (!deletion) throw new Error("Deletion did not start");
            if (ordering === "failure-first") {
              releaseFailure();
              await bounded(worker);
              await bounded(deletionCommit);
              const id = z.uuid().parse(transcriptId);
              expect(await readNotifications(id)).toHaveLength(1);
              releaseDeletion();
              await bounded(deletion);
            } else {
              releaseDeletion();
              const outcome = await deletion.then(
                () => null,
                (error: unknown) => error,
              );
              expect(outcome).toBe(ordering === "deletion-rollback" ? marker : null);
              await bounded(worker);
              const id = z.uuid().parse(transcriptId);
              if (ordering === "deletion-first") {
                expect(await readStoppedState(id)).toEqual({ status: "error", error_code: "deleted" });
                expect(await readNotifications(id)).toEqual([]);
              } else {
                expect(await readNotifications(id)).toHaveLength(1);
              }
            }
          } finally {
            releaseFailure();
            releaseDeletion();
            await Promise.allSettled([
              ...(worker ? [worker] : []),
              ...(deletionState.current ? [deletionState.current] : []),
            ]);
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
        let gatewayReached = () => {};
        let releaseGateway = () => {};
        let rerunReady = () => {};
        let releaseRerun = () => {};
        let workerWaiting = () => {};
        let afterGateway = false;
        const gatewayAtBoundary = new Promise<void>((resolve) => {
          gatewayReached = resolve;
        });
        const gatewayGate = new Promise<void>((resolve) => {
          releaseGateway = resolve;
        });
        const rerunAtCommit = new Promise<void>((resolve) => {
          rerunReady = resolve;
        });
        const rerunGate = new Promise<void>((resolve) => {
          releaseRerun = resolve;
        });
        const workerAtLock = new Promise<void>((resolve) => {
          workerWaiting = resolve;
        });
        async function bounded<T>(promise: Promise<T>): Promise<T> {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              promise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Rerun overlap barrier timed out")), 5000);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        const observe = (kind: "worker" | "rerun") =>
          new Proxy(runtime, {
            get(target, key, receiver) {
              if (key !== "connect") {
                const value: unknown = Reflect.get(target, key, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, prop, innerReceiver) {
                    if (prop !== "query") {
                      const value: unknown = Reflect.get(connection, prop, innerReceiver);
                      return typeof value === "function" ? value.bind(connection) : value;
                    }
                    return async (...args: unknown[]) => {
                      const sql = typeof args[0] === "string" ? args[0] : "";
                      const automationLock = sql.includes("FROM item_automation") && sql.includes("FOR UPDATE");
                      if (kind === "worker" && afterGateway && automationLock && workerPid === undefined) {
                        workerPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                          ?.pid;
                        workerWaiting();
                      }
                      if (kind === "rerun" && sql.trim().toUpperCase() === "COMMIT") {
                        rerunPid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                          ?.pid;
                        rerunReady();
                        await rerunGate;
                      }
                      const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                      if (sql.trim().toUpperCase() === "BEGIN")
                        await connection.query("SET LOCAL statement_timeout = '5s'");
                      return result;
                    };
                  },
                });
              };
            },
          });
        let first = true;
        const gateway = new (class extends FakeAudioGatewayClient {
          override async diarize(request: DiarizeRequest): Promise<DiarizationTurn[]> {
            if (first) {
              first = false;
              transcriptId = (await readTranscript(file.id)).id;
              gatewayReached();
              await gatewayGate;
              afterGateway = true;
            }
            return super.diarize(request);
          }
        })();
        const key = `transcription-job:${file.id}`;
        let worker: Promise<void> | undefined;
        let rerun: ReturnType<ReturnType<typeof createRerunTranscriptionRouteHandler>> | undefined;
        try {
          await inTenantZero(() =>
            enqueueJob(
              pool,
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              { fileItemId: file.id },
              { jobKey: key, maxAttempts: 3 },
            ),
          );
          worker = runOnce({
            pgPool: pool,
            taskList: {
              [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
                CORE_TASK_NAMES.TRANSCRIPTION_JOB,
                createTranscriptionTask(observe("worker"), blobStorage, gateway, summaryClient),
              ),
            },
          });
          worker.catch(() => {});
          await bounded(gatewayAtBoundary);
          const id = z.uuid().parse(transcriptId);
          rerun = inTenantZero(() =>
            createRerunTranscriptionRouteHandler(observe("rerun"))({ params: { id }, body: undefined }),
          );
          rerun.catch(() => {});
          await bounded(rerunAtCommit);
          releaseGateway();
          await bounded(workerAtLock);
          if (!rerunPid || !workerPid) throw new Error("Missing competing backend PID");
          let blocked = false;
          for (let n = 0; n < 100 && !blocked; n++) {
            const result = await pool.query<{ blocked: boolean }>(
              "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
              [rerunPid, workerPid],
            );
            blocked = result.rows[0]?.blocked === true;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(blocked).toBe(true);
          releaseRerun();
          expect((await bounded(rerun)).status).toBe(202);
          await bounded(worker);
          expect((await readAutomation(id))?.status).toBe("done");
        } finally {
          releaseGateway();
          releaseRerun();
          await Promise.allSettled([...(worker ? [worker] : []), ...(rerun ? [rerun] : [])]);
          await runtime.end();
        }
      }, 20000);

      it.each(["source", "transcript"] as const)(
        "settles the queued job when the %s is purged between creation and attempt start",
        async (targetKind) => {
          const { files, file } = await createSourceFile();
          await createUser();
          let checkpointWritten = false;
          let purged = false;
          let transcriptId: string | undefined;
          const observedPool = new Proxy(pool, {
            get(target, property, receiver) {
              if (property !== "connect") {
                const value: unknown = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, key, innerReceiver) {
                    if (key !== "query") {
                      const value: unknown = Reflect.get(connection, key, innerReceiver);
                      return typeof value === "function" ? value.bind(connection) : value;
                    }
                    return async (...args: unknown[]) => {
                      const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                      const sql = typeof args[0] === "string" ? args[0] : "";
                      const parameters = z.array(z.unknown()).safeParse(args[1]);
                      if (
                        sql.includes("UPDATE items SET computed") &&
                        parameters.success &&
                        parameters.data[2] === "create"
                      )
                        checkpointWritten = true;
                      if (checkpointWritten && !purged && sql.trim().toUpperCase() === "COMMIT") {
                        purged = true;
                        await inTenantZero(async () => {
                          const transcript = await readTranscript(file.id);
                          transcriptId = transcript.id;
                          const cp = createChokePoint(pool);
                          const id = targetKind === "source" ? file.id : transcript.id;
                          const transcripts = await withTransaction(pool, (inner) =>
                            getDatabaseByModuleId(inner, "transcripts"),
                          );
                          if (!transcripts) throw new Error("Missing Transcripts database");
                          const databaseId = targetKind === "source" ? files.id : transcripts.id;
                          await cp.softDeleteItem(databaseId, id);
                          expect(
                            (await cp.purgeExpiredTrashSubtree(id, new Date(Date.now() + 60_000))).purgedItemIds,
                          ).toContain(id);
                        });
                      }
                      return result;
                    };
                  },
                });
              };
            },
          });
          const key = `transcription-job:${file.id}`;
          const taskList = {
            [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              createTranscriptionTask(observedPool, blobStorage, gatewayClient, summaryClient),
            ),
          };
          await inTenantZero(() =>
            enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key }),
          );
          await runOnce({ pgPool: pool, taskList });
          expect(purged).toBe(true);
          expect((await pool.query("SELECT id FROM graphile_worker._private_jobs WHERE key = $1", [key])).rows).toEqual(
            [],
          );
          expect(gatewayClient.diarizeCalls).toEqual([]);
          expect(gatewayClient.transcribeCalls).toEqual([]);
          expect(summaryClient.calls).toEqual([]);
          expect(await readNotifications(z.uuid().parse(transcriptId))).toEqual([]);
          if (targetKind === "source") {
            expect(await readStoppedState(z.uuid().parse(transcriptId))).toEqual({
              status: "error",
              error_code: "deleted",
            });
          } else {
            expect(
              (await pool.query("SELECT item_id FROM item_automation WHERE item_id = $1", [transcriptId])).rows,
            ).toEqual([]);
          }
        },
      );

      it("stops cleanly when the source is purged after diarization commits and before ASR starts", async () => {
        const { files, file } = await createSourceFile();
        await createUser();
        let checkpointWritten = false;
        let purged = false;
        let transcriptId: string | undefined;
        const observedPool = new Proxy(pool, {
          get(target, property, receiver) {
            if (property !== "connect") {
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, key, receiver) {
                  if (key !== "query") {
                    const value: unknown = Reflect.get(connection, key, receiver);
                    return typeof value === "function" ? value.bind(connection) : value;
                  }
                  return async (...args: unknown[]) => {
                    const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                    const sql = typeof args[0] === "string" ? args[0] : "";
                    const parameters = z.array(z.unknown()).safeParse(args[1]);
                    if (
                      sql.includes("UPDATE items SET computed") &&
                      parameters.success &&
                      parameters.data[2] === "diarize"
                    )
                      checkpointWritten = true;
                    if (checkpointWritten && !purged && sql.trim().toUpperCase() === "COMMIT") {
                      purged = true;
                      await inTenantZero(async () => {
                        const source = await withTransaction(pool, (inner) => getItemById(inner, files.id, file.id));
                        transcriptId = z.uuid().parse(source?.computed.create);
                        const cp = createChokePoint(pool);
                        await cp.softDeleteItem(files.id, file.id);
                        const removed = await cp.purgeExpiredTrashSubtree(file.id, new Date(Date.now() + 60_000));
                        expect(removed.purgedItemIds).toContain(file.id);
                      });
                    }
                    return result;
                  };
                },
              });
            };
          },
        });
        await createTranscriptionTask(
          observedPool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FINAL_ATTEMPT);
        expect(purged).toBe(true);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toEqual([]);
        if (!transcriptId) throw new Error("Missing transcript ID");
        expect(await readStoppedState(transcriptId)).toEqual({ status: "error", error_code: "deleted" });
        expect(await readNotifications(transcriptId)).toEqual([]);
      });

      it("falls back to the deleted stop instead of rolling back when the last attempt fails on a trashed transcript", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const trashingSummary = new (class extends FakeSummaryClient {
          override async complete(): Promise<AiGatewayCompletionResult> {
            await pool.query(deleteTranscriptSql(file.id));
            throw new Error("simulated summary outage");
          }
        })();

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          trashingSummary,
        )({ fileItemId: file.id }, FINAL_ATTEMPT);

        const transcript = await readTranscript(file.id);
        expect(await readStoppedState(transcript.id)).toEqual({ status: "error", error_code: "deleted" });
        expect(await readNotifications(transcript.id)).toEqual([]);
      });

      it("runs again after the transcript is restored and the job is rerun", async () => {
        const { file } = await createSourceFile();
        const gateway = new DeletingGateway(deleteTranscriptSql);
        gateway.fileItemId = file.id;
        await createTranscriptionTask(
          pool,
          blobStorage,
          gateway,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);
        const transcript = await readTranscript(file.id);
        const transcripts = await inTenantZero(() =>
          withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts")),
        );
        if (!transcripts) throw new Error("Missing Transcripts database");
        await inTenantZero(() => createChokePoint(pool).restoreItem(transcripts.id, transcript.id));
        gateway.deleteWhere = () => "SELECT 1";

        const requested = await inTenantZero(() =>
          createRerunTranscriptionRouteHandler(pool)({ params: { id: transcript.id }, body: undefined }),
        );
        expect(requested).toEqual({ status: 202, body: { id: transcript.id, fileItemId: file.id } });
        const taskList = {
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
            CORE_TASK_NAMES.TRANSCRIPTION_JOB,
            createTranscriptionTask(pool, blobStorage, gateway, summaryClient),
          ),
        };
        await runOnce({ pgPool: pool, taskList });

        expect(await readStoppedState(transcript.id)).toEqual({ status: "done", error_code: null });
        expect(gateway.diarizeCalls).toHaveLength(2);
        expect(gateway.transcribeCalls).toHaveLength(1);
      });
    });

    it("retries through graphile-worker at most three times with growing backoff, then records the failure once", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const failure = new Error("simulated summary outage");
      summaryClient.failure = failure;
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
        ),
      };
      const jobKey = `transcription-job:${file.id}`;
      await inTenantZero(() =>
        enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey, maxAttempts: 3 }),
      );

      async function runDueJob(): Promise<{ attempts: number; delaySeconds: number }> {
        await pool.query("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1", [jobKey]);
        await runOnce({ pgPool: pool, taskList });
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
      expect(await readNotifications(transcript.id)).toHaveLength(1);
    });

    it("keeps the diagnostic sentinel out of actual worker failure logs and queue state", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const sentinel = "PRIVATE_PROVIDER_SENTINEL_1386";
      summaryClient.failure = new Error(sentinel);
      const jobKey = `transcription-job:${file.id}`;
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
        ),
      };
      const logger = vi.spyOn(console, "error");
      let lines: string;
      observedLogs.chunks.length = 0;
      try {
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey, maxAttempts: 1 }),
        );
        await runOnce({ pgPool: pool, taskList });
        lines = inspect(logger.mock.calls, { depth: 8 });
      } finally {
        logger.mockRestore();
      }
      const job = await pool.query<{ last_error: string | null }>(
        "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
        [jobKey],
      );
      expect(job.rows[0]?.last_error).toContain("Transcription task failed");
      expect(job.rows[0]?.last_error).not.toContain(sentinel);
      expect(lines).toContain("Transcription task failed");
      expect(lines).not.toContain(sentinel);
      expect(observedLogs.chunks.join("")).not.toContain(sentinel);
      const transcript = await readTranscript(file.id);
      expect((await readAutomation(transcript.id))?.error).toBe(sentinel);
    });

    it("keeps transient retry diagnostics out of actual worker and application output", async () => {
      const { file } = await createSourceFile();
      await createUser();
      const sentinel = "PRIVATE_RETRY_SENTINEL_1386";
      summaryClient.failure = new Error(sentinel);
      const key = `transcription-job:${file.id}`;
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
        ),
      };
      observedLogs.chunks.length = 0;
      const graphile = vi.spyOn(console, "error");
      try {
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 3 }),
        );
        await runOnce({ pgPool: pool, taskList });
        const workerOutput = inspect(graphile.mock.calls, { depth: 8 });
        expect(workerOutput).toContain("Transcription task failed");
        expect(workerOutput).not.toContain(sentinel);
        expect(observedLogs.chunks.join("")).not.toContain(sentinel);
        const jobs = await pool.query<{ attempts: number }>(
          "SELECT attempts FROM graphile_worker.jobs WHERE key = $1",
          [key],
        );
        expect(jobs.rows[0]?.attempts).toBe(1);
        const transcript = await readTranscript(file.id);
        expect((await readAutomation(transcript.id))?.status).toBe("pending");
        expect(await readNotifications(transcript.id)).toEqual([]);
      } finally {
        graphile.mockRestore();
      }
    });

    it("passes a safe failure to the real queue wrapper when the running task is superseded", async () => {
      const { file } = await createSourceFile();
      const sentinel = "PRIVATE_SUPERSEDED_SENTINEL_1386";
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        started = resolve;
      });
      let first = true;
      const gateway: AiGatewayClientPort = {
        async complete(input) {
          if (first) {
            first = false;
            started();
            await gate;
            throw new Error(sentinel);
          }
          return summaryClient.complete(input);
        },
      };
      const key = `transcription-job:${file.id}`;
      const task = createTranscriptionTask(pool, blobStorage, gatewayClient, gateway);
      let outward: unknown;
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          async (payload, helpers) => {
            try {
              await task(payload, helpers);
            } catch (error) {
              outward = error;
              throw error;
            }
          },
        ),
      };
      let worker: Promise<void> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      observedLogs.chunks.length = 0;
      try {
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 3 }),
        );
        worker = runOnce({ pgPool: pool, taskList });
        await Promise.race([
          reached,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Timed out waiting for transcription")), 10000);
          }),
        ]);
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 3 }),
        );
        release();
        await worker;
      } finally {
        if (timeout) clearTimeout(timeout);
        release();
        await worker;
      }
      expect(outward).toMatchObject({
        name: "TranscriptionQueueError",
        message: "Transcription task failed",
        code: "unknown",
      });
      expect(outward).not.toHaveProperty("cause");
      expect(inspect(outward)).not.toContain(sentinel);
      expect(observedLogs.chunks.join("")).toContain("Job was superseded by a re-enqueue");
      expect(observedLogs.chunks.join("")).not.toContain(sentinel);
      const queueRecords = observedLogs.chunks
        .flatMap((chunk) => chunk.split("\n").filter(Boolean))
        .map((line) => {
          const value: unknown = JSON.parse(line);
          return z
            .object({ msg: z.string(), err: z.record(z.string(), z.unknown()).optional() })
            .passthrough()
            .parse(value);
        });
      const superseded = queueRecords.find((record) => record.msg.startsWith("Job was superseded by a re-enqueue"));
      expect(superseded?.err).toBeDefined();
      expect(superseded?.err).not.toHaveProperty("cause");
      expect(summaryClient.calls.length).toBeGreaterThan(0);
    });

    it("preserves a safe worker failure when diagnostic recording itself fails", async () => {
      const { file } = await createSourceFile();
      await createUser();
      summaryClient.failure = new Error("PRIVATE_ORIGINAL_RECORD_FAILURE_1386");
      const key = `transcription-job:${file.id}`;
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
        ),
      };
      // The trigger injects an otherwise unavailable notification persistence failure.
      await pool.query(`CREATE FUNCTION test_failure_1386() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'PRIVATE_RECORDING_FAILURE_1386'; END $$`);
      await pool.query(`CREATE TRIGGER test_failure_1386 BEFORE INSERT ON notifications
        FOR EACH ROW EXECUTE FUNCTION test_failure_1386()`);
      observedLogs.chunks.length = 0;
      const graphile = vi.spyOn(console, "error");
      try {
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 1 }),
        );
        await runOnce({ pgPool: pool, taskList });
        const job = await pool.query<{ last_error: string | null }>(
          "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
          [key],
        );
        expect(job.rows[0]?.last_error).toContain("Transcription task failed");
        expect(job.rows[0]?.last_error).not.toContain("PRIVATE_ORIGINAL_RECORD_FAILURE_1386");
        expect(job.rows[0]?.last_error).not.toContain("PRIVATE_RECORDING_FAILURE_1386");
        const appOutput = observedLogs.chunks.join("");
        const workerOutput = inspect(graphile.mock.calls, { depth: 8 });
        expect(appOutput).toContain("Failed to record a transcription failure");
        expect(workerOutput).toContain("Transcription task failed");
        for (const sentinel of ["PRIVATE_ORIGINAL_RECORD_FAILURE_1386", "PRIVATE_RECORDING_FAILURE_1386"]) {
          expect(appOutput).not.toContain(sentinel);
          expect(workerOutput).not.toContain(sentinel);
        }
        const transcript = await readTranscript(file.id);
        expect((await readAutomation(transcript.id))?.status).toBe("pending");
        expect(await readNotifications(transcript.id)).toEqual([]);
      } finally {
        graphile.mockRestore();
        await pool.query("DROP TRIGGER test_failure_1386 ON notifications");
        await pool.query("DROP FUNCTION test_failure_1386()");
      }
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
      const key = `transcription-job:${file.id}`;
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(pool, storage, gatewayClient, summaryClient),
        ),
      };
      observedLogs.chunks.length = 0;
      const graphile = vi.spyOn(console, "error");
      try {
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId: file.id }, { jobKey: key, maxAttempts: 1 }),
        );
        await runOnce({ pgPool: pool, taskList });
        const job = await pool.query<{ last_error: string | null }>(
          "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
          [key],
        );
        expect(job.rows[0]?.last_error).toContain("Transcription task failed");
        const appOutput = observedLogs.chunks.join("");
        const workerOutput = inspect(graphile.mock.calls, { depth: 8 });
        expect(appOutput).toContain("Failed to delete normalized audio that no blob references");
        expect(workerOutput).toContain("Transcription task failed");
        for (const sentinel of ["PRIVATE_STORAGE_FAILURE_1386", "PRIVATE_CLEANUP_FAILURE_1386"]) {
          expect(job.rows[0]?.last_error).not.toContain(sentinel);
          expect(appOutput).not.toContain(sentinel);
          expect(workerOutput).not.toContain(sentinel);
        }
      } finally {
        graphile.mockRestore();
      }
    });

    it.each(["files", "transcripts"] as const)(
      "reports a safe worker failure when the %s catalog is unavailable before a transcript exists",
      async (moduleId) => {
        const { file } = await createSourceFile();
        // Simulate a missing built-in catalog entry, which normal APIs cannot remove.
        await pool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = $1", [moduleId]);
        const key = `transcription-job:${file.id}`;
        const taskList = {
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
            CORE_TASK_NAMES.TRANSCRIPTION_JOB,
            createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
          ),
        };
        observedLogs.chunks.length = 0;
        const graphile = vi.spyOn(console, "error");
        try {
          await inTenantZero(() =>
            enqueueJob(
              pool,
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              { fileItemId: file.id },
              { jobKey: key, maxAttempts: 1 },
            ),
          );
          await runOnce({ pgPool: pool, taskList });
          const job = await pool.query<{ last_error: string | null }>(
            "SELECT last_error FROM graphile_worker.jobs WHERE key = $1",
            [key],
          );
          const workerOutput = inspect(graphile.mock.calls, { depth: 8 });
          const original = moduleId === "files" ? "Files database not found" : "Transcripts database not found";
          expect(job.rows[0]?.last_error).toContain("Transcription task failed");
          expect(workerOutput).toContain("Transcription task failed");
          expect(workerOutput).not.toContain(original);
          expect(observedLogs.chunks.join("")).not.toContain(original);
          expect(job.rows[0]?.last_error).not.toContain(original);
          const automations = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM item_automation");
          expect(automations.rows[0]?.count).toBe(0);
        } finally {
          graphile.mockRestore();
        }
      },
    );

    describe("daily requeue and manual rerun (issue #186)", () => {
      function createTaskList() {
        return {
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
            CORE_TASK_NAMES.TRANSCRIPTION_JOB,
            createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient),
          ),
        };
      }

      /** Makes every queued transcription job due now and runs whatever is runnable once. */
      async function runDueJobs(): Promise<void> {
        await pool.query(
          "UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key LIKE 'transcription-job:%'",
        );
        await runOnce({ pgPool: pool, taskList: createTaskList() });
      }

      async function runSweep(): Promise<void> {
        const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
        if (!transcripts) throw new Error("Transcripts database was not seeded");
        await inTenantZero(() =>
          createTranscriptionRequeueSweepAction(pool)(
            { transcriptsDatabaseId: transcripts.id },
            { heartbeatId: randomUUID(), projectItemId: randomUUID() },
          ),
        );
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
        const jobKey = `transcription-job:${fileItemId}`;
        await inTenantZero(() =>
          enqueueJob(pool, CORE_TASK_NAMES.TRANSCRIPTION_JOB, { fileItemId }, { jobKey, maxAttempts: 3 }),
        );
        for (let attempt = 0; attempt < 3; attempt += 1) await runDueJobs();
        const transcript = await readTranscript(fileItemId);
        expect(await readAutomation(transcript.id)).toMatchObject({ status: "error", attempts: 3 });
        summaryClient.failure = null;
        return transcript.id;
      }

      it("requeues an error row daily under its key and resumes the same row without repeating a paid stage", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const transcriptId = await failPermanently(file.id);

        await runSweep();
        await runSweep();
        expect(await readRunnableJobs()).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);
        await runDueJobs();

        const done = await readTranscript(file.id);
        expect(done.id).toBe(transcriptId);
        expect(done.properties.status).toBe("done");
        expect(await readAutomation(transcriptId)).toEqual({ status: "done", error: null, attempts: 4 });
        expect(await countTranscripts()).toBe(1);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toHaveLength(1);
        // Three failed summary attempts, then the one that succeeded — never a repeat of a cached summary.
        expect(summaryClient.calls).toHaveLength(4);

        await runSweep();
        expect(await readRunnableJobs()).toEqual([]);
      });

      it("reruns a done row by hand on the same row and key without any paid call", async () => {
        const { file } = await createSourceFile();
        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);
        const transcript = await readTranscript(file.id);
        const paidCalls = [
          gatewayClient.diarizeCalls.length,
          gatewayClient.transcribeCalls.length,
          summaryClient.calls.length,
        ];

        const result = await inTenantZero(() =>
          createRerunTranscriptionRouteHandler(pool)({
            params: { id: transcript.id },
            body: undefined,
          }),
        );
        expect(result.status).toBe(202);
        expect(await readRunnableJobs()).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);
        await runDueJobs();

        expect(await readRunnableJobs()).toEqual([]);
        expect((await readTranscript(file.id)).properties.status).toBe("done");
        expect(await readAutomation(transcript.id)).toMatchObject({ status: "done", attempts: 2 });
        expect(await countTranscripts()).toBe(1);
        expect([
          gatewayClient.diarizeCalls.length,
          gatewayClient.transcribeCalls.length,
          summaryClient.calls.length,
        ]).toEqual(paidCalls);
      });

      it("reruns an error row by hand from its checkpoints", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const transcriptId = await failPermanently(file.id);

        await inTenantZero(() =>
          createRerunTranscriptionRouteHandler(pool)({ params: { id: transcriptId }, body: undefined }),
        );
        await runDueJobs();

        expect((await readTranscript(file.id)).properties.status).toBe("done");
        expect(await countTranscripts()).toBe(1);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toHaveLength(1);
        expect(summaryClient.calls).toHaveLength(4);
      });

      it("never reruns a locked row by either path", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const transcriptId = await failPermanently(file.id);
        await pool.query("UPDATE item_automation SET status = 'locked' WHERE item_id = $1", [transcriptId]);

        await runSweep();
        await expect(
          inTenantZero(() =>
            createRerunTranscriptionRouteHandler(pool)({ params: { id: transcriptId }, body: undefined }),
          ),
        ).rejects.toMatchObject({ status: 403, code: "transcription_locked" });
        await runDueJobs();

        expect(await readRunnableJobs()).toEqual([]);
        expect(await readAutomation(transcriptId)).toMatchObject({ status: "locked", attempts: 3 });
        expect(summaryClient.calls).toHaveLength(3);
      });
    });

    describe("rerun of a finished transcript without meeting notes (issue #1712)", () => {
      /**
       * Runs the pipeline to `done`, then removes `meetingNotes`, which a transcript finished before
       * issue #1695 does not have. No production write removes the key, so the row is edited directly.
       * Everything else is what today's pipeline leaves, the source's `suggestSpeakers` checkpoint and
       * the speaker cards included; `finishWithoutNotesOrSpeakerProposals` removes those as well.
       */
      async function finishWithoutNotes(fileItemId: string) {
        await createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient)({ fileItemId }, FIRST_ATTEMPT);
        const finished = await readTranscript(fileItemId);
        expect(finished.properties.status).toBe("done");
        const stripped = await pool.query("UPDATE items SET computed = computed - 'meetingNotes' WHERE id = $1", [
          finished.id,
        ]);
        expect(stripped.rowCount).toBe(1);
        return readTranscript(fileItemId);
      }

      /**
       * `finishWithoutNotes`, then the shape an earlier pipeline left when step 7 had nobody to ask
       * about (no linked Event, or none with a named participant): no `suggestSpeakers` checkpoint on
       * the source and no speaker card. The cards leave through the Trash and its purge, so their
       * idempotency keys are free again. No production write removes the checkpoint, so the source row
       * is edited directly.
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
        const chokePoint = createChokePoint(pool);
        for (const card of speakerCards) {
          await inTenantZero(() => chokePoint.softDeleteItem(card.database_id, card.id));
          // Any cutoff after the moment the card was trashed makes it eligible; no wall-clock wait is involved.
          const purged = await inTenantZero(() =>
            chokePoint.purgeExpiredTrashSubtree(card.id, new Date(Date.now() + 60_000)),
          );
          expect(purged.purgedItemIds).toEqual([card.id]);
        }
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
        const source = await withTransaction(pool, (client) => getItemById(client, filesDatabaseId, fileItemId));
        if (!source) throw new Error("expected the source Files item");
        return source.computed;
      }

      async function readFailure(transcriptId: string) {
        const { rows } = await pool.query<{
          status: string;
          error: string | null;
          error_code: string | null;
          attempts: number;
        }>("SELECT status, error, error_code, attempts FROM item_automation WHERE item_id = $1", [transcriptId]);
        return rows;
      }

      async function countNotifications(): Promise<number> {
        const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM notifications");
        return rows[0]?.count ?? 0;
      }

      async function readTranscriptionJobs(): Promise<Array<{ key: string | null; attempts: number }>> {
        const { rows } = await pool.query<{ key: string | null; attempts: number }>(
          "SELECT key, attempts FROM graphile_worker.jobs WHERE task_identifier = $1",
          [CORE_TASK_NAMES.TRANSCRIPTION_JOB],
        );
        return rows;
      }

      it("pays only the summarize call, keeps status done while it runs and adds no card", async () => {
        const { files, file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        const sourceBefore = await readSourceComputed(files.id, file.id);
        const matchBefore = await readMatch(before.id);
        const cardsBefore = await readCardIds();
        // No Event matched: the first run left the pairing card and one card per speaker.
        expect(matchBefore.cards).toHaveLength(1);
        expect(cardsBefore).toHaveLength(3);
        const observed: Array<{ status: unknown; automation: string | undefined }> = [];
        /** Reads the row's visible state while the paid call of the rerun is out. */
        const observing = new (class extends FakeSummaryClient {
          override async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
            observed.push({
              status: (await readTranscript(file.id)).properties.status,
              automation: await readAutomationStatus(before.id),
            });
            return super.complete(input);
          }
        })();

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          observing,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        expect(observing.calls.map((call) => call.operation)).toEqual(["transcript_summary"]);
        expect(observed).toEqual([{ status: "done", automation: "pending" }]);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toHaveLength(1);
        const after = await readTranscript(file.id);
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual({ ...before.computed, meetingNotes: { ...FAKE_NOTES, actionItems: [] } });
        expect(await readSourceComputed(files.id, file.id)).toEqual(sourceBefore);
        expect(await readMatch(after.id)).toEqual(matchBefore);
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 2 });
        expect(await countNotifications()).toBe(0);
      });

      it("makes no second speaker suggestion call and keeps the Event edge and the speaker cards", async () => {
        const { file } = await createSourceFile();
        const eventId = await createEvent(FIXTURE_CREATION_TIME);
        const aliceId = await createParticipant(eventId, "Alice");
        summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];
        const before = await finishWithoutNotes(file.id);
        expect(summaryClient.calls.map((call) => call.operation)).toEqual([
          "transcript_summary",
          "transcript_speaker_suggestion",
        ]);
        const cardsBefore = await readCardIds();
        expect(cardsBefore).toHaveLength(2);
        expect(await readMatch(before.id)).toEqual({ eventIds: [eventId], cards: [] });

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        expect(summaryClient.calls.map((call) => call.operation)).toEqual([
          "transcript_summary",
          "transcript_speaker_suggestion",
          "transcript_summary",
        ]);
        expect(gatewayClient.diarizeCalls).toHaveLength(1);
        expect(gatewayClient.transcribeCalls).toHaveLength(1);
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
        expect(await readMatch(after.id)).toEqual({ eventIds: [eventId], cards: [] });
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await countSpeakerEdges()).toBe(0);
      });

      it("adds no speaker card and no checkpoint for a transcript an earlier pipeline finished without them", async () => {
        const { files, file } = await createSourceFile();
        const before = await finishWithoutNotesOrSpeakerProposals(file.id);
        const sourceBefore = await readSourceComputed(files.id, file.id);
        expect(sourceBefore).not.toHaveProperty("suggestSpeakers");
        const cardsBefore = await readCardIds();
        // No Event matched: only the pairing card of the first run is left.
        expect(cardsBefore).toHaveLength(1);
        expect(await readSpeakerCards()).toEqual([]);

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        const after = await readTranscript(file.id);
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual({ ...before.computed, meetingNotes: { ...FAKE_NOTES, actionItems: [] } });
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await readSpeakerCards()).toEqual([]);
        expect(await readSourceComputed(files.id, file.id)).toEqual(sourceBefore);
        // The first run's notes call and the rerun's; nothing else was asked.
        expect(summaryClient.calls.map((call) => call.operation)).toEqual(["transcript_summary", "transcript_summary"]);
        expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 2 });
      });

      it("pays no speaker suggestion call for such a transcript whose Event has a named participant", async () => {
        const { files, file } = await createSourceFile();
        const eventId = await createEvent(FIXTURE_CREATION_TIME);
        const aliceId = await createParticipant(eventId, "Alice");
        summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];
        // The state of a transcript whose Event got its named participant only after it was finished.
        const before = await finishWithoutNotesOrSpeakerProposals(file.id);
        const sourceBefore = await readSourceComputed(files.id, file.id);
        expect(sourceBefore).not.toHaveProperty("suggestSpeakers");
        // The linked Event left no pairing card, and the speaker cards are gone.
        expect(await readCardIds()).toEqual([]);
        const callsBefore = summaryClient.calls.length;

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        // Alice is still an unmapped participant: an unfinished transcript would be asked about here.
        expect(summaryClient.calls.slice(callsBefore).map((call) => call.operation)).toEqual(["transcript_summary"]);
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed).toEqual({ ...before.computed, meetingNotes: { ...FAKE_NOTES, actionItems: [] } });
        expect(await readCardIds()).toEqual([]);
        expect(await readSourceComputed(files.id, file.id)).toEqual(sourceBefore);
        expect(await readMatch(after.id)).toEqual({ eventIds: [eventId], cards: [] });
        expect(await countSpeakerEdges()).toBe(0);
      });

      it("neither links nor proposes an Event again after the user removed the transcript's Event edge", async () => {
        const { file } = await createSourceFile();
        const eventId = await createEvent(FIXTURE_CREATION_TIME);
        const before = await finishWithoutNotes(file.id);
        expect(await readMatch(before.id)).toEqual({ eventIds: [eventId], cards: [] });
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

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        // The Event still starts inside the recording's window: an unfinished transcript would be linked to it.
        expect(await readMatch(before.id)).toEqual({ eventIds: [], cards: [] });
        expect(await readCardIds()).toEqual(cardsBefore);
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
      });

      it("still converges on the Event edge and the speaker checkpoint when an unfinished run resumes", async () => {
        const { files, file } = await createSourceFile();
        const eventId = await createEvent(FIXTURE_CREATION_TIME);
        const aliceId = await createParticipant(eventId, "Alice");
        summaryClient.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];
        const controller = new AbortController();
        /** Requests the shutdown while step 7's call is out: the step still commits, and the run stops before finalize. */
        const interrupting: AiGatewayClientPort = {
          complete: (input) => {
            if (input.operation === "transcript_speaker_suggestion") controller.abort();
            return summaryClient.complete(input);
          },
        };
        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          interrupting,
        )({ fileItemId: file.id }, { ...FIRST_ATTEMPT, abortSignal: controller.signal });
        const interrupted = await readTranscript(file.id);
        expect(interrupted.properties.status).toBe("processing");
        expect(await readMatch(interrupted.id)).toEqual({ eventIds: [eventId], cards: [] });
        const cardsBefore = await readCardIds();
        expect(cardsBefore).toHaveLength(2);
        const sourceBefore = await readSourceComputed(files.id, file.id);
        expect(sourceBefore).toHaveProperty("suggestSpeakers");

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          summaryClient,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        expect((await readTranscript(file.id)).properties.status).toBe("done");
        expect(summaryClient.calls.map((call) => call.operation)).toEqual([
          "transcript_summary",
          "transcript_speaker_suggestion",
        ]);
        expect(await readMatch(interrupted.id)).toEqual({ eventIds: [eventId], cards: [] });
        expect(await readCardIds()).toEqual(cardsBefore);
        expect(await readSourceComputed(files.id, file.id)).toEqual(sourceBefore);
      });

      it("writes no speaker card and no checkpoint when the transcript is finished while the suggestion call is out", async () => {
        const { files, file } = await createSourceFile();
        const eventId = await createEvent(FIXTURE_CREATION_TIME);
        const aliceId = await createParticipant(eventId, "Alice");
        /**
         * Finishes the transcript while this run's suggestion call is out, through the owner-process
         * write finalize uses. It stands in for a concurrent run that had nobody left to ask about and so
         * finished the transcript without the checkpoint.
         */
        class FinishingSummaryClient extends FakeSummaryClient {
          override async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
            if (input.operation === "transcript_speaker_suggestion") {
              const transcript = await readTranscript(file.id);
              await withTransaction(pool, async (client) => {
                const transcripts = await getDatabaseByModuleId(client, "transcripts");
                if (!transcripts) throw new Error("Transcripts database was not seeded");
                await updateItemWithClient(
                  client,
                  { databaseId: transcripts.id, itemId: transcript.id, propertiesPatch: { status: "done" } },
                  { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
                );
              });
            }
            return super.complete(input);
          }
        }
        const finishing = new FinishingSummaryClient();
        finishing.speakerMappings = [{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }];

        await createTranscriptionTask(
          pool,
          blobStorage,
          gatewayClient,
          finishing,
        )({ fileItemId: file.id }, FIRST_ATTEMPT);

        // The call was already out and is paid; its answer is dropped.
        expect(finishing.calls.map((call) => call.operation)).toEqual([
          "transcript_summary",
          "transcript_speaker_suggestion",
        ]);
        expect(await readCardIds()).toEqual([]);
        expect(await readSourceComputed(files.id, file.id)).not.toHaveProperty("suggestSpeakers");
        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(await readMatch(after.id)).toEqual({ eventIds: [eventId], cards: [] });
        expect(await readAutomation(after.id)).toMatchObject({ status: "done", attempts: 1 });
      });

      it("gets its notes from the job the backfill cutover enqueues, and the next cutover run enqueues nothing", async () => {
        const { file } = await createSourceFile();
        const before = await finishWithoutNotes(file.id);
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        const failures: unknown[] = [];
        try {
          await runAsSystem("test cutover", () => runTenantCutoverMigrations(runtime));
          expect(await readTranscriptionJobs()).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);

          const taskList = {
            [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
              CORE_TASK_NAMES.TRANSCRIPTION_JOB,
              createTranscriptionTask(runtime, blobStorage, gatewayClient, summaryClient),
            ),
          };
          await runOnce({ pgPool: pool, taskList });

          expect(await readTranscriptionJobs()).toEqual([]);
          const after = await readTranscript(file.id);
          expect(after.id).toBe(before.id);
          expect(after.properties.status).toBe("done");
          expect(after.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
          expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 2 });
          // The first run's notes call and the rerun's; no audio stage ran again.
          expect(summaryClient.calls.map((call) => call.operation)).toEqual([
            "transcript_summary",
            "transcript_summary",
          ]);
          expect(gatewayClient.diarizeCalls).toHaveLength(1);
          expect(gatewayClient.transcribeCalls).toHaveLength(1);

          await runAsSystem("test cutover", () => runTenantCutoverMigrations(runtime));
          expect(await readTranscriptionJobs()).toEqual([]);
        } catch (error) {
          failures.push(error);
        }
        try {
          await runtime.end();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Backfill cutover test or cleanup failed");
      });

      it("leaves status done and writes no notification when its last attempt fails", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        const cardsBefore = await readCardIds();
        const failure = new Error("simulated summary outage");
        summaryClient.failure = failure;

        await expect(
          createTranscriptionTask(
            pool,
            blobStorage,
            gatewayClient,
            summaryClient,
          )({ fileItemId: file.id }, FINAL_ATTEMPT),
        ).rejects.toMatchObject({ name: "TranscriptionQueueError", message: "Transcription task failed" });

        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual(before.computed);
        expect(await readFailure(after.id)).toEqual([
          { status: "error", error: failure.message, error_code: "unknown", attempts: 2 },
        ]);
        expect(await countNotifications()).toBe(0);
        expect(await readCardIds()).toEqual(cardsBefore);
      });

      it("leaves status done and writes no notification when the gateway budget rejects it", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        summaryClient.failure = new AiGatewayFailedError("budget_exceeded");

        await expect(
          createTranscriptionTask(
            pool,
            blobStorage,
            gatewayClient,
            summaryClient,
          )({ fileItemId: file.id }, FIRST_ATTEMPT),
        ).resolves.toBeUndefined();

        const after = await readTranscript(file.id);
        expect(after.properties).toEqual(before.properties);
        expect(after.computed).toEqual(before.computed);
        expect(await readFailure(after.id)).toMatchObject([
          { status: "error", error_code: "budgetExceeded", attempts: 2 },
        ]);
        expect(await countNotifications()).toBe(0);
      });

      it("is finished by the daily requeue sweep after such a failure, still without a notification", async () => {
        const { file } = await createSourceFile();
        await createUser();
        const before = await finishWithoutNotes(file.id);
        summaryClient.failure = new Error("simulated summary outage");
        const task = createTranscriptionTask(pool, blobStorage, gatewayClient, summaryClient);
        await expect(task({ fileItemId: file.id }, FINAL_ATTEMPT)).rejects.toMatchObject({
          name: "TranscriptionQueueError",
        });
        expect(await readAutomation(before.id)).toMatchObject({ status: "error", attempts: 2 });
        summaryClient.failure = null;

        const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
        if (!transcripts) throw new Error("Transcripts database was not seeded");
        await inTenantZero(() =>
          createTranscriptionRequeueSweepAction(pool)(
            { transcriptsDatabaseId: transcripts.id },
            { heartbeatId: randomUUID(), projectItemId: randomUUID() },
          ),
        );
        expect(await readTranscriptionJobs()).toEqual([{ key: `transcription-job:${file.id}`, attempts: 0 }]);
        await runOnce({
          pgPool: pool,
          taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(CORE_TASK_NAMES.TRANSCRIPTION_JOB, task) },
        });

        const after = await readTranscript(file.id);
        expect(after.properties.status).toBe("done");
        expect(after.computed.meetingNotes).toEqual({ ...FAKE_NOTES, actionItems: [] });
        expect(await readAutomation(after.id)).toEqual({ status: "done", error: null, attempts: 3 });
        expect(await countNotifications()).toBe(0);
      });
    });
  });
});
