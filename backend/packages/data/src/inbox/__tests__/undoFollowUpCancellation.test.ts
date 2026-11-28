import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@alldots/queue";
import { runInTenant } from "@alldots/shared";
import { createUser } from "../../auth/usersStore.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { hasCredential } from "../../credentials/externalCredentialsStore.js";
import { withTransaction } from "../../db/pool.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import type { connectMcpServer as ConnectMcpServerFn } from "../../mcp/mcpConnectionFactory.js";
import { handleMcpServerSyncTask, mcpServerSyncJobKey, syncMcpServerTools } from "../../mcp/mcpSync.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { TRANSCRIPTION_CREATE_COMPUTED_KEY } from "../../transcription/transcriptionComputedKeys.js";
import {
  TRANSCRIPTION_OWNER_PROCESS,
  enqueueTranscriptionCreate,
  enqueueTranscriptionJob,
  transcriptionCreateJobKey,
  transcriptionJobKey,
  transcriptionSourceLink,
} from "../../transcription/transcriptionJob.js";
import type { ItemRow } from "../../types.js";
import { listInboxAttachments, recordInboxAttachmentMetadata } from "../inboxAttachmentsStore.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createAlldotsTickAction } from "../inboxTickAction.js";
import { confirmProposalWithClient, readConfirmationResults, reopenProposalWithClient } from "../proposalActions.js";

// The undo of a confirmed card cancels the follow-up jobs the confirmation queued (a transcription for a recording
// card, the tool sync of an MCP server card) in its own transaction, and removes the transcript a finished
// transcription produced. The reversal of the synchronous writes is not tested here.

/**
 * `connectMock.impl` is what the mocked `connectMcpServer` calls. The sync handler is run in this file only for a server
 * item that is gone or in the Trash, so a call of it means the handler did not stop at its first read.
 */
const connectMock = vi.hoisted(() => ({
  calls: 0,
  impl: undefined as unknown as typeof ConnectMcpServerFn,
}));

vi.mock("../../mcp/mcpConnectionFactory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../mcp/mcpConnectionFactory.js")>();
  connectMock.impl = actual.connectMcpServer;
  return {
    ...actual,
    connectMcpServer: ((...args: Parameters<typeof ConnectMcpServerFn>) => {
      connectMock.calls += 1;
      return connectMock.impl(...args);
    }) as typeof ConnectMcpServerFn,
  };
});

const FIXTURE_RECORDED_AT = "2026-11-03T13:32:00.000Z";

let pool: Pool;
let databaseIds: { inboxDatabaseId: string; inboxItemTypesDatabaseId: string; processingProposalsDatabaseId: string };
let filesId: string;
let transcriptsId: string;
let mcpServersId: string;
let tasksId: string;
let actingUserId: string;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), () => withTransaction(pool, fn));
}

const config = () => ({ processingProposalsDatabaseId: databaseIds.processingProposalsDatabaseId });

const confirm = (cardId: string, userId: string | undefined = actingUserId): Promise<ItemRow> =>
  inTransaction((client) => confirmProposalWithClient(client, config(), cardId, undefined, userId));

