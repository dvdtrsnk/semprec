import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { findIdempotentReplay, lockItemById, lockItemByIdNowait, writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  rejectProposalWithClient,
} from "../../inbox/proposalActions.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { TRANSCRIPT_SEGMENTS_COMPUTED_KEY } from "../transcriptionComputedKeys.js";
import {
  createTranscriptDetailRouteHandler,
  createTranscriptSpeakerAssignRouteHandler,
  createTranscriptSpeakerCandidatesRouteHandler,
  createTranscriptSpeakersRouteHandler,
} from "../transcriptionRouteHandlers.js";
import { assignTranscriptSpeaker } from "../transcriptSpeakerAssignment.js";
import { proposeSpeakerMappings, speakerSuggestionIdempotencyKey } from "../transcriptSpeakerSuggestion.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b01";
const WAIT_MS = 10_000;
const MAILBOX_ID = "6f1f8d0e-3c57-4a56-9d0b-2f8a3e3f4b11";

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Thanks for joining everyone.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Happy to be here today.", startsAt: 2.5, endsAt: 5 },
  { speaker: "SPEAKER_02", text: "Let us begin with the offer.", startsAt: 5.5, endsAt: 7 },
];

interface World {
  /** The tenant's own person and the organizer of the Event. */
  me: string;
  /** A participant with an accepted invitation, relationship `client`. */
  alice: string;
  /** A participant linked without an invitation. */
  bob: string;
  /** A person who is not a participant. */
  carol: string;
  event: string;
  transcript: string;
}

async function databaseId(moduleId: string): Promise<string> {
  const database = (await createChokePoint(runtime).listDatabases()).find((row) => row.ownerModuleId === moduleId);
  if (!database) throw new Error(`Missing ${moduleId}`);
  return database.id;
}

async function propertyId(moduleId: string, key: string): Promise<string> {
  const property = (await createChokePoint(runtime).listProperties(await databaseId(moduleId))).find(
    (row) => row.key === key,
  );
  if (!property) throw new Error(`Missing ${moduleId}.${key}`);
  return property.id;
}

async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  return (await createChokePoint(runtime).createItem({ databaseId: await databaseId(moduleId), properties })).id;
}

/** A user-written edge, the way the generic relation endpoint writes it. */
async function link(
  moduleId: string,
  key: string,
  callerItemId: string,
  targetItemId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const relationPropertyId = await propertyId(moduleId, key);
  await withTransaction(runtime, async (client) => {
    await createRelationWithClient(client, { relationPropertyId, callerItemId, targetItemId, metadata }, undefined, {
      writerKind: "user",
    });
  });
}

/** A transcript of the tenant in scope with segments of three speakers and no mapping. */
async function createTranscript(): Promise<string> {
  const transcripts = await databaseId("transcripts");
  return withTransaction(runtime, async (client) => {
    const item = await createItemWithClient(client, { databaseId: transcripts, properties: { name: "Meeting" } });
    await writeComputed(client, transcripts, item.id, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, SEGMENTS);
    return item.id;
  });
}

/**
 * The tenant in scope with its own person, who organizes an Event, a participant with an accepted
 * invitation, a participant linked without one, a person outside the Event and a transcript linked to the
 * Event whose three speakers are unmapped.
 */
async function buildWorld(): Promise<World> {
  const me = await createItem("people", { name: "Zdenek Own" });
  const alice = await createItem("people", { name: "Alice Novak", relationship: "client" });
  const bob = await createItem("people", { name: "Bob Dvorak" });
  const carol = await createItem("people", { name: "Carol Svoboda" });
  await withTransaction(runtime, (client) => setSelfPersonId(client, me));
  const event = await createItem("events", { name: "Offer meeting", date: "2026-10-16" });
  await link("events", "people", event, me, { role: "organizer" });
  // An invitation is written by the calendar module's invitation code with the system writer kind (issue #1757).
  await createChokePoint(runtime).createRelation({
    relationPropertyId: await propertyId("events", "people"),
    callerItemId: event,
    targetItemId: alice,
    metadata: { invitation: { status: "accepted", email: "alice@example.com", mailboxId: MAILBOX_ID } },
  });
  await link("events", "people", event, bob);
  const transcript = await createTranscript();
  await link("transcripts", "event", transcript, event);
  return { me, alice, bob, carol, event, transcript };
}

const identity = { user: { id: USER_ID, locale: "en" } };

function assign(transcriptId: string, speaker: string, body: unknown) {
  return createTranscriptSpeakerAssignRouteHandler(runtime)({
    params: { id: transcriptId, speaker },
    body,
    identity,
  });
}

function candidates(transcriptId: string) {
  return createTranscriptSpeakerCandidatesRouteHandler(runtime)({ params: { id: transcriptId }, identity });
}

const assignedSchema = z.object({ speaker: z.string(), label: z.string(), personId: z.string().nullable() }).strict();

