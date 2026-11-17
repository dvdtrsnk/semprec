import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AiGatewayClientPort } from "@semprec/shared";
import type { AudioGatewayClient } from "../../audioGatewayClient.js";

register(new URL("../../../src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url), import.meta.url);

const {
  createBlob,
  createChokePoint,
  createItemWithClient,
  createPool,
  getDatabaseByModuleId,
  getItemById,
  LocalFsBlobStorageWriter,
  tenantBlobStorageKey,
  withTransaction,
} = await import("@semprec/data");
const { runInTenant } = await import("@semprec/shared");
const { CORE_TASK_NAMES, enqueueJob, registerTask, runOnce } = await import("@semprec/queue");
const { createTranscriptionTask } = await import("../../transcriptionTask.js");
const { generateOggFixture } = await import("./mediaFixtures.js");

const inputSchema = z.strictObject({
  mode: z.enum(["failure", "stop", "consume"]),
  tenantId: z.uuid(),
  storageRoot: z.string().refine(isAbsolute),
  audioPath: z.string().refine(isAbsolute),
  fileItemId: z.uuid().optional(),
  source: z.enum(["wav", "ogg"]).optional(),
});
const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  length += bytes.length;
  if (length > 8192) throw new Error("Fixture input exceeds limit");
  chunks.push(bytes);
}
const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const request = inputSchema.parse(input);
if ((request.mode === "consume") !== (request.fileItemId !== undefined))
  throw new Error("Invalid fixture mode and file ID");
const connectionString = process.env.BATCH09_RUNTIME_DATABASE_URL;
if (!connectionString) throw new Error("Missing isolated runtime database");
const pool = createPool(connectionString);
const storage = new LocalFsBlobStorageWriter(request.storageRoot);
let diarizeCalls = 0;
let transcribeCalls = 0;
let summaryCalls = 0;
let fileItemId = request.fileItemId;
const sentinel = "BATCH09_PRIVATE_PROVIDER_DIAGNOSTIC";

let primary: unknown;
let failed = false;
try {
  const state = await runInTenant(request.tenantId, async () => {
    const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
    const transcripts = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "transcripts"));
    if (!files || !transcripts) throw new Error("Missing fixture databases");
    if (!fileItemId) {
      const audio = request.source === "ogg" ? await generateOggFixture() : await readFile(request.audioPath);
      if (audio.length === 0 || audio.length > 2_000_000) throw new Error("Invalid fixture audio length");
      const storageKey = await withTransaction(pool, (client) =>
        tenantBlobStorageKey(client, `blobs/${randomUUID()}.${request.source === "ogg" ? "ogg" : "wav"}`),
      );
      await storage.writeStream(storageKey, Readable.from(audio));
      const file = await withTransaction(pool, async (client) => {
        const blob = await createBlob(client, {
          mimeType: request.source === "ogg" ? "audio/ogg" : "audio/wav",
          byteSize: audio.length,
          storageKey,
        });
        return createItemWithClient(client, {
          databaseId: files.id,
          properties: { name: "Fixture audio", file: { blobId: blob.id } },
        });
      });
      fileItemId = file.id;
      await enqueueJob(
        pool,
        CORE_TASK_NAMES.TRANSCRIPTION_JOB,
        { fileItemId },
        {
          jobKey: `transcription-job:${fileItemId}`,
          maxAttempts: request.mode === "failure" ? 1 : 3,
        },
      );
    }
    return { id: fileItemId, filesId: files.id, transcriptsId: transcripts.id };
  });
  const { id, filesId, transcriptsId } = state;
  const gateway: AudioGatewayClient = {
    async diarize() {
      diarizeCalls++;
      if (request.mode === "stop") {
        const source = await withTransaction(pool, (client) => getItemById(client, filesId, id));
        const transcriptId = z.uuid().parse(source?.computed.create);
        await createChokePoint(pool).softDeleteItem(transcriptsId, transcriptId);
      }
      return [{ speaker: "SPEAKER_00", start: 0, end: 0.5 }];
    },
    async transcribe() {
      transcribeCalls++;
      return { text: "Alpha", language: "en", segments: [{ start: 0, end: 0.4, text: "Alpha" }] };
    },
  };
  const summary: AiGatewayClientPort = {
    async complete(input) {
      summaryCalls++;
      if (request.mode === "failure") throw new Error(sentinel);
      const content =
        input.operation === "transcript_speaker_suggestion"
          ? { mappings: [] }
          : {
              title: "Fixture",
              summary: "Fixture summary",
              shortSummary: "Fixture summary",
              decisions: [],
              actionItems: [],
            };
      return { content, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const taskList = {
    [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPTION_JOB,
      createTranscriptionTask(pool, storage, gateway, summary),
    ),
  };
  await runOnce({ pgPool: pool, taskList });
  const source = await runInTenant(request.tenantId, () =>
    withTransaction(pool, (client) => getItemById(client, filesId, id)),
  );
  const transcriptId = z.uuid().parse(source?.computed.create);
  const prepare = z
    .object({ normalizedBlobId: z.uuid(), playbackBlobId: z.uuid().optional() })
    .parse(source?.computed.prepare);
  const result = {
    mode: request.mode,
    fileItemId: id,
    transcriptId,
    normalizedBlobId: prepare.normalizedBlobId,
    ...(prepare.playbackBlobId ? { playbackBlobId: prepare.playbackBlobId } : {}),
    diarizeCalls,
    transcribeCalls,
    summaryCalls,
  };
  process.stdout.write(`BATCH09_FRAME ${JSON.stringify(result)}\n`);
} catch (error) {
  primary = error;
  failed = true;
}
try {
  await pool.end();
} catch (error) {
  if (failed) process.stderr.write(`Fixture pool cleanup failed: ${String(error)}\n`);
  else {
    primary = error;
    failed = true;
  }
}
if (failed) {
  if (primary instanceof Error) throw primary;
  throw new Error("Fixture failed with a non-error value", { cause: primary });
}
