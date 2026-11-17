import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createBlob } from "../blobs/blobsStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { audioKindForDuration, type InboxAttachmentMetadata } from "../inbox/inboxAttachmentMetadata.js";
import { listInboxAttachments, recordInboxAttachmentMetadata } from "../inbox/inboxAttachmentsStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inbox/inboxTickAction.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import type { ItemRow } from "../types.js";

// The Inbox tick routes an item holding a long recording to the recording card before the model
// computation, and makes no model call for it.

let pool: Pool;
let databaseIds: { inboxDatabaseId: string; inboxItemTypesDatabaseId: string; processingProposalsDatabaseId: string };

const compute = vi.fn<ComputeSemprecProposalFn>(async () => ({ properties: {}, candidates: [] }));

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), () => withTransaction(pool, fn));
}

type Attachment = { mimeType: string; metadata: InboxAttachmentMetadata | null };

/** An audio attachment of `seconds` whose metadata the job has written. */
const audioOfSeconds = (seconds: number): Attachment => ({
  mimeType: "audio/mp4",
  metadata: { pages: null, durationSeconds: seconds, audioKind: audioKindForDuration(seconds) },
});
const photo: Attachment = { mimeType: "image/jpeg", metadata: { pages: null, width: 100, height: 100 } };

async function itemWith(attachments: Attachment[], text?: string): Promise<string> {
  return inTransaction(async (client) => {
    const blobs = [];
    for (const attachment of attachments) {
      blobs.push(
        await createBlob(client, {
          mimeType: attachment.mimeType,
          byteSize: 1024,
          storageKey: `blobs/${randomUUID()}`,
        }),
      );
    }
    const item = await createInboxItemWithClient(client, {
      inboxDatabaseId: databaseIds.inboxDatabaseId,
      date: "2026-11-05",
      time: "09:00",
      ...(text === undefined ? {} : { text }),
      attachments: blobs.map((blob) => ({ blobId: blob.id, source: "share" as const })),
    });
    const rows = await listInboxAttachments(client, [item.id]);
    for (const [index, row] of rows.entries()) {
      const metadata = attachments[index]?.metadata;
      if (metadata) {
        await recordInboxAttachmentMetadata(client, {
          attachmentId: row.attachmentId,
          metadata,
          thumbnail: null,
          reduced: null,
        });
      }
    }
    return item.id;
  });
}

async function runTick(itemId: string): Promise<void> {
  const tick = createSemprecTickAction(pool, compute);
  await runInTenant(getTenantZeroId(), () =>
    tick(databaseIds, { heartbeatId: "hb", projectItemId: randomUUID(), itemId }),
  );
}

async function cardsOf(itemId: string): Promise<ItemRow[]> {
  return inTransaction(async (client) => {
    const property = await getPropertyByKey(client, databaseIds.processingProposalsDatabaseId, "sourceInbox");
    const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
    if (!definition) throw new Error("Processing proposals has no sourceInbox relation");
    const cards: ItemRow[] = [];
    for (const edge of await listRelationsForItem(client, definition.id, itemId)) {
      const card = await getItemById(client, databaseIds.processingProposalsDatabaseId, otherSide(edge, itemId));
      if (card) cards.push(card);
    }
    return cards;
  });
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
  compute.mockClear();
});

afterAll(async () => {
  await pool?.end();
});

describe("the tick's routing of an item by its attachments", () => {
  it("produces the recording card for a 23-minute M4A and makes no model call", async () => {
    const itemId = await itemWith([audioOfSeconds(23 * 60)], "Shared from Voice Memos");

    await runTick(itemId);

    expect(compute).not.toHaveBeenCalled();
    const [card, ...rest] = await cardsOf(itemId);
    expect(rest).toEqual([]);
    expect(card?.properties).toMatchObject({
      kind: "inbox",
      status: "proposed",
      proposal: { entityKind: "transcription", properties: { name: "Shared from Voice Memos" } },
    });
  });

  it.each([
    [119, false],
    [120, true],
    [121, true],
  ])("at %i seconds the recording card is produced: %s", async (seconds, isRecording) => {
    const itemId = await itemWith([audioOfSeconds(seconds)], "A call");

    await runTick(itemId);

    expect(compute).toHaveBeenCalledTimes(isRecording ? 0 : 1);
    const cards = await cardsOf(itemId);
    if (isRecording) expect(cards[0]?.properties.proposal).toMatchObject({ entityKind: "transcription" });
    else
      expect(
        cards.every((card) => (card.properties.proposal as { entityKind?: string })?.entityKind !== "transcription"),
      ).toBe(true);
  });

  it("sends a 40-second voice note through the normal computation", async () => {
    const itemId = await itemWith([audioOfSeconds(40)], "Remember the milk");

    await runTick(itemId);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.calls[0]?.[0].sourceItem.id).toBe(itemId);
  });

  it("writes no card and makes no model call while the audio's metadata is not ready", async () => {
    const itemId = await itemWith([{ mimeType: "audio/mp4", metadata: null }], "Waiting for the probe");

    await runTick(itemId);

    expect(compute).not.toHaveBeenCalled();
    expect(await cardsOf(itemId)).toEqual([]);
  });

  it("produces the card once the metadata arrives and the tick runs again", async () => {
    const itemId = await itemWith([{ mimeType: "audio/mp4", metadata: null }]);
    await runTick(itemId);
    expect(await cardsOf(itemId)).toEqual([]);

    await inTransaction(async (client) => {
      const [attachment] = await listInboxAttachments(client, [itemId]);
      await recordInboxAttachmentMetadata(client, {
        attachmentId: attachment!.attachmentId,
        metadata: audioOfSeconds(600).metadata!,
        thumbnail: null,
        reduced: null,
      });
    });
    await runTick(itemId);

    expect(compute).not.toHaveBeenCalled();
    expect((await cardsOf(itemId))[0]?.properties.proposal).toMatchObject({ entityKind: "transcription" });
  });

  it("produces the recording card for an item with a recording and a photo", async () => {
    const itemId = await itemWith([photo, audioOfSeconds(600)]);

    await runTick(itemId);

    expect(compute).not.toHaveBeenCalled();
    const [card] = await cardsOf(itemId);
    const attachments = await inTransaction((client) => listInboxAttachments(client, [itemId]));
    const recording = attachments.find((attachment) => attachment.mimeType.startsWith("audio/"));
    expect(card?.properties.proposal).toMatchObject({ entityKind: "transcription", target: recording?.attachmentId });
  });

  it("leaves an item without audio to the normal computation, with a photo or without any attachment", async () => {
    const withPhoto = await itemWith([photo], "A receipt");
    const plain = await itemWith([], "Buy milk");

    await runTick(withPhoto);
    await runTick(plain);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls.map((call) => call[0].sourceItem.id).sort()).toEqual([plain, withPhoto].sort());
  });
});
