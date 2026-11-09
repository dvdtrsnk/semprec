import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant } from "../../testSupport/tenantFixtures.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
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

  async function createEvent(type: string, date: string, extra: Record<string, unknown> = {}): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: eventsId,
        properties: { name: `${type} at ${date}`, type, date, ...extra },
      }),
    );
    return item.id;
  }

  /** The stored `date` and `timeFrom` of an Event. */
  async function storedStart(eventId: string): Promise<{ date: unknown; timeFrom: unknown }> {
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
      [eventsId, eventId],
    );
    if (!rows[0]) throw new Error("Event row missing");
    return { date: rows[0].properties.date, timeFrom: rows[0].properties.timeFrom };
  }

  /**
   * An Event row as stored before a write rule existed: a `date` that still carries the instant (written
   * before issue #1598), or a `date` or `timeFrom` the Event rules of issue #1663 now refuse (a malformed
   * date, a non-time, a `24:00` start). Raw SQL on a valid Event the choke point created, because every
   * write path now normalizes or refuses such values; the matcher must still read them defensively.
   */
  async function createLegacyEvent(type: string, date: string, timeFrom?: string): Promise<string> {
    const eventId = await createEvent(type, "2024-01-01");
    const legacy: Record<string, unknown> = { date, ...(timeFrom === undefined ? {} : { timeFrom }) };
    const updated = await pool.query(
      "UPDATE items SET properties = (properties - 'timeFrom' - 'timeTo' - 'time') || $3::jsonb WHERE database_id = $1 AND id = $2",
      [eventsId, eventId, JSON.stringify(legacy)],
    );
    expect(updated.rowCount).toBe(1);
    return eventId;
  }

  async function setTenantZone(zone: string): Promise<void> {
    const databaseId = await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client));
    const itemId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
    await createChokePoint(pool).updateItem({ databaseId, itemId, propertiesPatch: { timezone: zone } });
  }

  function match(transcriptId: string) {
    return withTransaction(pool, (client) =>
      matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
    );
  }

  /** The Event ids linked to `transcriptId` through the Transcripts <-> Events relation. */
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
    const cards = await cardsFor(transcriptId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.properties).toMatchObject({
      history: [
        expect.objectContaining({
          message: "2 Events matched the recording's time window, so none was linked; proposed a new Event.",
        }),
      ],
    });
  });

  it("never considers Events outside the window, of another type, without a time, or deleted", async () => {
    const transcriptId = await createTranscript();
    // Since issue #1598 an Event's start is stored to the minute, so the nearest starts outside the window
    // are one minute out; the second-precision edges of a pre-#1598 row are covered further down.
    await createEvent("meeting", "2024-03-01T11:29:00.000Z");
    await createEvent("meeting", "2024-03-01T13:01:00.000Z");
    await createEvent("event", "2024-03-01T12:05:00.000Z");
    await createEvent("meeting", "2024-03-01");
    const notADate = await createLegacyEvent("meeting", "not a date");
    expect(await storedStart(notADate)).toEqual({ date: "not a date", timeFrom: undefined });
    const deletedId = await createEvent("standup", "2024-03-01T12:05:00.000Z");
    await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [deletedId]);

    expect(await match(transcriptId)).toBe("suggested");
    expect(await linkedEventIds(transcriptId)).toEqual([]);
  });

  it("links a second recording directly to the one Event that already holds a transcript, and creates no card (issue #1464)", async () => {
    const otherTranscriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T12:00:00.000Z");
    expect(await match(otherTranscriptId)).toBe("linked");
    const transcriptId = await createTranscript();

    expect(await match(transcriptId)).toBe("linked");

    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    expect(await linkedEventIds(otherTranscriptId)).toEqual([eventId]);
    expect(await proposalCount()).toBe(0);
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

  it("matches an Event normalized to a date and timeFrom by that wall-clock start in the Europe/Prague tenant zone (issue #1598)", async () => {
    const transcriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T11:45:00.000Z");
    expect(await storedStart(eventId)).toEqual({ date: "2024-03-01", timeFrom: "12:45" });
    const typedId = await createEvent("standup", "2024-03-01", { timeFrom: "11:20" });
    expect(await storedStart(typedId)).toEqual({ date: "2024-03-01", timeFrom: "11:20" });

    expect(await match(transcriptId)).toBe("linked");

    // 12:45 in Prague is 11:45Z, inside the window; 11:20 in Prague is 10:20Z, before it.
    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    expect(await proposalCount()).toBe(0);
  });

  it("reads the same stored start in the tenant zone: it matches in Europe/Prague and is outside the window in UTC (issue #1598)", async () => {
    const pragueEventId = await createEvent("meeting", "2024-03-01", { timeFrom: "13:30" });
    const firstTranscriptId = await createTranscript();
    expect(await match(firstTranscriptId)).toBe("linked");
    expect(await linkedEventIds(firstTranscriptId)).toEqual([pragueEventId]);

    await setTenantZone("UTC");
    const utcEventId = await createEvent("meeting", "2024-03-01", { timeFrom: "12:15" });
    const secondTranscriptId = await createTranscript();
    // In UTC the 13:30 start is after the recording's 13:00 end; only the 12:15 Event is a candidate.
    expect(await match(secondTranscriptId)).toBe("linked");
    expect(await linkedEventIds(secondTranscriptId)).toEqual([utcEventId]);
    expect(await proposalCount()).toBe(0);
  });

  it("matches an Event normalized in the America/New_York tenant zone (issue #1598)", async () => {
    await setTenantZone("America/New_York");
    const transcriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T12:10:00.000Z");
    expect(await storedStart(eventId)).toEqual({ date: "2024-03-01", timeFrom: "07:10" });

    expect(await match(transcriptId)).toBe("linked");
    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    // The rerun converges, as for every other match.
    expect(await match(transcriptId)).toBe("alreadyLinked");
    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    expect(await proposalCount()).toBe(0);
  });

  it("keeps reading a pre-#1598 date that carries a time to the second, ahead of any timeFrom", async () => {
    const transcriptId = await createTranscript();
    await createLegacyEvent("meeting", "2024-03-01T11:29:59.000Z");
    await createLegacyEvent("meeting", "2024-03-01T13:00:01.000Z");
    // Its own time wins: as a wall-clock start in Prague, 20:00 would be outside the window.
    const legacyId = await createLegacyEvent("standup", "2024-03-01T11:45:00.000Z", "20:00");
    expect(await storedStart(legacyId)).toEqual({ date: "2024-03-01T11:45:00.000Z", timeFrom: "20:00" });

    expect(await match(transcriptId)).toBe("linked");
    expect(await linkedEventIds(transcriptId)).toEqual([legacyId]);
  });

  it("leaves out an Event whose date or timeFrom is malformed or whose start is 24:00, and still links the valid one", async () => {
    // At UTC+12 the midnight ending 2024-03-01 is 12:00Z, the recording's start: read as a start, a 24:00
    // timeFrom would fall inside the window.
    await setTenantZone("Etc/GMT-12");
    const transcriptId = await createTranscript();
    // Stored before the Event rules of issue #1663 refused them.
    const malformed = [
      await createLegacyEvent("meeting", "2024-03-01", "24:00"),
      await createLegacyEvent("meeting", "2024-03-01", "nine"),
      await createLegacyEvent("meeting", "2024-02-30", "23:50"),
    ];
    expect(await Promise.all(malformed.map(storedStart))).toEqual([
      { date: "2024-03-01", timeFrom: "24:00" },
      { date: "2024-03-01", timeFrom: "nine" },
      { date: "2024-02-30", timeFrom: "23:50" },
    ]);
    await createEvent("meeting", "2024-03-01");
    const validId = await createEvent("standup", "2024-03-01", { timeFrom: "23:50" });
    expect(await storedStart(validId)).toEqual({ date: "2024-03-01", timeFrom: "23:50" });

    expect(await match(transcriptId)).toBe("linked");
    // 23:50 at UTC+12 is 11:50Z, inside the window.
    expect(await linkedEventIds(transcriptId)).toEqual([validId]);
    expect(await proposalCount()).toBe(0);
  });

  it("propagates an invalid tenant zone once an Event needs it, writing nothing, and does not read it for a pre-#1598 date", async () => {
    // Raw SQL: the settings write refuses an invalid zone, so only a corrupted row holds one.
    const settingsUpdate = await pool.query(
      'UPDATE items SET properties = properties || \'{"timezone": "Not/AZone"}\'::jsonb WHERE database_id = $1',
      [await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client))],
    );
    expect(settingsUpdate.rowCount).toBe(1);
    const legacyId = await createLegacyEvent("meeting", "2024-03-01T11:45:00.000Z");
    const firstTranscriptId = await createTranscript();
    expect(await match(firstTranscriptId)).toBe("linked");
    expect(await linkedEventIds(firstTranscriptId)).toEqual([legacyId]);

    await createEvent("meeting", "2024-03-01", { timeFrom: "12:30" });
    const secondTranscriptId = await createTranscript();
    const failure = await match(secondTranscriptId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({ details: { field: "timezone" } });
    expect(await linkedEventIds(secondTranscriptId)).toEqual([]);
    expect(await cardsFor(secondTranscriptId)).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it("stores the create-Event envelope as aiProposal too, at aiVersion 1 (issue #1471)", async () => {
    const transcriptId = await createTranscript();

    expect(await match(transcriptId)).toBe("suggested");

    const cards = await cardsFor(transcriptId);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.properties).toMatchObject({ aiVersion: 1 });
    expect(cards[0]?.properties.aiProposal).toEqual({
      entityKind: "database",
      target: eventsId,
      properties: { name: "Weekly sync", type: "meeting", date: RECORDING_START },
    });
  });
});

