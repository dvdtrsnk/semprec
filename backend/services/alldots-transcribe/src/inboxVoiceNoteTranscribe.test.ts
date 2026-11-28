import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, registerTask, runOnce, type TaskList } from "@alldots/queue";
import { runInTenant } from "@alldots/shared";
import {
  createActionQueueAffinity,
  createBlob,
  createItemWithClient,
  enqueueInboxAttachmentMetadata,
  enqueueInboxVoiceNoteTranscribe,
  getDatabaseByModuleId,
  getInboxAttachment,
  ingestUploadedBlob,
  insertInboxAttachments,
  itemDeleteWithClient,
  LocalFsBlobStorageWriter,
  recordInboxAttachmentMetadata,
  seedSystem,
  withTransaction,
  installQueueSchema,
} from "@alldots/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@alldots/data/testSupport";
import {
  AudioGatewayBudgetExceededError,
  AudioGatewayCallError,
  type AudioGatewayClient,
  type TranscribeRequest,
  type TranscriptionResult,
} from "./audioGatewayClient.js";
import { createInboxAttachmentMetadataTask } from "./inboxAttachmentMetadata.js";
import { createInboxVoiceNoteTranscribeTask, MAX_VOICE_NOTE_BYTES } from "./inboxVoiceNoteTranscribe.js";
import { generateImageFixture, generateM4aFixture } from "./__tests__/fixtures/mediaFixtures.js";

// The real metadata job (real ffprobe) queues the job under test; the gateway is a recording fake, on the
// runtime role pool with a second tenant. The default HTTP client is proven against a local server.

/** A local-filesystem storage that remembers which keys were read. */
class ObservedStorage extends LocalFsBlobStorageWriter {
  reads: string[] = [];

  override readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    this.reads.push(storageKey);
    return super.readStream(storageKey, range);
  }
}

/** A gateway that answers each request with `respond`, and records every request it got. */
class FakeAudioGateway implements AudioGatewayClient {
  requests: TranscribeRequest[] = [];
  respond: (request: TranscribeRequest) => Promise<string> | string = (request) =>
    `Note of ${request.audioSeconds} seconds.`;

  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    this.requests.push(request);
    return { text: await this.respond(request), language: "en", segments: [] };
  }

  async diarize(): Promise<never> {
    throw new Error("The voice note job never diarizes");
  }
}

const propertiesRowSchema = z.object({ properties: z.record(z.string(), z.unknown()) });

let adminPool: Pool;
let runtimePool: Pool;
let blobDir: string;
let storage: ObservedStorage;
let gateway: FakeAudioGateway;
let tenantA: string;
let tenantB: string;
let allTasks: TaskList;
let metadataTasks: TaskList;
let previousScope: string | undefined;

beforeAll(async () => {
  previousScope = process.env.ALLDOTS_TENANT_SCOPE;
  process.env.ALLDOTS_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  runtimePool = await createRuntimeRolePool(adminPool, "alldots_data");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  await installQueueSchema(adminPool);
  blobDir = await mkdtemp(join(tmpdir(), "alldots-inbox-voice-note-"));
  storage = new ObservedStorage(blobDir);
  gateway = new FakeAudioGateway();
  tenantA = await createTestTenant(adminPool);
  tenantB = await createTestTenant(adminPool);
  await runInTenant(tenantA, () => seedSystem(runtimePool));
  await runInTenant(tenantB, () => seedSystem(runtimePool));
  metadataTasks = {
    [CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA]: registerTask(
      CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA,
      createInboxAttachmentMetadataTask(runtimePool, storage),
    ),
  };
  allTasks = {
    ...metadataTasks,
    [CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE]: registerTask(
      CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE,
      createInboxVoiceNoteTranscribeTask(runtimePool, storage, gateway),
    ),
  };
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
  if (previousScope === undefined) delete process.env.ALLDOTS_TENANT_SCOPE;
  else process.env.ALLDOTS_TENANT_SCOPE = previousScope;
});

function inTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(runtimePool, fn));
}

async function inboxDatabaseId(client: PoolClient): Promise<string> {
  const inbox = await getDatabaseByModuleId(client, "inbox");
  if (!inbox) throw new Error("The Inbox database was not seeded");
  return inbox.id;
}

interface Attached {
  attachmentId: string;
  inboxItemId: string;
}

