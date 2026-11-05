import { setSelfPersonId } from "../../selfPerson.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import "../../domainWriteHooks.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
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
import { transcriptSpeakerCardContextSchema } from "../transcriptSpeakerCardContext.js";
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

  async function speakerCards(): Promise<Array<{ id: string; proposal: ProposalEnvelope | null; status: string }>> {
    const { rows } = await pool.query<{ id: string; proposal: ProposalEnvelope | null; status: string }>(
      `SELECT id, properties -> 'proposal' AS proposal, properties ->> 'status' AS status FROM items
       WHERE database_id = $1 AND properties ->> 'kind' = 'transcript' ORDER BY properties -> 'proposal' ->> 'target'`,
      [proposalsId],
    );
    return rows;
  }

  async function onlyCardId(): Promise<string> {
    const cards = (await speakerCards()).filter((card) => card.status === "proposed");
    if (cards.length !== 1 || !cards[0]) throw new Error(`Expected one proposed speaker card, found ${cards.length}`);
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
    it("keeps unmapped speakers when the transcript has no linked Event", async () => {
      expect(await context()).toMatchObject({ unmappedSpeakers: ["SPEAKER_00", "SPEAKER_01"], candidates: [] });
    });

    it("offers the tenant's own person even without an Event", async () => {
      await withTransaction(pool, (client) => setSelfPersonId(client, aliceId));
      expect((await context())?.candidates).toEqual([
        { id: aliceId, name: "Alice", title: null, invitationStatus: null },
      ]);
    });

    it("keeps the tenant's own person even when the stored name is empty", async () => {
      const ownId = await createItem(peopleId, "Owner");
      // Synthetic historical value: the current item writer rejects an empty title.
      const historical = await pool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{name}', '\"\"'::jsonb) WHERE tenant_id = $1 AND database_id = $2 AND id = $3",
        [getTenantZeroId(), peopleId, ownId],
      );
      expect(historical.rowCount).toBe(1);
      await withTransaction(pool, (client) => setSelfPersonId(client, ownId));
      expect((await context())?.candidates).toEqual([{ id: ownId, name: "", title: null, invitationStatus: null }]);
    });

    it("offers the Event's named participants for every unmapped key", async () => {
      await createParticipant("");
      await createItem(peopleId, "Carol");
      await linkEvent();

      const found = await context();

      expect(found?.unmappedSpeakers).toEqual(["SPEAKER_00", "SPEAKER_01"]);
      expect(found?.candidates).toEqual(
        expect.arrayContaining([
          { id: aliceId, name: "Alice", title: null, invitationStatus: null },
          { id: bobId, name: "Bob", title: null, invitationStatus: null },
        ]),
      );
      expect(found?.candidates).toHaveLength(2);
    });

    it("excludes participants of a trashed Event while keeping the tenant's own person", async () => {
      await withTransaction(pool, (client) => setSelfPersonId(client, aliceId));
      await linkEvent();
      await chokePoint.softDeleteItem(eventsId, eventId);
      expect((await context())?.candidates).toEqual([
        { id: aliceId, name: "Alice", title: null, invitationStatus: null },
      ]);
    });

    it("uses only recognized invitation status metadata as an optional hint", async () => {
      await linkEvent();
      const relationPropertyId = await propertyIdFor(eventsId, "people");
      await chokePoint.createRelation({
        relationPropertyId,
        callerItemId: eventId,
        targetItemId: aliceId,
        metadata: { invitation: { status: "accepted" } },
      });
      await chokePoint.createRelation({
        relationPropertyId,
        callerItemId: eventId,
        targetItemId: bobId,
        metadata: { invitation: { status: "unknown" } },
      });
      expect((await context())?.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: aliceId, invitationStatus: "accepted" }),
          expect.objectContaining({ id: bobId, invitationStatus: null }),
        ]),
      );
    });

    it("leaves out keys and participants already mapped, and has nothing to ask once every key is", async () => {
      await linkEvent();
      await mapSpeaker(aliceId, "SPEAKER_01");

      expect(await context()).toMatchObject({
        unmappedSpeakers: ["SPEAKER_00"],
        locale: "cs",
        candidates: [{ id: bobId, name: "Bob", title: null, invitationStatus: null }],
      });

      await mapSpeaker(bobId, "SPEAKER_00");
      expect(await context()).toBeNull();
    });
  });

  it("stores authentic selected quotes, source, reasons and alternatives on each speaker card", async () => {
    const segments = [
      { speaker: "SPEAKER_00", text: "We should review the entire proposal tomorrow.", startsAt: 0, endsAt: 1 },
      { speaker: "SPEAKER_00", text: "The team can discuss the remaining details together.", startsAt: 1, endsAt: 2 },
      { speaker: "SPEAKER_01", text: "This second speaker has enough words to quote.", startsAt: 2, endsAt: 3 },
      { speaker: "SPEAKER_02", text: "The third speaker also has a recorded sentence.", startsAt: 3, endsAt: 4 },
    ];
    await withTransaction(pool, (client) => writeComputed(client, transcriptsId, transcriptId, "segments", segments));
    await linkEvent();
    await propose([
      { speaker: "SPEAKER_00", personId: aliceId, reason: "Alice is named." },
      { speaker: "SPEAKER_01", personId: null, reason: "Uncertain." },
      { speaker: "SPEAKER_02", personId: aliceId, reason: "Duplicate candidate." },
    ]);
    const rows = await pool.query<{ status: string; context: unknown }>(
      "SELECT properties ->> 'status' AS status, properties -> 'context' AS context FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
      [proposalsId],
    );
    const cards = rows.rows.map((row) => ({
      status: row.status,
      context: transcriptSpeakerCardContextSchema.parse(row.context),
    }));
    expect(cards).toHaveLength(3);
    const first = cards.find((card) => card.context.speaker === "SPEAKER_00");
    expect(first).toMatchObject({
      status: "proposed",
      context: { reason: "Alice is named.", firstStartsAt: 0, source: { transcriptName: "Sync" } },
    });
    expect(first?.context.quotes).toEqual([
      { segmentIndex: 0, text: segments[0]?.text },
      { segmentIndex: 1, text: segments[1]?.text },
    ]);
    expect(first?.context.alternatives.map((entry) => entry.personId)).toEqual(
      expect.arrayContaining([aliceId, bobId]),
    );
    expect(cards.filter((card) => card.status === "needsClarification")).toHaveLength(2);
    for (const card of cards)
      for (const quote of card.context.quotes)
        expect(segments[quote.segmentIndex]?.text.startsWith(quote.text)).toBe(true);
  });

  describe("proposeSpeakerMappings", () => {
    it("creates one proposed card per valid suggestion and writes no mapping", async () => {
      await linkEvent();
      const carolId = await createItem(peopleId, "Carol");

      const proposed = await propose([
        { speaker: "SPEAKER_01", personId: aliceId, reason: "Named." },
        { speaker: "SPEAKER_07", personId: bobId, reason: "Named." },
        { speaker: "SPEAKER_00", personId: carolId, reason: "Named." },
        { speaker: "SPEAKER_00", personId: aliceId, reason: "Named." },
        { speaker: "SPEAKER_01", personId: bobId, reason: "Named." },
      ]);

      expect(proposed).toEqual(["SPEAKER_00", "SPEAKER_01"]);
      expect((await speakerCards()).map(({ proposal, status }) => ({ proposal, status }))).toEqual(
        expect.arrayContaining([
          { proposal: mapping(aliceId, "SPEAKER_01"), status: "proposed" },
          { proposal: null, status: "needsClarification" },
        ]),
      );
      expect(await mappedPersonIds()).toEqual([null, null]);
    });

    it("links each card to its transcript through sourceTranscript", async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)`,
        [await onlyCardId(), transcriptId],
      );
      expect(rows[0]?.count).toBe(1);
    });

    it("never proposes the same key twice across runs", async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);

      expect(await propose([{ speaker: "SPEAKER_01", personId: bobId, reason: "Named." }])).toEqual([]);
      expect(await speakerCards()).toHaveLength(2);
    });

    it("asks for unmapped speakers when there is no linked Event", async () => {
      expect(await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }])).toEqual([
        "SPEAKER_00",
        "SPEAKER_01",
      ]);
      expect(await speakerCards()).toHaveLength(2);
      expect(
        (await speakerCards()).every((card) => card.status === "needsClarification" && card.proposal === null),
      ).toBe(true);
    });

    it("stores the mapping as aiProposal too, at aiVersion 1 (issue #1471)", async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);

      const { rows } = await pool.query<{ aiProposal: unknown; proposal: unknown; aiVersion: number }>(
        `SELECT properties -> 'aiProposal' AS "aiProposal", properties -> 'proposal' AS proposal,
                (properties ->> 'aiVersion')::int AS "aiVersion"
           FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript' AND properties ->> 'status' = 'proposed'`,
        [proposalsId],
      );
      expect(rows).toEqual([
        { aiProposal: mapping(aliceId, "SPEAKER_01"), proposal: mapping(aliceId, "SPEAKER_01"), aiVersion: 1 },
      ]);
    });
  });

  describe("confirm, revise and reject of a speaker card", () => {
    beforeEach(async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);
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
      expect((await speakerCards()).find((card) => card.id === cardId)?.status).toBe("proposed");
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

    it("revise stores the revised mapping as aiProposal and counts a version (issue #1471)", async () => {
      const cardId = await onlyCardId();

      await revise(cardId, mapping(bobId, "SPEAKER_01"));

      const { rows } = await pool.query<{ aiProposal: unknown; aiVersion: number }>(
        `SELECT properties -> 'aiProposal' AS "aiProposal", (properties ->> 'aiVersion')::int AS "aiVersion"
           FROM items WHERE id = $1`,
        [cardId],
      );
      expect(rows).toEqual([{ aiProposal: mapping(bobId, "SPEAKER_01"), aiVersion: 2 }]);
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

      expect((await speakerCards()).find((card) => card.id === id)?.status).toBe("rejected");
      expect(await mappedPersonIds()).toEqual([null, null]);
    });
  });
});
