import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createBlob,
  createChokePoint,
  createItemWithClient,
  createTranscriptDeleteRouteHandler,
  createUser,
  createSempStatusRouteHandler,
  createViewTypeRegistry,
  enqueueTranscriptionJob,
  getDatabaseByModuleId,
  LocalFsBlobStorageWriter,
  seedSystem,
  setTenantAiBudget,
  withTransaction,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { AiGatewayClientPort, AiGatewayCompletionInput, AiGatewayCompletionResult } from "@semprec/shared";
import { AiGatewayFailedError } from "@semprec/shared";
import { createTranscriptionTask } from "../transcriptionTask.js";
import type { AudioGatewayClient, DiarizationTurn, TranscriptionResult } from "../audioGatewayClient.js";
import { FIXTURE_CREATION_TIME, generateMp4Fixture } from "./fixtures/mediaFixtures.js";

/**
 * The Semp status problem of a transcript that fails permanently, its resolution when a rerun finishes,
 * its silent resolution when the transcript is deleted, and the `transcription` service entry (issue
 * gh-1945). The pipeline runs the production task over a `semprec_data` pool inside a tenant with fake
 * audio and summary gateways, like the other transcribe tests; problems and jobs are read through the
 * status report of a runtime-role pool or, for the stored columns, through the admin pool.
 */

const FINAL_ATTEMPT = { job: { attempts: 3, max_attempts: 3 } };
const FIRST_ATTEMPT = { job: { attempts: 1, max_attempts: 3 } };

class FakeAudioGateway implements AudioGatewayClient {
  async diarize(): Promise<DiarizationTurn[]> {
    return [
      { speaker: "SPEAKER_00", start: 0, end: 0.5 },
      { speaker: "SPEAKER_01", start: 0.5, end: 1 },
    ];
  }
  async transcribe(): Promise<TranscriptionResult> {
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

/** Answers every request with fixed notes (or an empty speaker and Event suggestion), or fails with `failure`. */
class FakeSummaryClient implements AiGatewayClientPort {
  failure: Error | null = null;
  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    if (this.failure) throw this.failure;
    const usage = { inputTokens: 10, outputTokens: 5 };
    if (input.operation === "transcript_speaker_suggestion") return { content: { mappings: [] }, usage };
    if (input.operation === "transcript_event_match")
      return { content: { eventId: null, reason: "Cannot tell." }, usage };
    return {
      content: {
        title: "Greeting",
        summary: "{SPEAKER_00} greets {SPEAKER_01}.",
        shortSummary: "A greeting.",
        decisions: ["Keep greeting"],
        actionItems: [],
      },
      usage,
    };
  }
}

interface Tenant {
  id: string;
  userId: string | null;
}

const problemRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  category: z.string(),
  kind: z.string(),
  severity: z.string(),
  source_table: z.string(),
  source_id: z.uuid(),
  dedupe_key: z.string(),
  occurrence_count: z.number(),
  resolved_at: z.date().nullable(),
  resolution_kind: z.string().nullable(),
  first_seen_at: z.date(),
});

let admin: Pool;
let runtime: Pool;
let blobDir: string;
let blobStorage: LocalFsBlobStorageWriter;
let audioFixture: Buffer;
let summary: FakeSummaryClient;
let own: Tenant;
let foreign: Tenant;
let bare: Tenant;

