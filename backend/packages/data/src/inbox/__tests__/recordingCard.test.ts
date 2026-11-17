import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { getItemById, writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { recordRecordingIntake } from "../../transcription/recordingIntake.js";
import { TRANSCRIPTION_CREATE_COMPUTED_KEY } from "../../transcription/transcriptionComputedKeys.js";
import {
  enqueueTranscriptionCreate,
  enqueueTranscriptionJob,
  findTranscriptionCreateJobId,
  findTranscriptionJobId,
  transcriptionSourceLink,
  TRANSCRIPTION_OWNER_PROCESS,
} from "../../transcription/transcriptionJob.js";
import type { ItemRow } from "../../types.js";
import { getInboxAttachment, listInboxAttachments, recordInboxAttachmentMetadata } from "../inboxAttachmentsStore.js";
import type { InboxAttachmentMetadata } from "../inboxAttachmentMetadata.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import {
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  type ComputeSemprecProposalFn,
  type ProposalEnvelope,
} from "../inboxTickAction.js";
import { listInboxCards } from "../inboxCardsStore.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  rejectProposalWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../proposalActions.js";
import { recordingCardContextSchema } from "../recordingCardEnvelope.js";

// The card that proposes transcribing an audio attachment of an Inbox item, and its confirm. The tick produces the
// card without a model call; the confirm writes the recording request, moves the attachment into Files and enqueues
// the transcription in one transaction.

const FIXTURE_RECORDED_AT = "2026-11-03T13:32:00.000Z"; // 14:32 on 2026-11-03 in the default zone, Europe/Prague
const DURATION_SECONDS = 1380;

let pool: Pool;
let databaseIds: { inboxDatabaseId: string; inboxItemTypesDatabaseId: string; processingProposalsDatabaseId: string };
let eventsId: string;
let projectsId: string;
let filesId: string;

const modelIsNeverCalled: ComputeSemprecProposalFn = vi.fn(async () => {
  throw new Error("The model must not be called for a recording card");
});

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), () => withTransaction(pool, fn));
}

interface AudioOptions {
  mimeType?: string;
  /** `null` leaves the metadata job's result unwritten. */
  metadata?: InboxAttachmentMetadata | null;
}

const recordingMetadata = (recordedAt?: string): InboxAttachmentMetadata => ({
  pages: null,
  durationSeconds: DURATION_SECONDS,
  audioKind: "recording",
  ...(recordedAt === undefined ? {} : { recordedAt }),
});

async function itemWithAudio(
  text: string | undefined,
  audio: AudioOptions = {},
): Promise<{ itemId: string; attachmentId: string; blobId: string }> {
  const metadata = audio.metadata === undefined ? recordingMetadata(FIXTURE_RECORDED_AT) : audio.metadata;
  return inTransaction(async (client) => {
    const blob = await createBlob(client, {
      mimeType: audio.mimeType ?? "audio/mp4",
      byteSize: 4096,
      storageKey: `blobs/${randomUUID()}`,
    });
    const item = await createInboxItemWithClient(client, {
      inboxDatabaseId: databaseIds.inboxDatabaseId,
      date: "2026-11-05",
      time: "09:00",
      ...(text === undefined ? {} : { text }),
      attachments: [{ blobId: blob.id, source: "share" }],
    });
    const [attachment] = await listInboxAttachments(client, [item.id]);
    if (!attachment) throw new Error("The attachment was not stored");
    if (metadata !== null) {
      await recordInboxAttachmentMetadata(client, {
        attachmentId: attachment.attachmentId,
        metadata,
        thumbnail: null,
        reduced: null,
      });
    }
    return { itemId: item.id, attachmentId: attachment.attachmentId, blobId: blob.id };
  });
}

