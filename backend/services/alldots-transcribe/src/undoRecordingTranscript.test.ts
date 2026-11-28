import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  LocalFsBlobStorageWriter,
  createBlob,
  createChokePoint,
  createAlldotsTickAction,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  getItemById,
  insertInboxAttachments,
  listInboxAttachments,
  recordInboxAttachmentMetadata,
  seedSystem,
  withTransaction,
} from "@alldots/data";
import {
  confirmProposalWithClient,
  createInboxItemWithClient,
  getTestPool,
  inTenantZero,
  reopenProposalWithClient,
  resetDatabase,
} from "@alldots/data/testSupport";
import type { AiGatewayClientPort } from "@alldots/shared";
import type { AudioGatewayClient } from "./audioGatewayClient.js";
import { createTranscriptionCreateTask, createTranscriptionTask } from "./transcriptionTask.js";

// Runs the real transcription handlers around the undo of a confirmed recording card: the undo trashes the
// transcript the create step made, and a handler for a gone or trashed Files item writes nothing.

let pool: Pool;
let blobDir: string;

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  pool ??= getTestPool();
  blobDir = await mkdtemp(join(tmpdir(), "alldots-undo-transcript-"));
  await resetDatabase(pool);
  await seedSystem(pool, createViewTypeRegistry());
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

async function databaseId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new Error(`The ${moduleId} database was not seeded`);
  return database.id;
}

/** Runs `fn` in one transaction of tenant zero's scope. */
function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenantZero(() => withTransaction(pool, fn));
}

/** A recording card the tick made for an Inbox item with a shared recording, confirmed; the Files item it queued. */
async function confirmedRecording(): Promise<{ cardId: string; fileItemId: string; proposalsId: string }> {
  const ids = await inTransaction(async (client) => ({
    inboxDatabaseId: await databaseId(client, "inbox"),
    inboxItemTypesDatabaseId: await databaseId(client, "inboxItemTypes"),
    processingProposalsDatabaseId: await databaseId(client, "processingProposals"),
  }));
  const itemId = await inTransaction(async (client) => {
    const blob = await createBlob(client, {
      mimeType: "audio/mp4",
      byteSize: 4096,
      storageKey: `blobs/${randomUUID()}`,
    });
    const item = await createInboxItemWithClient(client, {
      inboxDatabaseId: ids.inboxDatabaseId,
      date: "2026-11-05",
      time: "09:00",
    });
    await insertInboxAttachments(client, item.id, [{ blobId: blob.id, source: "share" }]);
    const [attachment] = await listInboxAttachments(client, [item.id]);
    if (!attachment) throw new Error("The attachment was not stored");
    await recordInboxAttachmentMetadata(client, {
      attachmentId: attachment.attachmentId,
      metadata: { pages: null, durationSeconds: 1380, audioKind: "recording", recordedAt: "2026-11-03T13:32:00.000Z" },
      thumbnail: null,
      reduced: null,
    });
    return item.id;
  });
  const tick = createAlldotsTickAction(pool, async () => {
    throw new Error("The model must not be called for a recording card");
  });
  await inTenantZero(() => tick(ids, { heartbeatId: "hb", projectItemId: randomUUID(), itemId }));
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
    ids.processingProposalsDatabaseId,
  ]);
  if (rows.length !== 1 || !rows[0]) throw new Error("Expected exactly one card");
  const cardId = rows[0].id;
  const proposalsId = ids.processingProposalsDatabaseId;
  const confirmed = await inTransaction((client) =>
    confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
  );
  return { cardId, fileItemId: String(confirmed.properties.resultItemId), proposalsId };
}

const queuedTranscriptionJobs = async (): Promise<number> =>
  (
    await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key LIKE 'transcription-%'",
    )
  ).rows[0]?.n ?? 0;

async function transcriptOf(fileItemId: string): Promise<{ id: string; deletedAt: Date | null }> {
  const { rows } = await pool.query<{ id: string; deleted_at: Date | null }>(
    `SELECT t.id, t.deleted_at FROM items f
       JOIN items t ON t.id = (f.computed ->> 'create')::uuid
      WHERE f.id = $1`,
    [fileItemId],
  );
  if (!rows[0]) throw new Error("The create step left no transcript");
  return { id: z.uuid().parse(rows[0].id), deletedAt: rows[0].deleted_at };
}

/** Everything a handler could write: every item's version and trash state, the automation rows and the notifications. */
async function writtenState(): Promise<unknown> {
  const items = await pool.query("SELECT id, updated_at, deleted_at FROM items ORDER BY id");
  const automation = await pool.query("SELECT * FROM item_automation ORDER BY item_id");
  const notifications = await pool.query("SELECT id FROM notifications ORDER BY id");
  return { items: items.rows, automation: automation.rows, notifications: notifications.rows };
}