const reopen = (cardId: string) =>
  inTransaction((client) => reopenProposalWithClient(client, config(), cardId, {}, actingUserId));

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS counted`, params);
  return rows[0]?.n ?? 0;
}

/** The keys of the transcription and MCP sync jobs of the queue (other writes queue jobs of their own), read through graphile-worker's public `jobs` view. */
async function queuedKeys(): Promise<string[]> {
  const { rows } = await pool.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE key LIKE 'transcription-%' OR key LIKE 'mcp-server-sync-%'",
  );
  return rows.map((row) => row.key).sort();
}

async function itemState(itemId: string): Promise<{ deleted: boolean; deletedAt: string | null }> {
  const { rows } = await pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id = $1", [
    itemId,
  ]);
  if (!rows[0]) throw new Error(`Item ${itemId} does not exist`);
  return { deleted: rows[0].deleted_at !== null, deletedAt: rows[0].deleted_at?.toISOString() ?? null };
}

/** Waits until a backend is blocked on a row lock, which is where the undo stands while the producer holds the file. */
async function waitForLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The undo never waited for the lock of the Files item");
}

const transcriptCount = () => count("SELECT 1 FROM items WHERE database_id = $1", [transcriptsId]);

async function recordingCard(sharedBlobId?: string): Promise<string> {
  const itemId = await inTransaction(async (client) => {
    const blob = sharedBlobId
      ? { id: sharedBlobId }
      : await createBlob(client, { mimeType: "audio/mp4", byteSize: 4096, storageKey: `blobs/${randomUUID()}` });
    const item = await createInboxItemWithClient(client, {
      inboxDatabaseId: databaseIds.inboxDatabaseId,
      date: "2026-11-05",
      time: "09:00",
      attachments: [{ blobId: blob.id, source: "share" }],
    });
    const [attachment] = await listInboxAttachments(client, [item.id]);
    if (!attachment) throw new Error("The attachment was not stored");
    await recordInboxAttachmentMetadata(client, {
      attachmentId: attachment.attachmentId,
      metadata: { pages: null, durationSeconds: 1380, audioKind: "recording", recordedAt: FIXTURE_RECORDED_AT },
      thumbnail: null,
      reduced: null,
    });
    return item.id;
  });
  const tick = createAlldotsTickAction(pool, async () => {
    throw new Error("The model must not be called for a recording card");
  });
  await runInTenant(getTenantZeroId(), () =>
    tick(databaseIds, { heartbeatId: "hb", projectItemId: randomUUID(), itemId }),
  );
  const { rows } = await pool.query<{ id: string }>(
    `SELECT card.id FROM items card
       JOIN item_relations r ON (r.item_a = card.id AND r.item_b = $2) OR (r.item_b = card.id AND r.item_a = $2)
      WHERE card.database_id = $1`,
    [databaseIds.processingProposalsDatabaseId, itemId],
  );
  if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one card for the item, found ${rows.length}`);
  return rows[0].id;
}

function fileOf(confirmed: ItemRow): string {
  const [result] = readConfirmationResults(confirmed.properties);
  if (!result || result.databaseKey !== "files") throw new Error("The confirmation did not report a Files item");
  expect(result.followUp).toBe("transcriptionQueued");
  return result.itemId;
}

/**
 * A Files item the user uploaded earlier, with the jobs the upload queued (`POST /api/transcriptions` queues both in
 * the upload's transaction), and the blob it names, which the next recording card shares.
 */
async function uploadedRecording(): Promise<{ fileItemId: string; blobId: string }> {
  return inTransaction(async (client) => {
    const blob = await createBlob(client, {
      mimeType: "audio/mp4",
      byteSize: 4096,
      storageKey: `blobs/${randomUUID()}`,
    });
    const file = await createItemWithClient(client, {
      databaseId: filesId,
      properties: { name: "Upload", file: { blobId: blob.id } },
    });
    await enqueueTranscriptionCreate(client, { fileItemId: file.id });
    await enqueueTranscriptionJob(client, { fileItemId: file.id });
    return { fileItemId: file.id, blobId: blob.id };
  });
}

async function confirmedRecording(): Promise<{ cardId: string; fileItemId: string }> {
  const cardId = await recordingCard();
  return { cardId, fileItemId: fileOf(await confirm(cardId)) };
}

/**
 * What a transcription job that ran leaves: a Transcripts item bound to the Files item through its link, and the
 * `create` checkpoint on the Files item. Written with the calls the create step of `alldots-transcribe` makes. The
 * worker deletes a job when it completes it, so both jobs of the file are removed too.
 */