async function runTick(itemId: string, compute: ComputeSemprecProposalFn = modelIsNeverCalled): Promise<void> {
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

async function cardOf(itemId: string): Promise<ItemRow> {
  const cards = await cardsOf(itemId);
  if (cards.length !== 1 || !cards[0])
    throw new Error(`Expected exactly one card for ${itemId}, found ${cards.length}`);
  return cards[0];
}

function envelopeOf(card: ItemRow): ProposalEnvelope {
  const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (!envelope || "unknownKind" in envelope) throw new Error("The card has no known envelope");
  return envelope;
}

async function createEvent(properties: Record<string, unknown>): Promise<string> {
  return inTransaction(async (client) => (await createItemWithClient(client, { databaseId: eventsId, properties })).id);
}

async function createProject(name: string): Promise<string> {
  return inTransaction(
    async (client) => (await createItemWithClient(client, { databaseId: projectsId, properties: { name } })).id,
  );
}

async function linkEventToProject(eventId: string, projectId: string): Promise<void> {
  await inTransaction(async (client) => {
    const property = await getPropertyByKey(client, eventsId, "project");
    if (!property) throw new Error("Events has no project relation");
    await createRelationWithClient(client, {
      relationPropertyId: property.id,
      callerItemId: eventId,
      targetItemId: projectId,
    });
  });
}

/** Replaces the stored properties of an Event: a value the choke point refuses (a malformed date) can only get there this way. */
async function corruptEvent(eventId: string, patch: Record<string, unknown>): Promise<void> {
  // Raw SQL on purpose: the Events validation refuses these values, and the card has to survive them where they exist.
  await pool.query("UPDATE items SET properties = properties || $2::jsonb WHERE id = $1", [
    eventId,
    JSON.stringify(patch),
  ]);
}

async function storeEnvelope(cardId: string, envelope: ProposalEnvelope): Promise<void> {
  await inTransaction((client) =>
    updateItemWithClient(
      client,
      {
        databaseId: databaseIds.processingProposalsDatabaseId,
        itemId: cardId,
        propertiesPatch: { proposal: envelope },
      },
      { allowedSystemKeys: ["proposal"] },
    ),
  );
}

const config = () => ({ processingProposalsDatabaseId: databaseIds.processingProposalsDatabaseId });

const confirm = (cardId: string): Promise<ItemRow> =>
  inTransaction((client) => confirmProposalWithClient(client, config(), cardId));

const edit = (cardId: string, values: Record<string, unknown>) =>
  inTransaction((client) => updateProposalValuesWithClient(client, config(), cardId, { set: { primary: values } }));

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS counted`, params);
  return rows[0]?.n ?? 0;
}

const filesItemCount = () => count("SELECT 1 FROM items WHERE database_id = $1", [filesId]);
const requestCount = () => count("SELECT 1 FROM recording_requests");
const jobCount = (fileItemId: string) =>
  count("SELECT 1 FROM graphile_worker.jobs WHERE key = ANY($1::text[])", [
    [`transcription-create:${fileItemId}`, `transcription-job:${fileItemId}`],
  ]);
const anyTranscriptionJobCount = () => count("SELECT 1 FROM graphile_worker.jobs WHERE key LIKE 'transcription-%'");
const attachmentCount = (itemId: string) => count("SELECT 1 FROM inbox_attachments WHERE inbox_item_id = $1", [itemId]);

async function expectNothingStarted(itemId: string, attachmentId: string): Promise<void> {
  expect(await filesItemCount()).toBe(0);
  expect(await requestCount()).toBe(0);
  expect(await anyTranscriptionJobCount()).toBe(0);
  expect(await attachmentCount(itemId)).toBe(1);
  expect(await inTransaction((client) => getInboxAttachment(client, attachmentId))).not.toBeNull();
}

interface RequestRow {
  event_item_id: string | null;
  recorded_at: Date | null;
  name: string | null;
  language: string | null;
  num_speakers_exact: number | null;
  num_speakers_min: number | null;
  project_item_id: string | null;
}

async function requestRows(): Promise<RequestRow[]> {
  const { rows } = await pool.query<RequestRow>(
    `SELECT event_item_id, recorded_at, name, language, num_speakers_exact, num_speakers_min, project_item_id
       FROM recording_requests`,
  );
  return rows;
}

/** The `event_decision` of every recording request: `'none'` is the default, `'noEvent'` the explicit choice. */
async function eventDecisions(): Promise<string[]> {
  const { rows } = await pool.query<{ event_decision: string }>("SELECT event_decision FROM recording_requests");
  return rows.map((row) => row.event_decision);
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
  eventsId = await databaseIdFor("events");
  projectsId = await databaseIdFor("projects");
  filesId = await databaseIdFor("files");
  vi.mocked(modelIsNeverCalled).mockClear();
});

afterAll(async () => {
  await pool?.end();
});

describe("the recording card the Inbox tick produces for shared audio", () => {
  it("creates an inbox card with a transcription envelope, the local-day Events and the dated default name, without a model call and without starting a transcription", async () => {
    const { itemId, attachmentId } = await itemWithAudio(undefined);
    const planning = await createEvent({
      name: "Planning",
      type: "meeting",
      date: "2026-11-03",
      timeFrom: "14:00",
      timeTo: "15:00",
    });
    const standup = await createEvent({ name: "Standup", type: "standup", date: "2026-11-03", timeFrom: "09:00" });
    const calendarBlock = await createEvent({ name: "Calendar block", date: "2026-11-03", timeFrom: "13:00" });
    const conference = await createEvent({
      name: "Conference",
      type: "meeting",
      date: "2026-11-02",
      endDate: "2026-11-04",
    });
    const focus = await createEvent({ name: "Focus", type: "event", date: "2026-11-03", timeFrom: "08:00" });
    const yesterdayStandup = await createEvent({
      name: "Old standup",
      type: "standup",
      date: "2026-11-02",
      timeFrom: "09:00",
    });
    const dateTime = await createEvent({
      name: "Stored as a date-time",
      type: "meeting",
      date: "2026-11-03",
      timeFrom: "07:00",
    });
    await corruptEvent(dateTime, { date: "2026-11-03T07:00:00" });
    const malformedDate = await createEvent({ name: "Broken date", type: "meeting", date: "2026-11-03" });
    await corruptEvent(malformedDate, { date: "not-a-date" });
    // Passes the statement's text-prefix filter, so only the check in code can leave it out.
    const impossibleDate = await createEvent({ name: "Impossible date", type: "meeting", date: "2026-11-03" });
    await corruptEvent(impossibleDate, { date: "2026-02-31", endDate: "2026-11-30" });
    const malformedEnd = await createEvent({ name: "Broken end", type: "meeting", date: "2026-11-01" });
    await corruptEvent(malformedEnd, { endDate: "2026-99-99" });
    const project = await createProject("Home");
    await linkEventToProject(planning, project);

    await runTick(itemId);

    expect(modelIsNeverCalled).not.toHaveBeenCalled();
    const card = await cardOf(itemId);
    expect(card.properties).toMatchObject({ kind: "inbox", status: "proposed" });
    expect(envelopeOf(card)).toEqual({
      entityKind: "transcription",
      target: attachmentId,
      properties: { name: "Nahrávka 3. 11. 14:32" },
    });
    const context = recordingCardContextSchema.parse(card.properties.context);
    expect(context.recording).toEqual({
      durationSeconds: DURATION_SECONDS,
      recordedAt: FIXTURE_RECORDED_AT,
      source: "share",
    });
    const suggested = context.candidates.map((candidate) => candidate.eventId);
    expect(suggested).toEqual(expect.arrayContaining([planning, standup, calendarBlock, conference, dateTime]));
    expect(suggested).toHaveLength(5);
    expect(suggested).not.toContain(focus);
    expect(suggested).not.toContain(yesterdayStandup);
    expect(suggested).not.toContain(malformedDate);
    expect(suggested).not.toContain(impossibleDate);
    expect(suggested).not.toContain(malformedEnd);
    expect(context.candidates.find((candidate) => candidate.eventId === planning)).toEqual({
      eventId: planning,
      name: "Planning",
      date: "2026-11-03",
      timeFrom: "14:00",
      timeTo: "15:00",
      endDate: null,
      projectId: project,
      projectName: "Home",
    });
    // Nothing is transcribed, and nothing is paid for, before the card is confirmed.
    await expectNothingStarted(itemId, attachmentId);
  });

  it("is listed as a recording card", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);

    const list = await inTransaction((client) =>
      runInTenant(getTenantZeroId(), () => listInboxCards(client, { ownerUserId: randomUUID(), locale: "en" })),
    );

    const card = await cardOf(itemId);
    expect(list.cards.find((entry) => entry.cardId === card.id)).toMatchObject({
      cardKind: "recording",
      baseKind: "recording",
      status: "proposed",
    });
  });

  it("names the recording in the user's language", async () => {
    await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: "unused",
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    const { itemId } = await itemWithAudio(undefined);

    await runTick(itemId);

    expect(envelopeOf(await cardOf(itemId)).properties.name).toBe("Recording 3. 11. 14:32");
  });

  it("creates the card when the metadata has no recording time: no recordedAt, no suggestions and the undated default name", async () => {
    const { itemId, attachmentId } = await itemWithAudio(undefined, { metadata: recordingMetadata() });
    // An Event on the day the file was captured and uploaded must not be taken for the recording day.
    await createEvent({ name: "Capture day meeting", type: "meeting", date: "2026-11-05", timeFrom: "09:00" });

    await runTick(itemId);

    const card = await cardOf(itemId);
    expect(envelopeOf(card)).toEqual({
      entityKind: "transcription",
      target: attachmentId,
      properties: { name: "Nahrávka" },
    });
    expect(card.properties.context).toEqual({
      role: "recording",
      candidates: [],
      recording: { durationSeconds: DURATION_SECONDS, source: "share" },
    });
    expect(modelIsNeverCalled).not.toHaveBeenCalled();
    // The attachment's metadata is what the job wrote: no timestamp was added to it.
    const attachment = await inTransaction((client) => getInboxAttachment(client, attachmentId));
    expect(attachment?.metadata).toEqual(recordingMetadata());
  });

  it.each([
    ["with a recording time", recordingMetadata(FIXTURE_RECORDED_AT)],
    ["without a recording time", recordingMetadata()],
  ])("names the recording from the item's text first line %s", async (_label, metadata) => {
    const { itemId } = await itemWithAudio("## Call with the electrician\nSecond line", { metadata });

    await runTick(itemId);

    expect(envelopeOf(await cardOf(itemId)).properties).toEqual({ name: "Call with the electrician" });
  });

  it("falls back to the default name when the text has no readable line", async () => {
    const { itemId } = await itemWithAudio("  \n \n", { metadata: recordingMetadata() });

    await runTick(itemId);

    expect(envelopeOf(await cardOf(itemId)).properties).toEqual({ name: "Nahrávka" });
  });

  it("writes no card while the attachment's metadata is not computed yet, and no model call is made", async () => {
    const { itemId } = await itemWithAudio(undefined, { metadata: null });

    await runTick(itemId);

    expect(modelIsNeverCalled).not.toHaveBeenCalled();
    expect(await count("SELECT 1 FROM items WHERE database_id = $1", [databaseIds.processingProposalsDatabaseId])).toBe(
      0,
    );
  });

  it("an item without an audio attachment still goes through the model computation", async () => {
    const item = await inTransaction((client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: databaseIds.inboxDatabaseId,
        date: "2026-11-05",
        time: "09:00",
        text: "Buy milk",
      }),
    );
    const compute: ComputeSemprecProposalFn = vi.fn(async () => ({ properties: {}, candidates: [] }));

    await runTick(item.id, compute);

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("revises the card when the item's text changes, keeping the manual choices the user made", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    await edit(card.id, { language: "cs", numSpeakersMin: 2, noEvent: true });

    await inTransaction((client) =>
      updateItemWithClient(client, {
        databaseId: databaseIds.inboxDatabaseId,
        itemId,
        propertiesPatch: { text: "Meeting with the architect" },
      }),
    );
    await runTick(itemId);

    const revised = await cardOf(itemId);
    expect(revised.id).toBe(card.id);
    expect(envelopeOf(revised).properties).toEqual({
      name: "Meeting with the architect",
      language: "cs",
      numSpeakersMin: 2,
      noEvent: true,
    });
    expect(revised.properties.userEditedKeys).toEqual([
      "primary.language",
      "primary.noEvent",
      "primary.numSpeakersMin",
    ]);
    expect(recordingCardContextSchema.safeParse(revised.properties.context).success).toBe(true);
  });
});

describe("editing the recording card", () => {
  it("accepts a name, language, speaker count, a manual Event and a project although no Event is suggested", async () => {
    const { itemId } = await itemWithAudio(undefined, { metadata: recordingMetadata() });
    await runTick(itemId);
    const card = await cardOf(itemId);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-10-01", timeFrom: "12:00" });
    const projectId = await createProject("Renovation");

    const edited = await edit(card.id, {
      name: "Conversation with the electrician",
      language: "en",
      numSpeakersExact: 2,
      eventId,
      projectId,
    });

    expect(envelopeOf(edited.item).properties).toEqual({
      name: "Conversation with the electrician",
      language: "en",
      numSpeakersExact: 2,
      eventId,
      projectId,
    });
    expect(edited.item.properties.userEditedKeys).toEqual([
      "primary.eventId",
      "primary.language",
      "primary.name",
      "primary.numSpeakersExact",
      "primary.projectId",
    ]);
  });

  it("accepts clearing the Event and the project with null", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });
    await edit(card.id, { eventId });

    const cleared = await edit(card.id, { eventId: null });

    expect(envelopeOf(cleared.item).properties).toEqual({ name: "Nahrávka 3. 11. 14:32", eventId: null });
    expect(parseStoredProposalEnvelope(cleared.item.properties.proposal, card.id)).toMatchObject({
      entityKind: "transcription",
    });
  });

  it.each([
    ["a client-supplied recordedAt", { recordedAt: "2026-01-01T00:00:00.000Z" }, "recordedAt"],
    ["a client-supplied durationSeconds", { durationSeconds: 5 }, "durationSeconds"],
    ["an unknown key", { speakerNames: ["A"] }, "speakerNames"],
    ["a blank name", { name: "   " }, "name"],
    ["a language that is not a two-letter code", { language: "english" }, "language"],
    ["a speaker count below 1", { numSpeakersExact: 0 }, "numSpeakersExact"],
    ["a minimum speaker count below 2", { numSpeakersMin: 1 }, "numSpeakersMin"],
    ["a fractional speaker count", { numSpeakersExact: 1.5 }, "numSpeakersExact"],
    ["a speaker count beyond the integer column", { numSpeakersExact: 2_147_483_648 }, "numSpeakersExact"],
    ["a minimum speaker count beyond the integer column", { numSpeakersMin: 2_147_483_648 }, "numSpeakersMin"],
    ["an Event id that is not a UUID", { eventId: "tomorrow" }, "eventId"],
    ["a noEvent that is not a boolean", { noEvent: "yes" }, "noEvent"],
    ["a noEvent that is a number", { noEvent: 1 }, "noEvent"],
    ["noEvent true together with an eventId", { noEvent: true, eventId: randomUUID() }, "noEvent"],
  ])("refuses %s and keeps the card as it was", async (_label, values, field) => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const before = await cardOf(itemId);

    await expect(edit(before.id, values)).rejects.toMatchObject({
      code: "validation_failed",
      details: { field },
    });

    const after = await cardOf(itemId);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.properties.proposal).toEqual(before.properties.proposal);
  });

  it("accepts noEvent true, and false or null as no choice", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);

    const chosen = await edit(card.id, { noEvent: true });
    expect(envelopeOf(chosen.item).properties).toEqual({ name: "Nahrávka 3. 11. 14:32", noEvent: true });
    expect(chosen.item.properties.userEditedKeys).toEqual(["primary.noEvent"]);

    for (const value of [false, null]) {
      const cleared = await edit(card.id, { noEvent: value });
      expect(envelopeOf(cleared.item).properties).toMatchObject({ noEvent: value });
    }
  });

  it("refuses choosing an Event while the kept choice is noEvent, and accepts the switch in one edit", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });
    await edit(card.id, { noEvent: true });

    await expect(edit(card.id, { eventId })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "noEvent" },
    });
    expect(envelopeOf(await cardOf(itemId)).properties).toMatchObject({ noEvent: true });
    expect(envelopeOf(await cardOf(itemId)).properties).not.toHaveProperty("eventId");

    const switched = await edit(card.id, { noEvent: false, eventId });
    expect(envelopeOf(switched.item).properties).toMatchObject({ noEvent: false, eventId });
  });

  it("refuses both speaker counts on one card", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);

    await expect(edit(card.id, { numSpeakersExact: 2, numSpeakersMin: 3 })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("refuses an Event or a project that is not live, or of the wrong database", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const trashed = await createEvent({ name: "Cancelled", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });
    await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [trashed]);
    const project = await createProject("Not an Event");
    const event = await createEvent({ name: "Not a project", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });

    await expect(edit(card.id, { eventId: trashed })).rejects.toMatchObject({ details: { field: "eventId" } });
    await expect(edit(card.id, { eventId: project })).rejects.toMatchObject({ details: { field: "eventId" } });
    await expect(edit(card.id, { projectId: event })).rejects.toMatchObject({ details: { field: "projectId" } });
    await expect(edit(card.id, { projectId: randomUUID() })).rejects.toMatchObject({ details: { field: "projectId" } });
  });
});

describe("revising the recording card while the kept choice is noEvent (issue gh-1986)", () => {
  it("refuses a revise whose assistant envelope names an eventId, and keeps the card as it was", async () => {
    const { itemId, attachmentId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });
    await edit(card.id, { noEvent: true });
    const before = await cardOf(itemId);

    await expect(
      inTransaction((client) =>
        reviseProposalWithClient(client, config(), card.id, {
          message: "It was the lunch",
          entityKind: "transcription",
          target: attachmentId,
          properties: { name: "Lunch recording", eventId },
        }),
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "noEvent" } });

    const after = await cardOf(itemId);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.properties.proposal).toEqual(before.properties.proposal);
  });

  it("keeps the choice when the revise names no Event", async () => {
    const { itemId, attachmentId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    await edit(card.id, { noEvent: true });

    const revised = await inTransaction((client) =>
      reviseProposalWithClient(client, config(), card.id, {
        message: "Another name",
        entityKind: "transcription",
        target: attachmentId,
        properties: { name: "Another name" },
      }),
    );

    expect(envelopeOf(revised).properties).toEqual({ name: "Another name", noEvent: true });
  });
});

describe("what a transcription envelope has to be", () => {
  async function cardWithEnvelope(
    build: (ids: { attachmentId: string; itemId: string }) => ProposalEnvelope,
    itemText: string | undefined = undefined,
  ) {
    const audio = await itemWithAudio(itemText);
    await runTick(audio.itemId);
    const card = await cardOf(audio.itemId);
    await storeEnvelope(card.id, build(audio));
    return { ...audio, cardId: card.id };
  }

  it("is validated by assertValidProposalEnvelope: a valid one passes and returns no database", async () => {
    const { attachmentId } = await itemWithAudio(undefined);

    const target = await inTransaction((client) =>
      assertValidProposalEnvelope(client, {
        entityKind: "transcription",
        target: attachmentId,
        properties: { name: "Call", language: "cs" },
      }),
    );

    expect(target).toBeNull();
  });

  it.each([
    ["steps", { operations: [] }, "operations"],
    ["relations", { relations: {} }, "relations"],
  ])("refuses an envelope with %s", async (_label, extra, field) => {
    const { attachmentId } = await itemWithAudio(undefined);

    await expect(
      inTransaction((client) =>
        assertValidProposalEnvelope(client, {
          entityKind: "transcription",
          target: attachmentId,
          properties: { name: "Call" },
          ...extra,
        }),
      ),
    ).rejects.toMatchObject({ details: { field } });
  });

  it("refuses a target that is not an attachment, and an attachment that is not audio", async () => {
    const pdf = await itemWithAudio(undefined, { mimeType: "application/pdf", metadata: { pages: null } });

    await expect(
      inTransaction((client) =>
        assertValidProposalEnvelope(client, {
          entityKind: "transcription",
          target: pdf.attachmentId,
          properties: { name: "Call" },
        }),
      ),
    ).rejects.toMatchObject({ details: { field: "target" } });
    for (const target of [randomUUID(), "not-a-uuid"]) {
      await expect(
        inTransaction((client) =>
          assertValidProposalEnvelope(client, { entityKind: "transcription", target, properties: { name: "Call" } }),
        ),
      ).rejects.toMatchObject({ details: { field: "target" } });
    }
  });

  it("is parsed back by parseStoredProposalEnvelope with its properties", async () => {
    const { cardId } = await cardWithEnvelope(({ attachmentId }) => ({
      entityKind: "transcription",
      target: attachmentId,
      properties: { name: "Call", numSpeakersMin: 3 },
    }));
    const card = await inTransaction((client) =>
      getItemById(client, databaseIds.processingProposalsDatabaseId, cardId),
    );

    expect(parseStoredProposalEnvelope(card?.properties.proposal, cardId)).toEqual({
      entityKind: "transcription",
      target: expect.any(String),
      properties: { name: "Call", numSpeakersMin: 3 },
    });
  });

  it("is refused on confirm when it names an attachment of another Inbox item, and nothing is written", async () => {
    const mine = await itemWithAudio(undefined);
    const other = await itemWithAudio(undefined);
    await runTick(mine.itemId);
    const card = await cardOf(mine.itemId);
    await storeEnvelope(card.id, {
      entityKind: "transcription",
      target: other.attachmentId,
      properties: { name: "Stolen" },
    });

    await expect(confirm(card.id)).rejects.toMatchObject({ details: { field: "target" } });

    expect((await cardOf(mine.itemId)).properties.status).toBe("proposed");
    expect(await filesItemCount()).toBe(0);
    expect(await requestCount()).toBe(0);
    expect(await anyTranscriptionJobCount()).toBe(0);
    expect(await attachmentCount(other.itemId)).toBe(1);
  });

  it("is refused on confirm when the attachment is not audio", async () => {
    const { itemId, cardId, attachmentId } = await cardWithEnvelope(({ attachmentId: audioId }) => ({
      entityKind: "transcription",
      target: audioId,
      properties: { name: "Call" },
    }));
    const pdf = await inTransaction(async (client) => {
      const blob = await createBlob(client, {
        mimeType: "application/pdf",
        byteSize: 10,
        storageKey: `blobs/${randomUUID()}`,
      });
      const item = await createInboxItemWithClient(client, {
        inboxDatabaseId: databaseIds.inboxDatabaseId,
        date: "2026-11-05",
        time: "09:00",
        attachments: [{ blobId: blob.id, source: "files" }],
      });
      const [attachment] = await listInboxAttachments(client, [item.id]);
      return attachment!.attachmentId;
    });
    await storeEnvelope(cardId, { entityKind: "transcription", target: pdf, properties: { name: "Call" } });

    await expect(confirm(cardId)).rejects.toMatchObject({ details: { field: "target" } });

    await expectNothingStarted(itemId, attachmentId);
  });

  it.each([
    ["both speaker counts", { name: "Call", numSpeakersExact: 2, numSpeakersMin: 3 }],
    ["a client-supplied recordedAt", { name: "Call", recordedAt: "2026-01-01T00:00:00.000Z" }],
    ["a client-supplied durationSeconds", { name: "Call", durationSeconds: 3 }],
    ["a missing name", { language: "cs" }],
  ])("is refused on confirm with %s, and nothing is written", async (_label, properties) => {
    const { itemId, cardId, attachmentId } = await cardWithEnvelope(({ attachmentId: target }) => ({
      entityKind: "transcription",
      target,
      properties,
    }));

    await expect(confirm(cardId)).rejects.toMatchObject({ code: "validation_failed" });

    expect((await cardOf(itemId)).properties.status).toBe("proposed");
    await expectNothingStarted(itemId, attachmentId);
  });

  it("is refused on a card that is not an Inbox card", async () => {
    const { itemId, cardId, attachmentId } = await cardWithEnvelope(({ attachmentId: target }) => ({
      entityKind: "transcription",
      target,
      properties: { name: "Call" },
    }));
    await inTransaction((client) =>
      updateItemWithClient(
        client,
        {
          databaseId: databaseIds.processingProposalsDatabaseId,
          itemId: cardId,
          propertiesPatch: { kind: "transcript" },
        },
        { allowedSystemKeys: ["kind"] },
      ),
    );

    await expect(confirm(cardId)).rejects.toMatchObject({ details: { field: "entityKind" } });

    await expectNothingStarted(itemId, attachmentId);
  });
});

describe("confirming the recording card", () => {
  it("writes the recording request, moves the attachment into Files and enqueues both jobs, with the time of the metadata and the user's own project", async () => {
    const { itemId, attachmentId, blobId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const projectId = await createProject("Renovation");
    await edit(card.id, {
      name: "Conversation with the electrician",
      language: "cs",
      numSpeakersExact: 2,
      projectId,
    });

    const confirmed = await confirm(card.id);

    const files = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1",
      [filesId],
    );
    expect(files.rows).toHaveLength(1);
    const file = files.rows[0]!;
    expect(file.properties).toMatchObject({
      name: "Conversation with the electrician",
      type: "audio",
      file: { blobId },
    });
    expect(await attachmentCount(itemId)).toBe(0);
    const [request, ...rest] = await requestRows();
    expect(rest).toEqual([]);
    expect(request).toMatchObject({
      event_item_id: null,
      name: "Conversation with the electrician",
      language: "cs",
      num_speakers_exact: 2,
      num_speakers_min: null,
      project_item_id: projectId,
    });
    expect(request?.recorded_at?.toISOString()).toBe(FIXTURE_RECORDED_AT);
    expect(await inTransaction((client) => findTranscriptionCreateJobId(client, file.id))).not.toBeNull();
    expect(await inTransaction((client) => findTranscriptionJobId(client, file.id))).not.toBeNull();
    expect(await jobCount(file.id)).toBe(2);
    expect(confirmed.properties).toMatchObject({
      status: "confirmed",
      resultItemId: file.id,
      resultLabel: "Conversation with the electrician",
    });
    expect(readConfirmationResults(confirmed.properties)).toEqual([
      expect.objectContaining({
        ref: "primary",
        itemId: file.id,
        databaseKey: "files",
        label: "Conversation with the electrician",
        role: "primary",
        followUp: "transcriptionQueued",
      }),
    ]);
    expect(
      await pool.query("SELECT capture_channel, inbox_item_id FROM item_origins WHERE item_id = $1", [file.id]),
    ).toMatchObject({ rows: [{ capture_channel: "inbox", inbox_item_id: itemId }] });
    void attachmentId;
  });

  it("confirms a recording that has no recording time: the intake gets none and no time is written back anywhere", async () => {
    const { itemId, attachmentId } = await itemWithAudio(undefined, { metadata: recordingMetadata() });
    await runTick(itemId);
    const card = await cardOf(itemId);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-10-01", timeFrom: "12:00" });
    await edit(card.id, { name: "Voice memo", language: "en", numSpeakersMin: 3, eventId });

    const confirmed = await confirm(card.id);

    const [request] = await requestRows();
    expect(request).toMatchObject({
      event_item_id: eventId,
      recorded_at: null,
      name: "Voice memo",
      language: "en",
      num_speakers_min: 3,
      project_item_id: null,
    });
    const fileId = String(confirmed.properties.resultItemId);
    expect(await jobCount(fileId)).toBe(2);
    expect(confirmed.properties.context).toEqual({
      role: "recording",
      candidates: [],
      recording: { durationSeconds: DURATION_SECONDS, source: "share" },
    });
    expect(attachmentId).toBeDefined();
    expect(await attachmentCount(itemId)).toBe(0);
  });

  it("writes no project into the request when it is the chosen Event's project, and writes another project as the recording's own", async () => {
    const eventProject = await createProject("Event project");
    const otherProject = await createProject("Other project");
    const eventId = await createEvent({ name: "Planning", type: "meeting", date: "2026-11-03", timeFrom: "14:00" });
    await linkEventToProject(eventId, eventProject);

    const inherited = await itemWithAudio(undefined);
    await runTick(inherited.itemId);
    const inheritedCard = await cardOf(inherited.itemId);
    await edit(inheritedCard.id, { eventId, projectId: eventProject });
    await confirm(inheritedCard.id);

    const own = await itemWithAudio(undefined);
    await runTick(own.itemId);
    const ownCard = await cardOf(own.itemId);
    await edit(ownCard.id, { eventId, projectId: otherProject });
    await confirm(ownCard.id);

    const rows = await requestRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event_item_id)).toEqual([eventId, eventId]);
    expect(rows.map((row) => row.project_item_id).sort()).toEqual([null, otherProject].sort());
  });

  it("writes a project chosen without an Event as the recording's own", async () => {
    const project = await createProject("Renovation");
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    await edit(card.id, { projectId: project });

    await confirm(card.id);

    expect((await requestRows())[0]).toMatchObject({ event_item_id: null, project_item_id: project });
  });

  it("returns an already confirmed card as it is and enqueues nothing again", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const first = await confirm(card.id);
    const fileId = String(first.properties.resultItemId);
    const jobsAfterFirst = await anyTranscriptionJobCount();

    const second = await confirm(card.id);

    expect(second.properties.results).toEqual(first.properties.results);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(await anyTranscriptionJobCount()).toBe(jobsAfterFirst);
    expect(await jobCount(fileId)).toBe(2);
    expect(await filesItemCount()).toBe(1);
    expect(await requestCount()).toBe(1);
  });

  it("links an existing Files item with the same blob instead of duplicating it, and starts no second transcription for a transcribed one", async () => {
    const { itemId, blobId } = await itemWithAudio(undefined);
    const existing = await inTransaction(
      async (client) =>
        (await createItemWithClient(client, { databaseId: filesId, properties: { name: "Earlier", file: { blobId } } }))
          .id,
    );
    await runTick(itemId);
    const card = await cardOf(itemId);

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.resultItemId).toBe(existing);
    expect(await filesItemCount()).toBe(1);
    expect(await attachmentCount(itemId)).toBe(0);
    expect(await jobCount(existing)).toBe(2);
    expect(readConfirmationResults(confirmed.properties)[0]).toMatchObject({ followUp: "transcriptionQueued" });
  });

  it("reports no queued follow-up when the jobs of the linked Files item were queued before the confirm, and queues no second pair", async () => {
    const { itemId, blobId } = await itemWithAudio(undefined);
    const existing = await inTransaction(async (client) => {
      const file = await createItemWithClient(client, {
        databaseId: filesId,
        properties: { name: "Uploaded", file: { blobId } },
      });
      await enqueueTranscriptionCreate(client, { fileItemId: file.id });
      await enqueueTranscriptionJob(client, { fileItemId: file.id });
      return file.id;
    });
    const queuedBefore = await anyTranscriptionJobCount();
    await runTick(itemId);
    const card = await cardOf(itemId);

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.resultItemId).toBe(existing);
    expect(readConfirmationResults(confirmed.properties)[0]).toMatchObject({ followUp: null });
    expect(await jobCount(existing)).toBe(2);
    expect(await anyTranscriptionJobCount()).toBe(queuedBefore);
  });

  it("reports no queued follow-up and enqueues nothing when the Files item already has its transcript", async () => {
    const { itemId, blobId } = await itemWithAudio(undefined);
    const existing = await inTransaction(async (client) => {
      const file = await createItemWithClient(client, {
        databaseId: filesId,
        properties: { name: "Earlier", file: { blobId } },
      });
      const transcripts = await getDatabaseByModuleId(client, "transcripts");
      if (!transcripts) throw new Error("Transcripts database was not seeded");
      const transcript = await createItemWithClient(
        client,
        {
          databaseId: transcripts.id,
          properties: { status: "processing", link: transcriptionSourceLink(file.id) },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await writeComputed(client, filesId, file.id, TRANSCRIPTION_CREATE_COMPUTED_KEY, transcript.id);
      return file.id;
    });
    await runTick(itemId);
    const card = await cardOf(itemId);

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.resultItemId).toBe(existing);
    expect(readConfirmationResults(confirmed.properties)[0]).toMatchObject({ followUp: null });
    expect(await anyTranscriptionJobCount()).toBe(0);
    expect(await attachmentCount(itemId)).toBe(0);
  });

  it("rolls back the move of the attachment, the request and the jobs when the intake fails after the move, and leaves the card proposed", async () => {
    const { itemId, attachmentId, blobId } = await itemWithAudio(undefined);
    const firstEvent = await createEvent({ name: "First", type: "meeting", date: "2026-11-03", timeFrom: "10:00" });
    const secondEvent = await createEvent({ name: "Second", type: "meeting", date: "2026-11-03", timeFrom: "11:00" });
    // The Files item that already names the blob was recorded for another Event, which the intake refuses to replace.
    const existing = await inTransaction(async (client) => {
      const file = await createItemWithClient(client, {
        databaseId: filesId,
        properties: { name: "Earlier", file: { blobId } },
      });
      await recordRecordingIntake(client, { fileItemId: file.id, eventId: firstEvent, recordedAt: null });
      return file.id;
    });
    const jobsBefore = await anyTranscriptionJobCount();
    await runTick(itemId);
    const card = await cardOf(itemId);
    await edit(card.id, { eventId: secondEvent });

    await expect(confirm(card.id)).rejects.toMatchObject({ code: "recording_linked_elsewhere" });

    expect((await cardOf(itemId)).properties.status).toBe("proposed");
    expect(await attachmentCount(itemId)).toBe(1);
    expect(await inTransaction((client) => getInboxAttachment(client, attachmentId))).not.toBeNull();
    expect(await filesItemCount()).toBe(1);
    expect((await requestRows()).map((row) => row.event_item_id)).toEqual([firstEvent]);
    expect(await anyTranscriptionJobCount()).toBe(jobsBefore);
    expect(await jobCount(existing)).toBe(2);
  });

  it("rolls back the Files item it created, its origin, the request and the jobs when a step fails after the move, and leaves the card proposed", async () => {
    const { itemId, attachmentId } = await itemWithAudio("Call with the electrician");
    await runTick(itemId);
    const card = await cardOf(itemId);
    const itemsBefore = await count("SELECT 1 FROM items");
    const originsBefore = await count("SELECT 1 FROM item_origins");
    await pool.query(`
      CREATE FUNCTION fail_recording_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure after the move'; END $$`);
    await pool.query(`
      CREATE TRIGGER fail_recording_request_insert BEFORE INSERT ON recording_requests
        FOR EACH ROW EXECUTE FUNCTION fail_recording_request_insert()`);
    try {
      await expect(confirm(card.id)).rejects.toThrow("injected failure after the move");
    } finally {
      await pool.query("DROP TRIGGER fail_recording_request_insert ON recording_requests");
      await pool.query("DROP FUNCTION fail_recording_request_insert()");
    }

    expect((await cardOf(itemId)).properties.status).toBe("proposed");
    await expectNothingStarted(itemId, attachmentId);
    expect(await count("SELECT 1 FROM items")).toBe(itemsBefore);
    expect(await count("SELECT 1 FROM item_origins")).toBe(originsBefore);
  });

  it("stores the explicit noEvent decision in the confirm's transaction, and the request keeps the default otherwise", async () => {
    const chosen = await itemWithAudio(undefined);
    await runTick(chosen.itemId);
    const chosenCard = await cardOf(chosen.itemId);
    await edit(chosenCard.id, { noEvent: true });

    await confirm(chosenCard.id);

    expect(await eventDecisions()).toEqual(["noEvent"]);
    expect(await requestRows()).toHaveLength(1);
  });

  it.each([
    ["no choice", {}],
    ["noEvent false", { noEvent: false }],
    ["noEvent null", { noEvent: null }],
  ])("leaves the default decision for a confirm with %s", async (_label, values) => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    if (Object.keys(values).length > 0) await edit(card.id, values);

    await confirm(card.id);

    expect(await eventDecisions()).toEqual(["none"]);
  });

  it("leaves the default decision for a confirm with a chosen Event", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });
    await edit(card.id, { eventId });

    await confirm(card.id);

    expect(await eventDecisions()).toEqual(["none"]);
    expect((await requestRows())[0]).toMatchObject({ event_item_id: eventId });
  });

  it("stores noEvent on a request that already names an Event and keeps that Event, and never clears the decision", async () => {
    const { itemId, blobId } = await itemWithAudio(undefined);
    const eventId = await createEvent({ name: "Lunch", type: "meeting", date: "2026-11-03", timeFrom: "12:00" });
    const existing = await inTransaction(async (client) => {
      const file = await createItemWithClient(client, {
        databaseId: filesId,
        properties: { name: "Earlier", file: { blobId } },
      });
      await recordRecordingIntake(client, { fileItemId: file.id, eventId, recordedAt: null });
      return file.id;
    });
    await runTick(itemId);
    const card = await cardOf(itemId);
    await edit(card.id, { noEvent: true });

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.resultItemId).toBe(existing);
    expect(await eventDecisions()).toEqual(["noEvent"]);
    expect((await requestRows())[0]).toMatchObject({ event_item_id: eventId });
  });

  it("does not clear a stored noEvent decision when a later confirm of the same Files item makes no such choice", async () => {
    const first = await itemWithAudio(undefined);
    await runTick(first.itemId);
    const firstCard = await cardOf(first.itemId);
    await edit(firstCard.id, { noEvent: true });
    const confirmedFirst = await confirm(firstCard.id);
    // The same blob shared again becomes a second card whose confirm links the Files item that holds the request.
    const second = await inTransaction(async (client) => {
      const item = await createInboxItemWithClient(client, {
        inboxDatabaseId: databaseIds.inboxDatabaseId,
        date: "2026-11-05",
        time: "10:00",
        attachments: [{ blobId: first.blobId, source: "share" }],
      });
      const [attachment] = await listInboxAttachments(client, [item.id]);
      if (!attachment) throw new Error("The attachment was not stored");
      await recordInboxAttachmentMetadata(client, {
        attachmentId: attachment.attachmentId,
        metadata: recordingMetadata(FIXTURE_RECORDED_AT),
        thumbnail: null,
        reduced: null,
      });
      return item.id;
    });
    await runTick(second);
    const secondCard = await cardOf(second);

    const confirmedSecond = await confirm(secondCard.id);

    expect(confirmedSecond.properties.resultItemId).toBe(confirmedFirst.properties.resultItemId);
    expect(await eventDecisions()).toEqual(["noEvent"]);
  });

  it("confirms with the largest speaker count the request's integer column holds", async () => {
    const { itemId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);
    await edit(card.id, { numSpeakersExact: 2_147_483_647 });

    await confirm(card.id);

    expect((await requestRows()).map((row) => row.num_speakers_exact)).toEqual([2_147_483_647]);
  });
});