describe("Semp status problems of transcriptions (issue gh-1945)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    audioFixture = await generateMp4Fixture({ creationTime: FIXTURE_CREATION_TIME });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    blobDir = await mkdtemp(join(tmpdir(), "semprec-transcription-problems-"));
    blobStorage = new LocalFsBlobStorageWriter(blobDir);
    summary = new FakeSummaryClient();
    own = await buildTenant(true);
    foreign = await buildTenant(true);
    bare = await buildTenant(false);
  });

  afterEach(async () => {
    // A test that installs a fault trigger removes it itself; this covers a test that failed before doing so.
    await admin.query("DROP TRIGGER IF EXISTS semp_problems_test_fault ON semp_problems");
    await rm(blobDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** A tenant with the seeded system databases and an AI budget row (a tenant without one lists `aiBudgetMissing`). */
  async function buildTenant(withUser: boolean): Promise<Tenant> {
    const id = await createTestTenant(admin);
    const user = withUser
      ? await runAsSystem("transcription problems test user", () =>
          createUser(admin, {
            tenantId: id,
            email: `${randomUUID()}@example.test`,
            passwordHash: "unused",
            locale: "en",
          }),
        )
      : null;
    await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
    if (user)
      await runAsSystem("transcription problems test budget", () =>
        withTransaction(runtime, (client) =>
          setTenantAiBudget(client, { tenantId: id, updatedBy: user.id, dailyCapUsd: null, monthlyCapUsd: null }),
        ),
      );
    return { id, userId: user?.id ?? null };
  }

  /** An audio Files item of `tenant` whose bytes are the fixture, so the pipeline runs for real. */
  async function createSourceFile(tenant: Tenant): Promise<string> {
    return runInTenant(tenant.id, async () => {
      const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!files) throw new Error("Files database was not seeded");
      const storageKey = `source/${randomUUID()}`;
      await blobStorage.writeStream(storageKey, Readable.from(audioFixture));
      const blob = await withTransaction(runtime, (client) =>
        createBlob(client, { mimeType: "audio/mp4", byteSize: audioFixture.byteLength, storageKey }),
      );
      const file = await withTransaction(runtime, (client) =>
        createItemWithClient(client, {
          databaseId: files.id,
          properties: { name: "recording", file: { blobId: blob.id } },
        }),
      );
      return file.id;
    });
  }

  function runTask(tenant: Tenant, fileItemId: string, helpers: typeof FINAL_ATTEMPT): Promise<void> {
    return runInTenant(tenant.id, () =>
      createTranscriptionTask(runtime, blobStorage, new FakeAudioGateway(), summary)({ fileItemId }, helpers),
    );
  }

  /** Runs the task and expects it to fail, as every attempt of a failing summary does. */
  async function runFailing(tenant: Tenant, fileItemId: string, helpers: typeof FINAL_ATTEMPT): Promise<void> {
    summary.failure = new AiGatewayFailedError("http");
    await expect(runTask(tenant, fileItemId, helpers)).rejects.toMatchObject({ name: "TranscriptionQueueError" });
  }

  async function transcriptOf(fileItemId: string) {
    const { rows } = await admin.query<{ id: string; status: unknown; name: unknown }>(
      `SELECT t.id, t.properties->'status' AS status, t.properties->'name' AS name FROM items f
         JOIN items t ON t.id = (f.computed->>'create')::uuid WHERE f.id = $1`,
      [fileItemId],
    );
    const row = rows[0];
    if (!row) throw new Error("expected a transcript for the file");
    return { id: row.id, status: row.status, name: z.string().nullable().parse(row.name) };
  }

  /** Gives the transcript a user-entered name, as a user does; the pipeline never writes one. */
  async function nameTranscript(tenant: Tenant, transcriptId: string, name: string): Promise<void> {
    await runInTenant(tenant.id, async () => {
      const transcripts = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "transcripts"));
      if (!transcripts) throw new Error("Transcripts database was not seeded");
      await createChokePoint(runtime).updateItem({
        databaseId: transcripts.id,
        itemId: transcriptId,
        propertiesPatch: { name },
      });
    });
  }

  async function problemsOf(transcriptId: string) {
    const { rows } = await admin.query<Record<string, unknown>>(
      "SELECT * FROM semp_problems WHERE dedupe_key = $1 ORDER BY first_seen_at, id",
      [`transcription:${transcriptId}`],
    );
    return z.array(problemRowSchema.passthrough()).parse(rows);
  }

  async function countNotifications(transcriptId: string): Promise<number> {
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notifications WHERE source_id = $1",
      [transcriptId],
    );
    return rows[0]?.count ?? 0;
  }

  function userOf(tenant: Tenant): string {
    if (!tenant.userId) throw new Error("The tenant has no user");
    return tenant.userId;
  }

  const report = async (tenant: Tenant) =>
    (await runInTenant(tenant.id, () => createSempStatusRouteHandler(runtime)())).body;

  /** A transcript that failed permanently once: its file id, its id and the problem it raised. */
  async function failedTranscript(tenant: Tenant) {
    const fileItemId = await createSourceFile(tenant);
    await runFailing(tenant, fileItemId, FINAL_ATTEMPT);
    const transcript = await transcriptOf(fileItemId);
    return { fileItemId, transcript, problem: (await problemsOf(transcript.id))[0] };
  }

  describe("raising", () => {
    it("creates one active transcription problem when a transcript fails permanently, and merges a second failure into it", async () => {
      const fileItemId = await createSourceFile(own);

      await runFailing(own, fileItemId, FINAL_ATTEMPT);

      const transcript = await transcriptOf(fileItemId);
      const [first, ...others] = await problemsOf(transcript.id);
      expect(others).toEqual([]);
      expect(first).toMatchObject({
        user_id: own.userId,
        category: "transcription",
        kind: "transcriptionFailed",
        severity: "warning",
        source_table: "item_automation",
        source_id: transcript.id,
        dedupe_key: `transcription:${transcript.id}`,
        occurrence_count: 1,
        resolved_at: null,
        resolution_kind: null,
      });

      await runFailing(own, fileItemId, FINAL_ATTEMPT);

      const again = await problemsOf(transcript.id);
      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({ id: first!.id, occurrence_count: 2, resolved_at: null });
    });

    it("lists the problem as active with the transcript's name and a retry action", async () => {
      const { transcript, problem } = await failedTranscript(own);
      await nameTranscript(own, transcript.id, "Quarterly planning");

      const listed = (await report(own)).problems.find((entry) => entry.id === problem!.id);

      expect(listed).toMatchObject({
        category: "transcription",
        source: { table: "item_automation", id: transcript.id },
        mergedCount: 1,
        actions: [{ kind: "retryTranscription", target: transcript.id }],
      });
      expect(listed?.text).toContain("Quarterly planning");
    });

    it("raises no problem for a transient failure", async () => {
      const fileItemId = await createSourceFile(own);

      await runFailing(own, fileItemId, FIRST_ATTEMPT);

      const transcript = await transcriptOf(fileItemId);
      expect(await problemsOf(transcript.id)).toEqual([]);
      expect(await countNotifications(transcript.id)).toBe(0);
    });

    it("raises no problem for a permanent failure of a transcript that is already done", async () => {
      const fileItemId = await createSourceFile(own);
      await runTask(own, fileItemId, FIRST_ATTEMPT);
      const transcript = await transcriptOf(fileItemId);
      expect(transcript.status).toBe("done");
      // Raw SQL: no production write removes the notes of a finished transcript, which only a transcript finished
      // before issue #1695 lacks; their absence makes the rerun reach the summary step, which fails here.
      const stripped = await admin.query("UPDATE items SET computed = computed - 'meetingNotes' WHERE id = $1", [
        transcript.id,
      ]);
      expect(stripped.rowCount).toBe(1);

      await runFailing(own, fileItemId, FINAL_ATTEMPT);

      expect((await transcriptOf(fileItemId)).status).toBe("done");
      expect(await problemsOf(transcript.id)).toEqual([]);
      expect(await countNotifications(transcript.id)).toBe(0);
    });

    it("raises no problem, and no notification, in a tenant without a user", async () => {
      const fileItemId = await createSourceFile(bare);

      await runFailing(bare, fileItemId, FINAL_ATTEMPT);

      const transcript = await transcriptOf(fileItemId);
      expect(transcript.status).toBe("error");
      expect(await problemsOf(transcript.id)).toEqual([]);
      expect(await countNotifications(transcript.id)).toBe(0);
    });

    it("leaves no problem and no notification when the failure's transaction rolls back", async () => {
      const fileItemId = await createSourceFile(own);
      // Raw DDL: a fault the raise hits after the failure's other writes, so the whole recording must roll back.
      await admin.query(
        `CREATE FUNCTION semp_problems_test_fault() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$`,
      );
      await admin.query(
        "CREATE TRIGGER semp_problems_test_fault BEFORE INSERT ON semp_problems FOR EACH ROW EXECUTE FUNCTION semp_problems_test_fault()",
      );
      try {
        await runFailing(own, fileItemId, FINAL_ATTEMPT);
      } finally {
        await admin.query("DROP TRIGGER semp_problems_test_fault ON semp_problems");
        await admin.query("DROP FUNCTION semp_problems_test_fault()");
      }

      const transcript = await transcriptOf(fileItemId);
      expect(await problemsOf(transcript.id)).toEqual([]);
      expect(await countNotifications(transcript.id)).toBe(0);
      expect(transcript.status).not.toBe("error");
      const automation = await admin.query<{ status: string }>(
        "SELECT status FROM item_automation WHERE item_id = $1",
        [transcript.id],
      );
      expect(automation.rows).toEqual([{ status: "pending" }]);
    });
  });

  describe("resolving", () => {
    it("resolves the problem as recovered when a rerun finishes, and lists it in the recent history with the transcript's name", async () => {
      const { fileItemId, transcript, problem } = await failedTranscript(own);
      await nameTranscript(own, transcript.id, "Quarterly planning");

      summary.failure = null;
      await runTask(own, fileItemId, FIRST_ATTEMPT);

      expect((await transcriptOf(fileItemId)).status).toBe("done");
      const [resolved, ...others] = await problemsOf(transcript.id);
      expect(others).toEqual([]);
      expect(resolved).toMatchObject({ id: problem!.id, resolution_kind: "recovered" });
      expect(resolved?.resolved_at).toBeInstanceOf(Date);
      const after = await report(own);
      expect(after.problems.map((entry) => entry.id)).not.toContain(problem!.id);
      expect(after.resolvedRecent).toEqual([
        {
          id: problem!.id,
          category: "transcription",
          resolutionTitle: "Transcript 'Quarterly planning' completed",
          resolvedAt: resolved!.resolved_at!.toISOString(),
        },
      ]);
    });

    it("writes the neutral word in the history title of a transcript that has no name", async () => {
      const { fileItemId, transcript, problem } = await failedTranscript(own);
      expect(transcript.name).toBeNull();

      summary.failure = null;
      await runTask(own, fileItemId, FIRST_ATTEMPT);

      expect((await report(own)).resolvedRecent).toEqual([
        expect.objectContaining({ id: problem!.id, resolutionTitle: "Transcript '(unnamed)' completed" }),
      ]);
    });

    it("keeps the problem active and the transcript unfinished when the finalize transaction rolls back", async () => {
      const { fileItemId, transcript, problem } = await failedTranscript(own);
      // Raw DDL: a fault the resolve hits after the finalize step's other writes, so the step must roll back as one.
      await admin.query(
        `CREATE FUNCTION semp_problems_test_fault() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$`,
      );
      await admin.query(
        "CREATE TRIGGER semp_problems_test_fault BEFORE UPDATE ON semp_problems FOR EACH ROW EXECUTE FUNCTION semp_problems_test_fault()",
      );
      summary.failure = null;
      try {
        await expect(runTask(own, fileItemId, FIRST_ATTEMPT)).rejects.toMatchObject({
          name: "TranscriptionQueueError",
        });
      } finally {
        await admin.query("DROP TRIGGER semp_problems_test_fault ON semp_problems");
        await admin.query("DROP FUNCTION semp_problems_test_fault()");
      }

      expect((await transcriptOf(fileItemId)).status).toBe("error");
      const stored = await problemsOf(transcript.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: problem!.id, resolved_at: null, resolution_kind: null });
      expect((await report(own)).resolvedRecent).toEqual([]);
    });

    it("resolves the problem silently when the transcript is deleted, and leaves another transcript's problem alone", async () => {
      const deleted = await failedTranscript(own);
      const kept = await failedTranscript(own);

      const response = await runInTenant(own.id, () =>
        createTranscriptDeleteRouteHandler(runtime)({
          params: { id: deleted.transcript.id },
          identity: { user: { id: userOf(own) } },
        }),
      );

      expect(response).toMatchObject({ status: 200 });
      expect((await problemsOf(deleted.transcript.id))[0]).toMatchObject({
        id: deleted.problem!.id,
        resolution_kind: "sourceDeleted",
      });
      expect((await problemsOf(kept.transcript.id))[0]).toMatchObject({ id: kept.problem!.id, resolved_at: null });
      const after = await report(own);
      expect(after.problems.map((entry) => entry.id)).toEqual(expect.arrayContaining([kept.problem!.id]));
      expect(after.problems.map((entry) => entry.id)).not.toContain(deleted.problem!.id);
      expect(after.resolvedRecent).toEqual([]);
    });

    it("changes nothing when a transcript without a problem is deleted", async () => {
      const fileItemId = await createSourceFile(own);
      await runTask(own, fileItemId, FIRST_ATTEMPT);
      const transcript = await transcriptOf(fileItemId);

      const response = await runInTenant(own.id, () =>
        createTranscriptDeleteRouteHandler(runtime)({
          params: { id: transcript.id },
          identity: { user: { id: userOf(own) } },
        }),
      );

      expect(response).toMatchObject({ status: 200 });
      expect(await problemsOf(transcript.id)).toEqual([]);
    });
  });

  describe("the transcription service entry", () => {
    /** Enqueues `count` transcription jobs in `tenant`'s scope, like the producers of the pipeline do. */
    async function enqueueJobs(tenant: Tenant, count: number): Promise<string[]> {
      const fileItemIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const fileItemId = randomUUID();
        fileItemIds.push(fileItemId);
        await runInTenant(tenant.id, () =>
          withTransaction(runtime, (client) => enqueueTranscriptionJob(client, { fileItemId })),
        );
      }
      return fileItemIds;
    }

    /**
     * Marks the job of `fileItemId` as taken by a worker, or as one that used up its attempts. Raw SQL on the
     * private tables of graphile-worker 0.17.x: a job is `running` only inside a worker's handler, which
     * a test cannot hold open from outside the queue's own loop.
     */
    async function setJobState(fileItemId: string, state: "running" | "exhausted"): Promise<void> {
      const result = await admin.query(
        state === "running"
          ? "UPDATE graphile_worker._private_jobs SET locked_at = now(), locked_by = 'test-worker' WHERE key = $1"
          : "UPDATE graphile_worker._private_jobs SET attempts = max_attempts WHERE key = $1",
        [`transcription-job:${fileItemId}`],
      );
      expect(result.rowCount).toBe(1);
    }

    async function service(tenant: Tenant) {
      const found = (await report(tenant)).services.find((entry) => entry.key === "transcription");
      if (!found) throw new Error("The report has no transcription service");
      return found;
    }

    it("counts only the tenant's own queued and running transcription jobs", async () => {
      const [, taken] = await enqueueJobs(own, 3);
      await setJobState(taken!, "running");
      await enqueueJobs(foreign, 2);

      expect(await service(own)).toMatchObject({
        key: "transcription",
        name: "Meeting transcripts",
        detail: { queued: 2, running: 1 },
      });
      expect(await service(foreign)).toMatchObject({ detail: { queued: 2, running: 0 } });
    });

    it("reports zero queued and running jobs for a tenant with none, even while another tenant has some", async () => {
      await enqueueJobs(foreign, 2);

      expect(await service(own)).toMatchObject({ state: "ok", since: null, detail: { queued: 0, running: 0 } });
    });

    it("counts neither a job that used up its attempts nor a job of another task", async () => {
      const [exhausted] = await enqueueJobs(own, 2);
      await setJobState(exhausted!, "exhausted");
      await runInTenant(own.id, () =>
        withTransaction(runtime, (client) =>
          enqueueJob(client, CORE_TASK_NAMES.TRANSCRIPTION_CREATE, { fileItemId: randomUUID() }),
        ),
      );

      expect((await service(own)).detail).toEqual({ queued: 1, running: 0 });
    });

    it("is in error since the first report of the active problem, and ok again once it is resolved", async () => {
      const { fileItemId, problem } = await failedTranscript(own);

      expect(await service(own)).toMatchObject({
        state: "error",
        since: problem!.first_seen_at.toISOString(),
        detail: { queued: 0, running: 0 },
      });
      expect(await service(foreign)).toMatchObject({ state: "ok", since: null });

      summary.failure = null;
      await runTask(own, fileItemId, FIRST_ATTEMPT);

      expect(await service(own)).toMatchObject({ state: "ok", since: null });
    });
  });
});