/** The answer of an assignment that succeeded, its body parsed at the boundary. */
async function assigned(transcriptId: string, speaker: string, personId: string | null) {
  const answer = await assign(transcriptId, speaker, { personId });
  expect(answer.status).toBe(200);
  return assignedSchema.parse(JSON.parse(JSON.stringify(answer.body)));
}

const speakersSchema = z.object({
  speakers: z.array(z.object({ speaker: z.string(), label: z.string(), personId: z.string().nullable() })),
});

/** The label and person `GET /api/transcripts/:id/speakers` shows for every key. */
async function listedSpeakers(transcriptId: string) {
  const answer = await createTranscriptSpeakersRouteHandler(runtime)({ params: { id: transcriptId }, identity });
  return speakersSchema.parse(JSON.parse(JSON.stringify(answer.body))).speakers;
}

const candidatesSchema = z
  .object({
    participants: z.array(
      z
        .object({
          personId: z.string(),
          name: z.string().nullable(),
          title: z.null(),
          relationship: z.string().nullable(),
          invitationStatus: z.enum(["pending", "accepted", "tentative", "declined"]).nullable(),
          mappedSpeaker: z.string().nullable(),
        })
        .strict(),
    ),
    self: z
      .object({ personId: z.string(), name: z.string().nullable(), mappedSpeaker: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

async function candidateList(transcriptId: string) {
  const answer = await candidates(transcriptId);
  expect(answer.status).toBe(200);
  const parsed = candidatesSchema.parse(JSON.parse(JSON.stringify(answer.body)));
  return { ...parsed, participants: [...parsed.participants].sort((a, b) => a.personId.localeCompare(b.personId)) };
}

/** The `ChokePointError` a call was refused with: its status, code and details. Any other outcome fails the test. */
async function refusal(
  call: Promise<unknown>,
): Promise<{ status: number; code: string; message: string; details: unknown }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ChokePointError) {
      return { status: error.status, code: error.code, message: error.message, details: error.details };
    }
    throw error;
  }
  throw new Error("Expected the call to be refused");
}

const NOT_FOUND = {
  status: 404,
  code: "not_found",
  message: "Transcript or person not found",
  details: { resource: "transcriptSpeaker" },
};

interface EdgeRow {
  id: string;
  item_a: string;
  item_b: string;
  metadata: Record<string, unknown>;
}

/** Every edge of the relation `key` of the database `moduleId`, read through the runtime role; ordered by endpoint ids. */
async function edgesOf(moduleId: string, key: string): Promise<EdgeRow[]> {
  const { rows } = await runtime.query<EdgeRow>(
    `SELECT r.id, r.item_a, r.item_b, r.metadata
       FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
      WHERE d.property_id_a = $1 OR d.property_id_b = $1 ORDER BY r.item_a, r.item_b`,
    [await propertyId(moduleId, key)],
  );
  return rows;
}

/** The speaker keys the `speakers` edges of the transcript map, as `[speaker, personId]`, sorted. */
async function mappings(transcriptId: string): Promise<[string, string][]> {
  return (await edgesOf("transcripts", "speakers"))
    .filter((edge) => edge.item_a === transcriptId)
    .map((edge): [string, string] => [String(edge.metadata.speaker), edge.item_b])
    .sort();
}

/** The persons on the `people` edges of the Event, sorted. */
async function participants(eventId: string): Promise<string[]> {
  return (await edgesOf("events", "people"))
    .filter((edge) => edge.item_a === eventId)
    .map((edge) => edge.item_b)
    .sort();
}

const cardSchema = z
  .object({
    status: z.string(),
    resultItemId: z.string().optional(),
    resultLabel: z.string().optional(),
    history: z.array(z.object({ author: z.string(), message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/** The speaker-suggestion card of `speaker`, as stored, with its id. */
async function cardOf(transcriptId: string, speaker: string) {
  const proposals = await databaseId("processingProposals");
  const item = await withTransaction(runtime, (client) =>
    findIdempotentReplay(client, proposals, speakerSuggestionIdempotencyKey(transcriptId, speaker)),
  );
  if (!item) throw new Error(`No card for ${speaker}`);
  return { id: item.id, properties: item.properties, card: cardSchema.parse(item.properties) };
}

/**
 * Creates the cards of the three unmapped speakers the way the transcription pipeline does: SPEAKER_00 proposes
 * Alice, SPEAKER_01 asks for clarification and SPEAKER_02 proposes Bob.
 */
async function createCards(world: World): Promise<void> {
  await withTransaction(runtime, async (client) => {
    const proposed = await proposeSpeakerMappings(client, {
      transcriptId: world.transcript,
      suggestions: [
        { speaker: "SPEAKER_00", personId: world.alice, reason: "Greets the room" },
        { speaker: "SPEAKER_02", personId: world.bob, reason: "Opens the agenda" },
      ],
    });
    expect(proposed).toEqual(["SPEAKER_00", "SPEAKER_01", "SPEAKER_02"]);
  });
}

/** Stores `proposal` as the open card of `speaker`, which production writes cannot do for a malformed or foreign envelope. */
async function storeProposal(transcriptId: string, speaker: string, proposal: Record<string, unknown>): Promise<void> {
  const card = await cardOf(transcriptId, speaker);
  const processingProposals = await databaseId("processingProposals");
  await withTransaction(runtime, (client) =>
    updateItemWithClient(
      client,
      { databaseId: processingProposals, itemId: card.id, propertiesPatch: { proposal, status: "proposed" } },
      { allowedSystemKeys: ["proposal", "status"] },
    ),
  );
}

/** Records the invalidations `fn` publishes; the hook is cleared again afterwards. */
async function capturingInvalidations(fn: () => Promise<unknown>): Promise<InvalidationEvent[]> {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  try {
    await fn();
  } finally {
    setInvalidationHook(() => {});
  }
  return events;
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Polls, bounded, until `count` backends wait for a lock; read on the superuser pool. The embedded server of
 * the run serves this test file alone.
 */
async function untilBlocked(count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await admin.query<{ blocked: number }>(
      "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
    );
    if ((rows[0]?.blocked ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Fewer than ${count} backends were waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Holds the row lock of one item in an open transaction until `whileHeld` has finished, then commits it. The
 * gate opens on every path and the holder is awaited before this returns.
 */
async function holdingRowLock(moduleId: string, itemId: string, whileHeld: () => Promise<void>): Promise<void> {
  const database = await databaseId(moduleId);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let announce: () => void = () => {};
  const announced = new Promise<void>((resolve) => (announce = resolve));
  const holder = withTransaction(runtime, async (client) => {
    await lockItemById(client, database, itemId);
    announce();
    await gate;
  });
  const failedEarly = holder.then((): never => {
    throw new Error("The holding transaction ended before it was released");
  });
  try {
    await within(Promise.race([announced, failedEarly]), "the holding lock");
    await whileHeld();
  } finally {
    open();
    await Promise.allSettled([holder, failedEarly]);
  }
  await holder;
}

/**
 * Runs `during` while a transaction that proposed the cards of the transcript (SPEAKER_00 proposes Alice) holds the
 * transcript's row lock and has not committed them, then commits it. The gate opens on every path and the
 * proposing transaction is awaited before this returns.
 */
async function whileProposalUncommitted(world: World, during: () => Promise<void>): Promise<void> {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let announce: () => void = () => {};
  const announced = new Promise<void>((resolve) => (announce = resolve));
  const proposer = withTransaction(runtime, async (client) => {
    await proposeSpeakerMappings(client, {
      transcriptId: world.transcript,
      suggestions: [{ speaker: "SPEAKER_00", personId: world.alice, reason: "Greets the room" }],
    });
    announce();
    await gate;
  });
  const failedEarly = proposer.then((): never => {
    throw new Error("The proposing transaction ended before it was released");
  });
  try {
    await within(Promise.race([announced, failedEarly]), "the uncommitted proposal");
    await during();
  } finally {
    open();
    await Promise.allSettled([proposer, failedEarly]);
  }
  await proposer;
}

describe("transcript speaker assignment (issue #1770)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify speaker assignment role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("PUT /api/transcripts/:id/speakers/:speaker", () => {
    it("maps an unmapped speaker in one call, shows the name in the transcript detail and closes the card", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);

        const answer = await assigned(world.transcript, "SPEAKER_00", world.alice);

        expect(answer).toEqual({ speaker: "SPEAKER_00", label: "Alice Novak", personId: world.alice });
        expect(await mappings(world.transcript)).toEqual([["SPEAKER_00", world.alice]]);
        const detail = await createTranscriptDetailRouteHandler(runtime)({
          params: { id: world.transcript },
          identity,
        });
        expect(detail.body).toMatchObject({
          speakers: [
            { speaker: "SPEAKER_00", label: "Alice Novak", personId: world.alice },
            { speaker: "SPEAKER_01" },
            {},
          ],
        });
        const { card, properties } = await cardOf(world.transcript, "SPEAKER_00");
        expect(card).toMatchObject({ status: "confirmed", resultItemId: world.alice, resultLabel: "Alice Novak" });
        expect(card.history?.at(-1)).toMatchObject({ author: "user" });
        expect(card.history?.at(-1)?.message).toContain("manual assignment");
        expect(readConfirmationResults(properties)).toMatchObject([
          { itemId: world.transcript, databaseKey: "transcripts", role: "primary", linkLabels: ["Alice Novak"] },
        ]);
      });
    });

    it("answers the label GET /api/transcripts/:id/speakers shows for the key", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        const answer = await assigned(world.transcript, "SPEAKER_01", world.bob);

        expect((await listedSpeakers(world.transcript)).find((entry) => entry.speaker === "SPEAKER_01")).toEqual(
          answer,
        );
      });
    });

    it("rejects the card of the key when it proposed another person", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);

        await assigned(world.transcript, "SPEAKER_00", world.carol);

        const { card } = await cardOf(world.transcript, "SPEAKER_00");
        expect(card.status).toBe("rejected");
        expect(card.resultItemId).toBeUndefined();
        expect(card.history?.at(-1)?.message).toContain("manual assignment");
        // The cards of the other keys are not touched.
        expect((await cardOf(world.transcript, "SPEAKER_01")).card.status).toBe("needsClarification");
        expect((await cardOf(world.transcript, "SPEAKER_02")).card.status).toBe("proposed");
      });
    });

    it("rejects the card of the key when it proposed the person for another key", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        // The card of SPEAKER_01 proposes Alice for SPEAKER_00. No production write makes such a card, so
        // the fixture stores the envelope directly.
        await storeProposal(world.transcript, "SPEAKER_01", {
          entityKind: "relation",
          target: world.alice,
          properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_00" } },
        });

        await assigned(world.transcript, "SPEAKER_01", world.alice);

        expect((await cardOf(world.transcript, "SPEAKER_01")).card.status).toBe("rejected");
        expect(await mappings(world.transcript)).toEqual([["SPEAKER_01", world.alice]]);
      });
    });

    it("rejects the card of the key when it proposed the person through another relation", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        await storeProposal(world.transcript, "SPEAKER_01", {
          entityKind: "relation",
          target: world.alice,
          properties: { propertyKey: "event", metadata: { speaker: "SPEAKER_01" } },
        });

        await assigned(world.transcript, "SPEAKER_01", world.alice);

        expect((await cardOf(world.transcript, "SPEAKER_01")).card.status).toBe("rejected");
      });
    });

    it("confirms the card of the key when it proposed exactly this person for this key", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        await storeProposal(world.transcript, "SPEAKER_01", {
          entityKind: "relation",
          target: world.alice,
          properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } },
        });

        await assigned(world.transcript, "SPEAKER_01", world.alice);

        expect((await cardOf(world.transcript, "SPEAKER_01")).card).toMatchObject({
          status: "confirmed",
          resultItemId: world.alice,
        });
      });
    });

    it("rejects a card that asked for clarification", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);

        await assigned(world.transcript, "SPEAKER_01", world.bob);

        expect((await cardOf(world.transcript, "SPEAKER_01")).card.status).toBe("rejected");
      });
    });

    it("leaves a card that was rejected or confirmed before untouched", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        const proposals = await databaseId("processingProposals");
        const confirmedCard = await cardOf(world.transcript, "SPEAKER_00");
        const rejectedCard = await cardOf(world.transcript, "SPEAKER_02");
        await withTransaction(runtime, async (client) => {
          await confirmProposalWithClient(
            client,
            { processingProposalsDatabaseId: proposals },
            confirmedCard.id,
            undefined,
            USER_ID,
          );
          await rejectProposalWithClient(client, { processingProposalsDatabaseId: proposals }, rejectedCard.id);
        });
        const confirmedBefore = (await cardOf(world.transcript, "SPEAKER_00")).properties;
        const rejectedBefore = (await cardOf(world.transcript, "SPEAKER_02")).properties;
        expect(confirmedBefore).toMatchObject({ status: "confirmed", resultItemId: world.alice });
        expect(rejectedBefore).toMatchObject({ status: "rejected" });

        await assigned(world.transcript, "SPEAKER_00", world.carol);
        await assigned(world.transcript, "SPEAKER_02", world.bob);

        expect((await cardOf(world.transcript, "SPEAKER_00")).properties).toEqual(confirmedBefore);
        expect((await cardOf(world.transcript, "SPEAKER_02")).properties).toEqual(rejectedBefore);
        expect(await mappings(world.transcript)).toEqual([
          ["SPEAKER_00", world.carol],
          ["SPEAKER_02", world.bob],
        ]);
      });
    });

    it("leaves a card that is invalid untouched", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        const card = await cardOf(world.transcript, "SPEAKER_00");
        const processingProposals = await databaseId("processingProposals");
        // The status the tick gives a card whose source is gone, set directly because only the tick writes it.
        await withTransaction(runtime, (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: processingProposals,
              itemId: card.id,
              propertiesPatch: { status: "invalid", invalidReason: "sourceDeleted" },
            },
            { allowedSystemKeys: ["status", "invalidReason"] },
          ),
        );
        const invalid = (await cardOf(world.transcript, "SPEAKER_00")).properties;
        expect(invalid).toMatchObject({ status: "invalid" });

        await assigned(world.transcript, "SPEAKER_00", world.alice);

        expect((await cardOf(world.transcript, "SPEAKER_00")).properties).toEqual(invalid);
      });
    });

    it("assigns a key whose card is in the Trash and leaves the card in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        const trashed = await cardOf(world.transcript, "SPEAKER_00");
        await createChokePoint(runtime).softDeleteItem(await databaseId("processingProposals"), trashed.id);

        await assigned(world.transcript, "SPEAKER_00", world.alice);

        expect((await cardOf(world.transcript, "SPEAKER_00")).properties).toEqual(trashed.properties);
        expect(await mappings(world.transcript)).toEqual([["SPEAKER_00", world.alice]]);
      });
    });

    it("assigns a key that has no card", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        expect(await assigned(world.transcript, "SPEAKER_02", world.bob)).toMatchObject({ personId: world.bob });
        expect(await mappings(world.transcript)).toEqual([["SPEAKER_02", world.bob]]);
      });
    });

    it("adds an assigned person who is not a participant to the Event, as an attendee without an invitation", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const before = await participants(world.event);

        await assigned(world.transcript, "SPEAKER_00", world.carol);

        expect(await participants(world.event)).toEqual([...before, world.carol].sort());
        const edge = (await edgesOf("events", "people")).find((row) => row.item_b === world.carol);
        expect(edge?.metadata).toEqual({});
      });
    });

    it("adds no second edge for a participant and keeps the invitation of an invited one", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const before = await edgesOf("events", "people");

        await assigned(world.transcript, "SPEAKER_00", world.alice);
        await assigned(world.transcript, "SPEAKER_01", world.bob);

        expect(await edgesOf("events", "people")).toEqual(before);
      });
    });

    it("writes no participant for a transcript without a linked Event", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const transcript = await createTranscript();
        const before = await edgesOf("events", "people");

        await assigned(transcript, "SPEAKER_00", world.carol);

        expect(await mappings(transcript)).toEqual([["SPEAKER_00", world.carol]]);
        expect(await edgesOf("events", "people")).toEqual(before);
      });
    });

    it("writes no participant when the linked Event is in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createChokePoint(runtime).softDeleteItem(await databaseId("events"), world.event);
        const before = await edgesOf("events", "people");

        await assigned(world.transcript, "SPEAKER_00", world.carol);

        expect(await mappings(world.transcript)).toEqual([["SPEAKER_00", world.carol]]);
        expect(await edgesOf("events", "people")).toEqual(before);
      });
    });

    it("replaces the person of a key and leaves the Event's participants as they are", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await assigned(world.transcript, "SPEAKER_00", world.carol);
        const participantsBefore = await participants(world.event);
        expect(participantsBefore).toContain(world.carol);

        const answer = await assigned(world.transcript, "SPEAKER_00", world.bob);

        expect(answer).toEqual({ speaker: "SPEAKER_00", label: "Bob Dvorak", personId: world.bob });
        expect(await mappings(world.transcript)).toEqual([["SPEAKER_00", world.bob]]);
        expect(await participants(world.event)).toEqual(participantsBefore);
      });
    });

    it("clears a key, which shows as unmapped again, and leaves the Event's participants as they are", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await assigned(world.transcript, "SPEAKER_00", world.carol);
        const participantsBefore = await participants(world.event);

        const answer = await assigned(world.transcript, "SPEAKER_00", null);

        expect(answer).toEqual({ speaker: "SPEAKER_00", label: "Speaker 1", personId: null });
        expect(await mappings(world.transcript)).toEqual([]);
        expect((await listedSpeakers(world.transcript))[0]).toEqual(answer);
        expect(await participants(world.event)).toEqual(participantsBefore);
      });
    });

    it("answers a cleared key that was never mapped as a success and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const events = await capturingInvalidations(async () => {
          expect(await assigned(world.transcript, "SPEAKER_01", null)).toEqual({
            speaker: "SPEAKER_01",
            label: "Speaker 2",
            personId: null,
          });
        });

        expect(await mappings(world.transcript)).toEqual([]);
        expect(events).toEqual([]);
      });
    });

    it("leaves the open card as it is when a key is cleared", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        const before = await cardOf(world.transcript, "SPEAKER_00");

        await assigned(world.transcript, "SPEAKER_00", null);

        expect((await cardOf(world.transcript, "SPEAKER_00")).properties).toEqual(before.properties);
      });
    });

    it("answers the same person twice as a success that writes nothing the second time", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await assigned(world.transcript, "SPEAKER_00", world.carol);
        const edgesBefore = [...(await edgesOf("transcripts", "speakers")), ...(await edgesOf("events", "people"))];

        const events = await capturingInvalidations(async () => {
          expect(await assigned(world.transcript, "SPEAKER_00", world.carol)).toEqual(first);
        });

        expect([...(await edgesOf("transcripts", "speakers")), ...(await edgesOf("events", "people"))]).toEqual(
          edgesBefore,
        );
        expect(events).toEqual([]);
      });
    });

    it("refuses a person who is mapped to another key and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        await assigned(world.transcript, "SPEAKER_00", world.alice);
        const edgesBefore = [...(await edgesOf("transcripts", "speakers")), ...(await edgesOf("events", "people"))];
        const cardBefore = await cardOf(world.transcript, "SPEAKER_01");

        const events = await capturingInvalidations(async () => {
          expect(await refusal(assign(world.transcript, "SPEAKER_01", { personId: world.alice }))).toMatchObject({
            status: 400,
            code: "validation_failed",
            details: { field: "personId", reason: "personAlreadyMapped", speaker: "SPEAKER_00" },
          });
        });

        expect([...(await edgesOf("transcripts", "speakers")), ...(await edgesOf("events", "people"))]).toEqual(
          edgesBefore,
        );
        expect((await cardOf(world.transcript, "SPEAKER_01")).properties).toEqual(cardBefore.properties);
        expect(events).toEqual([]);
      });
    });

    it("refuses a key the transcript does not have and changes nothing", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const eventEdges = await edgesOf("events", "people");

        expect(await refusal(assign(world.transcript, "SPEAKER_09", { personId: world.carol }))).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "speaker", reason: "unknownSpeaker" },
        });
        expect(await refusal(assign(world.transcript, "SPEAKER_09", { personId: null }))).toMatchObject({
          status: 400,
          details: { field: "speaker", reason: "unknownSpeaker" },
        });

        expect(await mappings(world.transcript)).toEqual([]);
        expect(await edgesOf("events", "people")).toEqual(eventEdges);
      });
    });

    it("answers an unknown person, a person in the Trash and an item of another database with the same 404", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const project = await createItem("projects", { name: "Web" });
        const trashed = await createItem("people", { name: "Gone" });
        await createChokePoint(runtime).softDeleteItem(await databaseId("people"), trashed);
        const eventEdges = await edgesOf("events", "people");

        for (const personId of [randomUUID(), trashed, project]) {
          expect(await refusal(assign(world.transcript, "SPEAKER_00", { personId }))).toEqual(NOT_FOUND);
        }

        expect(await mappings(world.transcript)).toEqual([]);
        expect(await edgesOf("events", "people")).toEqual(eventEdges);
      });
    });

    it("answers another tenant's person like an unknown one", async () => {
      let foreignPerson = "";
      await runInTenant(foreign, async () => {
        foreignPerson = await createItem("people", { name: "Foreign" });
      });
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        expect(await refusal(assign(world.transcript, "SPEAKER_00", { personId: foreignPerson }))).toEqual(NOT_FOUND);
        expect(await refusal(assign(world.transcript, "SPEAKER_00", { personId: randomUUID() }))).toEqual(NOT_FOUND);

        expect(await mappings(world.transcript)).toEqual([]);
      });
    });

    it("answers an unknown transcript, a transcript in the Trash and another tenant's transcript with the same 404", async () => {
      let foreignTranscript = "";
      let foreignPerson = "";
      await runInTenant(foreign, async () => {
        const world = await buildWorld();
        foreignTranscript = world.transcript;
        foreignPerson = world.carol;
      });
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const trashed = await createTranscript();
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), trashed);

        for (const transcriptId of [randomUUID(), trashed, foreignTranscript]) {
          expect(await refusal(assign(transcriptId, "SPEAKER_00", { personId: world.carol }))).toEqual(NOT_FOUND);
          expect(await refusal(assign(transcriptId, "SPEAKER_00", { personId: null }))).toEqual(NOT_FOUND);
        }

        expect(await mappings(world.transcript)).toEqual([]);
        expect(await mappings(trashed)).toEqual([]);
      });
      await runInTenant(foreign, async () => {
        expect(await mappings(foreignTranscript)).toEqual([]);
        expect(await participants((await edgesOf("transcripts", "event"))[0]?.item_b ?? "")).not.toContain(
          foreignPerson,
        );
      });
    });

    it.each([
      ["a transcript id that is not a UUID", "not-a-uuid", "SPEAKER_00", { personId: null }, "id"],
      ["an over-long speaker key", "", "S".repeat(257), { personId: null }, "speaker"],
      ["a person id that is not a UUID", "", "SPEAKER_00", { personId: "alice" }, "personId"],
      ["a numeric person id", "", "SPEAKER_00", { personId: 5 }, "personId"],
      ["a body without personId", "", "SPEAKER_00", {}, "personId"],
      ["a body that is null", "", "SPEAKER_00", null, "body"],
      ["a body that is a string", "", "SPEAKER_00", "SPEAKER_00", "body"],
      ["a body that is an array", "", "SPEAKER_00", [], "body"],
    ])("refuses %s with validation_failed on %s", async (_label, id, speaker, body, field) => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        expect(await refusal(assign(id === "" ? world.transcript : id, speaker, body))).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field },
        });

        expect(await mappings(world.transcript)).toEqual([]);
      });
    });

    it("publishes the edge invalidations of an assignment to the user's sockets after the commit", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const transcripts = await databaseId("transcripts");
        const people = await databaseId("people");
        await assigned(world.transcript, "SPEAKER_00", world.alice);

        const events = await capturingInvalidations(async () => {
          await assigned(world.transcript, "SPEAKER_00", world.bob);
        });

        // Removing Alice's edge and writing Bob's announces the transcript once (its two writes are coalesced to
        // the last) and each person once, all addressed to the signed-in user so that every device of theirs refreshes.
        const relation = (databaseId: string, itemId: string, propertyKey: string | null, op: "put" | "delete") => ({
          scope: "relation",
          databaseId,
          itemId,
          propertyKey,
          op,
          userId: USER_ID,
        });
        expect(events).toHaveLength(3);
        expect(events).toEqual(
          expect.arrayContaining([
            relation(transcripts, world.transcript, "speakers", "put"),
            relation(people, world.alice, null, "delete"),
            relation(people, world.bob, null, "put"),
          ]),
        );
      });
    });

    it("publishes nothing when the assignment is refused", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        const events = await capturingInvalidations(async () => {
          await refusal(assign(world.transcript, "SPEAKER_09", { personId: world.carol }));
        });

        expect(events).toEqual([]);
      });
    });

    it("waits for the card's lock before it takes the transcript's, the order the confirm of a card uses", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createCards(world);
        const card = await cardOf(world.transcript, "SPEAKER_00");
        const transcripts = await databaseId("transcripts");
        let call: ReturnType<typeof assigned> | undefined;

        await holdingRowLock("processingProposals", card.id, async () => {
          call = assigned(world.transcript, "SPEAKER_00", world.alice);
          call.catch(() => {});
          await untilBlocked(1);
          // The waiting assignment holds nothing of the transcript yet: NOWAIT would fail if it did.
          await withTransaction(runtime, async (client) => {
            expect((await lockItemByIdNowait(client, transcripts, world.transcript))?.id).toBe(world.transcript);
          });
          expect(await mappings(world.transcript)).toEqual([]);
        });
        if (!call) throw new Error("The assignment was not started");

        expect(await call).toMatchObject({ personId: world.alice });
        expect((await cardOf(world.transcript, "SPEAKER_00")).card.status).toBe("confirmed");
      });
    });

    it("settles a card that a concurrent proposal created while the assignment waited for the transcript", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        let call: ReturnType<typeof assigned> | undefined;

        await whileProposalUncommitted(world, async () => {
          call = assigned(world.transcript, "SPEAKER_00", world.alice);
          call.catch(() => {});
          // The assignment looked for the card, saw none and now waits for the transcript the proposal holds.
          await untilBlocked(1);
        });
        if (!call) throw new Error("The assignment was not started");

        expect(await call).toMatchObject({ personId: world.alice });
        expect((await cardOf(world.transcript, "SPEAKER_00")).card).toMatchObject({
          status: "confirmed",
          resultItemId: world.alice,
        });
      });
    });

    it("answers 409 and changes nothing when a confirm holds the card that appeared while the assignment waited", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        // The card is locked by another transaction at the moment the assignment asks for it, as a confirm of the
        // card would hold it before it waits for the transcript. NOWAIT must refuse instead of waiting.
        // The managed transaction knows its client by identity, so the client itself is wrapped, not proxied.
        const contend = (client: PoolClient): PoolClient => {
          const original = client.query.bind(client);
          const guarded = async (...args: unknown[]): Promise<unknown> => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (!text.includes("FOR UPDATE NOWAIT")) return Reflect.apply(original, client, args);
            const card = await cardOf(world.transcript, "SPEAKER_00");
            let answer: unknown;
            // The statement fails with lock_not_available while the other transaction holds the card.
            await holdingRowLock("processingProposals", card.id, async () => {
              answer = await Reflect.apply(original, client, args);
            });
            return answer;
          };
          Reflect.set(client, "query", guarded);
          return client;
        };
        let refused: ReturnType<typeof refusal> | undefined;

        await whileProposalUncommitted(world, async () => {
          refused = refusal(
            withTransaction(runtime, async (client) => {
              try {
                return await assignTranscriptSpeaker(contend(client), {
                  transcriptId: world.transcript,
                  speaker: "SPEAKER_00",
                  personId: world.alice,
                  userId: USER_ID,
                });
              } finally {
                // The client goes back to the pool: its own statement method serves the next test again.
                Reflect.deleteProperty(client, "query");
              }
            }),
          );
          refused.catch(() => {});
          await untilBlocked(1);
        });
        if (!refused) throw new Error("The assignment was not started");

        expect(await refused).toMatchObject({ status: 409, code: "version_conflict", details: { field: "speaker" } });
        expect(await mappings(world.transcript)).toEqual([]);
        expect((await cardOf(world.transcript, "SPEAKER_00")).card.status).toBe("proposed");
      });
    });

    it("leaves one person on the key when two assignments run at the same time", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        let calls: ReturnType<typeof assigned>[] = [];

        await holdingRowLock("transcripts", world.transcript, async () => {
          calls = [
            assigned(world.transcript, "SPEAKER_00", world.alice),
            assigned(world.transcript, "SPEAKER_00", world.bob),
          ];
          for (const call of calls) call.catch(() => {});
          await untilBlocked(2);
          expect(await mappings(world.transcript)).toEqual([]);
        });
        const answers = await Promise.all(calls);

        const mapped = await mappings(world.transcript);
        expect(mapped).toHaveLength(1);
        expect(answers.map((answer) => answer.personId)).toContain(mapped[0]?.[1]);
      });
    });
  });

  describe("GET /api/transcripts/:id/speaker-candidates", () => {
    it("returns each participant with the invitation status and the key they are mapped to, and the own person as self", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await assigned(world.transcript, "SPEAKER_01", world.bob);

        const result = await candidateList(world.transcript);

        expect(result.participants).toEqual(
          [
            {
              personId: world.alice,
              name: "Alice Novak",
              title: null,
              relationship: "client",
              invitationStatus: "accepted",
              mappedSpeaker: null,
            },
            {
              personId: world.bob,
              name: "Bob Dvorak",
              title: null,
              relationship: null,
              invitationStatus: null,
              mappedSpeaker: "SPEAKER_01",
            },
          ].sort((a, b) => a.personId.localeCompare(b.personId)),
        );
        expect(result.self).toEqual({ personId: world.me, name: "Zdenek Own", mappedSpeaker: null });
      });
    });

    it("leaves the organizer out of the participants and reports the key the own person is mapped to", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await assigned(world.transcript, "SPEAKER_02", world.me);

        const result = await candidateList(world.transcript);

        expect(result.participants.map((participant) => participant.personId)).not.toContain(world.me);
        expect(result.self).toEqual({ personId: world.me, name: "Zdenek Own", mappedSpeaker: "SPEAKER_02" });
      });
    });

    it("returns every participant, including one who declined", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createChokePoint(runtime).createRelation({
          relationPropertyId: await propertyId("events", "people"),
          callerItemId: world.event,
          targetItemId: world.carol,
          metadata: { invitation: { status: "declined", email: "carol@example.com", mailboxId: MAILBOX_ID } },
        });

        const result = await candidateList(world.transcript);

        expect(result.participants.find((entry) => entry.personId === world.carol)).toMatchObject({
          invitationStatus: "declined",
        });
        expect(result.participants).toHaveLength(3);
      });
    });

    it("leaves a participant in the Trash out", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createChokePoint(runtime).softDeleteItem(await databaseId("people"), world.bob);

        const result = await candidateList(world.transcript);

        expect(result.participants.map((entry) => entry.personId)).toEqual([world.alice]);
      });
    });

    it("returns no participants but the own person for a transcript without an Event", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const transcript = await createTranscript();

        expect(await candidateList(transcript)).toEqual({
          participants: [],
          self: { personId: world.me, name: "Zdenek Own", mappedSpeaker: null },
        });
      });
    });

    it("returns no participants when the linked Event is in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createChokePoint(runtime).softDeleteItem(await databaseId("events"), world.event);

        const result = await candidateList(world.transcript);

        expect(result.participants).toEqual([]);
        expect(result.self).toMatchObject({ personId: world.me });
      });
    });

    it("returns self null in a tenant without an own person", async () => {
      await runInTenant(tenant, async () => {
        const event = await createItem("events", { name: "Offer meeting", date: "2026-10-16" });
        const bob = await createItem("people", { name: "Bob Dvorak" });
        await link("events", "people", event, bob);
        const transcript = await createTranscript();
        await link("transcripts", "event", transcript, event);

        const result = await candidateList(transcript);

        expect(result.self).toBeNull();
        expect(result.participants.map((entry) => entry.personId)).toEqual([bob]);
      });
    });

    it("answers an unknown transcript, a transcript in the Trash and another tenant's transcript with the same 404", async () => {
      let foreignTranscript = "";
      await runInTenant(foreign, async () => {
        foreignTranscript = (await buildWorld()).transcript;
      });
      await runInTenant(tenant, async () => {
        await buildWorld();
        const trashed = await createTranscript();
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), trashed);

        for (const transcriptId of [randomUUID(), trashed, foreignTranscript]) {
          expect(await refusal(candidates(transcriptId))).toEqual(NOT_FOUND);
        }
      });
    });

    it("refuses a transcript id that is not a UUID with validation_failed", async () => {
      await runInTenant(tenant, async () => {
        expect(await refusal(candidates("not-a-uuid"))).toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "id" },
        });
      });
    });
  });
});