describe("rejecting the recording card", () => {
  it("transcribes nothing and keeps the audio with its Inbox item", async () => {
    const { itemId, attachmentId } = await itemWithAudio(undefined);
    await runTick(itemId);
    const card = await cardOf(itemId);

    const rejected = await inTransaction((client) => rejectProposalWithClient(client, config(), card.id));

    expect(rejected.properties.status).toBe("rejected");
    await expectNothingStarted(itemId, attachmentId);
  });
});

describe("tenant isolation of the recording card (runtime role pool)", () => {
  it("does not see another tenant's Event, project or attachment, and refuses a confirm that names them", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const setUp = async (tenant: string) => {
        await runInTenant(tenant, () => seedSystem(runtime));
        return withTenantTransaction(runtime, tenant, async (client) => {
          const inbox = await getDatabaseByModuleId(client, "inbox");
          const events = await getDatabaseByModuleId(client, "events");
          const projects = await getDatabaseByModuleId(client, "projects");
          const proposals = await getDatabaseByModuleId(client, "processingProposals");
          const types = await getDatabaseByModuleId(client, "inboxItemTypes");
          if (!inbox || !events || !projects || !proposals || !types) throw new Error("Tenant was not seeded");
          const blob = await createBlob(client, {
            mimeType: "audio/mp4",
            byteSize: 10,
            storageKey: `${tenant}/blobs/${randomUUID()}`,
          });
          const item = await createInboxItemWithClient(client, {
            inboxDatabaseId: inbox.id,
            date: "2026-11-05",
            time: "09:00",
            attachments: [{ blobId: blob.id, source: "share" }],
          });
          const [attachment] = await listInboxAttachments(client, [item.id]);
          await recordInboxAttachmentMetadata(client, {
            attachmentId: attachment!.attachmentId,
            metadata: recordingMetadata(FIXTURE_RECORDED_AT),
            thumbnail: null,
            reduced: null,
          });
          const event = await createItemWithClient(client, {
            databaseId: events.id,
            properties: { name: "Meeting", type: "meeting", date: "2026-11-03", timeFrom: "10:00" },
          });
          const project = await createItemWithClient(client, {
            databaseId: projects.id,
            properties: { name: "Project" },
          });
          return {
            attachmentId: attachment!.attachmentId,
            itemId: item.id,
            eventId: event.id,
            projectId: project.id,
            databaseIds: {
              inboxDatabaseId: inbox.id,
              inboxItemTypesDatabaseId: types.id,
              processingProposalsDatabaseId: proposals.id,
            },
          };
        });
      };
      const a = await setUp(tenantA);
      const b = await setUp(tenantB);
      const envelope = (target: string, properties: Record<string, unknown>): ProposalEnvelope => ({
        entityKind: "transcription",
        target,
        properties: { name: "Call", ...properties },
      });
      const validate = (tenant: string, value: ProposalEnvelope) =>
        withTenantTransaction(runtime, tenant, (client) => assertValidProposalEnvelope(client, value));

      await expect(
        validate(tenantA, envelope(a.attachmentId, { eventId: a.eventId, projectId: a.projectId })),
      ).resolves.toBeNull();
      await expect(validate(tenantA, envelope(a.attachmentId, { eventId: b.eventId }))).rejects.toMatchObject({
        details: { field: "eventId" },
      });
      await expect(validate(tenantA, envelope(a.attachmentId, { projectId: b.projectId }))).rejects.toMatchObject({
        details: { field: "projectId" },
      });
      await expect(validate(tenantA, envelope(b.attachmentId, {}))).rejects.toMatchObject({
        details: { field: "target" },
      });

      // A card of tenant A that names tenant B's Event is refused on confirm and writes nothing.
      const tick = createSemprecTickAction(runtime, modelIsNeverCalled);
      await runInTenant(tenantA, () =>
        tick(a.databaseIds, { heartbeatId: "hb", projectItemId: randomUUID(), itemId: a.itemId }),
      );
      const cardId = await withTenantTransaction(runtime, tenantA, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
          [a.databaseIds.processingProposalsDatabaseId],
        );
        if (rows.length !== 1 || !rows[0]) throw new Error("Expected one card");
        await updateItemWithClient(
          client,
          {
            databaseId: a.databaseIds.processingProposalsDatabaseId,
            itemId: rows[0].id,
            propertiesPatch: { proposal: envelope(a.attachmentId, { eventId: b.eventId }) },
          },
          { allowedSystemKeys: ["proposal"] },
        );
        return rows[0].id;
      });
      await expect(
        runInTenant(tenantA, () =>
          withTransaction(runtime, (client) =>
            confirmProposalWithClient(
              client,
              { processingProposalsDatabaseId: a.databaseIds.processingProposalsDatabaseId },
              cardId,
            ),
          ),
        ),
      ).rejects.toMatchObject({ details: { field: "eventId" } });
      const written = await withTenantTransaction(runtime, tenantA, async (client) => {
        const requests = await client.query("SELECT 1 FROM recording_requests");
        const attachments = await client.query("SELECT 1 FROM inbox_attachments WHERE inbox_item_id = $1", [a.itemId]);
        return { requests: requests.rowCount, attachments: attachments.rowCount };
      });
      expect(written).toEqual({ requests: 0, attachments: 1 });
    } finally {
      await runtime.end();
    }
  });
});
