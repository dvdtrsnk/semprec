import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { listTranscriptSpeakers } from "../transcriptionSpeakerEdges.js";
import { createTranscriptSpeakersRouteHandler } from "../transcriptionRouteHandlers.js";

let pool: Pool;

const SEGMENTS = [
  { speaker: "SPEAKER_01", text: "Hello.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_00", text: "Hi, Alice.", startsAt: 1, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Shall we start?", startsAt: 2, endsAt: 3 },
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

/** Issue #185: speaker-to-People mappings written through the generic relation operation and composed at read time. */
describe("Transcript speaker mappings (issue #185)", () => {
  let transcriptsId: string;
  let peopleId: string;
  let speakersPropertyId: string;
  let chokePoint: ChokePoint;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
    peopleId = await databaseIdFor("people");
    speakersPropertyId = await propertyIdFor(transcriptsId, "speakers");
    chokePoint = createChokePoint(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** `null` creates a transcript the merge step has not reached yet. */
  async function createTranscript(segments: unknown[] | null = SEGMENTS): Promise<string> {
    return withTransaction(pool, async (client) => {
      const item = await createItemWithClient(client, { databaseId: transcriptsId, properties: { name: "Sync" } });
      if (segments !== null) await writeComputed(client, transcriptsId, item.id, "segments", segments);
      return item.id;
    });
  }

  async function createPerson(name: string): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId: peopleId, properties: { name } }),
    );
    return item.id;
  }

  function map(transcriptId: string, personId: string, metadata?: Record<string, unknown>) {
    return chokePoint.createRelation({
      relationPropertyId: speakersPropertyId,
      callerItemId: transcriptId,
      targetItemId: personId,
      metadata,
    });
  }

  function speakers(transcriptId: string) {
    return withTransaction(pool, (client) => listTranscriptSpeakers(client, transcriptId));
  }

  async function readSegments(transcriptId: string): Promise<unknown> {
    const { rows } = await pool.query<{ segments: unknown }>(
      "SELECT computed -> 'segments' AS segments FROM items WHERE id = $1",
      [transcriptId],
    );
    return rows[0]?.segments;
  }

  describe("rendering", () => {
    it("lists every speaker key unmapped, numbered by first appearance", async () => {
      const transcriptId = await createTranscript();

      expect(await speakers(transcriptId)).toEqual([
        { speaker: "SPEAKER_01", ordinal: 1, person: null },
        { speaker: "SPEAKER_00", ordinal: 2, person: null },
      ]);
    });

    it("shows a mapping without rewriting segments, and keeps every other key's ordinal", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");

      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      expect(await speakers(transcriptId)).toEqual([
        { speaker: "SPEAKER_01", ordinal: 1, person: null },
        { speaker: "SPEAKER_00", ordinal: 2, person: { id: aliceId, name: "Alice" } },
      ]);
      expect(await readSegments(transcriptId)).toEqual(SEGMENTS);
    });

    it("renders a key whose mapped person was deleted as unmapped", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await chokePoint.softDeleteItem(peopleId, aliceId);

      expect((await speakers(transcriptId))[1]).toEqual({ speaker: "SPEAKER_00", ordinal: 2, person: null });
    });

    it("lists no speakers before the merge step has written segments", async () => {
      const transcriptId = await createTranscript(null);

      expect(await speakers(transcriptId)).toEqual([]);
    });

    it("rejects an unknown transcript with not_found", async () => {
      await expect(speakers("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("writing through the generic relation operation", () => {
    it("replaces a person's key by writing the edge again", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      const edge = await map(transcriptId, aliceId, { speaker: "SPEAKER_01" });

      expect(edge.metadata).toEqual({ speaker: "SPEAKER_01" });
      expect((await speakers(transcriptId)).map((entry) => entry.person?.id ?? null)).toEqual([aliceId, null]);
    });

    it("replaces a person's key through the metadata update", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await chokePoint.updateRelation({
        relationPropertyId: speakersPropertyId,
        callerItemId: transcriptId,
        targetItemId: aliceId,
        metadata: { speaker: "SPEAKER_01" },
      });

      expect((await speakers(transcriptId)).map((entry) => entry.person?.id ?? null)).toEqual([aliceId, null]);
    });

    it("rejects a metadata update to a key another person holds", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      const bobId = await createPerson("Bob");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });
      await map(transcriptId, bobId, { speaker: "SPEAKER_01" });

      await expect(
        chokePoint.updateRelation({
          relationPropertyId: speakersPropertyId,
          callerItemId: transcriptId,
          targetItemId: aliceId,
          metadata: { speaker: "SPEAKER_01" },
        }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { reason: "speakerAlreadyMapped" } });
    });

    it("refuses a key another person already holds, and accepts it once that mapping is removed", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      const bobId = await createPerson("Bob");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await expect(map(transcriptId, bobId, { speaker: "SPEAKER_00" })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "metadata", reason: "speakerAlreadyMapped", personId: aliceId },
      });

      await chokePoint.deleteRelation({
        relationPropertyId: speakersPropertyId,
        callerItemId: transcriptId,
        targetItemId: aliceId,
      });
      await map(transcriptId, bobId, { speaker: "SPEAKER_00" });

      expect((await speakers(transcriptId))[1]?.person).toEqual({ id: bobId, name: "Bob" });
    });

    it("removes a mapping, leaving the key unmapped", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      await chokePoint.deleteRelation({
        relationPropertyId: speakersPropertyId,
        callerItemId: transcriptId,
        targetItemId: aliceId,
      });

      expect((await speakers(transcriptId)).every((entry) => entry.person === null)).toBe(true);
      expect(await readSegments(transcriptId)).toEqual(SEGMENTS);
    });

    it.each([
      ["no metadata", undefined],
      ["an empty speaker", { speaker: "" }],
      ["a non-string speaker", { speaker: 0 }],
      ["an extra key", { speaker: "SPEAKER_00", confidence: 1 }],
    ])("rejects %s with validation_failed on metadata", async (_label, metadata) => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");

      await expect(map(transcriptId, aliceId, metadata)).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "metadata" },
      });
    });

    it("rejects a key no segment carries, including every key before segments exist", async () => {
      const transcriptId = await createTranscript();
      const unmergedId = await createTranscript(null);
      const aliceId = await createPerson("Alice");

      for (const id of [transcriptId, unmergedId]) {
        await expect(map(id, aliceId, { speaker: "SPEAKER_07" })).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "metadata", reason: "unknownSpeaker" },
        });
      }
    });

    it("keeps a system-owned speakers relation's owner_violation for add and remove", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });
      await pool.query("UPDATE properties SET owner = 'system', owner_process = 'someProcess' WHERE id = $1", [
        speakersPropertyId,
      ]);

      await expect(map(transcriptId, aliceId, { speaker: "SPEAKER_01" })).rejects.toMatchObject({
        code: "owner_violation",
      });
      await expect(
        chokePoint.deleteRelation({
          relationPropertyId: speakersPropertyId,
          callerItemId: transcriptId,
          targetItemId: aliceId,
        }),
      ).rejects.toMatchObject({ code: "owner_violation" });
    });

    it("rejects a target outside People with validation_failed on targetItemId", async () => {
      const transcriptId = await createTranscript();
      const otherTranscriptId = await createTranscript();

      await expect(map(transcriptId, otherTranscriptId, { speaker: "SPEAKER_00" })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "targetItemId" },
      });
    });

    it("leaves other relations' metadata unconstrained", async () => {
      const eventsId = await databaseIdFor("events");
      const peoplePropertyId = await propertyIdFor(eventsId, "people");
      const eventId = (
        await withTransaction(pool, (client) =>
          createItemWithClient(client, { databaseId: eventsId, properties: { name: "Sync" } }),
        )
      ).id;
      const aliceId = await createPerson("Alice");

      const edge = await chokePoint.createRelation({
        relationPropertyId: peoplePropertyId,
        callerItemId: eventId,
        targetItemId: aliceId,
        metadata: { anything: true },
      });

      expect(edge.metadata).toEqual({ anything: true });
    });
  });

  describe("GET /api/transcripts/:id/speakers", () => {
    function get(id: string, locale: string) {
      return createTranscriptSpeakersRouteHandler(pool)({ params: { id }, identity: { user: { locale } } });
    }

    it("labels unmapped keys 'Speaker N' in English and 'Mluvčí N' in Czech, and mapped keys by name", async () => {
      const transcriptId = await createTranscript();
      const aliceId = await createPerson("Alice");
      await map(transcriptId, aliceId, { speaker: "SPEAKER_00" });

      expect(await get(transcriptId, "en")).toEqual({
        status: 200,
        body: {
          speakers: [
            { speaker: "SPEAKER_01", label: "Speaker 1", personId: null },
            { speaker: "SPEAKER_00", label: "Alice", personId: aliceId },
          ],
        },
      });
      expect(await get(transcriptId, "cs")).toMatchObject({
        body: { speakers: [{ label: "Mluvčí 1" }, { label: "Alice" }] },
      });
    });

    it("labels a mapped person with no name by the key's ordinal", async () => {
      const transcriptId = await createTranscript();
      const namelessId = await createPerson("");
      await map(transcriptId, namelessId, { speaker: "SPEAKER_00" });

      expect(await get(transcriptId, "en")).toMatchObject({
        body: { speakers: [{ label: "Speaker 1" }, { label: "Speaker 2", personId: namelessId }] },
      });
    });

    it("rejects a non-UUID id with validation_failed before any query", async () => {
      await expect(get("not-a-uuid", "en")).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an unknown transcript with not_found", async () => {
      await expect(get("00000000-0000-0000-0000-000000000000", "en")).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