async function finishTranscription(fileItemId: string, linkedFileItemId = fileItemId): Promise<string> {
  const transcriptId = await inTransaction(async (client) => {
    const transcript = await createItemWithClient(
      client,
      {
        databaseId: transcriptsId,
        properties: { name: "Call", status: "done", link: transcriptionSourceLink(linkedFileItemId) },
      },
      { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
    );
    await writeComputed(client, filesId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, transcript.id);
    return transcript.id;
  });
  await completeJobs(fileItemId);
  return transcriptId;
}

async function completeJobs(fileItemId: string): Promise<void> {
  for (const key of [transcriptionCreateJobKey(fileItemId), transcriptionJobKey(fileItemId)]) {
    await pool.query("SELECT graphile_worker.remove_job($1)", [key]);
  }
}

/** A card for a new MCP server, created as the tick never does: through the choke point with the keys the tick writes. */
async function mcpServerCard(): Promise<string> {
  const envelope = {
    entityKind: "database",
    target: mcpServersId,
    properties: { name: "Remote tool", connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" } },
  };
  return cardWith(envelope);
}

async function cardWith(envelope: Record<string, unknown>): Promise<string> {
  const card = await inTransaction((client) =>
    createItemWithClient(
      client,
      {
        databaseId: databaseIds.processingProposalsDatabaseId,
        properties: { kind: "inbox", status: "proposed", proposal: envelope, aiProposal: envelope },
      },
      { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal"] },
    ),
  );
  return card.id;
}

async function confirmedServer(
  options: { userId?: string | undefined; credential?: boolean } = {},
): Promise<{ cardId: string; serverId: string; followUp: string | null }> {
  const cardId = await mcpServerCard();
  const confirmed = await inTransaction((client) =>
    confirmProposalWithClient(
      client,
      config(),
      cardId,
      options.credential ? { credentialType: "api_key", plaintext: "sk-test" } : undefined,
      "userId" in options ? options.userId : actingUserId,
    ),
  );
  const [result] = readConfirmationResults(confirmed.properties);
  if (!result) throw new Error("The confirmation reported no result");
  return { cardId, serverId: result.itemId, followUp: result.followUp };
}

beforeEach(async () => {
  pool ??= getTestPool();
  await resetDatabase(pool);
  await seedSystem(pool, createViewTypeRegistry());
  databaseIds = {
    inboxDatabaseId: await databaseIdFor("inbox"),
    inboxItemTypesDatabaseId: await databaseIdFor("inboxItemTypes"),
    processingProposalsDatabaseId: await databaseIdFor("processingProposals"),
  };
  filesId = await databaseIdFor("files");
  transcriptsId = await databaseIdFor("transcripts");
  mcpServersId = await databaseIdFor("mcpServers");
  tasksId = await databaseIdFor("tasks");
  actingUserId = (
    await createUser(pool, {
      email: "admin@example.test",
      passwordHash: "unused",
      tenantId: getTenantZeroId(),
      role: "admin",
    })
  ).id;
  connectMock.calls = 0;
});

afterAll(async () => {
  await pool?.end();
});

describe("undoing a confirmed recording card (transcription follow-up)", () => {
  it("removes both queued jobs when the worker has not picked them up, and creates no transcript", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    expect(await queuedKeys()).toEqual([transcriptionCreateJobKey(fileItemId), transcriptionJobKey(fileItemId)].sort());

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual([]);
    expect(await transcriptCount()).toBe(0);
  });

  it("leaves the jobs of a Files item that the user's own upload queued before the card was confirmed", async () => {
    const upload = await uploadedRecording();
    const cardId = await recordingCard(upload.blobId);
    const uploadJobs = [transcriptionCreateJobKey(upload.fileItemId), transcriptionJobKey(upload.fileItemId)].sort();
    expect(await queuedKeys()).toEqual(uploadJobs);

    const confirmed = await confirm(cardId);

    const [result] = readConfirmationResults(confirmed.properties);
    expect(result).toMatchObject({ itemId: upload.fileItemId, databaseKey: "files", followUp: null });
    expect(await queuedKeys()).toEqual(uploadJobs);

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual(uploadJobs);
    expect((await itemState(upload.fileItemId)).deleted).toBe(false);
  });

  it("takes the Files row before the job rows, so a producer that holds the file and upserts a job does not deadlock with it", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    let fileLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => (fileLocked = resolve));
    let releaseProducer: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (releaseProducer = resolve));
    // The producer holds the Files row the way `recordRecordingIntake` does, then upserts the job under its key.
    const producer = inTransaction(async (client) => {
      await client.query("SELECT id FROM items WHERE id = $1 FOR NO KEY UPDATE", [fileItemId]);
      fileLocked();
      await gate;
      await enqueueTranscriptionJob(client, { fileItemId });
    });
    producer.catch(() => undefined);
    await locked;
    const undo = reopen(cardId);
    undo.catch(() => undefined);
    // The undo is queued behind the producer's file lock. It must not hold a job row by then: with the job rows taken
    // first it would, and the producer's upsert would wait for it while it waits for the producer (a deadlock).
    await waitForLockWaiter();
    releaseProducer();
    await producer;

    const { item } = await undo;

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual([]);
  });

  it("touches only the jobs of its own file", async () => {
    const first = await confirmedRecording();
    const second = await confirmedRecording();
    const server = await confirmedServer();

    await reopen(first.cardId);

    expect(await queuedKeys()).toEqual(
      [
        transcriptionCreateJobKey(second.fileItemId),
        transcriptionJobKey(second.fileItemId),
        mcpServerSyncJobKey(server.serverId),
      ].sort(),
    );
  });

  it("puts the Transcripts item of a finished transcription into the trash", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    const transcriptId = await finishTranscription(fileItemId);
    expect((await itemState(transcriptId)).deleted).toBe(false);

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect((await itemState(transcriptId)).deleted).toBe(true);
    expect(await queuedKeys()).toEqual([]);
  });

  it("removes the jobs and trashes the transcript of a transcription that is half done", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    const transcriptId = await inTransaction(async (client) => {
      const transcript = await createItemWithClient(
        client,
        {
          databaseId: transcriptsId,
          properties: { name: "Call", status: "processing", link: transcriptionSourceLink(fileItemId) },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await writeComputed(client, filesId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, transcript.id);
      return transcript.id;
    });

    await reopen(cardId);

    expect((await itemState(transcriptId)).deleted).toBe(true);
    expect(await queuedKeys()).toEqual([]);
  });

  it("leaves a transcript that is already in the trash as it is", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    const transcriptId = await finishTranscription(fileItemId);
    await inTransaction((client) =>
      itemDeleteWithClient(client, transcriptsId, transcriptId, { queueAffinity: createActionQueueAffinity() }),
    );
    const trashed = await itemState(transcriptId);

    await reopen(cardId);

    expect(await itemState(transcriptId)).toEqual(trashed);
  });

  it("finishes when the transcript the checkpoint names no longer exists", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    await inTransaction((client) =>
      // A checkpoint whose transcript was purged from the Trash names an id that no row has: written through the
      // checkpoint writer the create step uses.
      writeComputed(client, filesId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, randomUUID()),
    );

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual([]);
  });

  it("refuses the undo and writes nothing when the checkpoint names the transcript of another file", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    const otherFile = await confirmedRecording();
    const otherTranscript = await finishTranscription(otherFile.fileItemId);
    await inTransaction((client) =>
      writeComputed(client, filesId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, otherTranscript),
    );
    const keysBefore = await queuedKeys();

    await expect(reopen(cardId)).rejects.toThrow(/is not the transcript of Files item/);

    expect((await itemState(otherTranscript)).deleted).toBe(false);
    expect(await queuedKeys()).toEqual(keysBefore);
    const { rows } = await pool.query<{ status: string }>(
      "SELECT properties ->> 'status' AS status FROM items WHERE id = $1",
      [cardId],
    );
    expect(rows).toEqual([{ status: "confirmed" }]);
  });

  it("refuses the undo and keeps the jobs when the checkpoint is not an item id", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    await inTransaction((client) =>
      writeComputed(client, filesId, fileItemId, TRANSCRIPTION_CREATE_COMPUTED_KEY, "not-an-item-id"),
    );

    await expect(reopen(cardId)).rejects.toThrow();

    expect(await queuedKeys()).toEqual([transcriptionCreateJobKey(fileItemId), transcriptionJobKey(fileItemId)].sort());
  });

  it("still trashes the transcript when the Files item is in the trash", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    const transcriptId = await finishTranscription(fileItemId);
    await inTransaction((client) =>
      itemDeleteWithClient(client, filesId, fileItemId, { queueAffinity: createActionQueueAffinity() }),
    );

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect((await itemState(transcriptId)).deleted).toBe(true);
  });
});

