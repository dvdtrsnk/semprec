import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  createBlob,
  createItemWithClient,
  createRelationWithClient,
  createSemprecTickAction,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  getItemById,
  insertInboxAttachments,
  listInboxAttachments,
  readRecordingRequest,
  recordInboxAttachmentMetadata,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  confirmProposalWithClient,
  createInboxItemWithClient,
  getTestPool,
  inTenantZero,
  resetDatabase,
  updateProposalValuesWithClient,
} from "@semprec/data/testSupport";
import { createTranscriptionCreateTask } from "./transcriptionTask.js";

// Issue gh-1978: a recording card confirmed in the Inbox ends as a transcript with the name, the recording time and the
// project the user chose. The data package's tests prove what the confirm writes into the recording request; this test
// runs the transcription create step over that request, which only this service can do.

const RECORDED_AT = "2026-11-03T13:32:00.000Z";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
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

/** An Inbox item with a shared 23-minute recording whose metadata is written, and the recording card the tick made for it. */
async function recordingCard(recordedAt?: string): Promise<{ cardId: string; proposalsId: string }> {
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
      metadata: {
        pages: null,
        durationSeconds: 1380,
        audioKind: "recording",
        ...(recordedAt === undefined ? {} : { recordedAt }),
      },
      thumbnail: null,
      reduced: null,
    });
    return item.id;
  });
  const tick = createSemprecTickAction(pool, async () => {
    throw new Error("The model must not be called for a recording card");
  });
  await inTenantZero(() => tick(ids, { heartbeatId: "hb", projectItemId: randomUUID(), itemId }));
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
    ids.processingProposalsDatabaseId,
  ]);
  if (rows.length !== 1 || !rows[0]) throw new Error("Expected exactly one card");
  return { cardId: rows[0].id, proposalsId: ids.processingProposalsDatabaseId };
}

async function transcriptOf(fileItemId: string): Promise<{ id: string; properties: Record<string, unknown> }> {
  return inTransaction(async (client) => {
    const file = await getItemById(client, await databaseId(client, "files"), fileItemId);
    const id = z.uuid().parse(file?.computed.create);
    const transcript = await getItemById(client, await databaseId(client, "transcripts"), id);
    if (!transcript) throw new Error("The transcript was not created");
    return { id, properties: transcript.properties };
  });
}

async function projectEdges(transcriptId: string): Promise<string[]> {
  const { rows } = await pool.query<{ item_a: string }>(
    `SELECT r.item_a FROM item_relations r
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id = d.property_id_b
      WHERE p.key = 'project' AND r.item_b = $1`,
    [transcriptId],
  );
  return rows.map((row) => row.item_a);
}

async function valueLinkCount(transcriptId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM value_links WHERE item_id = $1 AND property_key = 'project'",
    [transcriptId],
  );
  return rows[0]?.n ?? 0;
}

describe("a confirmed recording card becomes a transcript", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });

  it("has the chosen name, the recording time of the attachment's metadata as its date and the user's own project", async () => {
    const { cardId, proposalsId } = await recordingCard(RECORDED_AT);
    const project = await inTransaction(async (client) =>
      createItemWithClient(client, {
        databaseId: await databaseId(client, "projects"),
        properties: { name: "Renovation" },
      }),
    );
    const config = { processingProposalsDatabaseId: proposalsId };
    await inTransaction((client) =>
      updateProposalValuesWithClient(client, config, cardId, {
        set: { primary: { name: "Conversation with the electrician", projectId: project.id, language: "cs" } },
      }),
    );

    const confirmed = await inTransaction((client) => confirmProposalWithClient(client, config, cardId));

    const fileItemId = String(confirmed.properties.resultItemId);
    const request = await inTransaction((client) => readRecordingRequest(client, fileItemId));
    expect(request).toMatchObject({
      name: "Conversation with the electrician",
      projectItemId: project.id,
      language: "cs",
    });
    expect(Date.parse(String(request?.recordedAt))).toBe(Date.parse(RECORDED_AT));
    await inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId }));
    const transcript = await transcriptOf(fileItemId);
    expect(transcript.properties).toMatchObject({ name: "Conversation with the electrician", status: "processing" });
    expect(Date.parse(String(transcript.properties.date))).toBe(Date.parse(RECORDED_AT));
    expect(await projectEdges(transcript.id)).toEqual([project.id]);
    expect(await valueLinkCount(transcript.id)).toBe(0);
  });

  it("takes the Event's project as an inherited value when the card's project is left as the Event's", async () => {
    const { cardId, proposalsId } = await recordingCard(RECORDED_AT);
    const ids = await inTransaction(async (client) => {
      const project = await createItemWithClient(client, {
        databaseId: await databaseId(client, "projects"),
        properties: { name: "Apollo" },
      });
      const eventsId = await databaseId(client, "events");
      const event = await createItemWithClient(client, {
        databaseId: eventsId,
        properties: { name: "Planning", type: "meeting", date: "2026-10-22" },
      });
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = 'project'",
        [eventsId],
      );
      return { projectId: project.id, eventId: event.id, projectPropertyId: rows[0]?.id ?? "" };
    });
    await inTransaction((client) =>
      createRelationWithClient(client, {
        relationPropertyId: ids.projectPropertyId,
        callerItemId: ids.eventId,
        targetItemId: ids.projectId,
      }),
    );
    const config = { processingProposalsDatabaseId: proposalsId };
    await inTransaction((client) =>
      updateProposalValuesWithClient(client, config, cardId, {
        set: { primary: { name: "Planning call", eventId: ids.eventId, projectId: ids.projectId } },
      }),
    );

    const confirmed = await inTransaction((client) => confirmProposalWithClient(client, config, cardId));

    const fileItemId = String(confirmed.properties.resultItemId);
    expect((await inTransaction((client) => readRecordingRequest(client, fileItemId)))?.projectItemId).toBeNull();
    await inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId }));
    const transcript = await transcriptOf(fileItemId);
    expect(transcript.properties).toMatchObject({ name: "Planning call" });
    expect(Date.parse(String(transcript.properties.date))).toBe(Date.parse(RECORDED_AT));
    expect(await projectEdges(transcript.id)).toEqual([ids.projectId]);
    expect(await valueLinkCount(transcript.id)).toBe(1);
  });

  it("is created from a recording without a recording time with the upload time as its date, as for any request without one", async () => {
    const { cardId, proposalsId } = await recordingCard();
    const config = { processingProposalsDatabaseId: proposalsId };

    const confirmed = await inTransaction((client) => confirmProposalWithClient(client, config, cardId));

    const fileItemId = String(confirmed.properties.resultItemId);
    expect((await inTransaction((client) => readRecordingRequest(client, fileItemId)))?.recordedAt).toBeNull();
    await inTenantZero(() => createTranscriptionCreateTask(pool)({ fileItemId }));
    const transcript = await transcriptOf(fileItemId);
    const blob = await pool.query<{ created_at: Date }>(
      "SELECT b.created_at FROM blobs b JOIN items i ON i.properties -> 'file' ->> 'blobId' = b.id::text WHERE i.id = $1",
      [fileItemId],
    );
    expect(new Date(String(transcript.properties.date)).getTime()).toBe(blob.rows[0]?.created_at.getTime());
  });
});
