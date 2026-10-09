import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createBlob,
  createItemWithClient,
  createPool,
  createUser,
  getDatabaseByModuleId,
  LocalFsBlobStorageWriter,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { CORE_TASK_NAMES, enqueueJob, registerTask, runOnce } from "@semprec/queue";
import {
  currentTenantScope,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
  type TenantScope,
} from "@semprec/shared";
import { createTranscribeQueueRuntime, type TranscribeQueueRuntime } from "./queueRuntime.js";
import { createTranscriptionTask } from "./transcriptionTask.js";
import type {
  AudioGatewayClient,
  DiarizationTurn,
  DiarizeRequest,
  TranscribeRequest,
  TranscriptionResult,
} from "./audioGatewayClient.js";
import { FIXTURE_CREATION_TIME, generateMp4Fixture } from "./__tests__/fixtures/mediaFixtures.js";

const originalMode = process.env.SEMPREC_TENANT_SCOPE;

let resetPool: Pool;
let pool: Pool;
let registry: ModuleRegistry;
let runtime: TranscribeQueueRuntime | undefined;
let tenantZero: string;
let tmpBlobDir: string;
let blobStorage: LocalFsBlobStorageWriter;
let audioFixture: Buffer;
let audioGateway: ScopeRecordingAudioGateway;
let summaryGateway: ScopeRecordingSummaryGateway;

/** Records `currentTenantScope()` on every call, as the HTTP gateway clients will to add the tenant header. */
class ScopeRecordingAudioGateway implements AudioGatewayClient {
  diarizeScopes: (TenantScope | undefined)[] = [];
  transcribeScopes: (TenantScope | undefined)[] = [];
  onTranscribe: () => void = () => {};

  async diarize(_request: DiarizeRequest): Promise<DiarizationTurn[]> {
    this.diarizeScopes.push(currentTenantScope());
    return [
      { speaker: "SPEAKER_00", start: 0, end: 0.5 },
      { speaker: "SPEAKER_01", start: 0.5, end: 1 },
    ];
  }