describe("undoing a confirmed recording card whose Files item was purged", () => {
  it("removes the jobs and finishes, there being no checkpoint left to read", async () => {
    const { cardId, fileItemId } = await confirmedRecording();
    await runInTenant(getTenantZeroId(), async () => {
      const chokePoint = createChokePoint(pool);
      await chokePoint.softDeleteItem(filesId, fileItemId);
      const purged = await chokePoint.purgeExpiredTrashSubtree(fileItemId, new Date(Date.now() + 60_000));
      expect(purged.purgedItemIds).toContain(fileItemId);
    });

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual([]);
  });
});

describe("undoing a confirmed MCP server card (tool sync follow-up)", () => {
  it("removes the queued sync when the worker has not picked it up, with the server and its credential", async () => {
    const { cardId, serverId } = await confirmedServer({ credential: true });
    expect(await queuedKeys()).toEqual([mcpServerSyncJobKey(serverId)]);

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual([]);
    expect((await itemState(serverId)).deleted).toBe(true);
    expect(await inTransaction((client) => hasCredential(client, serverId))).toBe(false);
  });

  it("finds no job to remove after the sync completed, and still trashes the server", async () => {
    const { cardId, serverId } = await confirmedServer();
    await pool.query("SELECT graphile_worker.remove_job($1)", [mcpServerSyncJobKey(serverId)]);

    const { item } = await reopen(cardId);

    expect(item.properties.status).toBe("proposed");
    expect((await itemState(serverId)).deleted).toBe(true);
    expect(await queuedKeys()).toEqual([]);
  });

  it("detaches a sync a worker is running and does not retry it, and the run ends normally", async () => {
    const { cardId, serverId } = await confirmedServer();
    const key = mcpServerSyncJobKey(serverId);
    const job = await pool.query<{ id: string }>("SELECT id::text AS id FROM graphile_worker.jobs WHERE key = $1", [
      key,
    ]);
    const jobId = job.rows[0]?.id;
    if (!jobId) throw new Error("The sync was not queued");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = runOnce(
      { pgPool: pool },
      {
        [CORE_TASK_NAMES.MCP_SERVER_SYNC]: async () => {
          started();
          await released;
        },
      },
    );
    try {
      await running;

      await reopen(cardId);

      const { rows } = await pool.query<{ key: string | null; attempts: number; max_attempts: number }>(
        "SELECT key, attempts, max_attempts FROM graphile_worker.jobs WHERE id = $1",
        [jobId],
      );
      expect(rows).toEqual([{ key: null, attempts: 1, max_attempts: 1 }]);
    } finally {
      release();
      await worker;
    }
    expect(await count("SELECT 1 FROM graphile_worker.jobs WHERE id = $1", [jobId])).toBe(0);
  });
});

