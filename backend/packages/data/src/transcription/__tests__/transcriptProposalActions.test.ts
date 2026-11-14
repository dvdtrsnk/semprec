import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import "../../domainWriteHooks.js";
import {
  getTestPool,
  getTenantZeroId,
  inTenantZero,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { insertValueLink, listValueLinksByItemIds } from "../../chokePoint/valueLinksStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { appendHistoryEntry, type ProposalEnvelope } from "../../inbox/inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../../inbox/proposalActions.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";
import { proposeSpeakerMappings } from "../transcriptSpeakerSuggestion.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { getSystemSettingsDatabaseId } from "../../systemSettings.js";
import { ValidationError } from "../../errors.js";

let pool: Pool;

const RECORDING_START = "2024-03-01T12:00:00.000Z";

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

describe("Transcript proposal confirm/revise (issue #184)", () => {
  let transcriptsId: string;
  let eventsId: string;
  let proposalsId: string;
  let tasksId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
    eventsId = await databaseIdFor("events");
    proposalsId = await databaseIdFor("processingProposals");
    tasksId = await databaseIdFor("tasks");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTranscript(name = "Weekly sync"): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name, date: RECORDING_START } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    );
    return item.id;
  }

  async function createItem(databaseId: string, name: string): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId, properties: { name } }),
    );
    return item.id;
  }

  /**
   * An existing Event on the recording's day. Its create needs a `date` (issue #1663); with no type and no start it is
   * never a match candidate, as the date-less Events of these scenarios were not.
   */
  async function existingEvent(name: string): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: eventsId, properties: { name, date: "2024-03-01" } }),
    );
    return item.id;
  }

  /** A `kind = 'transcript'` card as the match step emits it: no Event in the window, so a create-Event proposal. */
  async function createTranscriptCard(): Promise<{ transcriptId: string; cardId: string }> {
    const transcriptId = await createTranscript();
    await withTransaction(pool, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds: 3600 }));
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
      [proposalsId],
    );
    if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one transcript card, found ${rows.length}`);
    return { transcriptId, cardId: rows[0].id };
  }

  async function linkTranscriptToEvent(transcriptId: string, eventId: string): Promise<void> {
    const relationPropertyId = await propertyIdFor(transcriptsId, "event");
    await withTransaction(pool, (client) =>
      createRelationWithClient(client, { relationPropertyId, callerItemId: transcriptId, targetItemId: eventId }),
    );
  }

  /**
   * Confirms inside tenant zero: a confirmed Event with a project writes an Events `project` edge, a link-rule
   * source (issue #1697), and that write queues a propagation job, which needs a tenant scope.
   */
  function confirm(cardId: string) {
    return inTenantZero(() =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
      ),
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

  function linkExisting(eventId: string): ProposalEnvelope {
    return { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } };
  }

  /** The create-Event envelope the match step proposes: the recording's date in the tenant zone, date-only. */
  function createEvent(name = "Weekly sync"): ProposalEnvelope {
    return { entityKind: "database", target: eventsId, properties: { name, type: "meeting", date: "2024-03-01" } };
  }

  /** The new-meeting envelope the match step proposes for the recording of these scenarios: named after the transcript, 13:00-14:00 Prague time. */
  function newMeeting(): ProposalEnvelope {
    return {
      entityKind: "database",
      target: eventsId,
      properties: { name: "Weekly sync", type: "meeting", date: "2024-03-01", timeFrom: "13:00", timeTo: "14:00" },
    };
  }

  /** Every Transcripts <-> Events edge, as `{ transcriptId, eventId }` pairs. */
  async function transcriptEventEdges(): Promise<Array<{ transcriptId: string; eventId: string }>> {
    const eventPropertyId = await propertyIdFor(transcriptsId, "event");
    const transcriptPropertyId = await propertyIdFor(eventsId, "transcript");
    const { rows } = await pool.query<{ item_a: string; item_b: string; a_is_transcript: boolean }>(
      `SELECT r.item_a, r.item_b, d.property_id_a = $1 AS a_is_transcript
       FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE d.property_id_a IN ($1, $2) OR d.property_id_b IN ($1, $2)`,
      [eventPropertyId, transcriptPropertyId],
    );
    return rows.map((row) =>
      row.a_is_transcript
        ? { transcriptId: row.item_a, eventId: row.item_b }
        : { transcriptId: row.item_b, eventId: row.item_a },
    );
  }

  async function eventIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [eventsId],
    );
    return rows.map((row) => row.id);
  }

  async function cardProperties(cardId: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE id = $1",
      [cardId],
    );
    if (!rows[0]) throw new Error(`Card ${cardId} not found`);
    return rows[0].properties;
  }

  /**
   * Makes the card one written before `referencedItemIds` existed, so the trash of its project does not invalidate it (issue
   * #1916) and the test reaches the confirm's own validation of its targets. No current writer produces that state.
   */
  async function forgetReferencedItems(cardId: string): Promise<void> {
    await pool.query("UPDATE items SET properties = properties - 'referencedItemIds' WHERE id = $1", [cardId]);
  }

  describe("confirm", () => {
    it.each(["create Event", "link existing Event"] as const)(
      "attributes changed transcript event link during %s confirmation and rollback",
      async (mode) => {
        const { transcriptId, cardId } = await createTranscriptCard();
        const existingId = mode === "link existing Event" ? await existingEvent("Planning") : undefined;
        if (existingId) await revise(cardId, linkExisting(existingId));
        const eventsBefore = await eventIds();
        await withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: transcriptId,
            propertyKey: "event",
            ruleKey: "test",
            sources: [],
          }),
        );
        const actorId = randomUUID();
        const events: InvalidationEvent[] = [];
        setInvalidationHook((event) => events.push(event));
        try {
          const failure = new Error("rollback transcript confirmation");
          await expect(
            withTransaction(pool, async (client) => {
              await confirmProposalWithClient(
                client,
                { processingProposalsDatabaseId: proposalsId },
                cardId,
                undefined,
                actorId,
              );
              expect(events).toEqual([]);
              throw failure;
            }),
          ).rejects.toBe(failure);
          expect(events).toEqual([]);
          expect(
            (await withTransaction(pool, (client) => listValueLinksByItemIds(client, [transcriptId])))[0]?.state,
          ).toBe("on");
          expect(await transcriptEventEdges()).toEqual([]);
          expect(await eventIds()).toEqual(eventsBefore);
          expect((await cardProperties(cardId)).status).toBe("proposed");
          const confirmed = await withTransaction(pool, (client) =>
            confirmProposalWithClient(
              client,
              { processingProposalsDatabaseId: proposalsId },
              cardId,
              undefined,
              actorId,
            ),
          );
          const eventId = confirmed.properties.resultItemId;
          if (typeof eventId !== "string") throw new Error("Missing confirmed Event ID");
          if (existingId) {
            expect(eventId).toBe(existingId);
            expect(await eventIds()).toEqual(eventsBefore);
          } else {
            expect(await eventIds()).toEqual([...eventsBefore, eventId].sort());
          }
          expect((await cardProperties(cardId)).status).toBe("confirmed");
          expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
          expect(
            (await withTransaction(pool, (client) => listValueLinksByItemIds(client, [transcriptId])))[0],
          ).toMatchObject({ state: "broken", brokenBy: "user" });
          expect(events.filter((event) => event.scope === "item" && event.itemId === transcriptId)).toEqual([
            expect.objectContaining({ userId: actorId }),
          ]);
          events.length = 0;
          await confirm(cardId);
          expect(events).toEqual([]);
        } finally {
          setInvalidationHook(() => {});
        }
      },
    );

    it("attributes a proposed speaker mapping and rolls back before commit", async () => {
      const transcriptId = await createTranscript("Speaker fixture");
      const peopleId = await databaseIdFor("people");
      const personId = await createItem(peopleId, "Alice");
      const eventId = await existingEvent("Meeting");
      // In tenant zero: the Events `people` edge is a link-rule source (issue #1697), so its write queues a
      // propagation job, which needs a tenant scope.
      await inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await writeComputed(client, transcriptsId, transcriptId, "segments", [
            { speaker: "SPEAKER_01", text: "Hello", startsAt: 0, endsAt: 1 },
          ]);
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(eventsId, "people"),
            callerItemId: eventId,
            targetItemId: personId,
          });
          await createRelationWithClient(client, {
            relationPropertyId: await propertyIdFor(transcriptsId, "event"),
            callerItemId: transcriptId,
            targetItemId: eventId,
          });
          await proposeSpeakerMappings(client, {
            transcriptId,
            suggestions: [{ speaker: "SPEAKER_01", personId, reason: "Recognized from the discussion" }],
          });
          await insertValueLink(client, {
            itemId: transcriptId,
            propertyKey: "speakers",
            ruleKey: "test",
            sources: [],
          });
        }),
      );
      const cards = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
        [proposalsId],
      );
      if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Missing speaker proposal");
      const cardId = cards.rows[0].id;
      // Only the `speakers` relation and link: linking the Event also gave the transcript the person in `people`,
      // with links for `people` and `project` (issue #1697).
      const speakersPropertyId = await propertyIdFor(transcriptsId, "speakers");
      const speakerEdges = () =>
        withTenantTransaction(pool, getTenantZeroId(), (client) =>
          client.query<{ metadata: unknown }>(
            `SELECT r.metadata FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
             WHERE $1 IN (r.item_a, r.item_b) AND $2 IN (r.item_a, r.item_b) AND r.tenant_id = $3 AND d.property_id_a = $4`,
            [transcriptId, personId, getTenantZeroId(), speakersPropertyId],
          ),
        );
      const speakersLink = async () =>
        (await withTransaction(pool, (client) => listValueLinksByItemIds(client, [transcriptId]))).find(
          (link) => link.propertyKey === "speakers",
        );
      const beforeEdges = (await speakerEdges()).rows;
      expect(beforeEdges).toEqual([]);
      const actorId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        const failure = new Error("rollback speaker confirmation");
        await expect(
          withTransaction(pool, async (client) => {
            await confirmProposalWithClient(
              client,
              { processingProposalsDatabaseId: proposalsId },
              cardId,
              undefined,
              actorId,
            );
            expect(events).toEqual([]);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(events).toEqual([]);
        expect((await speakersLink())?.state).toBe("on");
        expect((await cardProperties(cardId)).status).toBe("proposed");
        expect((await speakerEdges()).rows).toEqual(beforeEdges);
        await withTransaction(pool, (client) =>
          confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, undefined, actorId),
        );
        expect((await speakerEdges()).rows).toEqual([{ metadata: { speaker: "SPEAKER_01" } }]);
        expect(await speakersLink()).toMatchObject({ state: "broken", brokenBy: "user" });
        expect(events.filter((event) => event.scope === "item" && event.itemId === transcriptId)).toEqual([
          expect.objectContaining({ userId: actorId }),
        ]);
        events.length = 0;
        await confirm(cardId);
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    it("keeps a clarification card's speaker role and creates its Person and edge atomically", async () => {
      const transcriptId = await createTranscript("Unidentified speaker");
      const peopleId = await databaseIdFor("people");
      const alternativeId = await createItem(peopleId, "Alternative Person");
      await withTransaction(pool, async (client) => {
        await setSelfPersonId(client, alternativeId);
        await writeComputed(client, transcriptsId, transcriptId, "segments", [
          { speaker: "SPEAKER_01", text: "A real recorded sentence", startsAt: 0, endsAt: 2 },
        ]);
        await proposeSpeakerMappings(client, { transcriptId, suggestions: [] });
      });
      const cards = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
        [proposalsId],
      );
      if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Missing clarification card");
      const cardId = cards.rows[0].id;
      expect(await cardProperties(cardId)).toMatchObject({
        status: "needsClarification",
        proposal: null,
        context: { alternatives: expect.arrayContaining([expect.objectContaining({ personId: alternativeId })]) },
      });
      await expect(revise(cardId, createEvent())).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "entityKind" },
      });
      await revise(cardId, {
        entityKind: "relation",
        target: alternativeId,
        properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } },
      });
      expect(await cardProperties(cardId)).toMatchObject({
        status: "proposed",
        proposal: { entityKind: "relation", target: alternativeId },
      });
      await revise(cardId, { entityKind: "database", target: peopleId, properties: { name: "New Person" } });
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: cardId,
            propertiesPatch: { proposal: createEvent() },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      );
      await expect(confirm(cardId)).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "entityKind" },
      });
      await revise(cardId, { entityKind: "database", target: peopleId, properties: { name: "New Person" } });
      const before = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
        [peopleId],
      );
      const failure = new Error("rollback new person confirmation");
      await expect(
        withTransaction(pool, async (client) => {
          await confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(
        (
          await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL", [
            peopleId,
          ])
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM item_relations r JOIN items p ON p.database_id = $1 AND p.id IN (r.item_a, r.item_b) WHERE $2 IN (r.item_a, r.item_b)",
            [peopleId, transcriptId],
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect((await cardProperties(cardId)).status).toBe("proposed");
      const confirmed = await confirm(cardId);
      const personId = confirmed.properties.resultItemId;
      if (typeof personId !== "string") throw new Error("Missing created person");
      const edges = await pool.query<{ metadata: unknown }>(
        "SELECT metadata FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)",
        [transcriptId, personId],
      );
      expect(edges.rows).toEqual([{ metadata: { speaker: "SPEAKER_01" } }]);
      expect((await cardProperties(cardId)).status).toBe("confirmed");
    });

    it("confirms an Event, its project, and transcript edge together, and rolls back an invalid project", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const projectsId = await databaseIdFor("projects");
      const staleProjectId = await createItem(projectsId, "Deleted project");
      const eventsBefore = await eventIds();
      await revise(cardId, { ...createEvent(), relations: { project: [staleProjectId] } });
      await forgetReferencedItems(cardId);
      await createChokePoint(pool).softDeleteItem(projectsId, staleProjectId);
      await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, code: "validation_failed" });
      expect(await eventIds()).toEqual(eventsBefore);
      expect(await transcriptEventEdges()).toEqual([]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
      const projectId = await createItem(projectsId, "Project");
      await revise(cardId, { ...createEvent(), relations: { project: [projectId] } });
      const confirmed = await confirm(cardId);
      const eventId = confirmed.properties.resultItemId;
      if (typeof eventId !== "string") throw new Error("Missing confirmed Event");
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
      const projectEdges = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)",
        [eventId, projectId],
      );
      expect(projectEdges.rows[0]?.count).toBe("1");
    });

    it("creates the Event and the Transcription<->Event edge for a create-Event card", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();

      const confirmed = await confirm(cardId);

      const [eventId] = await eventIds();
      expect(await eventIds()).toHaveLength(1);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
      expect(confirmed.properties).toMatchObject({
        status: "confirmed",
        resultItemId: eventId,
        resultLabel: "Weekly sync",
      });
    });

    it("writes the relation to the existing Event for a link-existing card and creates no Event", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      await revise(cardId, linkExisting(eventId));

      const confirmed = await confirm(cardId);

      expect(await eventIds()).toEqual([eventId]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
      expect(confirmed.properties).toMatchObject({
        status: "confirmed",
        resultItemId: eventId,
        resultLabel: "Planning",
      });
    });

    it("leaves neither the Event nor an edge when the edge write fails for a create-Event card", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const otherEventId = await existingEvent("Linked meanwhile");
      await linkTranscriptToEvent(transcriptId, otherEventId);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "cardinality_violation" });

      expect(await eventIds()).toEqual([otherEventId]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId: otherEventId }]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });

    it("leaves no edge and the card proposed when the transcript is already linked to another Event", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const otherEventId = await existingEvent("Linked meanwhile");
      await linkTranscriptToEvent(transcriptId, otherEventId);
      const eventId = await existingEvent("Planning");
      await revise(cardId, linkExisting(eventId));

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "cardinality_violation" });

      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId: otherEventId }]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });

    it("links a card's transcript to an Event that already holds another transcript (issue #1464)", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      const otherTranscriptId = await createTranscript("Another recording");
      await linkTranscriptToEvent(otherTranscriptId, eventId);
      await revise(cardId, linkExisting(eventId));

      const confirmed = await confirm(cardId);

      expect(await eventIds()).toEqual([eventId]);
      const edges = await transcriptEventEdges();
      expect(edges).toHaveLength(2);
      expect(edges).toEqual(
        expect.arrayContaining([
          { transcriptId: otherTranscriptId, eventId },
          { transcriptId, eventId },
        ]),
      );
      expect(confirmed.properties).toMatchObject({
        status: "confirmed",
        resultItemId: eventId,
        resultLabel: "Planning",
      });
    });

    it("is idempotent under retry for a create-Event card: no second Event or edge", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();

      const first = await confirm(cardId);
      const second = await confirm(cardId);

      expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
      expect(await eventIds()).toHaveLength(1);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId: first.properties.resultItemId }]);
    });

    it("is idempotent under retry for a link-existing card: no second edge", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      await revise(cardId, linkExisting(eventId));

      await confirm(cardId);
      const second = await confirm(cardId);

      expect(second.properties.resultItemId).toBe(eventId);
      expect(await eventIds()).toEqual([eventId]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
    });

    it("re-checks a stored link-existing envelope: an Events database archived after the revise is refused", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      await revise(cardId, linkExisting(eventId));
      await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [eventsId]);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "database_archived" });

      expect(await transcriptEventEdges()).toEqual([]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });
  });

  describe("the proposed meeting (issue #1818)", () => {
    /** 14 October 2024, 13:52 in Prague (summer time), 47:10 long. */
    const MEETING_START = "2024-10-14T11:52:00.000Z";
    const MEETING_SECONDS = 47 * 60 + 10;
    const SPEAKERS = ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02", "SPEAKER_03"];

    async function createPerson(name: string): Promise<string> {
      return createItem(await databaseIdFor("people"), name);
    }

    /** A recording of `MEETING_START` with the diarized `SPEAKERS`, matched to a new-meeting card. */
    async function createRecordedCard(): Promise<{ transcriptId: string; cardId: string }> {
      const transcript = await withTransaction(pool, async (client) => {
        const item = await createItemWithClient(
          client,
          { databaseId: transcriptsId, properties: { date: MEETING_START } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await writeComputed(
          client,
          transcriptsId,
          item.id,
          "segments",
          SPEAKERS.map((speaker, index) => ({
            speaker,
            text: "A recorded sentence",
            startsAt: index,
            endsAt: index + 1,
          })),
        );
        return item;
      });
      expect(
        await withTransaction(pool, (client) =>
          matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: MEETING_SECONDS }),
        ),
      ).toBe("suggested");
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
        [proposalsId],
      );
      if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one transcript card, found ${rows.length}`);
      return { transcriptId: transcript.id, cardId: rows[0].id };
    }

    /** Maps `speaker` of the transcript to `personId`, as a confirmed speaker card would. */
    async function mapSpeaker(transcriptId: string, speaker: string, personId: string): Promise<void> {
      const relationPropertyId = await propertyIdFor(transcriptsId, "speakers");
      await inTenantZero(() =>
        withTransaction(pool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId,
            callerItemId: transcriptId,
            targetItemId: personId,
            metadata: { speaker },
          }),
        ),
      );
    }

    /** The people on the Events `people` edges of `eventId`, sorted by id. */
    async function participantIds(eventId: string): Promise<string[]> {
      const { rows } = await pool.query<{ other: string }>(
        `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
         FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         WHERE $1 IN (r.item_a, r.item_b) AND (d.property_id_a = $2 OR d.property_id_b = $2)
         ORDER BY 1`,
        [eventId, await propertyIdFor(eventsId, "people")],
      );
      return rows.map((row) => row.other);
    }

    /** Every Events `people` edge, whichever Event it belongs to. */
    async function participantEdgeCount(): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         WHERE d.property_id_a = $1 OR d.property_id_b = $1`,
        [await propertyIdFor(eventsId, "people")],
      );
      return Number(rows[0]?.count);
    }

    async function confirmedEventId(cardId: string): Promise<string> {
      const confirmed = await confirm(cardId);
      const eventId = confirmed.properties.resultItemId;
      if (typeof eventId !== "string") throw new Error("Missing confirmed Event");
      return eventId;
    }

    async function eventProperties(eventId: string): Promise<Record<string, unknown>> {
      const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE id = $1",
        [eventId],
      );
      if (!rows[0]) throw new Error(`Event ${eventId} not found`);
      return rows[0].properties;
    }

    it("writes the Event with its wall-clock times, the project, the mapped speakers without the own person and the transcript edge together", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const projectId = await createItem(await databaseIdFor("projects"), "Apollo");
      const [alice, bob, me] = [await createPerson("Alice"), await createPerson("Bob"), await createPerson("Me")];
      await mapSpeaker(transcriptId, "SPEAKER_00", alice);
      await mapSpeaker(transcriptId, "SPEAKER_01", bob);
      await mapSpeaker(transcriptId, "SPEAKER_02", me);
      await withTransaction(pool, (client) => setSelfPersonId(client, me));
      // SPEAKER_03 stays unmapped. The project comes from the user's revise: the match step proposes none.
      const proposal = (await cardProperties(cardId)).proposal as ProposalEnvelope;
      await revise(cardId, { ...proposal, relations: { project: [projectId] } });

      const eventId = await confirmedEventId(cardId);

      expect(await eventProperties(eventId)).toMatchObject({
        name: "Schůzka 14. 10.",
        type: "meeting",
        date: "2024-10-14",
        timeFrom: "13:52",
        timeTo: "14:39",
      });
      expect(await eventProperties(eventId)).not.toHaveProperty("endDate");
      expect(await eventIds()).toEqual([eventId]);
      expect(await participantIds(eventId)).toEqual([alice, bob].sort());
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
      const projectEdges = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM item_relations WHERE $1 IN (item_a, item_b) AND $2 IN (item_a, item_b)",
        [eventId, projectId],
      );
      expect(projectEdges.rows[0]?.count).toBe("1");
      expect((await cardProperties(cardId)).status).toBe("confirmed");
    });

    it("sets the Event's endDate to the next day for a recording that crosses local midnight", async () => {
      const transcriptId = await createTranscript("Late call");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: transcriptsId, itemId: transcriptId, propertiesPatch: { date: "2024-10-14T21:50:00.000Z" } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        ),
      );
      await withTransaction(pool, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds: 1800 }));
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
        [proposalsId],
      );

      const eventId = await confirmedEventId(rows[0]?.id ?? "");

      expect(await eventProperties(eventId)).toMatchObject({
        date: "2024-10-14",
        timeFrom: "23:50",
        timeTo: "00:20",
        endDate: "2024-10-15",
      });
    });

    it("adds no participant when no speaker is mapped, and the confirm still succeeds", async () => {
      const { transcriptId, cardId } = await createRecordedCard();

      const eventId = await confirmedEventId(cardId);

      expect(await participantIds(eventId)).toEqual([]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
    });

    it("adds no participant when the only mapped speaker is the own person", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const me = await createPerson("Me");
      await mapSpeaker(transcriptId, "SPEAKER_00", me);
      await withTransaction(pool, (client) => setSelfPersonId(client, me));

      const eventId = await confirmedEventId(cardId);

      expect(await participantIds(eventId)).toEqual([]);
    });

    it("adds a person mapped to two speakers once", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const alice = await createPerson("Alice");
      await mapSpeaker(transcriptId, "SPEAKER_00", alice);
      await mapSpeaker(transcriptId, "SPEAKER_03", alice);

      const eventId = await confirmedEventId(cardId);

      expect(await participantIds(eventId)).toEqual([alice]);
    });

    it("does not add a mapped person who is in the Trash", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const alice = await createPerson("Alice");
      const bob = await createPerson("Bob");
      await mapSpeaker(transcriptId, "SPEAKER_00", alice);
      await mapSpeaker(transcriptId, "SPEAKER_01", bob);
      await createChokePoint(pool).softDeleteItem(await databaseIdFor("people"), alice);

      const eventId = await confirmedEventId(cardId);

      expect(await participantIds(eventId)).toEqual([bob]);
    });

    it("records the participant edges in person id order, whatever the order of the speakers", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const people = [
        await createPerson("Alice"),
        await createPerson("Bob"),
        await createPerson("Carol"),
        await createPerson("Dan"),
      ];
      // Mapped in descending id order, so the speakers list the people from the largest id down.
      const descending = [...people].sort().reverse();
      for (const [index, personId] of descending.entries()) await mapSpeaker(transcriptId, SPEAKERS[index]!, personId);

      await confirmedEventId(cardId);

      const history = z
        .array(z.object({ addedRelations: z.array(z.object({ targetItemId: z.string() })).optional() }))
        .parse((await cardProperties(cardId)).history);
      expect(history.at(-1)?.addedRelations?.map((edge) => edge.targetItemId)).toEqual([...people].sort());
    });

    it("reads the speakers under the transcript's lock, so an assignment that is still open is not lost", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const alice = await createPerson("Alice");
      const relationPropertyId = await propertyIdFor(transcriptsId, "speakers");
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markAssigned: () => void = () => undefined;
      const assigned = new Promise<void>((resolve) => {
        markAssigned = resolve;
      });
      // A manual assignment that has written its speakers edge, holds the transcript's lock and has not committed.
      const assignment = inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await createRelationWithClient(client, {
            relationPropertyId,
            callerItemId: transcriptId,
            targetItemId: alice,
            metadata: { speaker: "SPEAKER_00" },
          });
          markAssigned();
          await gate;
        }),
      );
      try {
        await Promise.race([assigned, assignment]);
        const confirming = confirm(cardId);
        await waitUntilABackendWaitsForALock();
        release();
        await assignment;
        const confirmed = await confirming;

        const eventId = confirmed.properties.resultItemId;
        if (typeof eventId !== "string") throw new Error("Missing confirmed Event");
        expect(await participantIds(eventId)).toEqual([alice]);
      } finally {
        release();
        await assignment.catch(() => undefined);
      }
    });

    /** Polls `pg_stat_activity` until a statement of this database waits for a lock, so the overlap is not timed by a sleep. */
    async function waitUntilABackendWaitsForALock(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        );
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("No statement waited for a lock");
    }

    it("writes nothing and answers 400 validation_failed when the project no longer exists", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const projectsId = await databaseIdFor("projects");
      const staleProjectId = await createItem(projectsId, "Deleted project");
      await mapSpeaker(transcriptId, "SPEAKER_00", await createPerson("Alice"));
      const proposal = (await cardProperties(cardId)).proposal as ProposalEnvelope;
      await revise(cardId, { ...proposal, relations: { project: [staleProjectId] } });
      await forgetReferencedItems(cardId);
      await createChokePoint(pool).softDeleteItem(projectsId, staleProjectId);

      await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, code: "validation_failed" });

      expect(await eventIds()).toEqual([]);
      expect(await participantEdgeCount()).toBe(0);
      expect(await transcriptEventEdges()).toEqual([]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });

    it("writes neither the Event nor a participant when the transcript edge fails", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      await mapSpeaker(transcriptId, "SPEAKER_00", await createPerson("Alice"));
      const otherEventId = await existingEvent("Linked meanwhile");
      await linkTranscriptToEvent(transcriptId, otherEventId);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "cardinality_violation" });

      expect(await eventIds()).toEqual([otherEventId]);
      expect(await participantEdgeCount()).toBe(0);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });

    it("adds the participants once when the confirm is run twice", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      const alice = await createPerson("Alice");
      await mapSpeaker(transcriptId, "SPEAKER_00", alice);

      const eventId = await confirmedEventId(cardId);
      const second = await confirm(cardId);

      expect(second.properties.resultItemId).toBe(eventId);
      expect(await eventIds()).toEqual([eventId]);
      expect(await participantIds(eventId)).toEqual([alice]);
      expect(await participantEdgeCount()).toBe(1);
    });

    it("adds no participant to an existing Event that a link-existing card confirms", async () => {
      const { transcriptId, cardId } = await createRecordedCard();
      await mapSpeaker(transcriptId, "SPEAKER_00", await createPerson("Alice"));
      const eventId = await existingEvent("Planning");
      await revise(cardId, linkExisting(eventId));

      await confirm(cardId);

      expect(await participantIds(eventId)).toEqual([]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
    });

    describe("revise", () => {
      it("accepts a revised end on the next day that carries an endDate", async () => {
        const { cardId } = await createRecordedCard();
        const proposal = (await cardProperties(cardId)).proposal as ProposalEnvelope;

        const revised = await revise(cardId, {
          ...proposal,
          properties: { ...proposal.properties, timeFrom: "23:30", timeTo: "00:20", endDate: "2024-10-15" },
        });

        expect(revised.properties.proposal).toMatchObject({
          properties: { timeFrom: "23:30", timeTo: "00:20", endDate: "2024-10-15" },
        });
      });

      it.each([
        ["a timeTo that is not after the timeFrom on a single day", { timeFrom: "14:00", timeTo: "13:00" }, "timeTo"],
        ["a timeTo without a timeFrom", { timeFrom: null, timeTo: "13:00" }, "timeTo"],
        ["an endDate before the date", { endDate: "2024-10-13" }, "endDate"],
        ["a time that is not HH:MM", { timeFrom: "noon" }, "timeFrom"],
      ])("refuses %s with validation_failed and keeps the card as it was", async (_label, patch, field) => {
        const { cardId } = await createRecordedCard();
        const before = await cardProperties(cardId);
        const proposal = before.proposal as ProposalEnvelope;

        await expect(
          revise(cardId, { ...proposal, properties: { ...proposal.properties, ...patch } }),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });

        expect((await cardProperties(cardId)).proposal).toEqual(before.proposal);
      });

      it("refuses a revised Event without a date", async () => {
        const { cardId } = await createRecordedCard();
        const proposal = (await cardProperties(cardId)).proposal as ProposalEnvelope;
        const { date: _date, ...withoutDate } = proposal.properties;

        await expect(revise(cardId, { ...proposal, properties: withoutDate })).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "date" },
        });
      });

      it("reads a revised date that carries an offset in the tenant zone, as the Event write does", async () => {
        const { cardId } = await createRecordedCard();
        const proposal = (await cardProperties(cardId)).proposal as ProposalEnvelope;
        const { timeFrom: _from, timeTo: _to, ...bare } = proposal.properties;
        await revise(cardId, { ...proposal, properties: { ...bare, date: MEETING_START } });

        const eventId = await confirmedEventId(cardId);

        expect(await eventProperties(eventId)).toMatchObject({
          date: "2024-10-14",
          timeFrom: "13:52",
          timeTo: "14:52",
        });
      });

      describe("an invalid stored tenant time zone", () => {
        /** Raw SQL: the settings write refuses an invalid zone, so only a corrupted settings row holds one. */
        async function corruptTenantZone(): Promise<void> {
          const settingsDatabaseId = await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client));
          const result = await pool.query(
            `UPDATE items SET properties = properties || '{"timezone": "Not/AZone"}'::jsonb WHERE database_id = $1`,
            [settingsDatabaseId],
          );
          expect(result.rowCount).toBe(1);
        }

        function expectSettingsFailure(failure: unknown): void {
          expect(failure).toBeInstanceOf(Error);
          expect(failure).not.toBeInstanceOf(ValidationError);
          if (!(failure instanceof Error)) return;
          expect(failure.message).toBe("The tenant time zone setting is invalid");
          expect(failure.cause).toBeInstanceOf(ValidationError);
          expect(failure.cause).toMatchObject({ details: { field: "timezone" } });
        }

        async function withOffsetDate(cardId: string): Promise<ProposalEnvelope> {
          const proposal = (await cardProperties(cardId)).proposal as ProposalEnvelope;
          const { timeFrom: _from, timeTo: _to, ...bare } = proposal.properties;
          return { ...proposal, properties: { ...bare, date: MEETING_START } };
        }

        it("propagates from the revise of a date with an offset as a settings failure, not as a 400 on the date", async () => {
          const { cardId } = await createRecordedCard();
          const before = await cardProperties(cardId);
          const envelope = await withOffsetDate(cardId);
          await corruptTenantZone();

          const failure = await revise(cardId, envelope).then(
            () => null,
            (error: unknown) => error,
          );

          expectSettingsFailure(failure);
          expect((await cardProperties(cardId)).proposal).toEqual(before.proposal);
        });

        it("propagates from the confirm of a stored date with an offset and writes nothing", async () => {
          const { cardId } = await createRecordedCard();
          await revise(cardId, await withOffsetDate(cardId));
          await corruptTenantZone();

          const failure = await confirm(cardId).then(
            () => null,
            (error: unknown) => error,
          );

          expectSettingsFailure(failure);
          expect(await eventIds()).toEqual([]);
          expect((await cardProperties(cardId)).status).toBe("proposed");
        });
      });

      it("refuses a project that does not exist and keeps the card as it was", async () => {
        const { cardId } = await createRecordedCard();
        const before = await cardProperties(cardId);
        const projectsId = await databaseIdFor("projects");
        const staleProjectId = await createItem(projectsId, "Deleted project");
        await createChokePoint(pool).softDeleteItem(projectsId, staleProjectId);
        const proposal = before.proposal as ProposalEnvelope;

        await expect(revise(cardId, { ...proposal, relations: { project: [staleProjectId] } })).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
        });

        expect((await cardProperties(cardId)).proposal).toEqual(before.proposal);
      });
    });
  });

  describe("revise", () => {
    it("replaces the whole proposal, so flipping create -> link -> create and confirming yields one edge", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const existingEventId = await existingEvent("Planning");

      const linked = await revise(cardId, linkExisting(existingEventId));
      expect(linked.properties.proposal).toEqual(linkExisting(existingEventId));
      const recreated = await revise(cardId, createEvent("Retro"));
      expect(recreated.properties.proposal).toEqual(createEvent("Retro"));

      const confirmed = await confirm(cardId);

      const newEventId = confirmed.properties.resultItemId;
      expect(newEventId).not.toBe(existingEventId);
      expect(await eventIds()).toHaveLength(2);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId: newEventId }]);
    });

    it("flips link -> create -> link and confirming yields one edge to the linked Event", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const firstEventId = await existingEvent("Planning");
      const secondEventId = await existingEvent("Retro");

      await revise(cardId, linkExisting(firstEventId));
      await revise(cardId, createEvent());
      await revise(cardId, linkExisting(secondEventId));
      await confirm(cardId);

      expect(await eventIds()).toHaveLength(2);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId: secondEventId }]);
    });

    it("rejects a link target in the wrong database with validation_failed", async () => {
      const { cardId } = await createTranscriptCard();
      const taskId = await createItem(tasksId, "Not an Event");

      await expect(revise(cardId, linkExisting(taskId))).rejects.toMatchObject({ code: "validation_failed" });
      expect((await cardProperties(cardId)).proposal).toEqual(newMeeting());
    });

    it("rejects a link into an archived database with database_archived", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [eventsId]);

      await expect(revise(cardId, linkExisting(eventId))).rejects.toMatchObject({ code: "database_archived" });
    });

    it("rejects a link through a relation the user may not write with owner_violation", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      await pool.query("UPDATE properties SET owner = 'system', owner_process = 'someProcess' WHERE id = $1", [
        await propertyIdFor(transcriptsId, "event"),
      ]);

      await expect(revise(cardId, linkExisting(eventId))).rejects.toMatchObject({ code: "owner_violation" });
    });

    it("rejects a link through any relation other than the transcript's 'event' or 'speakers'", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");

      await expect(
        revise(cardId, { entityKind: "relation", target: eventId, properties: { propertyKey: "people" } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "properties" } });
    });

    it("refuses to turn an Event card into a speaker mapping", async () => {
      const { cardId } = await createTranscriptCard();
      const personId = await createItem(await databaseIdFor("people"), "Alice");

      await expect(
        revise(cardId, {
          entityKind: "relation",
          target: personId,
          properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_00" } },
        }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "entityKind" } });
    });

    it("rejects a relation envelope whose metadata is not an object", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");

      await expect(
        revise(cardId, { entityKind: "relation", target: eventId, properties: { propertyKey: "event", metadata: [] } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "properties" } });
    });

    it("rejects a relation envelope whose properties carry anything besides propertyKey and metadata", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");

      await expect(
        revise(cardId, { entityKind: "relation", target: eventId, properties: { propertyKey: "event", extra: 1 } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "properties" } });
    });

    it("rejects a create proposal targeting a database other than Events", async () => {
      const { cardId } = await createTranscriptCard();

      await expect(
        revise(cardId, { entityKind: "database", target: tasksId, properties: { name: "Task" } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "target" } });
    });

    it("rejects a pageContent proposal on a transcript card", async () => {
      const { cardId } = await createTranscriptCard();
      const pageId = await createItem(tasksId, "Some page");

      await expect(
        revise(cardId, { entityKind: "pageContent", target: pageId, properties: { flavour: "affine:paragraph" } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "entityKind" } });
    });

    it("rejects a relation proposal on a card that is not a transcript card", async () => {
      const eventId = await existingEvent("Planning");
      const inboxCard = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: proposalsId,
            properties: {
              kind: "inbox",
              proposal: createEvent(),
              history: appendHistoryEntry([], "Proposed."),
              status: "proposed",
            },
          },
          { allowedSystemKeys: ["kind", "proposal", "history", "status"] },
        ),
      );

      await expect(revise(inboxCard.id, linkExisting(eventId))).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "entityKind" },
      });
    });

    it("refuses to revise a confirmed transcript card", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await existingEvent("Planning");
      await confirm(cardId);

      await expect(revise(cardId, linkExisting(eventId))).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "status" },
      });
    });
  });
});
