import { setSelfPersonId } from "../../selfPerson.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES } from "@semprec/queue";
import * as relationStore from "../../chokePoint/relationsStore.js";
import "../../domainWriteHooks.js";
import {
  bindToTenantZero,
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { proposalHistoryEntrySchema } from "../../inbox/proposalHistory.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { lockItemById, writeComputed } from "../../chokePoint/itemsStore.js";
import type { ProposalEnvelope } from "../../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
  type ReviseProposalInput,
} from "../../inbox/proposalActions.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { listTranscriptSpeakers } from "../transcriptionSpeakerEdges.js";
import { peopleLastContactJobKey } from "../../people/lastContact.js";
import { transcriptSpeakerCardContextSchema } from "../transcriptSpeakerCardContext.js";
import {
  buildSpeakerSuggestionCheckpoint,
  isSpeakerSuggestionCurrent,
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  type SpeakerMappingSuggestion,
} from "../transcriptSpeakerSuggestion.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";

let pool: Pool;

/** An internal write without a writer stores it as `system`. */
const ACCEPTED_INVITATION = {
  status: "accepted",
  email: "alice@example.com",
  mailboxId: "6f1f8d0e-3c57-4a56-9d0b-2f8a3e3f4b11",
};

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Thanks for joining, Bob.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_01", text: "Happy to, Alice.", startsAt: 1, endsAt: 2 },
];

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** `"still waiting"` after `milliseconds`: the limit only ends a wait that would last as long as a lock is held. */
async function settledWithin<T>(work: Promise<T>, milliseconds = 10_000): Promise<T | "still waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"still waiting">((resolve) => {
    timer = setTimeout(() => resolve("still waiting"), milliseconds);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function propertyIdFor(databaseId: string, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
    databaseId,
    key,
  ]);
  if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
  return rows[0].id;
}

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
    // An Events `people` edge is a link-rule source: its write queues a job, which needs a tenant scope.
    chokePoint = bindToTenantZero(createChokePoint(pool));

    transcriptId = await withTransaction(pool, async (client) => {
      const item = await createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Sync" } });
      await writeComputed(client, transcriptsId, item.id, "segments", SEGMENTS);
      return item.id;
    });
    // An Event's create requires a date; the speaker suggestion reads only its participants.
    eventId = await createItem(eventsId, "Sync", { date: "2026-10-16" });
    aliceId = await createParticipant("Alice");
    bobId = await createParticipant("Bob");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createItem(databaseId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId, properties: { name, ...extra } }),
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

  const proposalOptions = () => ({ processingProposalsDatabaseId: proposalsId });

  function confirm(cardId: string, db: Pool = pool) {
    return withTransaction(db, (client) => confirmProposalWithClient(client, proposalOptions(), cardId));
  }

  /** A bare envelope is revised with the default user message. */
  function revise(cardId: string, input: ProposalEnvelope | ReviseProposalInput, db: Pool = pool) {
    const body: ReviseProposalInput = "message" in input ? input : { message: "Revised by user.", ...input };
    return withTransaction(db, (client) => reviseProposalWithClient(client, proposalOptions(), cardId, body));
  }

  function reject(cardId: string, db: Pool = pool) {
    return withTransaction(db, (client) => rejectProposalWithClient(client, proposalOptions(), cardId));
  }

  /** Runs `work` on a runtime-role pool, which row-level security applies to, in tenant zero unless `scoped` is off. */
  async function asRuntime<T>(work: (runtime: Pool) => Promise<T>, scoped = true): Promise<T> {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      return await (scoped ? runInTenant(getTenantZeroId(), () => work(runtime)) : work(runtime));
    } finally {
      await runtime.end();
    }
  }

  async function edgesBetween(db: Pool, a: string, b: string) {
    const { rows } = await db.query<{ id: string; metadata: unknown }>(
      "SELECT id, metadata FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b) ORDER BY id",
      [a, b],
    );
    return rows;
  }

  function mapping(personId: string, speaker: string): ProposalEnvelope {
    return { entityKind: "relation", target: personId, properties: { propertyKey: "speakers", metadata: { speaker } } };
  }

  async function mappedPersonIds(): Promise<Array<string | null>> {
    return (await speakers()).map((entry) => entry.person?.id ?? null);
  }

  /** Overwrites stored JSON the current writers refuse, standing in for a historical value. */
  async function setHistoricalProperty(itemId: string, key: string, value: string): Promise<void> {
    const historical = await pool.query(
      "UPDATE items SET properties = jsonb_set(properties, ARRAY[$4::text], to_jsonb($5::text)) WHERE tenant_id = $1 AND database_id = $2 AND id = $3",
      [getTenantZeroId(), peopleId, itemId, key, value],
    );
    expect(historical.rowCount).toBe(1);
  }

  const candidate = (id: string, name: string) => ({ id, name, title: null, invitationStatus: null });

  describe("readSpeakerSuggestionContext", () => {
    it("keeps unmapped speakers when the transcript has no linked Event", async () => {
      expect(await context()).toMatchObject({ unmappedSpeakers: ["SPEAKER_00", "SPEAKER_01"], candidates: [] });
    });

    it("offers the tenant's own person even without an Event, also when the stored name is empty", async () => {
      await withTransaction(pool, (client) => setSelfPersonId(client, aliceId));
      expect((await context())?.candidates).toEqual([candidate(aliceId, "Alice")]);
      // The current item writer rejects an empty title.
      await setHistoricalProperty(aliceId, "name", "");
      expect((await context())?.candidates).toEqual([candidate(aliceId, "")]);
    });

    it("offers the Event's named participants for every unmapped key", async () => {
      await createParticipant("");
      await createItem(peopleId, "Carol");
      await linkEvent();

      const found = await context();

      expect(found?.unmappedSpeakers).toEqual(["SPEAKER_00", "SPEAKER_01"]);
      expect(found?.candidates).toHaveLength(2);
      expect(found?.candidates).toEqual(expect.arrayContaining([candidate(aliceId, "Alice"), candidate(bobId, "Bob")]));
    });

    it("ignores an incidental historical title on a participant", async () => {
      // The current People writer has no supported title property.
      await setHistoricalProperty(aliceId, "title", "Historical title");
      await linkEvent();
      expect((await context())?.candidates).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: aliceId, name: "Alice", title: null })]),
      );
    });

    it("excludes participants of a trashed Event while keeping the tenant's own person", async () => {
      await withTransaction(pool, (client) => setSelfPersonId(client, aliceId));
      await linkEvent();
      await chokePoint.softDeleteItem(eventsId, eventId);
      expect((await context())?.candidates).toEqual([candidate(aliceId, "Alice")]);
    });

    it("uses only recognized invitation status metadata as an optional hint", async () => {
      await linkEvent();
      const relationPropertyId = await propertyIdFor(eventsId, "people");
      await chokePoint.createRelation({
        relationPropertyId,
        callerItemId: eventId,
        targetItemId: aliceId,
        metadata: { invitation: ACCEPTED_INVITATION },
      });
      const bobEdge = await chokePoint.createRelation({
        relationPropertyId,
        callerItemId: eventId,
        targetItemId: bobId,
      });
      // The participant edge hook refuses this shape, so only an old stored edge can hold it.
      const legacy = await pool.query("UPDATE item_relations SET metadata = $2::jsonb WHERE id = $1", [
        bobEdge.id,
        JSON.stringify({ invitation: { status: "unknown" } }),
      ]);
      expect(legacy.rowCount).toBe(1);
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
        candidates: [candidate(bobId, "Bob")],
      });
      await mapSpeaker(bobId, "SPEAKER_00");
      expect(await context()).toBeNull();
    });

    it("uses only eligible quotes while retaining each speaker's actual first start", async () => {
      const segment = (speaker: string, text: string, startsAt: number) => ({
        speaker: `SPEAKER_0${speaker}`,
        text,
        startsAt,
        endsAt: startsAt + 1,
      });
      const counted = (words: number) =>
        "One two three four five six seven eight nine".split(" ").slice(0, words).join(" ");
      const long = "We discussed this proposal with the team ".repeat(6);
      const segments = [
        segment("0", "First short", 0),
        segment("1", "Short one", 1),
        segment("1", "Short two", 2),
        segment("2", "No quote one", 3),
        segment("2", "No quote two", 4),
        segment("2", counted(5), 5),
        segment("0", counted(6), 6),
        segment("0", counted(7), 7),
        segment("0", counted(8), 8),
        segment("0", counted(9), 9),
        segment("0", long, 10),
        segment("1", counted(6), 11),
      ];
      await withTransaction(pool, (client) => writeComputed(client, transcriptsId, transcriptId, "segments", segments));
      expect((await context())?.details).toEqual([
        {
          speaker: "SPEAKER_00",
          ordinal: 1,
          firstStartsAt: 0,
          quotes: [
            { segmentIndex: 8, text: counted(8) },
            { segmentIndex: 9, text: counted(9) },
            { segmentIndex: 10, text: long.slice(0, 140) },
          ],
        },
        { speaker: "SPEAKER_01", ordinal: 2, firstStartsAt: 1, quotes: [{ segmentIndex: 11, text: counted(6) }] },
        { speaker: "SPEAKER_02", ordinal: 3, firstStartsAt: 3, quotes: [] },
      ]);
    });
  });

  describe("proposeSpeakerMappings", () => {
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

    it("links the card to its transcript, stores the mapping as aiProposal at aiVersion 1 and the person as referencedItemIds", async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);

      expect(await edgesBetween(pool, await onlyCardId(), transcriptId)).toHaveLength(1);
      const { rows } = await pool.query<{
        status: string;
        ai: unknown;
        proposal: unknown;
        version: number;
        refs: unknown;
      }>(
        `SELECT properties ->> 'status' AS status, properties -> 'aiProposal' AS ai, properties -> 'proposal' AS proposal,
                (properties ->> 'aiVersion')::int AS version, properties -> 'referencedItemIds' AS refs
           FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript' ORDER BY properties ->> 'status'`,
        [proposalsId],
      );
      expect(rows).toEqual([
        { status: "needsClarification", ai: null, proposal: null, version: 1, refs: [] },
        {
          status: "proposed",
          ai: mapping(aliceId, "SPEAKER_01"),
          proposal: mapping(aliceId, "SPEAKER_01"),
          version: 1,
          refs: [aliceId],
        },
      ]);
    });

    it("announces each new card once, and never proposes the same key twice across runs", async () => {
      await linkEvent();
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);
        const cards = await speakerCards();
        expect(events.every((event) => event.op === "created" && event.userId === undefined)).toBe(true);
        expect(events.map((event) => event.cardId).sort()).toEqual(cards.map((card) => card.id).sort());
        events.splice(0);

        expect(await propose([{ speaker: "SPEAKER_01", personId: bobId, reason: "Named." }])).toEqual([]);
        expect(events).toEqual([]);
        expect(await speakerCards()).toHaveLength(2);
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }
    });

    it("asks for unmapped speakers when there is no linked Event", async () => {
      expect(await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }])).toEqual([
        "SPEAKER_00",
        "SPEAKER_01",
      ]);
      const cards = await speakerCards();
      expect(cards).toHaveLength(2);
      expect(cards.every((card) => card.status === "needsClarification" && card.proposal === null)).toBe(true);
    });

    it.each(["rejected", "trashed"] as const)(
      "does not recreate a %s speaker card and creates a different key",
      async (state) => {
        await asRuntime(async (runtime) => {
          await createChokePoint(runtime).createRelation({
            relationPropertyId: await propertyIdFor(transcriptsId, "event"),
            callerItemId: transcriptId,
            targetItemId: eventId,
          });
          const proposeAs = (segments: typeof SEGMENTS, suggestions: SpeakerMappingSuggestion[]) =>
            withTransaction(runtime, async (client) => {
              await writeComputed(client, transcriptsId, transcriptId, "segments", segments);
              return proposeSpeakerMappings(client, { transcriptId, suggestions });
            });
          await proposeAs(SEGMENTS.slice(0, 1), [{ speaker: "SPEAKER_00", personId: aliceId, reason: "Named." }]);
          const first = await cardOf("SPEAKER_00");
          if (state === "rejected") await reject(first, runtime);
          else await createChokePoint(runtime).softDeleteItem(proposalsId, first);
          await proposeAs(SEGMENTS, [
            { speaker: "SPEAKER_00", personId: aliceId, reason: "Named." },
            { speaker: "SPEAKER_01", personId: bobId, reason: "Named." },
          ]);
          const cards = await runtime.query<{ id: string; speaker: string; deleted_at: Date | null }>(
            "SELECT id, properties->'context'->>'speaker' AS speaker, deleted_at FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript'",
            [proposalsId],
          );
          expect(cards.rows.filter((card) => card.speaker === "SPEAKER_00").map((card) => card.id)).toEqual([first]);
          expect(cards.rows.filter((card) => card.speaker === "SPEAKER_01" && card.deleted_at === null)).toHaveLength(
            1,
          );
        });
      },
    );
  });

  it("confirms a revised speaker without an Event and adds no participant edge", async () => {
    await asRuntime(async (runtime) => {
      await withTransaction(runtime, (client) => proposeSpeakerMappings(client, { transcriptId, suggestions: [] }));
      const cardId = await cardOf("SPEAKER_00");
      await revise(cardId, { message: "Choose", ...mapping(aliceId, "SPEAKER_00") }, runtime);
      const eventEdges = () =>
        runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a,item_b)",
          [eventId],
        );
      const before = await eventEdges();
      const confirmed = await confirm(cardId, runtime);
      expect((await eventEdges()).rows).toEqual(before.rows);
      expect(confirmed.properties.status).toBe("confirmed");
      const history = z.array(z.object({ addedRelations: z.unknown().optional() })).parse(confirmed.properties.history);
      expect(history.at(-1)?.addedRelations).toBeUndefined();
      expect(await edgesBetween(runtime, transcriptId, aliceId)).toHaveLength(1);
    });
  });

  describe("confirm, revise and reject of a speaker card", () => {
    beforeEach(async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);
    });

    async function eventPeopleEdges(client: PoolClient) {
      const propertyId = await propertyIdFor(eventsId, "people");
      const definition = await relationStore.getRelationDefinitionByPropertyId(client, propertyId);
      if (!definition) throw new Error("Missing Event people relation");
      return { propertyId, edges: await relationStore.listRelationsForItem(client, definition.id, eventId) };
    }

    it("adds a nonparticipant atomically and records only the inserted Event edge", async () => {
      const foreign = await createTestTenant(pool);
      const cardId = await onlyCardId();
      await asRuntime(async (runtime) => {
        const own = <T>(work: () => Promise<T>) => runInTenant(getTenantZeroId(), work);
        const readEdges = () => own(() => withTransaction(runtime, eventPeopleEdges));
        const person = await own(() =>
          createChokePoint(runtime).createItem({ databaseId: peopleId, properties: { name: "New participant" } }),
        );
        await own(() => revise(cardId, { message: "Choose person", ...mapping(person.id, "SPEAKER_01") }, runtime));
        const before = await readEdges();
        await expect(runInTenant(foreign, () => confirm(cardId, runtime))).rejects.toMatchObject({ status: 404 });
        const confirmed = await own(() => confirm(cardId, runtime));
        const after = await readEdges();
        const extra = after.edges.filter((edge) => edge.itemA === person.id || edge.itemB === person.id);
        expect(extra).toHaveLength(1);
        expect(extra[0]?.metadata).toEqual({});
        expect(after.edges).toHaveLength(before.edges.length + 1);
        expect((await own(() => edgesBetween(runtime, transcriptId, person.id))).map((edge) => edge.metadata)).toEqual([
          { speaker: "SPEAKER_01" },
        ]);
        const parsedHistory = z.array(proposalHistoryEntrySchema).parse(confirmed.properties.history);
        expect(parsedHistory.at(-1)?.addedRelations).toEqual([
          {
            edgeId: extra[0]?.id,
            relationPropertyId: after.propertyId,
            callerItemId: eventId,
            targetItemId: person.id,
          },
        ]);
        const repeated = await own(() => confirm(cardId, runtime));
        expect(repeated.properties).toEqual(confirmed.properties);
        expect(repeated.updatedAt).toEqual(confirmed.updatedAt);
        expect((await readEdges()).edges).toEqual(after.edges);
      }, false);
    });

    it.each(["user-first", "confirm-first"] as const)(
      "serializes a real competing user write in the %s order",
      async (order) => {
        const cardId = await onlyCardId();
        await asRuntime(async (runtime) => {
          const person = await createChokePoint(runtime).createItem({
            databaseId: peopleId,
            properties: { name: "Concurrent participant" },
          });
          const propertyId = await propertyIdFor(eventsId, "people");
          await revise(cardId, { message: "Choose", ...mapping(person.id, "SPEAKER_01") }, runtime);
          const confirmIn = (client: PoolClient) => confirmProposalWithClient(client, proposalOptions(), cardId);
          const userWrite = (client: PoolClient) =>
            createRelationWithClient(
              client,
              {
                relationPropertyId: propertyId,
                callerItemId: eventId,
                targetItemId: person.id,
                metadata: { role: "attendee" },
              },
              undefined,
              { writerKind: "user" },
            );
          const backendPid = async (client: PoolClient) =>
            (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
          let release = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let firstPid = 0;
          let secondPid = 0;
          let firstReady = false;
          const first = withTransaction(runtime, async (client) => {
            firstPid = await backendPid(client);
            const result = order === "user-first" ? await userWrite(client) : await confirmIn(client);
            firstReady = true;
            await gate;
            return result;
          });
          void first.catch(() => {});
          let second: Promise<unknown> | undefined;
          try {
            await vi.waitFor(() => expect(firstReady).toBe(true), { timeout: 5000 });
            second = withTransaction(runtime, async (client) => {
              secondPid = await backendPid(client);
              return order === "user-first" ? confirmIn(client) : userWrite(client);
            });
            void second.catch(() => {});
            await vi.waitFor(
              async () => {
                expect(secondPid).not.toBe(0);
                const blocked = await runtime.query<{
                  blocked: boolean;
                  insertion: boolean;
                  enqueue: boolean;
                  eventLock: boolean;
                }>(
                  "SELECT $2::int = ANY(pg_blocking_pids(pid)) AS blocked, position('INSERT INTO item_relations' IN query) > 0 AS insertion, starts_with(query, 'SELECT graphile_worker.add_job(') AS enqueue, position('FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE' IN query) > 0 AS \"eventLock\" FROM pg_stat_activity WHERE pid = $1::int",
                  [secondPid, firstPid],
                );
                // Confirm-first: the user write's participant INSERT waits on the confirm's uncommitted edge; the
                // confirm's insert-only write takes no Event row lock, so the user write is not held in the hook.
                // User-first: the confirm's speakers edge enqueues People `lastContact`, which waits on the user
                // write's uncommitted job under the same person's key, before the participant insert.
                expect(blocked.rows[0]).toEqual(
                  order === "user-first"
                    ? { blocked: true, insertion: false, enqueue: true, eventLock: false }
                    : { blocked: true, insertion: true, enqueue: false, eventLock: false },
                );
              },
              { timeout: 5000 },
            );
          } finally {
            release();
            await Promise.allSettled([first, second]);
          }
          const [firstResult, secondResult] = await Promise.all([first, second]);
          expect(order === "user-first" ? secondResult : firstResult).toMatchObject({
            properties: { status: "confirmed" },
          });
          const rows = await edgesBetween(runtime, eventId, person.id);
          expect(rows.map((row) => row.metadata)).toEqual([{ role: "attendee" }]);
          // Both writers queued the same person's recompute; job-key deduplication left one job.
          const lastContactJobs = await pool.query<{ task_identifier: string; key: string | null }>(
            "SELECT task_identifier, key FROM graphile_worker.jobs WHERE key = $1",
            [peopleLastContactJobKey(person.id)],
          );
          expect(lastContactJobs.rows).toEqual([
            { task_identifier: CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE, key: peopleLastContactJobKey(person.id) },
          ]);
          const card = await runtime.query<{ history: unknown }>(
            "SELECT properties->'history' AS history FROM items WHERE database_id = $1 AND id = $2",
            [proposalsId, cardId],
          );
          const history = z
            .array(z.object({ addedRelations: z.array(z.object({ edgeId: z.string() })).optional() }))
            .parse(card.rows[0]?.history);
          expect(history.at(-1)?.addedRelations).toEqual(
            order === "user-first" ? undefined : [expect.objectContaining({ edgeId: rows[0]?.id })],
          );
        });
      },
      20_000,
    );

    it("confirms while an Event update holds the Event's row lock, and the update then queues the same person's recompute", async () => {
      const cardId = await onlyCardId();
      let confirming: Promise<unknown> | undefined;
      await asRuntime(async (runtime) => {
        try {
          const outcome = await withTransaction(runtime, async (update) => {
            // What an Event update holds first: the row lock of the Event.
            await lockItemById(update, eventsId, eventId);
            confirming = confirm(cardId, runtime);
            // The confirm queued Alice's `lastContact` recompute; the update below queues the same job key. A
            // confirm whose participant insert waited for this row lock would hold that key and deadlock, so the
            // wait is given a limit.
            const confirmed = await settledWithin(confirming);
            const updated = await updateItemWithClient(
              update,
              { databaseId: eventsId, itemId: eventId, propertiesPatch: { date: "2026-10-17" } },
              { writer: { writerKind: "user" } },
            );
            return { confirmed, date: updated.properties.date };
          });
          expect(outcome.confirmed).toMatchObject({ properties: { status: "confirmed" } });
          expect(outcome.date).toBe("2026-10-17");
        } finally {
          // After the update ended, a confirm that did wait ends too; it is settled before the pool is closed.
          await confirming?.catch(() => undefined);
        }
      });
      expect(await mappedPersonIds()).toContain(aliceId);
      const lastContactJobs = await pool.query<{ key: string | null }>(
        "SELECT key FROM graphile_worker.jobs WHERE key = $1",
        [peopleLastContactJobKey(aliceId)],
      );
      expect(lastContactJobs.rows).toEqual([{ key: peopleLastContactJobKey(aliceId) }]);
    }, 30_000);

    it("keeps an existing participant's metadata and omits a new-edge history entry", async () => {
      const cardId = await onlyCardId();
      await asRuntime(async (runtime) => {
        await createChokePoint(runtime).createRelation({
          relationPropertyId: await propertyIdFor(eventsId, "people"),
          callerItemId: eventId,
          targetItemId: aliceId,
          metadata: { invitation: ACCEPTED_INVITATION },
        });
        const before = await edgesBetween(runtime, eventId, aliceId);
        const confirmed = await confirm(cardId, runtime);
        expect(await edgesBetween(runtime, eventId, aliceId)).toEqual(before);
        const history = z
          .array(z.object({ message: z.string(), addedRelations: z.unknown().optional() }))
          .parse(confirmed.properties.history);
        expect(history.at(-1)).toMatchObject({ message: "Confirmed by user." });
        expect(history.at(-1)?.addedRelations).toBeUndefined();
      });
    });

    it("rolls back the speaker edge when its linked Event is trashed", async () => {
      const cardId = await onlyCardId();
      await asRuntime(async (runtime) => {
        await createChokePoint(runtime).softDeleteItem(eventsId, eventId);
        const snapshot = () =>
          runtime.query<{ card: unknown; edges: unknown }>(
            `SELECT (SELECT to_jsonb(i) FROM items i WHERE i.id = $1) AS card,
                    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM item_relations r
                     WHERE $2 IN (r.item_a, r.item_b) OR $3 IN (r.item_a, r.item_b)) AS edges`,
            [cardId, transcriptId, eventId],
          );
        const before = await snapshot();
        const speakerEdgesBefore = await edgesBetween(runtime, transcriptId, aliceId);
        let firstWriteObserved = false;
        await expect(
          withTransaction(runtime, async (client) => {
            // Observes the speaker-edge insert on this transaction's own client, so the rollback is shown to
            // undo a write that did happen.
            const own = Object.getOwnPropertyDescriptor(client, "query");
            /* eslint-disable @typescript-eslint/unbound-method */
            const query = client.query;
            client.query = new Proxy(query, {
              apply(target, receiver, args: unknown[]) {
                const result: unknown = Reflect.apply(target, receiver, args);
                const values = args[1];
                if (
                  typeof args[0] !== "string" ||
                  !args[0].includes("INSERT INTO item_relations") ||
                  !Array.isArray(values) ||
                  !values.includes(transcriptId) ||
                  !values.includes(aliceId)
                )
                  return result;
                return Promise.resolve(result).then((actual: unknown) => {
                  firstWriteObserved = z.object({ rowCount: z.number().nullable() }).parse(actual).rowCount === 1;
                  return actual;
                });
              },
            });
            /* eslint-enable @typescript-eslint/unbound-method */
            try {
              return await confirmProposalWithClient(client, proposalOptions(), cardId);
            } finally {
              if (own) Object.defineProperty(client, "query", own);
              else Reflect.deleteProperty(client, "query");
            }
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(firstWriteObserved).toBe(true);
        expect(await edgesBetween(runtime, transcriptId, aliceId)).toEqual(speakerEdgesBefore);
        expect((await snapshot()).rows).toEqual(before.rows);
        const card = await runtime.query<{ status: string }>(
          "SELECT properties->>'status' AS status FROM items WHERE database_id = $1 AND id = $2",
          [proposalsId, cardId],
        );
        expect(card.rows).toEqual([{ status: "proposed" }]);
      });
    });

    it("confirm writes the user-owned mapping with its speaker key, and a retry writes nothing more", async () => {
      const cardId = await onlyCardId();

      const confirmed = await confirm(cardId);
      await confirm(cardId);

      expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: aliceId, resultLabel: "Alice" });
      expect(await mappedPersonIds()).toEqual([null, aliceId]);
      // Only the `speakers` relation: the transcript also holds Alice in `people`, inherited from its Event.
      const { rows } = await pool.query<{ metadata: unknown }>(
        `SELECT r.metadata FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         WHERE $1 IN (r.item_a, r.item_b) AND $2 IN (r.item_a, r.item_b) AND d.property_id_a = $3`,
        [transcriptId, aliceId, await propertyIdFor(transcriptsId, "speakers")],
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

    it("revise can change the person, stores it as aiProposal at a new version, and confirm then maps that person", async () => {
      const cardId = await onlyCardId();

      await revise(cardId, mapping(bobId, "SPEAKER_01"));
      const { rows } = await pool.query<{ aiProposal: unknown; aiVersion: number }>(
        `SELECT properties -> 'aiProposal' AS "aiProposal", (properties ->> 'aiVersion')::int AS "aiVersion"
           FROM items WHERE id = $1`,
        [cardId],
      );
      expect(rows).toEqual([{ aiProposal: mapping(bobId, "SPEAKER_01"), aiVersion: 2 }]);
      await confirm(cardId);

      expect(await mappedPersonIds()).toEqual([null, bobId]);
    });

    it.each([
      {
        name: "a key the transcript does not have",
        envelope: () => mapping(aliceId, "SPEAKER_07"),
        refusal: { reason: "unknownSpeaker" },
      },
      {
        name: "an Event relation",
        envelope: (): ProposalEnvelope => ({
          entityKind: "relation",
          target: eventId,
          properties: { propertyKey: "event" },
        }),
        refusal: { field: "entityKind" },
      },
      {
        name: "a database proposal",
        envelope: (): ProposalEnvelope => ({ entityKind: "database", target: eventsId, properties: { name: "Sync" } }),
        refusal: { field: "entityKind" },
      },
    ])("revise refuses $name", async ({ envelope, refusal }) => {
      await expect(revise(await onlyCardId(), envelope())).rejects.toMatchObject({
        code: "validation_failed",
        details: refusal,
      });
    });

    it("reject writes no mapping", async () => {
      const id = await onlyCardId();
      await reject(id);

      expect((await speakerCards()).find((card) => card.id === id)?.status).toBe("rejected");
      expect(await mappedPersonIds()).toEqual([null, null]);
    });
  });

  /** Read without the choke point. */
  async function cardRow(cardId: string) {
    const { rows } = await pool.query<{
      properties: Record<string, unknown>;
      updated_at: Date;
      deleted_at: Date | null;
    }>("SELECT properties, updated_at, deleted_at FROM items WHERE id = $1", [cardId]);
    if (!rows[0]) throw new Error(`Card ${cardId} not found`);
    return rows[0];
  }

  async function cardOf(speaker: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties -> 'context' ->> 'speaker' = $2`,
      [proposalsId, speaker],
    );
    if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one card for ${speaker}, found ${rows.length}`);
    return rows[0].id;
  }

  const alternativeIds = (properties: Record<string, unknown>): string[] =>
    transcriptSpeakerCardContextSchema
      .parse(properties.context)
      .alternatives.map((alternative) => alternative.personId)
      .sort();

  describe("a clarification card is refreshed and no other card is rewritten", () => {
    const greetedAsAlice = (): SpeakerMappingSuggestion[] => [
      { speaker: "SPEAKER_00", personId: aliceId, reason: "Is greeted as Alice." },
    ];

    it("refreshes an untouched clarification card with the new alternatives and, when confident, a proposal", async () => {
      expect(await propose([])).toEqual(["SPEAKER_00", "SPEAKER_01"]);
      const confident = await cardOf("SPEAKER_00");
      const unsure = await cardOf("SPEAKER_01");
      expect(alternativeIds((await cardRow(confident)).properties)).toEqual([]);
      expect((await cardRow(confident)).properties.referencedItemIds).toEqual([]);
      await linkEvent();

      expect(await propose(greetedAsAlice())).toEqual([]);

      expect(await cardOf("SPEAKER_00")).toBe(confident);
      const proposed = (await cardRow(confident)).properties;
      expect(proposed).toMatchObject({
        status: "proposed",
        proposal: mapping(aliceId, "SPEAKER_00"),
        aiProposal: mapping(aliceId, "SPEAKER_00"),
        aiVersion: 2,
        context: { reason: "Is greeted as Alice." },
        history: [expect.objectContaining({ author: "ai", kind: "recompute" })],
      });
      expect(alternativeIds(proposed)).toEqual([aliceId, bobId].sort());
      // The refreshed proposal names the person, so the card is found when that person is archived or deleted.
      expect(proposed.referencedItemIds).toEqual([aliceId]);
      const stillUnsure = (await cardRow(unsure)).properties;
      expect(stillUnsure).toMatchObject({ status: "needsClarification", proposal: null, aiVersion: 1 });
      expect(alternativeIds(stillUnsure)).toEqual([aliceId, bobId].sort());
      expect(await speakerCards()).toHaveLength(2);
      expect(await mappedPersonIds()).toEqual([null, null]);
    });

    it.each<{ name: string; arrange: (cardId: string) => Promise<unknown>; event?: boolean; suggest?: boolean }>([
      { name: "when the refresh would change nothing", arrange: async () => {}, event: false, suggest: false },
      {
        name: "a clarification card the user touched",
        // A message alone is the user's own history entry; it changes nothing else of the card.
        arrange: (cardId) => revise(cardId, { message: "Not sure yet" }),
      },
      { name: "a rejected card, and creates no second one", arrange: (cardId) => reject(cardId) },
      {
        name: "a clarification card in the Trash",
        arrange: (cardId) =>
          withTransaction(pool, (client) =>
            itemDeleteWithClient(client, proposalsId, cardId, { queueAffinity: createActionQueueAffinity() }),
          ),
      },
    ])("writes nothing for $name", async ({ arrange, event = true, suggest = true }) => {
      await propose([]);
      const cardId = await cardOf("SPEAKER_00");
      await arrange(cardId);
      if (event) await linkEvent();
      const before = await cardRow(cardId);

      expect(await propose(suggest ? greetedAsAlice() : [])).toEqual([]);

      expect(await cardRow(cardId)).toEqual(before);
      expect(await speakerCards()).toHaveLength(2);
    });

    it("leaves a proposed card, whatever the model suggests now", async () => {
      await linkEvent();
      await propose(greetedAsAlice());
      const cardId = await cardOf("SPEAKER_00");
      const before = await cardRow(cardId);

      await propose([{ speaker: "SPEAKER_00", personId: bobId, reason: "Changed its mind." }]);

      expect(await cardRow(cardId)).toEqual(before);
    });

    it("leaves a card that another transaction holds, without waiting for it", async () => {
      await propose([]);
      const cardId = await cardOf("SPEAKER_00");
      await linkEvent();
      const before = await cardRow(cardId);
      // A confirm of the card locks it first and the transcript second: this stands in for one in progress.
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM items WHERE id = $1 FOR UPDATE", [cardId]);
        expect(await settledWithin(propose(greetedAsAlice()))).toEqual([]);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect(await cardRow(cardId)).toEqual(before);
    });
  });

  describe("the checkpoint binding", () => {
    const context = (eventId: string | null, ids: string[]) => ({
      eventId,
      candidates: ids.map((id) => candidate(id, id)),
    });

    it("is current only for the Event and the candidates it was written for, in any order", () => {
      const checkpoint = buildSpeakerSuggestionCheckpoint(context(eventId, [bobId, aliceId]), undefined, [
        "SPEAKER_00",
      ]);

      expect(checkpoint).toEqual({ proposedSpeakers: ["SPEAKER_00"], eventId, candidateIds: [aliceId, bobId].sort() });
      expect(isSpeakerSuggestionCurrent(checkpoint, context(eventId, [aliceId, bobId]))).toBe(true);
      for (const other of [
        context(eventId, [aliceId]),
        context(eventId, [aliceId, bobId, randomUUID()]),
        context(randomUUID(), [aliceId, bobId]),
        context(null, [aliceId, bobId]),
      ])
        expect(isSpeakerSuggestionCurrent(checkpoint, other)).toBe(false);
    });

    it("counts an absent, an old and an unreadable checkpoint as different, and a no-Event one as current for no Event", () => {
      for (const stale of [undefined, { proposedSpeakers: ["SPEAKER_00"] }, { proposedSpeakers: "SPEAKER_00" }])
        expect(isSpeakerSuggestionCurrent(stale, context(null, []))).toBe(false);
      const noEvent = buildSpeakerSuggestionCheckpoint(context(null, []), undefined, []);
      expect(noEvent).toEqual({ proposedSpeakers: [], eventId: null, candidateIds: [] });
      expect(isSpeakerSuggestionCurrent(noEvent, context(null, []))).toBe(true);
    });

    it("keeps the keys of an earlier checkpoint and ignores one it cannot read", () => {
      const earlier = { proposedSpeakers: ["SPEAKER_00"], eventId: null, candidateIds: [] };

      expect(buildSpeakerSuggestionCheckpoint(context(null, []), earlier, ["SPEAKER_01", "SPEAKER_00"])).toMatchObject({
        proposedSpeakers: ["SPEAKER_00", "SPEAKER_01"],
      });
      expect(buildSpeakerSuggestionCheckpoint(context(null, []), "garbage", ["SPEAKER_01"])).toMatchObject({
        proposedSpeakers: ["SPEAKER_01"],
      });
    });
  });

  describe("the changed-edge trigger", () => {
    async function jobKeys(): Promise<string[]> {
      const { rows } = await pool.query<{ key: string; queue_name: string | null; max_attempts: number }>(
        `SELECT key, queue_name, max_attempts FROM graphile_worker.jobs
          WHERE task_identifier = 'transcriptSpeakerSuggestion' ORDER BY key`,
      );
      for (const row of rows) {
        expect(row.queue_name).toBe(`transcript-speaker-suggestion:${getTenantZeroId()}`);
        expect(row.max_attempts).toBe(3);
      }
      return rows.map((row) => row.key);
    }

    async function clearJobs(): Promise<void> {
      await pool.query("TRUNCATE graphile_worker._private_jobs RESTART IDENTITY CASCADE");
    }

    const keyOf = (id: string) => `transcript-speaker-suggestion:${id}`;

    async function eventRelation(
      write: "createRelation" | "deleteRelation",
      databaseId: string,
      key: string,
      callerItemId: string,
      targetItemId: string,
    ) {
      await chokePoint[write]({ relationPropertyId: await propertyIdFor(databaseId, key), callerItemId, targetItemId });
    }

    it("enqueues one job for the transcript when its Event edge is created, and again when it is deleted", async () => {
      await linkEvent();
      expect(await jobKeys()).toEqual([keyOf(transcriptId)]);
      await clearJobs();

      await eventRelation("deleteRelation", transcriptsId, "event", transcriptId, eventId);

      expect(await jobKeys()).toEqual([keyOf(transcriptId)]);
    });

    it("enqueues a job for every transcript that shares the Event when a participant is added or removed", async () => {
      const other = await withTransaction(pool, async (client) => {
        const item = await createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Other" } });
        await writeComputed(client, transcriptsId, item.id, "segments", SEGMENTS);
        return item.id;
      });
      await linkEvent();
      await eventRelation("createRelation", transcriptsId, "event", other, eventId);
      const carolId = await createItem(peopleId, "Carol");
      for (const write of ["createRelation", "deleteRelation"] as const) {
        await clearJobs();
        await eventRelation(write, eventsId, "people", eventId, carolId);
        expect(await jobKeys()).toEqual([keyOf(transcriptId), keyOf(other)].sort());
      }
    });

    it.each([
      { name: "a participant of an Event no transcript is linked to", arrange: async () => {} },
      {
        name: "a participant of an Event whose only transcript is in the Trash",
        arrange: async () => {
          await linkEvent();
          await withTransaction(pool, (client) =>
            itemDeleteWithClient(client, transcriptsId, transcriptId, { queueAffinity: createActionQueueAffinity() }),
          );
        },
      },
    ])("enqueues nothing for $name", async ({ arrange }) => {
      await arrange();
      await clearJobs();

      await createParticipant("Carol");

      expect(await jobKeys()).toEqual([]);
    });

    it("enqueues nothing for an update of a participant edge", async () => {
      await linkEvent();
      await clearJobs();

      // The server writes the invitation onto the edge, as the calendar module's invitation code does.
      await chokePoint.updateRelation({
        relationPropertyId: await propertyIdFor(eventsId, "people"),
        callerItemId: eventId,
        targetItemId: aliceId,
        metadata: { role: "attendee", invitation: ACCEPTED_INVITATION },
      });

      const edges = await edgesBetween(pool, eventId, aliceId);
      expect(edges[0]?.metadata).toMatchObject({ invitation: ACCEPTED_INVITATION });
      expect(await jobKeys()).toEqual([]);
    });

    it("enqueues nothing for another relation of the Event or of the transcript", async () => {
      const projectId = await createItem(await databaseIdFor("projects"), "Apollo");
      await linkEvent();
      await clearJobs();

      await eventRelation("createRelation", eventsId, "project", eventId, projectId);
      await eventRelation("createRelation", transcriptsId, "people", transcriptId, aliceId);

      expect(await jobKeys()).toEqual([]);
    });

    it("converges many edge writes onto one job per transcript", async () => {
      await linkEvent();
      await createParticipant("Carol");
      await createParticipant("Dave");

      expect(await jobKeys()).toEqual([keyOf(transcriptId)]);
    });

    it.each([
      { name: "a revise of the card to an Event, which is only checked, and one job for its confirm", revised: true },
      { name: "the confirm of a new-meeting card, which writes the participants and the edge", revised: false },
    ])("with the Event card of a recording, enqueues the right jobs for $name", async ({ revised }) => {
      // No Event overlaps the date, so the match step leaves a new-meeting card.
      const cardTranscriptId = await withTransaction(pool, async (client) => {
        const item = await createItemWithClient(
          client,
          { databaseId: transcriptsId, properties: { name: "Recorded", date: "2024-03-01T12:00:00.000Z" } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await matchTranscriptToEvent(client, { transcriptId: item.id, durationSeconds: 3600 });
        return item.id;
      });
      const { rows } = await pool.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN item_relations r ON r.item_a = i.id OR r.item_b = i.id
          WHERE i.database_id = $1 AND i.properties ->> 'kind' = 'transcript' AND $2 IN (r.item_a, r.item_b)`,
        [proposalsId, cardTranscriptId],
      );
      if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one card, found ${rows.length}`);
      const cardId = rows[0].id;
      await clearJobs();

      await runInTenant(getTenantZeroId(), async () => {
        if (revised) {
          await withTransaction(pool, (client) =>
            reviseProposalWithClient(client, proposalOptions(), cardId, {
              entityKind: "relation",
              target: eventId,
              properties: { propertyKey: "event" },
            }),
          );
          expect(await jobKeys()).toEqual([]);
        }
        await confirm(cardId);
      });

      expect(await jobKeys()).toEqual([keyOf(cardTranscriptId)]);
    });
  });
});
