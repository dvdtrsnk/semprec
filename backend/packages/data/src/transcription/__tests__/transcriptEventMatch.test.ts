import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { NotFoundError } from "../../errors.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";

let pool: Pool;

const RECORDING_START = "2024-03-01T12:00:00.000Z";
const DURATION_SECONDS = 3600;

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

describe("matchTranscriptToEvent (issue #247)", () => {
  let transcriptsId: string;
  let eventsId: string;
  let proposalsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
    eventsId = await databaseIdFor("events");
    proposalsId = await databaseIdFor("processingProposals");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTranscript(properties: Record<string, unknown> = { date: RECORDING_START }): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name: "Weekly sync", ...properties } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    );
    return item.id;
  }

  async function createEvent(type: string, date: string): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: eventsId, properties: { name: `${type} at ${date}`, type, date } }),
    );
    return item.id;
  }

  function match(transcriptId: string) {
    return withTransaction(pool, (client) =>
      matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
    );
  }

  /** The Event ids linked to `transcriptId` through the Transcripts <-> Events 1:1 relation. */
  async function linkedEventIds(transcriptId: string): Promise<string[]> {
    const { rows } = await pool.query<{ other: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
       FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE (d.property_id_a = $2 OR d.property_id_b = $2) AND (r.item_a = $1 OR r.item_b = $1)`,
      [transcriptId, await propertyIdFor(transcriptsId, "event")],
    );
    return rows.map((row) => row.other);
  }

  /** Every Processing proposal card whose `sourceTranscript` points at `transcriptId`. */
  async function cardsFor(transcriptId: string) {
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
      `SELECT i.id, i.properties FROM items i
       JOIN item_relations r ON (r.item_a = i.id AND r.item_b = $1) OR (r.item_b = i.id AND r.item_a = $1)
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE i.database_id = $2 AND (d.property_id_a = $3 OR d.property_id_b = $3)`,
      [transcriptId, proposalsId, await propertyIdFor(proposalsId, "sourceTranscript")],
    );
    return rows;
  }

  async function proposalCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    return Number(rows[0]?.count);
  }

  it("links the one candidate inside the window directly and creates no card", async () => {
    const transcriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T11:45:00.000Z");

    expect(await match(transcriptId)).toBe("linked");

    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    expect(await proposalCount()).toBe(0);
  });

  it("counts both window edges as inside: 30 minutes before the start and the recording's end", async () => {
    const transcriptId = await createTranscript();
    await createEvent("standup", "2024-03-01T11:30:00.000Z");
    await createEvent("meeting", "2024-03-01T13:00:00.000Z");

    expect(await match(transcriptId)).toBe("suggested");
    expect(await linkedEventIds(transcriptId)).toEqual([]);
  });

  it("creates one proposed transcript card with the create-Event proposal when no Event matches", async () => {
    const transcriptId = await createTranscript();

    expect(await match(transcriptId)).toBe("suggested");

    expect(await linkedEventIds(transcriptId)).toEqual([]);
    const cards = await cardsFor(transcriptId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.properties).toMatchObject({
      kind: "transcript",
      status: "proposed",
      proposal: {
        entityKind: "database",
        target: eventsId,
        properties: { name: "Weekly sync", type: "meeting", date: RECORDING_START },
      },
      history: [expect.objectContaining({ author: "ai" })],
    });
    expect(await proposalCount()).toBe(1);
  });

  it("creates a card and no edge when several Events match", async () => {
    const transcriptId = await createTranscript();
    await createEvent("meeting", "2024-03-01T12:00:00.000Z");
    await createEvent("standup", "2024-03-01T12:10:00.000Z");

    expect(await match(transcriptId)).toBe("suggested");

    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await cardsFor(transcriptId)).toHaveLength(1);
  });

  it("never considers Events outside the window, of another type, without a time, or deleted", async () => {
    const transcriptId = await createTranscript();
    await createEvent("meeting", "2024-03-01T11:29:59.000Z");
    await createEvent("meeting", "2024-03-01T13:00:01.000Z");
    await createEvent("event", "2024-03-01T12:05:00.000Z");
    await createEvent("meeting", "2024-03-01");
    await createEvent("meeting", "not a date");
    const deletedId = await createEvent("standup", "2024-03-01T12:05:00.000Z");
    await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [deletedId]);

    expect(await match(transcriptId)).toBe("suggested");
    expect(await linkedEventIds(transcriptId)).toEqual([]);
  });

  it("proposes a card rather than a second edge when the one candidate is already linked to another transcript", async () => {
    const otherTranscriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T12:00:00.000Z");
    expect(await match(otherTranscriptId)).toBe("linked");
    const transcriptId = await createTranscript();

    expect(await match(transcriptId)).toBe("suggested");

    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await linkedEventIds(otherTranscriptId)).toEqual([eventId]);
    expect(await cardsFor(transcriptId)).toHaveLength(1);
  });

  it("re-running on a linked transcript creates no card and no second edge", async () => {
    const transcriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T12:00:00.000Z");
    expect(await match(transcriptId)).toBe("linked");
    await createEvent("standup", "2024-03-01T12:15:00.000Z");

    expect(await match(transcriptId)).toBe("alreadyLinked");

    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    expect(await proposalCount()).toBe(0);
  });

  it("re-running on an ambiguous transcript converges on the same card, even once one Event now matches", async () => {
    const transcriptId = await createTranscript();
    expect(await match(transcriptId)).toBe("suggested");
    const [card] = await cardsFor(transcriptId);
    await createEvent("meeting", "2024-03-01T12:00:00.000Z");

    expect(await match(transcriptId)).toBe("alreadySuggested");

    expect(await cardsFor(transcriptId)).toEqual([card]);
    expect(await proposalCount()).toBe(1);
    expect(await linkedEventIds(transcriptId)).toEqual([]);
  });

  it("does not recreate a card the user deleted", async () => {
    const transcriptId = await createTranscript();
    expect(await match(transcriptId)).toBe("suggested");
    const [card] = await cardsFor(transcriptId);
    if (!card) throw new Error("expected a card");
    await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [card.id]);

    expect(await match(transcriptId)).toBe("alreadySuggested");
    expect(await proposalCount()).toBe(1);
  });

  it("rejects a transcript that has no recording date yet and writes nothing", async () => {
    const transcriptId = await createTranscript({});
    await createEvent("meeting", "2024-03-01T12:00:00.000Z");

    await expect(match(transcriptId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it("rejects a transcript id that does not exist", async () => {
    await expect(match("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
  });
});