/** Gateway clients that fail the test when a handler reaches a paid call. */
const unreachableGateway: AudioGatewayClient = {
  diarize: () => Promise.reject(new Error("A paid diarization call was made")),
  transcribe: () => Promise.reject(new Error("A paid transcription call was made")),
};
const unreachableSummary: AiGatewayClientPort = {
  complete: () => Promise.reject(new Error("A model call was made")),
};

describe("the undo of a confirmed recording card, around the real transcription handlers", () => {
  it("trashes the transcript the create step made and removes the jobs that were still queued", async () => {
    const { cardId, fileItemId, proposalsId } = await confirmedRecording();
    await inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId }));
    const transcript = await transcriptOf(fileItemId);
    expect(transcript.deletedAt).toBeNull();
    expect(await queuedTranscriptionJobs()).toBe(2);

    await inTransaction((client) =>
      reopenProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {}),
    );

    expect((await transcriptOf(fileItemId)).deletedAt).not.toBeNull();
    expect(await queuedTranscriptionJobs()).toBe(0);
    const reopened = await inTransaction((client) => getItemById(client, proposalsId, cardId));
    expect(reopened?.properties.status).toBe("proposed");
  });
});

describe("a transcription handler that runs for a Files item that is gone or in the Trash", () => {
  const runCreate = (fileItemId: string) => inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId }));
  const runJob = (fileItemId: string) =>
    inTenantZero(() =>
      createTranscriptionTask(
        pool,
        new LocalFsBlobStorageWriter(blobDir),
        unreachableGateway,
        unreachableSummary,
      )({ fileItemId }, { job: { attempts: 1, max_attempts: 3 } }),
    );

  async function transcriptCount(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'transcripts')`,
    );
    return rows[0]?.n ?? 0;
  }

  it.each([
    ["the create task", runCreate],
    ["the transcription job", runJob],
  ] as const)("%s writes nothing for a Files item in the Trash", async (_name, run) => {
    const { fileItemId } = await confirmedRecording();
    await inTenantZero(async () => {
      const filesId = await inTransaction((client) => databaseId(client, "files"));
      await createChokePoint(pool).softDeleteItem(filesId, fileItemId);
    });
    const before = await writtenState();

    await expect(run(fileItemId)).resolves.toBeUndefined();

    expect(await transcriptCount()).toBe(0);
    expect(await writtenState()).toEqual(before);
  });

  it.each([
    ["the create task", runCreate],
    ["the transcription job", runJob],
  ] as const)("%s writes nothing for a Files item that does not exist", async (_name, run) => {
    await confirmedRecording();
    const before = await writtenState();

    await expect(run(randomUUID())).resolves.toBeUndefined();

    expect(await transcriptCount()).toBe(0);
    expect(await writtenState()).toEqual(before);
  });

  // The one deliberate exception to "writes nothing": the attempt records `deleted` on the automation row.
  async function automationOf(transcriptId: string) {
    const { rows } = await pool.query(
      "SELECT status, error, error_code, attempts FROM item_automation WHERE item_id = $1",
      [transcriptId],
    );
    return rows[0] as { status: string; error: string | null; error_code: string | null; attempts: number };
  }

  it("records only the deleted status of the transcript's automation row for a Files item in the Trash, and no paid call", async () => {
    const { fileItemId } = await confirmedRecording();
    await runCreate(fileItemId);
    const transcript = await transcriptOf(fileItemId);
    expect(await automationOf(transcript.id)).toMatchObject({ status: "pending", error: null, attempts: 0 });
    await inTenantZero(async () => {
      const filesId = await inTransaction((client) => databaseId(client, "files"));
      await createChokePoint(pool).softDeleteItem(filesId, fileItemId);
    });
    const before = (await writtenState()) as { items: unknown; automation: unknown; notifications: unknown };

    await expect(runJob(fileItemId)).resolves.toBeUndefined();

    const after = (await writtenState()) as typeof before;
    expect(after.items).toEqual(before.items);
    expect(after.notifications).toEqual(before.notifications);
    expect(await automationOf(transcript.id)).toMatchObject({
      status: "error",
      error: "Transcript or source file deleted",
      error_code: "deleted",
      attempts: 0,
    });
    expect(await transcriptCount()).toBe(1);
  });

  it("records only the deleted status of the automation row for a transcript the undo trashed while the Files item stays live", async () => {
    const { cardId, fileItemId, proposalsId } = await confirmedRecording();
    await runCreate(fileItemId);
    const transcript = await transcriptOf(fileItemId);
    await inTransaction((client) =>
      reopenProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {}),
    );
    expect((await transcriptOf(fileItemId)).deletedAt).not.toBeNull();
    const before = (await writtenState()) as { items: unknown; automation: unknown; notifications: unknown };

    await expect(runJob(fileItemId)).resolves.toBeUndefined();

    const after = (await writtenState()) as typeof before;
    expect(after.items).toEqual(before.items);
    expect(after.notifications).toEqual(before.notifications);
    expect(await automationOf(transcript.id)).toMatchObject({ status: "error", error_code: "deleted", attempts: 0 });
  });
});