  async transcribe(_request: TranscribeRequest): Promise<TranscriptionResult> {
    this.transcribeScopes.push(currentTenantScope());
    this.onTranscribe();
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

class ScopeRecordingSummaryGateway implements AiGatewayClientPort {
  completeScopes: (TenantScope | undefined)[] = [];
  failure: Error | null = null;

  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    this.completeScopes.push(currentTenantScope());
    if (this.failure) throw this.failure;
    if (input.operation === "transcript_speaker_suggestion")
      return { content: { mappings: [] }, usage: { inputTokens: 10, outputTokens: 5 } };
    return { content: { summary: "a summary" }, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

/** Runs a fixture write or an assertion read in tenant zero's scope, as strict mode demands. */
function inTenantZero<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantZero, fn);
}

function expectEveryCallInTenantZero(scopes: (TenantScope | undefined)[]): void {
  expect(scopes.length).toBeGreaterThan(0);
  for (const scope of scopes) expect(scope).toEqual({ kind: "tenant", tenantId: tenantZero });
}

function createFileItem(): Promise<{ id: string }> {
  return inTenantZero(async () => {
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
}

function createTaskList() {
  return {
    [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPTION_JOB,
      createTranscriptionTask(pool, blobStorage, audioGateway, summaryGateway),
    ),
  };
}

/** Enqueues in tenant zero's scope, then runs the job from the test body with no ambient scope. */
async function enqueueAndRun(fileItemId: string, maxAttempts: number): Promise<void> {
  await inTenantZero(() =>
    enqueueJob(
      pool,
      CORE_TASK_NAMES.TRANSCRIPTION_JOB,
      { fileItemId },
      { jobKey: `transcription-job:${fileItemId}`, maxAttempts },
    ),
  );
  expect(currentTenantScope()).toBeUndefined();
  await runOnce({ pgPool: pool, taskList: createTaskList() });
}

function readTranscript(fileItemId: string): Promise<{ id: string; status: unknown }> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<{ id: string; status: unknown }>(
      `SELECT t.id, t.properties->>'status' AS status FROM items f JOIN items t ON t.id = (f.computed->>'create')::uuid
       WHERE f.id = $1`,
      [fileItemId],
    );
    if (!rows[0]) throw new Error("expected a transcript for the file");
    return rows[0];
  });
}

describe("transcribe process runs each job inside its tenant under strict enforcement (issue #992)", () => {
  beforeAll(async () => {
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    resetPool ??= getTestPool();
    pool ??= createPool(process.env.TEST_DATABASE_URL!);
    registry ??= await loadFullModuleRegistry();

    // Fixtures are written under the default (warn) mode first; strict is switched on once they exist.
    delete process.env.SEMPREC_TENANT_SCOPE;
    await resetDatabase(resetPool);
    const { rows } = await resetPool.query<{ id: string }>(`SELECT app_sole_tenant() AS id`);
    tenantZero = rows[0]!.id;
    await inTenantZero(async () => {
      await seedSystem(pool);
      await createUser(pool, { email: "owner@example.com", passwordHash: "unused", tenantId: getTenantZeroId() });
    });
    tmpBlobDir = join(tmpdir(), `semprec-transcribe-tenant-test-${randomUUID()}`);
    blobStorage = new LocalFsBlobStorageWriter(tmpBlobDir);
    audioGateway = new ScopeRecordingAudioGateway();
    summaryGateway = new ScopeRecordingSummaryGateway();
    runtime = undefined;
    process.env.SEMPREC_TENANT_SCOPE = "strict";
  });

  afterEach(async () => {
    try {
      await runtime?.stop();
    } finally {
      if (originalMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
      else process.env.SEMPREC_TENANT_SCOPE = originalMode;
      await rm(tmpBlobDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), resetPool?.end()]);
  });

  it("starts and stops the runtime with no ambient scope", async () => {
    expect(currentTenantScope()).toBeUndefined();
    runtime = await createTranscribeQueueRuntime(pool, registry, blobStorage);
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("settles a whole transcription done with every gateway call in its envelope's tenant", async () => {
    const file = await createFileItem();

    await enqueueAndRun(file.id, 3);

    expect((await readTranscript(file.id)).status).toBe("done");
    expectEveryCallInTenantZero(audioGateway.diarizeScopes);
    expectEveryCallInTenantZero(audioGateway.transcribeScopes);
    expectEveryCallInTenantZero(summaryGateway.completeScopes);
  });

  it("re-enqueues on shutdown with an envelope carrying the same tenant", async () => {
    const file = await createFileItem();
    const controller = new AbortController();
    audioGateway.onTranscribe = () => controller.abort();

    await inTenantZero(() =>
      createTranscriptionTask(
        pool,
        blobStorage,
        audioGateway,
        summaryGateway,
      )({ fileItemId: file.id }, { job: { attempts: 1, max_attempts: 3 }, abortSignal: controller.signal }),
    );

    expect(audioGateway.transcribeScopes).toHaveLength(1);
    const { rows } = await inTenantZero(() =>
      pool.query<{ payload: unknown }>("SELECT payload FROM graphile_worker._private_jobs WHERE key = $1", [
        `transcription-job:${file.id}`,
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ tenantId: tenantZero, payload: { fileItemId: file.id } });
  });

  it("records a final failure as error with one notification, without leaving the tenant's scope", async () => {
    const file = await createFileItem();
    summaryGateway.failure = new Error("simulated summary outage");

    await enqueueAndRun(file.id, 1);

    const transcript = await readTranscript(file.id);
    expect(transcript.status).toBe("error");
    const { rows } = await inTenantZero(() =>
      pool.query<{ kind: string }>("SELECT kind FROM notifications WHERE source_id = $1", [transcript.id]),
    );
    expect(rows).toEqual([{ kind: "automation_error" }]);
    expectEveryCallInTenantZero(summaryGateway.completeScopes);
  });
});
