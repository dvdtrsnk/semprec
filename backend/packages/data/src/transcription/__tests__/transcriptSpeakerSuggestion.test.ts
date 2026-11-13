import { setSelfPersonId } from "../../selfPerson.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
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
} from "../../inbox/proposalActions.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { listTranscriptSpeakers } from "../transcriptionSpeakerEdges.js";
import { peopleLastContactJobKey } from "../../people/lastContact.js";
import { transcriptSpeakerCardContextSchema } from "../transcriptSpeakerCardContext.js";
import {
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  type SpeakerMappingSuggestion,
} from "../transcriptSpeakerSuggestion.js";

let pool: Pool;

/** An invitation of the shape issue #1757 gives a participant edge; an internal write without a writer stores it as `system`. */
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

/**
 * The value of `work`, or the string `"still waiting"` when it has not settled after `milliseconds`. The limit
 * only ends a wait that would otherwise last as long as a lock is held; work that does not wait settles long
 * before it.
 */
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
    // An Events `people` edge is a link-rule source (issue #1697): its write queues a propagation job, which
    // needs a tenant scope.
    chokePoint = bindToTenantZero(createChokePoint(pool));

    transcriptId = await withTransaction(pool, async (client) => {
      const item = await createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Sync" } });
      await writeComputed(client, transcriptsId, item.id, "segments", SEGMENTS);
      return item.id;
    });
    // An Event's create requires a date (issue #1663); the speaker suggestion reads only its participants.
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

    it("ignores an incidental historical title on a participant", async () => {
      // Synthetic historical JSON: the current People writer has no supported title property.
      const historical = await pool.query(
        "UPDATE items SET properties = jsonb_set(properties, '{title}', to_jsonb($4::text)) WHERE tenant_id = $1 AND database_id = $2 AND id = $3",
        [getTenantZeroId(), peopleId, aliceId, "Historical title"],
      );
      expect(historical.rowCount).toBe(1);
      await linkEvent();
      expect((await context())?.candidates).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: aliceId, name: "Alice", title: null })]),
      );
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
        metadata: { invitation: ACCEPTED_INVITATION },
      });
      const bobEdge = await chokePoint.createRelation({
        relationPropertyId,
        callerItemId: eventId,
        targetItemId: bobId,
      });
      // The participant edge hook (issue #1757) refuses this shape, so only an edge stored before it can hold it.
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

  it("uses only eligible quotes while retaining each speaker's actual first start", async () => {
    const segments = [
      { speaker: "SPEAKER_00", text: "First short", startsAt: 0, endsAt: 1 },
      { speaker: "SPEAKER_01", text: "Short one", startsAt: 1, endsAt: 2 },
      { speaker: "SPEAKER_01", text: "Short two", startsAt: 2, endsAt: 3 },
      { speaker: "SPEAKER_02", text: "No quote one", startsAt: 3, endsAt: 4 },
      { speaker: "SPEAKER_02", text: "No quote two", startsAt: 4, endsAt: 5 },
      { speaker: "SPEAKER_02", text: "One two three four five", startsAt: 5, endsAt: 6 },
      { speaker: "SPEAKER_00", text: "One two three four five six", startsAt: 6, endsAt: 7 },
      { speaker: "SPEAKER_00", text: "One two three four five six seven", startsAt: 7, endsAt: 8 },
      { speaker: "SPEAKER_00", text: "One two three four five six seven eight", startsAt: 8, endsAt: 9 },
      { speaker: "SPEAKER_00", text: "One two three four five six seven eight nine", startsAt: 9, endsAt: 10 },
      { speaker: "SPEAKER_00", text: "We discussed this proposal with the team ".repeat(6), startsAt: 10, endsAt: 11 },
      { speaker: "SPEAKER_01", text: "One two three four five six", startsAt: 11, endsAt: 12 },
    ];
    expect(segments[5]!.text.split(/\s+/)).toHaveLength(5);
    expect(segments[11]!.text.split(/\s+/)).toHaveLength(6);
    await withTransaction(pool, (client) => writeComputed(client, transcriptsId, transcriptId, "segments", segments));
    const result = await context();
    expect(result?.details).toEqual([
      {
        speaker: "SPEAKER_00",
        ordinal: 1,
        firstStartsAt: 0,
        quotes: [
          { segmentIndex: 8, text: segments[8]!.text },
          { segmentIndex: 9, text: segments[9]!.text },
          { segmentIndex: 10, text: segments[10]!.text.slice(0, 140) },
        ],
      },
      { speaker: "SPEAKER_01", ordinal: 2, firstStartsAt: 1, quotes: [{ segmentIndex: 11, text: segments[11]!.text }] },
      { speaker: "SPEAKER_02", ordinal: 3, firstStartsAt: 3, quotes: [] },
    ]);
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

    it("announces each new card once and nothing for a repeated run (issue #1811)", async () => {
      await linkEvent();
      const events: InboxCardsInvalidationEvent[] = [];
      setInboxCardsInvalidationHook((event) => events.push(event));
      try {
        await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);
        const cardIds = (await speakerCards()).length;
        expect(events).toHaveLength(cardIds);
        const announced = events.splice(0);
        expect(announced.every((event) => event.op === "created" && event.userId === undefined)).toBe(true);
        const stored = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'processingProposals')",
        );
        expect(announced.map((event) => event.cardId).sort()).toEqual(stored.rows.map((row) => row.id).sort());

        expect(await propose([{ speaker: "SPEAKER_01", personId: bobId, reason: "Named." }])).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        setInboxCardsInvalidationHook(() => {});
      }
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

  it.each(["rejected", "trashed"] as const)(
    "does not recreate a %s speaker card and creates a different key",
    async (state) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tenant = getTenantZeroId();
        await runInTenant(tenant, async () => {
          const eventProperty = await runtime.query<{ id: string }>(
            "SELECT id FROM properties WHERE database_id = $1 AND key = 'event'",
            [transcriptsId],
          );
          if (!eventProperty.rows[0]) throw new Error("Missing transcript event property");
          await createChokePoint(runtime).createRelation({
            relationPropertyId: eventProperty.rows[0].id,
            callerItemId: transcriptId,
            targetItemId: eventId,
          });
          await withTransaction(runtime, (client) =>
            writeComputed(client, transcriptsId, transcriptId, "segments", SEGMENTS.slice(0, 1)),
          );
          await withTransaction(runtime, (client) =>
            proposeSpeakerMappings(client, {
              transcriptId,
              suggestions: [{ speaker: "SPEAKER_00", personId: aliceId, reason: "Named." }],
            }),
          );
          const rows = await runtime.query<{ id: string }>(
            "SELECT id FROM items WHERE database_id = $1 AND properties->'context'->>'speaker' = 'SPEAKER_00'",
            [proposalsId],
          );
          if (rows.rows.length !== 1 || !rows.rows[0]) throw new Error("Missing first speaker card");
          const first = rows.rows[0].id;
          if (state === "rejected")
            await withTransaction(runtime, (client) =>
              rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, first),
            );
          else await createChokePoint(runtime).softDeleteItem(proposalsId, first);
          await withTransaction(runtime, (client) =>
            writeComputed(client, transcriptsId, transcriptId, "segments", SEGMENTS),
          );
          await withTransaction(runtime, (client) =>
            proposeSpeakerMappings(client, {
              transcriptId,
              suggestions: [
                { speaker: "SPEAKER_00", personId: aliceId, reason: "Named." },
                { speaker: "SPEAKER_01", personId: bobId, reason: "Named." },
              ],
            }),
          );
          const cards = await runtime.query<{ id: string; speaker: string; deleted_at: Date | null }>(
            "SELECT id, properties->'context'->>'speaker' AS speaker, deleted_at FROM items WHERE database_id = $1 AND properties->>'kind' = 'transcript' ORDER BY speaker",
            [proposalsId],
          );
          expect(cards.rows.filter((card) => card.speaker === "SPEAKER_00")).toHaveLength(1);
          expect(cards.rows.find((card) => card.speaker === "SPEAKER_00")?.id).toBe(first);
          expect(cards.rows.filter((card) => card.speaker === "SPEAKER_01" && card.deleted_at === null)).toHaveLength(
            1,
          );
        });
      } finally {
        await runtime.end();
      }
    },
  );

  it("confirms a revised speaker without an Event and adds no participant edge", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = getTenantZeroId();
      await runInTenant(tenant, async () => {
        await withTransaction(runtime, (client) => proposeSpeakerMappings(client, { transcriptId, suggestions: [] }));
        const cards = await runtime.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->'context'->>'speaker' = 'SPEAKER_00'",
          [proposalsId],
        );
        if (!cards.rows[0]) throw new Error("Missing speaker card");
        const cardId = cards.rows[0].id;
        await withTransaction(runtime, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
            message: "Choose",
            ...mapping(aliceId, "SPEAKER_00"),
          }),
        );
        const before = await runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a,item_b)",
          [eventId],
        );
        const confirmed = await withTransaction(runtime, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
        );
        const after = await runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a,item_b)",
          [eventId],
        );
        expect(after.rows).toEqual(before.rows);
        expect(confirmed.properties.status).toBe("confirmed");
        const history = z
          .array(z.object({ addedRelations: z.unknown().optional() }))
          .parse(confirmed.properties.history);
        expect(history.at(-1)?.addedRelations).toBeUndefined();
        const mappingRows = await runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a,item_b) AND $2 IN (item_a,item_b)",
          [transcriptId, aliceId],
        );
        expect(mappingRows.rows).toEqual([{ count: 1 }]);
      });
    } finally {
      await runtime.end();
    }
  });

  describe("confirm, revise and reject of a speaker card", () => {
    beforeEach(async () => {
      await linkEvent();
      await propose([{ speaker: "SPEAKER_01", personId: aliceId, reason: "Named." }]);
    });

    it("adds a nonparticipant atomically and records only the inserted Event edge", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tenant = getTenantZeroId();
        const foreign = await createTestTenant(pool);
        const cardId = await onlyCardId();
        const readEdges = async () =>
          runInTenant(tenant, () =>
            withTransaction(runtime, async (client) => {
              const property = await client.query<{ id: string }>(
                "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
                [eventsId],
              );
              if (!property.rows[0]) throw new Error("Missing Event people property");
              const definition = await relationStore.getRelationDefinitionByPropertyId(client, property.rows[0].id);
              if (!definition) throw new Error("Missing Event people relation");
              return {
                propertyId: property.rows[0].id,
                edges: await relationStore.listRelationsForItem(client, definition.id, eventId),
              };
            }),
          );
        const person = await runInTenant(tenant, () =>
          createChokePoint(runtime).createItem({ databaseId: peopleId, properties: { name: "New participant" } }),
        );
        await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
              message: "Choose person",
              ...mapping(person.id, "SPEAKER_01"),
            }),
          ),
        );
        const before = await readEdges();
        await expect(
          runInTenant(foreign, () =>
            withTransaction(runtime, (client) =>
              confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
            ),
          ),
        ).rejects.toMatchObject({ status: 404 });
        const confirmed = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
          ),
        );
        const after = await readEdges();
        const extra = after.edges.filter((edge) => edge.itemA === person.id || edge.itemB === person.id);
        expect(extra).toHaveLength(1);
        expect(extra[0]?.metadata).toEqual({});
        expect(after.edges).toHaveLength(before.edges.length + 1);
        const speakerEdges = await runInTenant(tenant, () =>
          runtime.query<{ metadata: unknown }>(
            "SELECT metadata FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)",
            [transcriptId, person.id],
          ),
        );
        expect(speakerEdges.rows).toEqual([{ metadata: { speaker: "SPEAKER_01" } }]);
        expect(confirmed.properties.history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              addedRelations: [
                {
                  edgeId: extra[0]!.id,
                  relationPropertyId: after.propertyId,
                  callerItemId: eventId,
                  targetItemId: person.id,
                },
              ],
            }),
          ]),
        );
        const parsedHistory = z.array(proposalHistoryEntrySchema).parse(confirmed.properties.history);
        expect(parsedHistory.at(-1)?.addedRelations).toEqual([
          {
            edgeId: extra[0]!.id,
            relationPropertyId: after.propertyId,
            callerItemId: eventId,
            targetItemId: person.id,
          },
        ]);
        const repeated = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
          ),
        );
        expect(repeated.properties).toEqual(confirmed.properties);
        expect(repeated.updatedAt).toEqual(confirmed.updatedAt);
        expect((await readEdges()).edges).toEqual(after.edges);
      } finally {
        await runtime.end();
      }
    });

    it.each(["user-first", "confirm-first"] as const)(
      "serializes a real competing user write in the %s order",
      async (order) => {
        const runtime = await createRuntimeRolePool(pool, "semprec_data");
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let first: Promise<unknown> | undefined;
        let second: Promise<unknown> | undefined;
        let firstFailure: unknown;
        let secondFailure: unknown;
        let firstFailed = false;
        let secondFailed = false;
        let primaryFailure: unknown;
        let primaryFailed = false;
        const cleanupFailures: unknown[] = [];
        try {
          const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          );
          expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
          const tenant = getTenantZeroId();
          const cardId = await onlyCardId();
          await runInTenant(tenant, async () => {
            const person = await createChokePoint(runtime).createItem({
              databaseId: peopleId,
              properties: { name: "Concurrent participant" },
            });
            const property = await runtime.query<{ id: string }>(
              "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
              [eventsId],
            );
            if (!property.rows[0]) throw new Error("Missing Event people property");
            const propertyId = property.rows[0].id;
            await withTransaction(runtime, (client) =>
              reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
                message: "Choose",
                ...mapping(person.id, "SPEAKER_01"),
              }),
            );
            let firstPid = 0;
            let secondPid = 0;
            let firstReady = false;
            const confirm = (client: import("pg").PoolClient) =>
              confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId);
            const userWrite = (client: import("pg").PoolClient) =>
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
            first = withTransaction(runtime, async (client) => {
              const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              firstPid = pid.rows[0]?.pid ?? 0;
              const result = order === "user-first" ? await userWrite(client) : await confirm(client);
              firstReady = true;
              await gate;
              return result;
            });
            void first.catch((error: unknown) => {
              firstFailed = true;
              firstFailure = error;
            });
            await vi.waitFor(
              () => {
                if (firstFailed)
                  throw firstFailure instanceof Error
                    ? firstFailure
                    : new Error("First concurrent operation failed", { cause: firstFailure });
                expect(firstReady).toBe(true);
              },
              { timeout: 5000 },
            );
            second = withTransaction(runtime, async (client) => {
              const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              secondPid = pid.rows[0]?.pid ?? 0;
              return order === "user-first" ? confirm(client) : userWrite(client);
            });
            void second.catch((error: unknown) => {
              secondFailed = true;
              secondFailure = error;
            });
            await vi.waitFor(
              async () => {
                if (secondFailed)
                  throw secondFailure instanceof Error
                    ? secondFailure
                    : new Error("Second concurrent operation failed", { cause: secondFailure });
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
                // Confirm-first: the user write's participant INSERT waits on the confirm's uncommitted participant
                // edge. The confirm's insert-only write takes no Event row lock in the participant edge hook
                // (issue #1757), so the user write passes that hook's lock and is not held there.
                // User-first: the confirm writes its speakers edge first, and that edge's People `lastContact`
                // enqueue (issue #1660) waits on the user write's uncommitted job under the same person's key, before
                // the confirm reaches its participant insert.
                expect(blocked.rows[0]).toEqual(
                  order === "user-first"
                    ? { blocked: true, insertion: false, enqueue: true, eventLock: false }
                    : { blocked: true, insertion: true, enqueue: false, eventLock: false },
                );
              },
              { timeout: 5000 },
            );
            release();
            const [firstResult, secondResult] = await Promise.all([first, second]);
            const confirmed = order === "user-first" ? secondResult : firstResult;
            expect(confirmed).toMatchObject({ properties: { status: "confirmed" } });
            const rows = await runtime.query<{ id: string; metadata: unknown }>(
              "SELECT id, metadata FROM item_relations WHERE $1 IN (item_a,item_b) AND $2 IN (item_a,item_b)",
              [eventId, person.id],
            );
            expect(rows.rows).toHaveLength(1);
            expect(rows.rows[0]?.metadata).toEqual({ role: "attendee" });
            // Both writers queued the same person's recompute; job-key deduplication left one job.
            const lastContactJobs = await pool.query<{ task_identifier: string; key: string | null }>(
              "SELECT task_identifier, key FROM graphile_worker.jobs WHERE key = $1",
              [peopleLastContactJobKey(person.id)],
            );
            expect(lastContactJobs.rows).toEqual([
              {
                task_identifier: CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE,
                key: peopleLastContactJobKey(person.id),
              },
            ]);
            const card = await runtime.query<{ history: unknown }>(
              "SELECT properties->'history' AS history FROM items WHERE database_id = $1 AND id = $2",
              [proposalsId, cardId],
            );
            const history = z
              .array(z.object({ addedRelations: z.array(z.object({ edgeId: z.string() })).optional() }))
              .parse(card.rows[0]?.history);
            if (order === "user-first") expect(history.at(-1)?.addedRelations).toBeUndefined();
            else
              expect(history.at(-1)?.addedRelations).toEqual([expect.objectContaining({ edgeId: rows.rows[0]?.id })]);
          });
        } catch (error) {
          primaryFailed = true;
          primaryFailure = error;
        } finally {
          release();
          const settled = await Promise.allSettled(
            [first, second].filter((entry): entry is Promise<unknown> => entry !== undefined),
          );
          for (const result of settled)
            if (result.status === "rejected" && result.reason !== primaryFailure) cleanupFailures.push(result.reason);
          try {
            await runtime.end();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
        if (primaryFailed) {
          if (cleanupFailures.length)
            throw new AggregateError([primaryFailure, ...cleanupFailures], "Concurrent test and cleanup failed", {
              cause: primaryFailure,
            });
          throw primaryFailure instanceof Error
            ? primaryFailure
            : new Error("Concurrent test failed", { cause: primaryFailure });
        }
        if (cleanupFailures.length)
          throw new AggregateError(cleanupFailures, "Concurrent test cleanup failed", { cause: cleanupFailures[0] });
      },
      20_000,
    );

    it("confirms while an Event update holds the Event's row lock, and the update then queues the same person's recompute", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let confirming: Promise<unknown> | undefined;
      try {
        const cardId = await onlyCardId();
        await runInTenant(getTenantZeroId(), async () => {
          const outcome = await withTransaction(runtime, async (update) => {
            // What an Event update holds first: the row lock of the Event.
            await lockItemById(update, eventsId, eventId);
            confirming = withTransaction(runtime, (client) =>
              confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
            );
            // The confirm's speakers edge queued Alice's `lastContact` recompute (issue #1660). Alice already takes
            // part in the Event, so the update below queues the same job key. A confirm whose participant insert
            // waited for the row lock here would hold that key while it waits, and the two would deadlock. Such a
            // wait cannot end inside this callback, so it is given a limit.
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
        });
        expect(await mappedPersonIds()).toContain(aliceId);
        const lastContactJobs = await pool.query<{ key: string | null }>(
          "SELECT key FROM graphile_worker.jobs WHERE key = $1",
          [peopleLastContactJobKey(aliceId)],
        );
        expect(lastContactJobs.rows).toEqual([{ key: peopleLastContactJobKey(aliceId) }]);
      } finally {
        // After the update ended, a confirm that did wait ends too; it is settled before the pool is closed.
        await confirming?.catch(() => undefined);
        await runtime.end();
      }
    }, 30_000);

    it("keeps an existing participant's metadata and omits a new-edge history entry", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tenant = getTenantZeroId();
        const cardId = await onlyCardId();
        await runInTenant(tenant, async () => {
          const property = await runtime.query<{ id: string }>(
            "SELECT id FROM properties WHERE database_id = $1 AND key = 'people'",
            [eventsId],
          );
          if (!property.rows[0]) throw new Error("Missing Event people property");
          await createChokePoint(runtime).createRelation({
            relationPropertyId: property.rows[0].id,
            callerItemId: eventId,
            targetItemId: aliceId,
            metadata: { invitation: ACCEPTED_INVITATION },
          });
          const before = await runtime.query<{ id: string; metadata: unknown }>(
            "SELECT id, metadata FROM item_relations WHERE $1 IN (item_a,item_b) AND $2 IN (item_a,item_b)",
            [eventId, aliceId],
          );
          const confirmed = await withTransaction(runtime, (client) =>
            confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
          );
          const after = await runtime.query<{ id: string; metadata: unknown }>(
            "SELECT id, metadata FROM item_relations WHERE $1 IN (item_a,item_b) AND $2 IN (item_a,item_b)",
            [eventId, aliceId],
          );
          expect(after.rows).toEqual(before.rows);
          const history = z
            .array(z.object({ message: z.string(), addedRelations: z.unknown().optional() }))
            .parse(confirmed.properties.history);
          expect(history.at(-1)).toMatchObject({ message: "Confirmed by user." });
          expect(history.at(-1)?.addedRelations).toBeUndefined();
        });
      } finally {
        await runtime.end();
      }
    });

    it("rolls back the speaker edge when its linked Event is trashed", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tenant = getTenantZeroId();
        const cardId = await onlyCardId();
        await runInTenant(tenant, async () => {
          await createChokePoint(runtime).softDeleteItem(eventsId, eventId);
          const before = await runtime.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a,item_b) AND $2 IN (item_a,item_b)",
            [transcriptId, aliceId],
          );
          const snapshot = () =>
            runtime.query<{ card: unknown; edges: unknown }>(
              `SELECT (SELECT to_jsonb(i) FROM items i WHERE i.id = $1) AS card,
                    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM item_relations r
                     WHERE $2 IN (r.item_a, r.item_b) OR $3 IN (r.item_a, r.item_b)) AS edges`,
              [cardId, transcriptId, eventId],
            );
          const beforeState = await snapshot();
          let firstWriteObserved = false;
          await expect(
            withTransaction(runtime, async (client) => {
              const descriptor = Object.getOwnPropertyDescriptor(client, "query");
              /* eslint-disable @typescript-eslint/unbound-method */
              const query = client.query;
              const pending: Promise<unknown>[] = [];
              client.query = new Proxy(query, {
                apply(target, receiver, args: unknown[]) {
                  const result: unknown = Reflect.apply(target, receiver, args);
                  if (typeof args[0] !== "string" || !args[0].includes("INSERT INTO item_relations")) return result;
                  const values = args[1];
                  if (!Array.isArray(values) || !values.includes(transcriptId) || !values.includes(aliceId))
                    return result;
                  const observed = Promise.resolve(result).then((actual: unknown) => {
                    const parsed = z.object({ rowCount: z.number().nullable() }).parse(actual);
                    firstWriteObserved = parsed.rowCount === 1;
                    return actual;
                  });
                  pending.push(observed);
                  return observed;
                },
              });
              /* eslint-enable @typescript-eslint/unbound-method */
              const outcome = await confirmProposalWithClient(
                client,
                { processingProposalsDatabaseId: proposalsId },
                cardId,
              ).then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
              await Promise.allSettled(pending);
              let restoration: { error: unknown } | undefined;
              try {
                if (descriptor) Object.defineProperty(client, "query", descriptor);
                else if (!Reflect.deleteProperty(client, "query")) throw new Error("Cannot restore query descriptor");
              } catch (error) {
                restoration = { error };
              }
              if (!outcome.ok && restoration)
                throw new AggregateError(
                  [outcome.error, restoration.error],
                  "Confirmation and observer cleanup failed",
                  { cause: outcome.error },
                );
              if (!outcome.ok) throw outcome.error;
              if (restoration) throw restoration.error;
              return outcome.value;
            }),
          ).rejects.toMatchObject({ status: 400 });
          expect(firstWriteObserved).toBe(true);
          const after = await runtime.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM item_relations WHERE $1 IN (item_a,item_b) AND $2 IN (item_a,item_b)",
            [transcriptId, aliceId],
          );
          expect(after.rows).toEqual(before.rows);
          expect((await snapshot()).rows).toEqual(beforeState.rows);
          const card = await runtime.query<{ status: string }>(
            "SELECT properties->>'status' AS status FROM items WHERE database_id = $1 AND id = $2",
            [proposalsId, cardId],
          );
          expect(card.rows).toEqual([{ status: "proposed" }]);
        });
      } finally {
        await runtime.end();
      }
    });

    it("confirm writes the user-owned mapping with its speaker key, and a retry writes nothing more", async () => {
      const cardId = await onlyCardId();

      const confirmed = await confirm(cardId);
      await confirm(cardId);

      expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: aliceId, resultLabel: "Alice" });
      expect(await mappedPersonIds()).toEqual([null, aliceId]);
      // Only the `speakers` relation: the transcript also holds Alice in `people`, inherited from its Event (issue #1697).
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
