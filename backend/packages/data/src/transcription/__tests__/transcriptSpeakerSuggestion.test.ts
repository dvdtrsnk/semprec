import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import type { ProposalEnvelope } from "../../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
} from "../../inbox/proposalActions.js";
import { listTranscriptSpeakers } from "../transcriptionSpeakerEdges.js";
import {
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  type SpeakerMappingSuggestion,
} from "../transcriptSpeakerSuggestion.js";

let pool: Pool;

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Thanks for joining, Bob.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_01", text: "Happy to, Alice.", startsAt: 1, endsAt: 2 },
];

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function propertyIdFor(databaseId: string, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
    databaseId,
    key,
  ]);
  if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
  return rows[0].id;
}

/** Issue #185: AI-suggested speaker mappings are transcript cards; only a confirm writes the user-owned mapping. */
describe("Speaker mapping suggestions (issue #185)", () => {
  let transcriptsId: string;
  let peopleId: string;
  let eventsId: string;
  let proposalsId: string;
  let chokePoint: ChokePoint;
  let transcriptId: string;
  let eventId: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
    peopleId = await databaseIdFor("people");
    eventsId = await databaseIdFor("events");
    proposalsId = await databaseIdFor("processingProposals");
    chokePoint = createChokePoint(pool);

    transcriptId = await withTransaction(pool, async (client) => {
      const item = await createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Sync" } });
      await writeComputed(client, transcriptsId, item.id, "segments", SEGMENTS);
      return item.id;
    });
    eventId = await createItem(eventsId, "Sync");
    aliceId = await createParticipant("Alice");
    bobId = await createParticipant("Bob");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createItem(databaseId: string, name: string): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId, properties: { name } }),
    );
    return item.id;
  }

  async function createParticipant(name: string): Promise<string> {
    const personId = await createItem(peopleId, name);
    await chokePoint.createRelation({
      relationPropertyId: await propertyIdFor(eventsId, "people"),
      callerItemId: eventId,
      targetItemId: personId,
    });
    return personId;
  }

  async function linkEvent(): Promise<void> {
    await chokePoint.createRelation({
      relationPropertyId: await propertyIdFor(transcriptsId, "event"),
      callerItemId: transcriptId,
      targetItemId: eventId,
    });
  }

  function mapSpeaker(personId: string, speaker: string) {
    return propertyIdFor(transcriptsId, "speakers").then((relationPropertyId) =>
      chokePoint.createRelation({
        relationPropertyId,
        callerItemId: transcriptId,
        targetItemId: personId,
        metadata: { speaker },
      }),
    );
  }

  function context() {
    return withTransaction(pool, (client) => readSpeakerSuggestionContext(client, transcriptId));
  }

  function propose(suggestions: SpeakerMappingSuggestion[]) {
    return withTransaction(pool, (client) => proposeSpeakerMappings(client, { transcriptId, suggestions }));
  }

  function speakers() {
    return withTransaction(pool, (client) => listTranscriptSpeakers(client, transcriptId));
  }

  async function speakerCards(): Promise<Array<{ id: string; proposal: ProposalEnvelope; status: string }>> {
    const { rows } = await pool.query<{ id: string; proposal: ProposalEnvelope; status: string }>(
      `SELECT id, properties -> 'proposal' AS proposal, properties ->> 'status' AS status FROM items
       WHERE database_id = $1 AND properties ->> 'kind' = 'transcript' ORDER BY properties -> 'proposal' ->> 'target'`,
      [proposalsId],
    );
    return rows;
  }

  async function onlyCardId(): Promise<string> {
    const cards = await speakerCards();
    if (cards.length !== 1 || !cards[0]) throw new Error(`Expected one speaker card, found ${cards.length}`);
    return cards[0].id;
  }

  function confirm(cardId: string) {
    return withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
    );
  }

  function revise(cardId: string, envelope: ProposalEnvelope) {
    return withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
        message: "Revised by user.",
        ...envelope,
      }),
    );
  }

  function mapping(personId: string, speaker: string): ProposalEnvelope {
    return { entityKind: "relation", target: personId, properties: { propertyKey: "speakers", metadata: { speaker } } };
  }

  async function mappedPersonIds(): Promise<Array<string | null>> {
    return (await speakers()).map((entry) => entry.person?.id ?? null);
  }

  describe("readSpeakerSuggestionContext", () => {
    it("has nothing to ask while the transcript has no linked Event", async () => {
      expect(await context()).toBeNull();
    });

    it("offers the Event's named participants for every unmapped key", async () => {
      await createParticipant("");
      await createItem(peopleId, "Carol");
      await linkEvent();

      const found = await context();

      expect(found?.unmappedSpeakers).toEqual(["SPEAKER_00", "SPEAKER_01"]);
      expect(found?.candidates).toEqual(
        expect.arrayContaining([
          { id: aliceId, name: "Alice" },
          { id: bobId, name: "Bob" },
        ]),
      );
      expect(found?.candidates).toHaveLength(2);
    });

    it("leaves out keys and participants already mapped, and has nothing to ask once every key is", async () => {
      await linkEvent();
      await mapSpeaker(aliceId, "SPEAKER_01");

      expect(await context()).toEqual({ unmappedSpeakers: ["SPEAKER_00"], candidates: [{ id: bobId, name: "Bob" }] });

      await mapSpeaker(bobId, "SPEAKER_00");
      expect(await context()).toBeNull();
    });
  });

  describe("proposeSpeakerMappings", () => {
    it("creates one proposed card per valid suggestion and writes no mapping", async () => {
      await linkEvent();
      const carolId = await createItem(peopleId, "Carol");

      const proposed = await propose([
        { speaker: "SPEAKER_01", personId: aliceId },
        { speaker: "SPEAKER_07", personId: bobId },
        { speaker: "SPEAKER_00", personId: carolId },
        { speaker: "SPEAKER_00", personId: aliceId },
        { speaker: "SPEAKER_01", personId: bobId },
      ]);

      expect(proposed).toEqual(["SPEAKER_01"]);
      expect((await speakerCards()).map(({ proposal, status }) => ({ proposal, status }))).toEqual([
        { proposal: mapping(aliceId, "SPEAKER_01"), status: "proposed" },
      ]);
      expect(await mappedPersonIds()).toEqual([null, null]);
    });

    it("links each card to its transcript through sourceTranscript", async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId }]);

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)`,
        [await onlyCardId(), transcriptId],
      );
      expect(rows[0]?.count).toBe(1);
    });

    it("never proposes the same key twice across runs", async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId }]);

      expect(await propose([{ speaker: "SPEAKER_01", personId: bobId }])).toEqual([]);
      expect(await speakerCards()).toHaveLength(1);
    });

    it("proposes nothing when there is no linked Event", async () => {
      expect(await propose([{ speaker: "SPEAKER_01", personId: aliceId }])).toEqual([]);
      expect(await speakerCards()).toEqual([]);
    });
  });

  describe("confirm, revise and reject of a speaker card", () => {
    beforeEach(async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId }]);
    });

    it("confirm writes the user-owned mapping with its speaker key, and a retry writes nothing more", async () => {
      const cardId = await onlyCardId();

      const confirmed = await confirm(cardId);
      await confirm(cardId);

      expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: aliceId, resultLabel: "Alice" });
      expect(await mappedPersonIds()).toEqual([null, aliceId]);
      const { rows } = await pool.query<{ metadata: unknown }>(
        `SELECT metadata FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)`,
        [transcriptId, aliceId],
      );
      expect(rows).toEqual([{ metadata: { speaker: "SPEAKER_01" } }]);
    });

    it("confirm is refused when the key was mapped to someone else meanwhile, leaving the card proposed", async () => {
      const cardId = await onlyCardId();
      await mapSpeaker(bobId, "SPEAKER_01");

      await expect(confirm(cardId)).rejects.toMatchObject({
        code: "validation_failed",
        details: { reason: "speakerAlreadyMapped" },
      });
      expect((await speakerCards())[0]?.status).toBe("proposed");
      expect(await mappedPersonIds()).toEqual([null, bobId]);
    });

    it("confirm keeps the canonical owner_violation of the speakers relation", async () => {
      const cardId = await onlyCardId();
      await pool.query("UPDATE properties SET owner = 'system', owner_process = 'someProcess' WHERE id = $1", [
        await propertyIdFor(transcriptsId, "speakers"),
      ]);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "owner_violation" });
      expect(await mappedPersonIds()).toEqual([null, null]);
    });

    it("revise can change the person, and confirm then maps that person", async () => {
      const cardId = await onlyCardId();

      await revise(cardId, mapping(bobId, "SPEAKER_01"));
      await confirm(cardId);

      expect(await mappedPersonIds()).toEqual([null, bobId]);
    });

    it("revise refuses a key the transcript does not have", async () => {
      await expect(revise(await onlyCardId(), mapping(aliceId, "SPEAKER_07"))).rejects.toMatchObject({
        code: "validation_failed",
        details: { reason: "unknownSpeaker" },
      });
    });

    it("revise refuses to turn a speaker card into an Event proposal", async () => {
      await expect(
        revise(await onlyCardId(), { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "entityKind" } });
      await expect(
        revise(await onlyCardId(), { entityKind: "database", target: eventsId, properties: { name: "Sync" } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "entityKind" } });
    });

    it("reject writes no mapping", async () => {
      const id = await onlyCardId();
      await withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, id),
      );

      expect((await speakerCards())[0]?.status).toBe("rejected");
      expect(await mappedPersonIds()).toEqual([null, null]);
    });
  });
});