/** Uploads `bytes` as `POST /api/blobs` does and attaches them to `itemId`, or to a new item with `text`, queueing the metadata job. */
async function attachAudio(
  tenant: string,
  bytes: Buffer,
  options: { itemId?: string; text?: string } = {},
): Promise<Attached> {
  return runInTenant(tenant, async () => {
    const { blob } = await ingestUploadedBlob(runtimePool, {
      mimeType: "application/octet-stream",
      source: Readable.from([bytes]),
      maxBytes: 64 * 1024 * 1024,
      storage,
    });
    return withTransaction(runtimePool, async (client) => {
      const inboxItemId =
        options.itemId ??
        (
          await createItemWithClient(client, {
            databaseId: await inboxDatabaseId(client),
            properties: { date: "2026-11-02", time: "10:15", text: options.text ?? "Typed by hand" },
          })
        ).id;
      const [attachmentId] = await insertInboxAttachments(client, inboxItemId, [{ blobId: blob.id, source: "files" }]);
      if (attachmentId === undefined) throw new Error("No attachment was inserted");
      await enqueueInboxAttachmentMetadata(client, attachmentId);
      return { attachmentId, inboxItemId };
    });
  });
}

/** Raw `createBlob`, so a test can state a size the file does not have. */
async function attachRecorded(
  tenant: string,
  itemId: string,
  options: { bytes: Buffer; declaredByteSize: number; durationSeconds: number },
): Promise<string> {
  const storageKey = `${tenant}/blobs/${randomUUID()}`;
  await storage.writeStream(storageKey, Readable.from([options.bytes]));
  return inTenant(tenant, async (client) => {
    const blob = await createBlob(client, {
      mimeType: "audio/mp4",
      byteSize: options.declaredByteSize,
      storageKey,
    });
    const [attachmentId] = await insertInboxAttachments(client, itemId, [{ blobId: blob.id, source: "files" }]);
    if (attachmentId === undefined) throw new Error("No attachment was inserted");
    await recordInboxAttachmentMetadata(client, {
      attachmentId,
      metadata: { durationSeconds: options.durationSeconds, audioKind: "voiceNote", pages: null },
      thumbnail: null,
      reduced: null,
    });
    return attachmentId;
  });
}

/** Runs the queue until no job of `list` is waiting for its first attempt; a job that failed stays with its attempt counted. */
async function runQueue(list: TaskList = allTasks): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await runOnce({ pgPool: runtimePool, taskList: list });
    const { rows } = await adminPool.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM graphile_worker.jobs WHERE task_identifier = ANY($1::text[]) AND attempts = 0 AND run_at <= now()",
      [Object.keys(list)],
    );
    if (rows[0]?.waiting === 0) return;
  }
  throw new Error("The queue still holds jobs after ten rounds");
}

async function propertiesOf(tenant: string, itemId: string): Promise<Record<string, unknown>> {
  return runInTenant(tenant, () =>
    withTenantTransaction(runtimePool, tenant, async (client) => {
      const { rows } = await client.query("SELECT properties FROM items WHERE id = $1", [itemId]);
      return propertiesRowSchema.parse(rows[0]).properties;
    }),
  );
}

async function itemRow(tenant: string, itemId: string): Promise<string> {
  return runInTenant(tenant, () =>
    withTenantTransaction(runtimePool, tenant, async (client) => {
      const { rows } = await client.query<{ row: string }>("SELECT i::text AS row FROM items i WHERE id = $1", [
        itemId,
      ]);
      return rows[0]?.row ?? "missing";
    }),
  );
}

interface VoiceJob {
  id: string;
  key: string | null;
  attempts: number;
  lastError: string | null;
}

/** The transcription jobs still in the queue: a completed job is deleted by graphile-worker, a failed one stays. */
async function voiceJobs(): Promise<VoiceJob[]> {
  const { rows } = await adminPool.query<{
    id: string;
    key: string | null;
    attempts: number;
    last_error: string | null;
  }>("SELECT id::text AS id, key, attempts, last_error FROM graphile_worker.jobs WHERE task_identifier = $1", [
    CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE,
  ]);
  return rows.map((row) => ({ id: row.id, key: row.key, attempts: row.attempts, lastError: row.last_error }));
}

/** Makes every failed job of the queue due now, as graphile-worker's own backoff would after its delay. */
async function retryFailedJobsNow(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.reschedule_jobs((SELECT array_agg(id) FROM graphile_worker.jobs WHERE attempts > 0), run_at := now())",
  );
}