describe("a confirmation that queued no follow-up", () => {
  it("touches no job when the card created a task, whatever jobs other cards have queued", async () => {
    await confirmedRecording();
    await confirmedServer();
    const taskCard = await cardWith({ entityKind: "database", target: tasksId, properties: { name: "Buy milk" } });
    const confirmedTask = await confirm(taskCard);
    expect(readConfirmationResults(confirmedTask.properties)).toEqual([expect.objectContaining({ followUp: null })]);
    const before = await queuedKeys();
    expect(before).toHaveLength(3);

    const { item } = await reopen(taskCard);

    expect(item.properties.status).toBe("proposed");
    expect(await queuedKeys()).toEqual(before);
  });

  it("touches no job when an MCP server was confirmed without an acting user, so no sync was queued", async () => {
    const queued = await confirmedServer();
    const unqueued = await confirmedServer({ userId: undefined });
    expect(unqueued.followUp).toBeNull();
    expect(await queuedKeys()).toEqual([mcpServerSyncJobKey(queued.serverId)]);

    await reopen(unqueued.cardId);

    expect(await queuedKeys()).toEqual([mcpServerSyncJobKey(queued.serverId)]);
  });
});

describe("a sync handler that runs after the undo", () => {
  it("connects nowhere and writes nothing for the server item the undo trashed", async () => {
    const { cardId, serverId } = await confirmedServer();
    await reopen(cardId);
    const before = await pool.query("SELECT updated_at, deleted_at, properties FROM items WHERE id = $1", [serverId]);

    await expect(handleMcpServerSyncTask(pool, { mcpServerItemId: serverId, actingUserId })).resolves.toBeUndefined();

    expect(connectMock.calls).toBe(0);
    expect(await pool.query("SELECT updated_at, deleted_at, properties FROM items WHERE id = $1", [serverId])).toEqual(
      before,
    );
    expect(await count("SELECT 1 FROM mcp_tool_registrations WHERE mcp_server_item_id = $1", [serverId])).toBe(0);
    await expect(syncMcpServerTools(pool, serverId, { actorId: actingUserId })).rejects.toThrow(/No MCP server item/);
  });
});

