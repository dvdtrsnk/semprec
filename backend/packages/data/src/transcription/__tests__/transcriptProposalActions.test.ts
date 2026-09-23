import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient, createRelationWithClient } from "../../chokePoint/chokePoint.js";
import { appendHistoryEntry, type ProposalEnvelope } from "../../inbox/inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../../inbox/proposalActions.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";

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

  function linkExisting(eventId: string): ProposalEnvelope {
    return { entityKind: "relation", target: eventId, properties: { propertyKey: "event" } };
  }

  function createEvent(name = "Weekly sync"): ProposalEnvelope {
    return { entityKind: "database", target: eventsId, properties: { name, type: "meeting", date: RECORDING_START } };
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

  describe("confirm", () => {
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
      const eventId = await createItem(eventsId, "Planning");
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
      const otherEventId = await createItem(eventsId, "Linked meanwhile");
      await linkTranscriptToEvent(transcriptId, otherEventId);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "cardinality_violation" });

      expect(await eventIds()).toEqual([otherEventId]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId: otherEventId }]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });

    it("leaves no edge and the card proposed when the relation write fails for a link-existing card", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const eventId = await createItem(eventsId, "Planning");
      await revise(cardId, linkExisting(eventId));
      const otherTranscriptId = await createTranscript("Another recording");
      await linkTranscriptToEvent(otherTranscriptId, eventId);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "cardinality_violation" });

      expect(await transcriptEventEdges()).toEqual([{ transcriptId: otherTranscriptId, eventId }]);
      expect(await transcriptEventEdges()).not.toContainEqual(expect.objectContaining({ transcriptId }));
      expect((await cardProperties(cardId)).status).toBe("proposed");
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
      const eventId = await createItem(eventsId, "Planning");
      await revise(cardId, linkExisting(eventId));

      await confirm(cardId);
      const second = await confirm(cardId);

      expect(second.properties.resultItemId).toBe(eventId);
      expect(await eventIds()).toEqual([eventId]);
      expect(await transcriptEventEdges()).toEqual([{ transcriptId, eventId }]);
    });

    it("re-checks a stored link-existing envelope: an Events database archived after the revise is refused", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await createItem(eventsId, "Planning");
      await revise(cardId, linkExisting(eventId));
      await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [eventsId]);

      await expect(confirm(cardId)).rejects.toMatchObject({ code: "database_archived" });

      expect(await transcriptEventEdges()).toEqual([]);
      expect((await cardProperties(cardId)).status).toBe("proposed");
    });
  });

  describe("revise", () => {
    it("replaces the whole proposal, so flipping create -> link -> create and confirming yields one edge", async () => {
      const { transcriptId, cardId } = await createTranscriptCard();
      const existingEventId = await createItem(eventsId, "Planning");

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
      const firstEventId = await createItem(eventsId, "Planning");
      const secondEventId = await createItem(eventsId, "Retro");

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
      expect((await cardProperties(cardId)).proposal).toEqual(createEvent());
    });

    it("rejects a link into an archived database with database_archived", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await createItem(eventsId, "Planning");
      await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [eventsId]);

      await expect(revise(cardId, linkExisting(eventId))).rejects.toMatchObject({ code: "database_archived" });
    });

    it("rejects a link through a relation the user may not write with owner_violation", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await createItem(eventsId, "Planning");
      await pool.query("UPDATE properties SET owner = 'system', owner_process = 'someProcess' WHERE id = $1", [
        await propertyIdFor(transcriptsId, "event"),
      ]);

      await expect(revise(cardId, linkExisting(eventId))).rejects.toMatchObject({ code: "owner_violation" });
    });

    it("rejects a link through any relation other than the transcript's 'event' or 'speakers'", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await createItem(eventsId, "Planning");

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
      const eventId = await createItem(eventsId, "Planning");

      await expect(
        revise(cardId, { entityKind: "relation", target: eventId, properties: { propertyKey: "event", metadata: [] } }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "properties" } });
    });

    it("rejects a relation envelope whose properties carry anything besides propertyKey and metadata", async () => {
      const { cardId } = await createTranscriptCard();
      const eventId = await createItem(eventsId, "Planning");

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
      const eventId = await createItem(eventsId, "Planning");
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
      const eventId = await createItem(eventsId, "Planning");
      await confirm(cardId);

      await expect(revise(cardId, linkExisting(eventId))).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "status" },
      });
    });
  });
});