/** Drops the heartbeat jobs the writes so far queued, so only those of the call under test are seen. */
async function clearHeartbeatJobs(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.remove_job(key) FROM graphile_worker.jobs WHERE task_identifier = $1 AND key IS NOT NULL",
    [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE],
  );
}

async function heartbeatJobCount(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = $1",
    [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE],
  );
  return rows[0]?.n ?? -1;
}

function enqueueVoiceJob(tenant: string, itemId: string): Promise<void> {
  return inTenant(tenant, (client) => enqueueInboxVoiceNoteTranscribe(client, itemId));
}

describe("the inboxVoiceNoteTranscribe job (issue gh-1980)", () => {
  describe("one voice note", () => {
    it.each([
      { label: "a person who typed a text", text: "Blood pressure 135/85" },
      { label: "a person who typed nothing", text: "" },
    ])("fills transcribedText from a 40-second note and leaves the text of $label unchanged", async ({ text }) => {
      const bytes = await generateM4aFixture(40);
      const note = await attachAudio(tenantA, bytes, { text });

      await runQueue();

      expect(await propertiesOf(tenantA, note.inboxItemId)).toEqual({
        date: "2026-11-02",
        time: "10:15",
        text,
        transcribedText: "Note of 40 seconds.",
      });
      expect(gateway.requests).toHaveLength(1);
      const [request] = gateway.requests;
      expect(Buffer.from(request?.audio ?? []).equals(bytes)).toBe(true);
      expect(request?.audioSeconds).toBe(40);
      expect(request?.language).toBeUndefined();
      const stored = await inTenant(tenantA, (client) => getInboxAttachment(client, note.attachmentId));
      expect(request?.mimeType).toBe(stored?.mimeType);
      expect(request?.mimeType).toMatch(/^audio\//);
      expect(await voiceJobs()).toEqual([]);
    });

    it("transcribes only the notes shorter than 120 seconds: 119 is transcribed, 120 and 121 are not", async () => {
      const outcomes: Array<{ seconds: number; transcribed: unknown; requests: number }> = [];
      for (const seconds of [119, 120, 121]) {
        gateway.requests = [];
        const note = await attachAudio(tenantA, await generateM4aFixture(seconds));
        await runQueue();
        outcomes.push({
          seconds,
          transcribed: (await propertiesOf(tenantA, note.inboxItemId)).transcribedText ?? null,
          requests: gateway.requests.length,
        });
      }

      expect(outcomes).toEqual([
        { seconds: 119, transcribed: "Note of 119 seconds.", requests: 1 },
        { seconds: 120, transcribed: null, requests: 0 },
        { seconds: 121, transcribed: null, requests: 0 },
      ]);
    });

    it("leaves a recording of the same item out of the transcript, and transcribes its voice note", async () => {
      const note = await attachAudio(tenantA, await generateM4aFixture(40));
      await attachAudio(tenantA, await generateM4aFixture(121), { itemId: note.inboxItemId });

      await runQueue();

      expect(gateway.requests.map((request) => request.audioSeconds)).toEqual([40]);
      expect((await propertiesOf(tenantA, note.inboxItemId)).transcribedText).toBe("Note of 40 seconds.");
    });
  });

  describe("several voice notes", () => {
    it("joins the transcripts with a blank line in the order of the notes, not of their length or of the jobs", async () => {
      const first = await attachAudio(tenantA, await generateM4aFixture(50));
      await attachAudio(tenantA, await generateM4aFixture(30), { itemId: first.inboxItemId });
      // Both metadata jobs first, so the transcription runs once over both notes.
      await runQueue(metadataTasks);

      await runQueue();

      expect(await propertiesOf(tenantA, first.inboxItemId)).toMatchObject({
        text: "Typed by hand",
        transcribedText: "Note of 50 seconds.\n\nNote of 30 seconds.",
      });
      expect(gateway.requests.map((request) => request.audioSeconds)).toEqual([50, 30]);
    });

    it("trims each transcript and leaves a note that said nothing out of the join", async () => {
      gateway.respond = (request) => (request.audioSeconds === 30 ? "   " : `  Note of ${request.audioSeconds}.  \n`);
      const first = await attachAudio(tenantA, await generateM4aFixture(30));
      await attachAudio(tenantA, await generateM4aFixture(50), { itemId: first.inboxItemId });
      await attachAudio(tenantA, await generateM4aFixture(60), { itemId: first.inboxItemId });
      await runQueue(metadataTasks);

      await runQueue();

      expect((await propertiesOf(tenantA, first.inboxItemId)).transcribedText).toBe("Note of 50.\n\nNote of 60.");
    });

    it("does not transcribe a note larger than the cap and joins the others", async () => {
      const first = await attachAudio(tenantA, await generateM4aFixture(30));
      await runQueue(metadataTasks);
      const oversized = await attachRecorded(tenantA, first.inboxItemId, {
        bytes: Buffer.from("not read"),
        declaredByteSize: MAX_VOICE_NOTE_BYTES + 1,
        durationSeconds: 45,
      });
      // A note of exactly the cap is still sent.
      await attachRecorded(tenantA, first.inboxItemId, {
        bytes: await generateM4aFixture(20),
        declaredByteSize: MAX_VOICE_NOTE_BYTES,
        durationSeconds: 20,
      });
      storage.reads = [];

      await runQueue();

      expect(gateway.requests.map((request) => request.audioSeconds)).toEqual([30, 20]);
      expect((await propertiesOf(tenantA, first.inboxItemId)).transcribedText).toBe(
        "Note of 30 seconds.\n\nNote of 20 seconds.",
      );
      const oversizedKey = await inTenant(tenantA, async (client) => {
        const row = await getInboxAttachment(client, oversized);
        const { rows } = await client.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
          row?.blobId,
        ]);
        return rows[0]?.storage_key;
      });
      expect(oversizedKey).toBeDefined();
      expect(storage.reads).not.toContain(oversizedKey);
    });
  });

  describe("a rerun", () => {
    it("writes nothing when it finds the text that is stored: no row changes and nothing is announced", async () => {
      const note = await attachAudio(tenantA, await generateM4aFixture(40));
      await runQueue();
      const written = await itemRow(tenantA, note.inboxItemId);
      await clearHeartbeatJobs();

      await enqueueVoiceJob(tenantA, note.inboxItemId);
      await runQueue();

      expect(gateway.requests).toHaveLength(2);
      expect(await itemRow(tenantA, note.inboxItemId)).toBe(written);
      expect(await heartbeatJobCount()).toBe(0);
    });

    it("writes the new text when the transcript is different, and announces the update", async () => {
      const note = await attachAudio(tenantA, await generateM4aFixture(40));
      await runQueue();
      await clearHeartbeatJobs();
      gateway.respond = () => "A better transcript.";

      await enqueueVoiceJob(tenantA, note.inboxItemId);
      await runQueue();

      expect(await propertiesOf(tenantA, note.inboxItemId)).toMatchObject({
        text: "Typed by hand",
        transcribedText: "A better transcript.",
      });
      expect(await heartbeatJobCount()).toBeGreaterThan(0);
    });

    it("covers every voice note when a second one is attached later", async () => {
      const first = await attachAudio(tenantA, await generateM4aFixture(30));
      await runQueue();
      expect((await propertiesOf(tenantA, first.inboxItemId)).transcribedText).toBe("Note of 30 seconds.");

      await attachAudio(tenantA, await generateM4aFixture(40), { itemId: first.inboxItemId });
      await runQueue();

      expect((await propertiesOf(tenantA, first.inboxItemId)).transcribedText).toBe(
        "Note of 30 seconds.\n\nNote of 40 seconds.",
      );
    });
  });

  describe("when the gateway fails", () => {
    it.each([
      { label: "a call that failed", failure: new AudioGatewayCallError("Gateway responded with HTTP 502") },
      { label: "a budget refusal", failure: new AudioGatewayBudgetExceededError() },
    ])(
      "fails the job for a retry on $label, changes nothing, and writes the text when the retry succeeds",
      async ({ failure }) => {
        gateway.respond = () => {
          throw failure;
        };
        const note = await attachAudio(tenantA, await generateM4aFixture(40), { text: "Typed by hand" });

        await runQueue();

        const [job, ...others] = await voiceJobs();
        expect(others).toEqual([]);
        expect(job).toMatchObject({ key: `inbox-voice-note:${note.inboxItemId}`, attempts: 1 });
        expect(job?.lastError).toContain(failure.message);
        expect(await propertiesOf(tenantA, note.inboxItemId)).toEqual({
          date: "2026-11-02",
          time: "10:15",
          text: "Typed by hand",
        });

        gateway.respond = (request) => `Note of ${request.audioSeconds} seconds.`;
        await retryFailedJobsNow();
        await runQueue();

        expect(await voiceJobs()).toEqual([]);
        expect(await propertiesOf(tenantA, note.inboxItemId)).toMatchObject({
          text: "Typed by hand",
          transcribedText: "Note of 40 seconds.",
        });
      },
    );

    it("keeps an earlier transcript when a later run fails", async () => {
      const note = await attachAudio(tenantA, await generateM4aFixture(40));
      await runQueue();
      gateway.respond = () => {
        throw new AudioGatewayCallError("Gateway responded with HTTP 500");
      };

      await enqueueVoiceJob(tenantA, note.inboxItemId);
      await runQueue();

      expect((await voiceJobs())[0]?.attempts).toBe(1);
      expect((await propertiesOf(tenantA, note.inboxItemId)).transcribedText).toBe("Note of 40 seconds.");
    });
  });

  describe("when the voice notes change during the transcription", () => {
    it("writes nothing from the run, fails it, and covers both notes in the retry", async () => {
      const first = await attachAudio(tenantA, await generateM4aFixture(30));
      await runQueue(metadataTasks);
      let added = false;
      gateway.respond = async (request) => {
        if (!added) {
          added = true;
          // A second voice note arrives while the first is being transcribed.
          await attachRecorded(tenantA, first.inboxItemId, {
            bytes: await generateM4aFixture(20),
            declaredByteSize: 100,
            durationSeconds: 20,
          });
        }
        return `Note of ${request.audioSeconds} seconds.`;
      };

      await runQueue();

      const [job] = await voiceJobs();
      expect(job?.attempts).toBe(1);
      expect(job?.lastError).toContain("changed while they were transcribed");
      expect(Object.hasOwn(await propertiesOf(tenantA, first.inboxItemId), "transcribedText")).toBe(false);

      await retryFailedJobsNow();
      await runQueue();

      expect(await voiceJobs()).toEqual([]);
      expect((await propertiesOf(tenantA, first.inboxItemId)).transcribedText).toBe(
        "Note of 30 seconds.\n\nNote of 20 seconds.",
      );
    });
  });

  describe("an item with nothing to transcribe", () => {
    it("ends successfully without a gateway call for an item that has no voice note", async () => {
      const photo = await attachAudio(tenantA, await generateImageFixture({ width: 300, height: 200, format: "jpeg" }));
      await runQueue(metadataTasks);
      const before = await itemRow(tenantA, photo.inboxItemId);

      await enqueueVoiceJob(tenantA, photo.inboxItemId);
      await runQueue();

      expect(gateway.requests).toEqual([]);
      expect(await voiceJobs()).toEqual([]);
      expect(await itemRow(tenantA, photo.inboxItemId)).toBe(before);
    });

    it("ends successfully without a gateway call for an item in the Trash", async () => {
      const note = await attachAudio(tenantA, await generateM4aFixture(40));
      await runQueue(metadataTasks);
      await inTenant(tenantA, async (client) => {
        await itemDeleteWithClient(client, await inboxDatabaseId(client), note.inboxItemId, {
          queueAffinity: createActionQueueAffinity(),
        });
      });
      const before = await itemRow(tenantA, note.inboxItemId);

      await runQueue();

      expect(gateway.requests).toEqual([]);
      expect(await voiceJobs()).toEqual([]);
      expect(await itemRow(tenantA, note.inboxItemId)).toBe(before);
    });

    it("ends successfully without a gateway call for an item that no longer exists", async () => {
      await enqueueVoiceJob(tenantA, randomUUID());

      await runQueue();

      expect(gateway.requests).toEqual([]);
      expect(await voiceJobs()).toEqual([]);
    });
  });

  describe("tenants", () => {
    it("writes each tenant's own text into its own item", async () => {
      const inA = await attachAudio(tenantA, await generateM4aFixture(40));
      const inB = await attachAudio(tenantB, await generateM4aFixture(50), { text: "Theirs" });

      await runQueue();

      expect((await propertiesOf(tenantA, inA.inboxItemId)).transcribedText).toBe("Note of 40 seconds.");
      expect(await propertiesOf(tenantB, inB.inboxItemId)).toMatchObject({
        text: "Theirs",
        transcribedText: "Note of 50 seconds.",
      });
    });

    it("ends a job of tenant B that names tenant A's item without reading, sending or writing anything of A", async () => {
      const inA = await attachAudio(tenantA, await generateM4aFixture(40));
      await runQueue(metadataTasks);
      await adminPool.query("SELECT graphile_worker.remove_job($1)", [`inbox-voice-note:${inA.inboxItemId}`]);
      const before = await itemRow(tenantA, inA.inboxItemId);
      storage.reads = [];

      await enqueueVoiceJob(tenantB, inA.inboxItemId);
      await runQueue();

      expect(gateway.requests).toEqual([]);
      expect(storage.reads).toEqual([]);
      expect(await voiceJobs()).toEqual([]);
      expect(await itemRow(tenantA, inA.inboxItemId)).toBe(before);
    });
  });

  describe("its payload", () => {
    it.each([{ payload: {} }, { payload: { inboxItemId: "not-a-uuid" } }, { payload: null }])(
      "refuses $payload without a gateway call",
      async ({ payload }) => {
        const task = createInboxVoiceNoteTranscribeTask(runtimePool, storage, gateway);

        await expect(runInTenant(tenantA, () => task(payload))).rejects.toThrow();

        expect(gateway.requests).toEqual([]);
      },
    );
  });

  describe("the loopback gateway client it defaults to", () => {
    let server: Server;
    let received: Array<{
      url: string | undefined;
      authorization: string | undefined;
      tenant: string | undefined;
      body: unknown;
    }>;
    let previousPort: string | undefined;
    let previousToken: string | undefined;

    function readBody(req: IncomingMessage): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        req.on("error", reject);
      });
    }

    beforeEach(async () => {
      received = [];
      previousPort = process.env.AI_GATEWAY_PORT;
      previousToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;
      server = createServer((req, res) => {
        void readBody(req).then((body) => {
          received.push({
            url: req.url,
            authorization: req.headers.authorization,
            tenant:
              typeof req.headers["x-alldots-tenant-id"] === "string" ? req.headers["x-alldots-tenant-id"] : undefined,
            body,
          });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ text: "From the gateway.", language: "en", segments: [] }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The test server has no port");
      process.env.AI_GATEWAY_PORT = String(address.port);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousPort === undefined) delete process.env.AI_GATEWAY_PORT;
      else process.env.AI_GATEWAY_PORT = previousPort;
      if (previousToken === undefined) delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
      else process.env.AI_GATEWAY_INTERNAL_TOKEN = previousToken;
    });

    it("calls the transcription route of the gateway with the internal token and the tenant, and stores the answer", async () => {
      process.env.AI_GATEWAY_INTERNAL_TOKEN = "test-internal-token";
      const bytes = await generateM4aFixture(40);
      const note = await attachAudio(tenantA, bytes);
      await runQueue(metadataTasks);
      const task = createInboxVoiceNoteTranscribeTask(runtimePool, storage);

      await runInTenant(tenantA, () => task({ inboxItemId: note.inboxItemId }));

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        url: "/internal/transcribe",
        authorization: "Bearer test-internal-token",
        tenant: tenantA,
      });
      expect(received[0]?.body).toMatchObject({
        audioBase64: bytes.toString("base64"),
        audioSeconds: 40,
        filename: "voice-note",
      });
      expect((await propertiesOf(tenantA, note.inboxItemId)).transcribedText).toBe("From the gateway.");
    });

    it("fails the job and writes nothing when the internal token is not set", async () => {
      delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
      const note = await attachAudio(tenantA, await generateM4aFixture(40));
      await runQueue(metadataTasks);
      const before = await itemRow(tenantA, note.inboxItemId);
      const task = createInboxVoiceNoteTranscribeTask(runtimePool, storage);

      await expect(runInTenant(tenantA, () => task({ inboxItemId: note.inboxItemId }))).rejects.toThrow(
        "AI_GATEWAY_INTERNAL_TOKEN is not set",
      );

      expect(received).toEqual([]);
      expect(await itemRow(tenantA, note.inboxItemId)).toBe(before);
    });

    it("does not need the token for an item with no voice note", async () => {
      delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
      const item = await inTenant(tenantA, async (client) => {
        const created = await createItemWithClient(client, {
          databaseId: await inboxDatabaseId(client),
          properties: { date: "2026-11-02", time: "10:15", text: "No audio" },
        });
        return created.id;
      });
      const task = createInboxVoiceNoteTranscribeTask(runtimePool, storage);

      await expect(runInTenant(tenantA, () => task({ inboxItemId: item }))).resolves.toBeUndefined();

      expect(received).toEqual([]);
    });
  });
});