describe("tenant isolation of the follow-up cancellation (runtime role pool)", () => {
  it("removes only the jobs of the undoing tenant, with the runtime role that holds the queue grants", async () => {
    const runtime = await createRuntimeRolePool(pool, "alldots_data");
    try {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const setUp = async (tenant: string, email: string) => {
        await runInTenant(tenant, () => seedSystem(runtime));
        const userId = (await createUser(pool, { email, passwordHash: "unused", tenantId: tenant, role: "admin" })).id;
        return withTenantTransaction(runtime, tenant, async (client) => {
          const proposals = await getDatabaseByModuleId(client, "processingProposals");
          const servers = await getDatabaseByModuleId(client, "mcpServers");
          if (!proposals || !servers) throw new Error("Tenant was not seeded");
          const envelope = {
            entityKind: "database",
            target: servers.id,
            properties: { name: "Tool", connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" } },
          };
          const card = await createItemWithClient(
            client,
            {
              databaseId: proposals.id,
              properties: { kind: "inbox", status: "proposed", proposal: envelope, aiProposal: envelope },
            },
            { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal"] },
          );
          return { userId, cardId: card.id, proposalsId: proposals.id };
        });
      };
      const a = await setUp(tenantA, "a@example.test");
      const b = await setUp(tenantB, "b@example.test");
      const run = <T>(tenant: string, fn: (client: PoolClient) => Promise<T>) =>
        runInTenant(tenant, () => withTransaction(runtime, fn));
      const confirmServer = async (tenant: string, ids: typeof a): Promise<string> => {
        const confirmed = await run(tenant, (client) =>
          confirmProposalWithClient(
            client,
            { processingProposalsDatabaseId: ids.proposalsId },
            ids.cardId,
            undefined,
            ids.userId,
          ),
        );
        const [result] = readConfirmationResults(confirmed.properties);
        if (!result) throw new Error("The confirmation reported no result");
        return result.itemId;
      };
      const serverA = await confirmServer(tenantA, a);
      const serverB = await confirmServer(tenantB, b);
      expect(await queuedKeys()).toEqual([mcpServerSyncJobKey(serverA), mcpServerSyncJobKey(serverB)].sort());

      await run(tenantA, (client) =>
        reopenProposalWithClient(client, { processingProposalsDatabaseId: a.proposalsId }, a.cardId, {}, a.userId),
      );

      expect(await queuedKeys()).toEqual([mcpServerSyncJobKey(serverB)]);
      expect((await itemState(serverB)).deleted).toBe(false);
      expect(
        await withTenantTransaction(
          runtime,
          tenantA,
          async (client) => (await client.query("SELECT 1 FROM items WHERE id = $1", [serverB])).rowCount,
        ),
      ).toBe(0);
    } finally {
      await runtime.end();
    }
  });
});