describe("matchTranscriptToEvent per tenant, through the runtime role (issue #1598)", () => {
  let adminPool: Pool;
  let dataPool: Pool;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  async function databaseId(tenantId: string, moduleId: string): Promise<string> {
    return runInTenant(tenantId, async () => {
      const { rows } = await dataPool.query<{ id: string }>(
        "SELECT id FROM databases WHERE owner_module_id = $1 AND system",
        [moduleId],
      );
      if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
      return rows[0].id;
    });
  }

  /** A seeded tenant in `zone` with one transcript at the recording start and one Event at `timeFrom`. */
  async function tenantWithRecording(zone: string, timeFrom: string) {
    const tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
    const transcriptsDatabaseId = await databaseId(tenantId, "transcripts");
    const eventsDatabaseId = await databaseId(tenantId, "events");
    return runInTenant(tenantId, async () => {
      const chokePoint = createChokePoint(dataPool);
      if (zone !== "Europe/Prague") {
        const settings = await withTransaction(dataPool, async (client) => ({
          databaseId: await getSystemSettingsDatabaseId(client),
          itemId: await getSystemSettingsItemId(client),
        }));
        await chokePoint.updateItem({ ...settings, propertiesPatch: { timezone: zone } });
      }
      const { transcriptId, eventId } = await withTransaction(dataPool, async (client) => ({
        transcriptId: (
          await createItemWithClient(
            client,
            { databaseId: transcriptsDatabaseId, properties: { name: "Weekly sync", date: RECORDING_START } },
            { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          )
        ).id,
        eventId: (
          await createItemWithClient(client, {
            databaseId: eventsDatabaseId,
            properties: { name: "Sync", type: "meeting", date: "2024-03-01", timeFrom },
          })
        ).id,
      }));
      return { tenantId, transcriptId, eventId };
    });
  }

  function match(tenantId: string, transcriptId: string) {
    return runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) =>
        matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
      ),
    );
  }

  /** Every `[transcript, event]` edge of the Transcripts <-> Events relation the tenant can see. */
  async function edges(tenantId: string): Promise<Array<[string, string]>> {
    return runInTenant(tenantId, async () => {
      const { rows } = await dataPool.query<{ item_a: string; item_b: string }>(
        `SELECT r.item_a, r.item_b FROM item_relations r
           JOIN relation_definitions d ON d.id = r.relation_definition_id
           JOIN properties p ON p.id = d.property_id_a OR p.id = d.property_id_b
           JOIN databases db ON db.id = p.database_id
          WHERE db.owner_module_id = 'transcripts' AND p.key = 'event'
          ORDER BY r.item_a`,
      );
      return rows.map((row) => [row.item_a, row.item_b]);
    });
  }

  it("converts each tenant's Event start in its own zone and links only that tenant's Event, once", async () => {
    // 12:45 in Prague and 06:45 in New York are both 11:45Z, inside the window. Read in the other
    // tenant's zone either start would be outside it, and a visible foreign Event would make two candidates.
    const prague = await tenantWithRecording("Europe/Prague", "12:45");
    const newYork = await tenantWithRecording("America/New_York", "06:45");

    expect(await match(prague.tenantId, prague.transcriptId)).toBe("linked");
    expect(await match(newYork.tenantId, newYork.transcriptId)).toBe("linked");

    const pragueEdges = await edges(prague.tenantId);
    const newYorkEdges = await edges(newYork.tenantId);
    expect(pragueEdges).toHaveLength(1);
    expect(newYorkEdges).toHaveLength(1);
    expect(new Set(pragueEdges[0])).toEqual(new Set([prague.transcriptId, prague.eventId]));
    expect(new Set(newYorkEdges[0])).toEqual(new Set([newYork.transcriptId, newYork.eventId]));

    expect(await match(prague.tenantId, prague.transcriptId)).toBe("alreadyLinked");
    expect(await edges(prague.tenantId)).toEqual(pragueEdges);
    expect(await edges(newYork.tenantId)).toEqual(newYorkEdges);
  });
});
