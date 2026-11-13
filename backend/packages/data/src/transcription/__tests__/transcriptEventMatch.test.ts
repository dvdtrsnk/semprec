import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, getTenantZeroId } from "../../testSupport/tenantFixtures.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { ConflictError, NotFoundError, ValidationError } from "../../errors.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { setInboxCardsInvalidationHook, type InboxCardsInvalidationEvent } from "../../realtimeHook.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import {
  buildNewMeetingEnvelope,
  createTranscriptEventCard,
  listOverlappingEventIds,
  matchTranscriptToEvent,
  readEventRecommendationContext,
  readRecommendedEventProjectId,
  type EventRecommendation,
} from "../transcriptEventMatch.js";
import { getCalendarClock, type CalendarClock } from "../../calendarTime.js";

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

  /** A transcript as the create step leaves it (issue #1830): without a `name` unless `properties` gives one. */
  async function createTranscript(properties: Record<string, unknown> = { date: RECORDING_START }): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: transcriptsId, properties },
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
   * An Event whose stored time values are exactly `stored`. Raw SQL on a valid Event the choke point
   * created: every write path normalizes or refuses values such as a malformed date, a non-time, a
   * `24:00` start, an end before the start or a start without an end (the Events time rules of issues
   * #1598 and #1663), so only a row written before those rules can hold them; the matcher must still
   * read them defensively.
   */
  async function createRawEvent(type: string, stored: Record<string, unknown>): Promise<string> {
    const eventId = await createEvent(type, "2024-01-01");
    const updated = await pool.query(
      "UPDATE items SET properties = (properties - 'timeFrom' - 'timeTo' - 'time' - 'endDate') || $3::jsonb WHERE database_id = $1 AND id = $2",
      [eventsId, eventId, JSON.stringify(stored)],
    );
    expect(updated.rowCount).toBe(1);
    return eventId;
  }

  async function setTenantZone(zone: string): Promise<void> {
    const databaseId = await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client));
    const itemId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
    await createChokePoint(pool).updateItem({ databaseId, itemId, propertiesPatch: { timezone: zone } });
  }

  function match(transcriptId: string, durationSeconds = DURATION_SECONDS) {
    return withTransaction(pool, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds }));
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

  /** The `inboxCards` invalidations `fn` publishes after its transaction committed (issue #1811). */
  async function capturingInboxCards(fn: () => Promise<unknown>): Promise<InboxCardsInvalidationEvent[]> {
    const events: InboxCardsInvalidationEvent[] = [];
    setInboxCardsInvalidationHook((event) => events.push(event));
    try {
      await fn();
    } finally {
      setInboxCardsInvalidationHook(() => {});
    }
    return events;
  }

  it("announces the new suggestion card once, and nothing when the run converges on it (issue #1811)", async () => {
    const transcriptId = await createTranscript();

    const created = await capturingInboxCards(() => match(transcriptId));
    const [card] = await cardsFor(transcriptId);
    const again = await capturingInboxCards(async () => expect(await match(transcriptId)).toBe("alreadySuggested"));

    expect(card).toBeDefined();
    expect(created).toEqual([{ op: "created", cardId: card!.id }]);
    expect(again).toEqual([]);
  });

  it("announces no card when the one candidate is linked directly (issue #1811)", async () => {
    const transcriptId = await createTranscript();
    await createEvent("meeting", "2024-03-01T11:45:00.000Z");

    const events = await capturingInboxCards(async () => expect(await match(transcriptId)).toBe("linked"));

    expect(events).toEqual([]);
  });

  it("announces no card when the transaction that created it rolls back (issue #1811)", async () => {
    const transcriptId = await createTranscript();

    const events = await capturingInboxCards(async () => {
      await expect(
        withTransaction(pool, async (client) => {
          expect(await matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS })).toBe(
            "suggested",
          );
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
    });

    expect(events).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it("links the one candidate whose interval overlaps the recording directly and creates no card", async () => {
    const transcriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T11:45:00.000Z");

    expect(await match(transcriptId)).toBe("linked");

    expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    expect(await proposalCount()).toBe(0);
  });

  it("creates one proposed transcript card with the new-meeting proposal when no Event matches", async () => {
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
        properties: { name: "Schůzka 1. 3.", type: "meeting", date: "2024-03-01", timeFrom: "13:00", timeTo: "14:00" },
      },
      history: [
        expect.objectContaining({
          author: "ai",
          message: "0 Events overlapped the recording's time interval, so none was linked; proposed a new Event.",
        }),
      ],
    });
    expect(await proposalCount()).toBe(1);
  });

  it("returns the two overlapping Events as ambiguous and writes neither a card nor an edge, on every run (issue #1848)", async () => {
    const transcriptId = await createTranscript();
    const meetingId = await createEvent("meeting", "2024-03-01", {
      timeFrom: "13:00",
      timeTo: "13:30",
      endDate: "2024-03-01",
    });
    const standupId = await createEvent("standup", "2024-03-01", { timeFrom: "13:10" });
    const projectsId = await databaseIdFor("projects");
    const projectId = (
      await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: projectsId, properties: { name: "Apollo" } }),
      )
    ).id;
    const projectPropertyId = await propertyIdFor(eventsId, "project");
    // An Events `project` edge is a link-rule source, so its write needs a tenant scope.
    await runInTenant(getTenantZeroId(), () =>
      withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: projectPropertyId,
          callerItemId: meetingId,
          targetItemId: projectId,
        }),
      ),
    );

    const expected = {
      outcome: "ambiguous",
      candidates: [
        {
          id: meetingId,
          name: "meeting at 2024-03-01",
          date: "2024-03-01",
          timeFrom: "13:00",
          timeTo: "13:30",
          endDate: "2024-03-01",
          projectId,
          projectName: "Apollo",
        },
        {
          id: standupId,
          name: "standup at 2024-03-01",
          date: "2024-03-01",
          timeFrom: "13:10",
          // The choke point gave the Event the default one-hour length.
          timeTo: "14:10",
          endDate: null,
          projectId: null,
          projectName: null,
        },
      ],
    };
    expect(await match(transcriptId)).toEqual(expected);
    expect(await match(transcriptId)).toEqual(expected);

    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it("reports a stored Event without timeTo as a candidate whose timeTo is null (issue #1848)", async () => {
    const transcriptId = await createTranscript();
    const pointId = await createRawEvent("meeting", { date: "2024-03-01", timeFrom: "13:15" });
    const spanId = await createEvent("meeting", "2024-03-01", { timeFrom: "13:00", timeTo: "13:30" });

    const result = await match(transcriptId);

    expect(typeof result).toBe("object");
    expect(
      typeof result === "string"
        ? []
        : result.candidates.flatMap((candidate) =>
            "id" in candidate ? [{ id: candidate.id, timeFrom: candidate.timeFrom, timeTo: candidate.timeTo }] : [],
          ),
    ).toEqual([
      { id: spanId, timeFrom: "13:00", timeTo: "13:30" },
      { id: pointId, timeFrom: "13:15", timeTo: null },
    ]);
  });

  describe("the overlap rule in the tenant's time zone", () => {
    // Europe/Prague on 2024-03-01 is UTC+1: a recording at 12:52Z for 47 minutes runs 13:52-14:39 local.
    const AFTERNOON_RECORDING = { date: "2024-03-01T12:52:00.000Z", durationSeconds: 47 * 60 };

    it("links a meeting 12:30-14:00 to a recording 13:52-14:39", async () => {
      const transcriptId = await createTranscript({ date: AFTERNOON_RECORDING.date });
      const eventId = await createEvent("meeting", "2024-03-01", { timeFrom: "12:30", timeTo: "14:00" });

      expect(await match(transcriptId, AFTERNOON_RECORDING.durationSeconds)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
      expect(await proposalCount()).toBe(0);
    });

    it("does not link a meeting 13:25-13:40 that ended before a recording 13:52-14:39", async () => {
      const transcriptId = await createTranscript({ date: AFTERNOON_RECORDING.date });
      await createEvent("meeting", "2024-03-01", { timeFrom: "13:25", timeTo: "13:40" });

      expect(await match(transcriptId, AFTERNOON_RECORDING.durationSeconds)).toBe("suggested");

      expect(await linkedEventIds(transcriptId)).toEqual([]);
      expect(await proposalCount()).toBe(1);
    });

    it("links a meeting that began hours before the recording and runs through it", async () => {
      const transcriptId = await createTranscript();
      const eventId = await createEvent("meeting", "2024-03-01", { timeFrom: "09:00", timeTo: "17:00" });

      expect(await match(transcriptId)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    });

    // The recording is 13:00-14:00 local. Touching boundaries do not overlap; one minute more does.
    it.each([
      { side: "ends exactly when the recording starts", timeFrom: "12:00", timeTo: "13:00", outcome: "suggested" },
      { side: "starts exactly when the recording ends", timeFrom: "14:00", timeTo: "15:00", outcome: "suggested" },
      { side: "ends one minute after the recording starts", timeFrom: "12:00", timeTo: "13:01", outcome: "linked" },
      { side: "starts one minute before the recording ends", timeFrom: "13:59", timeTo: "15:00", outcome: "linked" },
    ])("an Event that $side is $outcome", async ({ timeFrom, timeTo, outcome }) => {
      const transcriptId = await createTranscript();
      const eventId = await createEvent("meeting", "2024-03-01", { timeFrom, timeTo });

      expect(await match(transcriptId)).toBe(outcome);

      expect(await linkedEventIds(transcriptId)).toEqual(outcome === "linked" ? [eventId] : []);
    });

    it.each(["meeting", "standup"])("considers an Event of type %s", async (type) => {
      const transcriptId = await createTranscript();
      const eventId = await createEvent(type, "2024-03-01", { timeFrom: "13:10", timeTo: "13:50" });

      expect(await match(transcriptId)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    });

    it("never considers an Event of type event", async () => {
      const transcriptId = await createTranscript();
      await createEvent("event", "2024-03-01", { timeFrom: "13:10", timeTo: "13:50" });

      expect(await match(transcriptId)).toBe("suggested");
      expect(await linkedEventIds(transcriptId)).toEqual([]);
    });

    it("never considers an all-day Event, whatever its type", async () => {
      const transcriptId = await createTranscript();
      await createEvent("meeting", "2024-03-01");
      await createEvent("standup", "2024-03-01");

      expect(await match(transcriptId)).toBe("suggested");
      expect(await linkedEventIds(transcriptId)).toEqual([]);
      expect((await cardsFor(transcriptId))[0]?.properties).toMatchObject({
        history: [expect.objectContaining({ message: expect.stringContaining("0 Events overlapped") })],
      });
    });

    it("never considers an Event in the Trash", async () => {
      const transcriptId = await createTranscript();
      const deletedId = await createEvent("standup", "2024-03-01", { timeFrom: "13:10", timeTo: "13:50" });
      await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [deletedId]);

      expect(await match(transcriptId)).toBe("suggested");
      expect(await linkedEventIds(transcriptId)).toEqual([]);
    });

    it("never considers an Event on another day", async () => {
      const transcriptId = await createTranscript();
      await createEvent("meeting", "2024-03-02", { timeFrom: "13:10", timeTo: "13:50" });

      expect(await match(transcriptId)).toBe("suggested");
      expect(await linkedEventIds(transcriptId)).toEqual([]);
    });

    it("compares an Event of 2026-10-14 13:30-14:30 in Europe/Prague (UTC+2) with a recording starting 11:45 UTC", async () => {
      // 13:30-14:30 in Prague is 11:30Z-12:30Z, so it overlaps the recording 11:45Z-12:45Z.
      const transcriptId = await createTranscript({ date: "2026-10-14T11:45:00.000Z" });
      const eventId = await createEvent("meeting", "2026-10-14", { timeFrom: "13:30", timeTo: "14:30" });

      expect(await match(transcriptId)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    });

    it("reads the same Event in a UTC tenant as 13:30Z-14:30Z, which a recording starting 11:45 UTC for an hour misses", async () => {
      await setTenantZone("UTC");
      const transcriptId = await createTranscript({ date: "2026-10-14T11:45:00.000Z" });
      await createEvent("meeting", "2026-10-14", { timeFrom: "13:30", timeTo: "14:30" });

      expect(await match(transcriptId)).toBe("suggested");

      expect(await linkedEventIds(transcriptId)).toEqual([]);
    });

    // 22:00 on 2026-10-14 to 02:00 on 2026-10-15 in Prague (UTC+2) is 20:00Z to 00:00Z.
    it("ends an overnight Event on its endDate: a recording after midnight local time is inside it", async () => {
      const transcriptId = await createTranscript({ date: "2026-10-14T23:30:00.000Z" });
      const eventId = await createEvent("meeting", "2026-10-14", {
        timeFrom: "22:00",
        endDate: "2026-10-15",
        timeTo: "02:00",
      });

      expect(await match(transcriptId, 1800)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([eventId]);
    });

    it("does not link an overnight Event to a recording that starts after its end on the endDate", async () => {
      const transcriptId = await createTranscript({ date: "2026-10-15T00:30:00.000Z" });
      await createEvent("meeting", "2026-10-14", { timeFrom: "22:00", endDate: "2026-10-15", timeTo: "02:00" });

      expect(await match(transcriptId, 1800)).toBe("suggested");

      expect(await linkedEventIds(transcriptId)).toEqual([]);
    });

    // A start with no end is a point: the write rules always add an end, so only an older row lacks one.
    it.each([
      { moment: "inside the recording", timeFrom: "13:30", outcome: "linked" },
      { moment: "exactly at the recording's start", timeFrom: "13:00", outcome: "suggested" },
      { moment: "exactly at the recording's end", timeFrom: "14:00", outcome: "suggested" },
      { moment: "after the recording", timeFrom: "14:30", outcome: "suggested" },
    ])("an Event without timeTo whose start is $moment is $outcome", async ({ timeFrom, outcome }) => {
      const transcriptId = await createTranscript();
      const eventId = await createRawEvent("meeting", { date: "2024-03-01", timeFrom });

      expect(await match(transcriptId)).toBe(outcome);

      expect(await linkedEventIds(transcriptId)).toEqual(outcome === "linked" ? [eventId] : []);
    });

    const VALID_TIMES = { date: "2024-03-01", timeFrom: "13:20", timeTo: "13:40" };
    // Each stored value below would overlap the 13:00-14:00 recording if it were read.
    it.each([
      { why: "a date that is not on the calendar", stored: { date: "2024-02-30", timeFrom: "13:10", timeTo: "13:50" } },
      { why: "a missing date", stored: { date: null, timeFrom: "13:10", timeTo: "13:50" } },
      { why: "a start that is not a time", stored: { date: "2024-03-01", timeFrom: "nine", timeTo: "13:50" } },
      { why: "an end that is not a time", stored: { date: "2024-03-01", timeFrom: "13:10", timeTo: "later" } },
      {
        why: "an endDate that is not on the calendar",
        stored: { date: "2024-03-01", timeFrom: "13:10", endDate: "2024-03-32", timeTo: "13:50" },
      },
      {
        why: "a date still carrying an offset, from before the Events rules of issue #1598",
        stored: { date: "2024-03-01T12:10:00.000Z", timeFrom: "13:10", timeTo: "13:50" },
      },
      { why: "an end before the start", stored: { date: "2024-03-01", timeFrom: "13:50", timeTo: "13:10" } },
    ])("leaves out an Event with $why and still links the valid one", async ({ stored }) => {
      const transcriptId = await createTranscript();
      await createRawEvent("meeting", stored);
      const validId = await createRawEvent("standup", VALID_TIMES);

      expect(await match(transcriptId)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([validId]);
      expect(await proposalCount()).toBe(0);
    });

    it("leaves out an Event that starts at 24:00 and converts an end of 24:00 to the midnight ending its day", async () => {
      // Recording 23:30-00:30 local. A 24:00 start would be the point at midnight, inside it.
      const transcriptId = await createTranscript({ date: "2024-03-01T22:30:00.000Z" });
      await createRawEvent("meeting", { date: "2024-03-01", timeFrom: "24:00", timeTo: "24:00" });
      const validId = await createEvent("standup", "2024-03-01", { timeFrom: "23:40", timeTo: "24:00" });

      expect(await match(transcriptId)).toBe("linked");

      expect(await linkedEventIds(transcriptId)).toEqual([validId]);
    });
  });

  describe("listOverlappingEventIds", () => {
    const RECORDING = {
      startMs: Date.parse(RECORDING_START),
      endMs: Date.parse(RECORDING_START) + DURATION_SECONDS * 1000,
    };

    function list(clockOverride?: (clock: CalendarClock) => CalendarClock): Promise<string[]> {
      return withTransaction(pool, async (client) => {
        const clock = await getCalendarClock(client);
        return listOverlappingEventIds(client, eventsId, RECORDING, clockOverride ? clockOverride(clock) : clock);
      });
    }

    it("orders the candidates by interval start, then id", async () => {
      const later = await createEvent("meeting", "2024-03-01", { timeFrom: "13:30", timeTo: "13:40" });
      const firstOfTie = await createEvent("standup", "2024-03-01", { timeFrom: "13:10", timeTo: "13:20" });
      const secondOfTie = await createEvent("meeting", "2024-03-01", { timeFrom: "13:10", timeTo: "13:50" });
      const earliest = await createEvent("meeting", "2024-03-01", { timeFrom: "09:00", timeTo: "17:00" });

      expect(await list()).toEqual([earliest, ...[firstOfTie, secondOfTie].sort(), later]);
    });

    it("lets a failure other than a refused date or time propagate", async () => {
      await createEvent("meeting", "2024-03-01", { timeFrom: "13:10", timeTo: "13:50" });

      await expect(
        list((clock) => ({
          ...clock,
          wallClockToInstant: () => {
            throw new TypeError("clock broke");
          },
        })),
      ).rejects.toThrow(new TypeError("clock broke"));
    });
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

  it("propagates an invalid tenant zone, writing neither an edge nor a card", async () => {
    // Raw SQL: the settings write refuses an invalid zone, so only a corrupted row holds one.
    const settingsUpdate = await pool.query(
      'UPDATE items SET properties = properties || \'{"timezone": "Not/AZone"}\'::jsonb WHERE database_id = $1',
      [await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client))],
    );
    expect(settingsUpdate.rowCount).toBe(1);
    await createEvent("meeting", "2024-03-01", { timeFrom: "12:30", timeTo: "14:00" });
    const transcriptId = await createTranscript();

    const failure = await match(transcriptId).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({ details: { field: "timezone" } });
    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await cardsFor(transcriptId)).toEqual([]);
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
      properties: { name: "Schůzka 1. 3.", type: "meeting", date: "2024-03-01", timeFrom: "13:00", timeTo: "14:00" },
    });
  });

  // The recording starts at 23:30 UTC on 2024-03-01 and lasts an hour: already 2024-03-02 in Prague (UTC+1), still the
  // 1st in UTC, where it crosses local midnight.
  it.each([
    {
      zone: "Europe/Prague",
      name: "Schůzka 2. 3.",
      span: { date: "2024-03-02", timeFrom: "00:30", timeTo: "01:30" },
    },
    {
      zone: "UTC",
      name: "Schůzka 1. 3.",
      span: { date: "2024-03-01", timeFrom: "23:30", timeTo: "00:30", endDate: "2024-03-02" },
    },
  ])("proposes the new meeting on the recording's date in $zone: $span.date", async ({ zone, name, span }) => {
    await setTenantZone(zone);
    const transcriptId = await createTranscript({ date: "2024-03-01T23:30:00.000Z" });

    expect(await match(transcriptId)).toBe("suggested");

    const [card] = await cardsFor(transcriptId);
    expect(card?.properties.proposal).toEqual({
      entityKind: "database",
      target: eventsId,
      properties: { name, type: "meeting", ...span },
    });
  });

  /** A user of tenant zero, whose `locale` renders the proposed meeting's name. */
  async function createUserWithLocale(locale: string): Promise<void> {
    await pool.query("INSERT INTO users (email, password_hash, locale, tenant_id) VALUES ($1, 'unused', $2, $3)", [
      `${locale}@example.com`,
      locale,
      getTenantZeroId(),
    ]);
  }

  /** The `properties` of the new-meeting proposal the match step wrote for a recording. */
  async function proposedMeeting(startsAt: string, durationSeconds: number): Promise<unknown> {
    const transcriptId = await createTranscript({ date: startsAt });
    expect(await match(transcriptId, durationSeconds)).toBe("suggested");
    const [card] = await cardsFor(transcriptId);
    return z.object({ properties: z.record(z.string(), z.unknown()) }).parse(card?.properties.proposal).properties;
  }

  it("proposes the meeting of a recording of 14 Oct 13:52 lasting 47:10 from 13:52 to 14:39, named by day and month (issue #1818)", async () => {
    // 11:52Z is 13:52 in Prague, which is on summer time (UTC+2) on 14 October 2024.
    expect(await proposedMeeting("2024-10-14T11:52:00.000Z", 47 * 60 + 10)).toEqual({
      name: "Schůzka 14. 10.",
      type: "meeting",
      date: "2024-10-14",
      timeFrom: "13:52",
      timeTo: "14:39",
    });
  });

  it("renders the proposed meeting's name in the English of the tenant user's locale (issue #1818)", async () => {
    await createUserWithLocale("en");

    expect(await proposedMeeting("2024-10-04T11:52:00.000Z", 1800)).toMatchObject({ name: "Meeting 4/10" });
  });

  it("renders the proposed meeting's name in Czech for a Czech user and in English for any other locale (issue #1818)", async () => {
    await createUserWithLocale("cs");
    expect(await proposedMeeting("2024-10-04T11:52:00.000Z", 1800)).toMatchObject({ name: "Schůzka 4. 10." });

    await pool.query("UPDATE users SET locale = 'de' WHERE tenant_id = $1", [getTenantZeroId()]);
    expect(await proposedMeeting("2024-10-05T11:52:00.000Z", 1800)).toMatchObject({ name: "Meeting 5/10" });
  });

  it("sets endDate to the next day for a recording that crosses local midnight (issue #1818)", async () => {
    // 21:50Z is 23:50 in Prague (UTC+2); half an hour later it is 00:20 on the 15th.
    expect(await proposedMeeting("2024-10-14T21:50:00.000Z", 1800)).toEqual({
      name: "Schůzka 14. 10.",
      type: "meeting",
      date: "2024-10-14",
      timeFrom: "23:50",
      timeTo: "00:20",
      endDate: "2024-10-15",
    });
  });

  it("sets endDate when the recording ends exactly at local midnight (issue #1818)", async () => {
    expect(await proposedMeeting("2024-10-14T21:30:00.000Z", 1800)).toMatchObject({
      date: "2024-10-14",
      timeFrom: "23:30",
      timeTo: "00:00",
      endDate: "2024-10-15",
    });
  });

  it("ends a recording shorter than a minute one minute after its start, so the Events rules accept the span (issue #1818)", async () => {
    const properties = await proposedMeeting("2024-10-14T11:52:30.000Z", 20);

    expect(properties).toMatchObject({ date: "2024-10-14", timeFrom: "13:52", timeTo: "13:53" });
    expect(properties).not.toHaveProperty("endDate");
  });

  const PROPOSED_NOTES = {
    title: "Pricing review with {SPEAKER_00}",
    summary: "{SPEAKER_00} presents the pricing.",
    shortSummary: "Pricing reviewed.",
    decisions: [],
    actionItems: [],
  };

  /** The name of the new-meeting proposal for a transcript with `properties` and, when given, stored `meetingNotes`. */
  async function proposedName(properties: Record<string, unknown>, notes?: Record<string, unknown>): Promise<unknown> {
    const transcriptId = await createTranscript({ date: RECORDING_START, ...properties });
    if (notes) {
      await withTransaction(pool, async (client) => {
        await writeComputed(client, transcriptsId, transcriptId, "segments", [
          { speaker: "SPEAKER_00", text: "Good morning everyone.", startsAt: 0, endsAt: 2 },
        ]);
        await writeComputed(client, transcriptsId, transcriptId, "meetingNotes", notes);
      });
    }
    expect(await match(transcriptId)).toBe("suggested");
    const [card] = await cardsFor(transcriptId);
    return z.object({ properties: z.object({ name: z.unknown() }) }).parse(card?.properties.proposal).properties.name;
  }

  it("names the new meeting after the name the user gave the transcript, ahead of the generated title (issue #1830)", async () => {
    expect(await proposedName({ name: "Pricing call" }, PROPOSED_NOTES)).toBe("Pricing call");
  });

  it("names the new meeting after the generated title with its speaker tokens replaced when the transcript has no name (issue #1830)", async () => {
    expect(await proposedName({}, PROPOSED_NOTES)).toBe("Pricing review with Mluvčí 1");
    await createUserWithLocale("en");
    expect(await proposedName({}, PROPOSED_NOTES)).toBe("Pricing review with Speaker 1");
  });

  it("treats a blank transcript name as none and uses the generated title (issue #1830)", async () => {
    expect(await proposedName({ name: "   " }, PROPOSED_NOTES)).toBe("Pricing review with Mluvčí 1");
  });

  it.each([
    ["no notes", undefined],
    ["a blank generated title", { ...PROPOSED_NOTES, title: "  " }],
  ])(
    "falls back to the day and month of the recording when there is a blank name and %s (issue #1830)",
    async (_label, notes) => {
      expect(await proposedName({ name: "" }, notes)).toBe("Schůzka 1. 3.");
    },
  );

  it("proposes no project for the card of a recording without a candidate Event (issue #1818)", async () => {
    const transcriptId = await createTranscript();

    expect(await match(transcriptId)).toBe("suggested");

    const [card] = await cardsFor(transcriptId);
    expect(card?.properties.proposal).not.toHaveProperty("relations");
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

describe("the Event recommendation of an ambiguous recording, through the runtime role (issue #1848)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let tenant: string;
  let otherTenant: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await createTestTenant(adminPool);
    otherTenant = await createTestTenant(adminPool);
    for (const tenantId of [tenant, otherTenant]) await runInTenant(tenantId, () => seedSystem(dataPool));
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  const SEGMENTS = [
    { speaker: "SPEAKER_00", text: "Hello everyone.", startsAt: 0, endsAt: 2 },
    { speaker: "SPEAKER_01", text: "Let us plan the next sprint for iOS today.", startsAt: 2, endsAt: 6 },
    { speaker: "SPEAKER_00", text: "Sounds good to me, I will take the login screen.", startsAt: 6, endsAt: 9 },
  ];
  const NOTES = {
    title: "Sprint planning",
    summary: "{SPEAKER_01} plans the iOS sprint, {SPEAKER_00} takes the login screen.",
    shortSummary: "iOS sprint planned.",
    decisions: [],
    actionItems: [],
  };

  async function databaseId(moduleId: string): Promise<string> {
    const { rows } = await dataPool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = $1 AND system",
      [moduleId],
    );
    if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
    return rows[0].id;
  }

  async function relationPropertyId(moduleId: string, key: string): Promise<string> {
    const { rows } = await dataPool.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [await databaseId(moduleId), key],
    );
    if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
    return rows[0].id;
  }

  async function createIn(moduleId: string, properties: Record<string, unknown>): Promise<string> {
    return (
      await withTransaction(dataPool, async (client) =>
        createItemWithClient(client, { databaseId: await databaseId(moduleId), properties }),
      )
    ).id;
  }

  async function link(moduleId: string, key: string, callerItemId: string, targetItemId: string): Promise<void> {
    const propertyId = await relationPropertyId(moduleId, key);
    await withTransaction(dataPool, (client) =>
      createRelationWithClient(client, { relationPropertyId: propertyId, callerItemId, targetItemId }),
    );
  }

  /** The recording 13:00-14:00 Prague time (12:00Z, an hour long) with the computed values steps 1, 4 and 5 store. */
  async function createRecording(
    computed: Record<string, unknown> = {},
    name: string | null = "Planning call",
  ): Promise<string> {
    const transcriptsId = await databaseId("transcripts");
    return withTransaction(dataPool, async (client) => {
      const item = await createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { ...(name === null ? {} : { name }), date: RECORDING_START } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      const values: Record<string, unknown> = {
        segments: SEGMENTS,
        durationSeconds: DURATION_SECONDS,
        meetingNotes: NOTES,
        ...computed,
      };
      for (const [key, value] of Object.entries(values))
        if (value !== undefined) await writeComputed(client, transcriptsId, item.id, key, value);
      return item.id;
    });
  }

  /** Two Events overlapping the recording: a meeting of project Apollo with two participants, and a bare standup. */
  async function createCandidates() {
    const meetingId = await createIn("events", {
      name: "Sprint planning",
      type: "meeting",
      date: "2024-03-01",
      timeFrom: "13:00",
      timeTo: "13:45",
    });
    const standupId = await createIn("events", {
      name: "Accountant call",
      type: "standup",
      date: "2024-03-01",
      timeFrom: "13:30",
      timeTo: "14:00",
    });
    const projectId = await createIn("projects", { name: "Apollo" });
    await link("events", "project", meetingId, projectId);
    await link("events", "people", meetingId, await createIn("people", { name: "Zora" }));
    await link("events", "people", meetingId, await createIn("people", { name: "Alice" }));
    return { meetingId, standupId, projectId };
  }

  function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runInTenant(tenantId, fn);
  }

  const readContext = (transcriptId: string) =>
    withTransaction(dataPool, (client) =>
      readEventRecommendationContext(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
    );

  const matchInTransaction = (transcriptId: string) =>
    withTransaction(dataPool, (client) =>
      matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
    );

  /** Matches the recording, then creates the card in the same transaction, as the transcription step does. */
  async function createCard(transcriptId: string, recommendation: EventRecommendation | null) {
    return withTransaction(dataPool, async (client) => {
      const matched = await matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS });
      if (typeof matched === "string") throw new Error(`Expected an ambiguous match, got '${matched}'`);
      return createTranscriptEventCard(client, { transcriptId, candidates: matched.candidates, recommendation });
    });
  }

  async function cardsOf(transcriptId: string) {
    const { rows } = await dataPool.query<{ id: string; properties: Record<string, unknown> }>(
      `SELECT i.id, i.properties FROM items i
       JOIN item_relations r ON (r.item_a = i.id AND r.item_b = $1) OR (r.item_b = i.id AND r.item_a = $1)
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE i.database_id = $2 AND (d.property_id_a = $3 OR d.property_id_b = $3)`,
      [
        transcriptId,
        await databaseId("processingProposals"),
        await relationPropertyId("processingProposals", "sourceTranscript"),
      ],
    );
    return rows;
  }

  async function eventEdgeCount(transcriptId: string): Promise<number> {
    const propertyId = await relationPropertyId("transcripts", "event");
    const { rows } = await dataPool.query<{ count: string }>(
      `SELECT count(*) FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
       WHERE (d.property_id_a = $2 OR d.property_id_b = $2) AND (r.item_a = $1 OR r.item_b = $1)`,
      [transcriptId, propertyId],
    );
    return Number(rows[0]?.count);
  }

  describe("readEventRecommendationContext", () => {
    it("returns the candidates with their project and sorted participant names, the rendered notes and the locale", async () => {
      await adminPool.query(
        "INSERT INTO users (email, password_hash, locale, tenant_id) VALUES ($1, 'unused', 'en', $2)",
        ["reader@example.com", tenant],
      );
      await inTenant(tenant, async () => {
        const { meetingId, standupId, projectId } = await createCandidates();
        const transcriptId = await createRecording();

        const context = await readContext(transcriptId);

        expect(context).toEqual({
          candidates: [
            {
              id: meetingId,
              name: "Sprint planning",
              date: "2024-03-01",
              timeFrom: "13:00",
              timeTo: "13:45",
              endDate: null,
              projectId,
              projectName: "Apollo",
              participantNames: ["Alice", "Zora"],
            },
            {
              id: standupId,
              name: "Accountant call",
              date: "2024-03-01",
              timeFrom: "13:30",
              timeTo: "14:00",
              endDate: null,
              projectId: null,
              projectName: null,
              participantNames: [],
            },
          ],
          notes: {
            title: "Sprint planning",
            summary: "Speaker 2 plans the iOS sprint, Speaker 1 takes the login screen.",
            shortSummary: "iOS sprint planned.",
          },
          locale: "en",
        });
      });
    });

    it("falls back to cs when the tenant has no user", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();
        expect((await readContext(await createRecording()))?.locale).toBe("cs");
      });
    });

    it("leaves a project in the Trash and a participant in the Trash out", async () => {
      await inTenant(tenant, async () => {
        const { meetingId, projectId } = await createCandidates();
        const [alice] = (
          await dataPool.query<{ id: string }>("SELECT id FROM items WHERE properties ->> 'name' = 'Alice'")
        ).rows;
        const chokePoint = createChokePoint(dataPool);
        await chokePoint.softDeleteItem(await databaseId("projects"), projectId);
        await chokePoint.softDeleteItem(await databaseId("people"), alice!.id);

        const candidate = (await readContext(await createRecording()))?.candidates.find(({ id }) => id === meetingId);

        expect(candidate).toMatchObject({ projectId: null, projectName: null, participantNames: ["Zora"] });
      });
    });

    it.each([
      ["no Event overlaps the recording", async () => {}],
      [
        "one Event overlaps the recording",
        async () => {
          await createIn("events", {
            name: "Only",
            type: "meeting",
            date: "2024-03-01",
            timeFrom: "13:00",
            timeTo: "13:30",
          });
        },
      ],
    ])("returns null when %s", async (_label, arrange) => {
      await inTenant(tenant, async () => {
        await arrange();
        expect(await readContext(await createRecording())).toBeNull();
      });
    });

    it("returns null once the transcript is linked to an Event or has its card", async () => {
      await inTenant(tenant, async () => {
        const { meetingId } = await createCandidates();
        const linked = await createRecording();
        await link("transcripts", "event", linked, meetingId);
        const suggested = await createRecording();
        await createCard(suggested, null);

        expect(await readContext(linked)).toBeNull();
        expect(await readContext(suggested)).toBeNull();
      });
    });

    it("throws NotFoundError for a transcript without stored meetingNotes, and for an unknown transcript", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();
        const withoutNotes = await createRecording({ meetingNotes: undefined });

        await expect(readContext(withoutNotes)).rejects.toThrow(NotFoundError);
        await expect(readContext("00000000-0000-4000-8000-000000000000")).rejects.toThrow(NotFoundError);
      });
    });

    it("reads only the calling tenant's Events, participants and projects", async () => {
      const mine = await inTenant(tenant, async () => ({
        ...(await createCandidates()),
        transcriptId: await createRecording(),
      }));
      const theirs = await inTenant(otherTenant, async () => ({
        ...(await createCandidates()),
        transcriptId: await createRecording(),
      }));

      const contextIds = async (tenantId: string, transcriptId: string) =>
        inTenant(tenantId, async () => (await readContext(transcriptId))?.candidates.map(({ id }) => id));

      expect(await contextIds(tenant, mine.transcriptId)).toEqual([mine.meetingId, mine.standupId]);
      expect(await contextIds(otherTenant, theirs.transcriptId)).toEqual([theirs.meetingId, theirs.standupId]);
      await inTenant(tenant, async () => {
        await expect(readContext(theirs.transcriptId)).rejects.toThrow(NotFoundError);
      });
    });
  });

  describe("createTranscriptEventCard", () => {
    it("proposes the recommended Event as a relation, with the complete context and no Event edge", async () => {
      await inTenant(tenant, async () => {
        const { meetingId, standupId, projectId } = await createCandidates();
        const transcriptId = await createRecording();

        const created = await createCard(transcriptId, { eventId: meetingId, reason: " It is about the sprint. " });

        const [card] = await cardsOf(transcriptId);
        expect(await cardsOf(transcriptId)).toHaveLength(1);
        expect(created).toEqual({ cardId: card?.id, recommendedEventId: meetingId, reason: "It is about the sprint." });
        // The card links the recommended Event, which already has its project (Apollo): it proposes no project of its own.
        expect(card?.properties.proposal).not.toHaveProperty("relations");
        const proposal = { entityKind: "relation", target: meetingId, properties: { propertyKey: "event" } };
        expect(card?.properties).toMatchObject({
          kind: "transcript",
          status: "proposed",
          proposal,
          aiProposal: proposal,
          aiVersion: 1,
          history: [
            expect.objectContaining({
              message:
                "2 Events overlapped the recording's time interval, so none was linked; recommended one of them from the recording's content.",
            }),
          ],
          context: {
            role: "event",
            candidates: [
              {
                id: meetingId,
                name: "Sprint planning",
                date: "2024-03-01",
                timeFrom: "13:00",
                timeTo: "13:45",
                endDate: null,
                projectId,
                projectName: "Apollo",
              },
              {
                id: standupId,
                name: "Accountant call",
                date: "2024-03-01",
                timeFrom: "13:30",
                timeTo: "14:00",
                endDate: null,
                projectId: null,
                projectName: null,
              },
            ],
            reason: "It is about the sprint.",
            recommendedEventId: meetingId,
            recording: {
              durationSeconds: DURATION_SECONDS,
              speakerCount: 2,
              quote: { segmentIndex: 1, text: "Let us plan the next sprint for iOS today." },
            },
          },
        });
        // The candidates and the reason live only in `context`.
        expect(Object.keys(card?.properties ?? {})).not.toEqual(expect.arrayContaining(["candidates"]));
        expect(card?.properties).not.toHaveProperty("candidates");
        expect(card?.properties).not.toHaveProperty("reason");
        expect(await eventEdgeCount(transcriptId)).toBe(0);
      });
    });

    it.each([
      ["answers null", (_ids: string[]) => ({ eventId: null, reason: "Cannot tell." }), "Cannot tell."],
      ["answers null with a blank reason", (_ids: string[]) => ({ eventId: null, reason: "   " }), null],
      [
        "answers an id that is not a candidate",
        (_ids: string[]) => ({ eventId: "00000000-0000-4000-8000-000000000001", reason: "It was this one." }),
        null,
      ],
      ["gives no recommendation", (_ids: string[]) => null, null],
    ])(
      "keeps the new-meeting proposal and recommends nothing when the model %s",
      async (_label, recommendationFor, expectedReason) => {
        await inTenant(tenant, async () => {
          const { meetingId, standupId } = await createCandidates();
          const transcriptId = await createRecording();

          const created = await createCard(transcriptId, recommendationFor([meetingId, standupId]));

          const [card] = await cardsOf(transcriptId);
          const proposal = {
            entityKind: "database",
            target: await databaseId("events"),
            properties: {
              name: "Planning call",
              type: "meeting",
              date: "2024-03-01",
              timeFrom: "13:00",
              timeTo: "14:00",
            },
          };
          expect(created).toEqual({ cardId: card?.id, recommendedEventId: null, reason: expectedReason });
          expect(card?.properties).toMatchObject({
            status: "proposed",
            proposal,
            aiProposal: proposal,
            history: [
              expect.objectContaining({
                message:
                  "2 Events overlapped the recording's time interval, so none was linked; none could be recommended from the recording's content; proposed a new Event.",
              }),
            ],
            context: { role: "event", reason: expectedReason, recommendedEventId: null },
          });
          // No recommended Event, so no project to propose, although a candidate has one.
          expect(card?.properties.proposal).not.toHaveProperty("relations");
          expect(await eventEdgeCount(transcriptId)).toBe(0);
        });
      },
    );

    it("names the new meeting after the generated title when the transcript has no name of its own (issue #1830)", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();
        const transcriptId = await createRecording({}, null);

        await createCard(transcriptId, null);

        expect((await cardsOf(transcriptId))[0]?.properties).toMatchObject({
          proposal: { entityKind: "database", properties: { name: "Sprint planning" } },
        });
      });
    });

    it("recommends the second candidate as well, so the membership test looks at every candidate", async () => {
      await inTenant(tenant, async () => {
        const { standupId } = await createCandidates();
        const transcriptId = await createRecording();

        await createCard(transcriptId, { eventId: standupId, reason: "Names the accountant." });

        expect((await cardsOf(transcriptId))[0]?.properties).toMatchObject({
          proposal: { entityKind: "relation", target: standupId },
          context: { recommendedEventId: standupId },
        });
      });
    });

    it("picks the first segment of at least five words as the quote and cuts it to 120 characters by code point", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();
        // 119 ASCII characters, then an emoji as the 120th code point: a cut by UTF-16 unit would keep only its high surrogate.
        const long = `${"ab ".repeat(39)}cd😀 tail end`;
        const transcriptId = await createRecording({
          segments: [
            { speaker: "SPEAKER_00", text: "Four words only here.", startsAt: 0, endsAt: 1 },
            { speaker: "SPEAKER_01", text: `  ${long}  `, startsAt: 1, endsAt: 2 },
            { speaker: "SPEAKER_00", text: "Another sentence with enough words.", startsAt: 2, endsAt: 3 },
          ],
        });

        await createCard(transcriptId, null);

        const context = z
          .object({
            recording: z.object({
              speakerCount: z.number(),
              quote: z.object({ segmentIndex: z.number(), text: z.string() }),
            }),
          })
          .parse((await cardsOf(transcriptId))[0]?.properties.context);
        expect(context.recording.speakerCount).toBe(2);
        expect(context.recording.quote.segmentIndex).toBe(1);
        expect(Array.from(context.recording.quote.text)).toHaveLength(120);
        expect(context.recording.quote.text).toBe(Array.from(long).slice(0, 120).join(""));
        expect(context.recording.quote.text.endsWith("😀")).toBe(true);
      });
    });

    it("has no quote when no segment has five words", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();
        const transcriptId = await createRecording({
          segments: [{ speaker: "SPEAKER_00", text: "Too short.", startsAt: 0, endsAt: 1 }],
        });

        await createCard(transcriptId, null);

        expect((await cardsOf(transcriptId))[0]?.properties.context).toMatchObject({
          recording: { durationSeconds: DURATION_SECONDS, speakerCount: 1, quote: null },
        });
      });
    });

    it.each([
      ["segments", { segments: undefined }],
      ["duration", { durationSeconds: undefined }],
    ])("throws NotFoundError and writes no card when the transcript has no %s", async (_label, computed) => {
      await inTenant(tenant, async () => {
        await createCandidates();
        const transcriptId = await createRecording(computed);

        await expect(createCard(transcriptId, null)).rejects.toThrow(NotFoundError);

        expect(await cardsOf(transcriptId)).toEqual([]);
      });
    });

    it("throws ConflictError and adds no second card when the transcript already has its card", async () => {
      await inTenant(tenant, async () => {
        const { meetingId } = await createCandidates();
        const transcriptId = await createRecording();
        await createCard(transcriptId, { eventId: meetingId, reason: "First." });
        const [first] = await cardsOf(transcriptId);

        await expect(
          withTransaction(dataPool, (client) =>
            createTranscriptEventCard(client, {
              transcriptId,
              candidates: [],
              recommendation: { eventId: null, reason: "Second." },
            }),
          ),
        ).rejects.toThrow(ConflictError);

        expect(await cardsOf(transcriptId)).toEqual([first]);
      });
    });

    it("throws NotFoundError for an unknown transcript", async () => {
      await inTenant(tenant, async () => {
        await expect(
          withTransaction(dataPool, (client) =>
            createTranscriptEventCard(client, {
              transcriptId: "00000000-0000-4000-8000-000000000000",
              candidates: [],
              recommendation: null,
            }),
          ),
        ).rejects.toThrow(NotFoundError);
      });
    });

    it("announces the card once after commit and none when its transaction rolls back", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();
        const rolledBack = await createRecording();
        const kept = await createRecording();
        const events: InboxCardsInvalidationEvent[] = [];
        setInboxCardsInvalidationHook((event) => events.push(event));
        try {
          await expect(
            withTransaction(dataPool, async (client) => {
              const matched = await matchTranscriptToEvent(client, {
                transcriptId: rolledBack,
                durationSeconds: DURATION_SECONDS,
              });
              if (typeof matched === "string") throw new Error("expected an ambiguous match");
              await createTranscriptEventCard(client, {
                transcriptId: rolledBack,
                candidates: matched.candidates,
                recommendation: null,
              });
              throw new Error("force rollback");
            }),
          ).rejects.toThrow("force rollback");
          expect(events).toEqual([]);

          await createCard(kept, null);
          const [card] = await cardsOf(kept);
          expect(events).toEqual([{ op: "created", cardId: card?.id }]);
        } finally {
          setInboxCardsInvalidationHook(() => {});
        }
      });
    });

    it("writes the card only in the calling tenant", async () => {
      const mine = await inTenant(tenant, async () => ({
        ...(await createCandidates()),
        transcriptId: await createRecording(),
      }));
      await inTenant(otherTenant, createCandidates);

      await inTenant(tenant, () => createCard(mine.transcriptId, { eventId: mine.meetingId, reason: "Mine." }));

      expect(await inTenant(tenant, () => cardsOf(mine.transcriptId))).toHaveLength(1);
      const foreignCards = await inTenant(otherTenant, async () => {
        const { rows } = await dataPool.query<{ count: string }>("SELECT count(*) FROM items WHERE database_id = $1", [
          await databaseId("processingProposals"),
        ]);
        return Number(rows[0]?.count);
      });
      expect(foreignCards).toBe(0);
    });
  });

  describe("the project of the recommended Event (issue #1818)", () => {
    const resolve = (eventId: string | null) =>
      withTransaction(dataPool, async (client) =>
        readRecommendedEventProjectId(client, await databaseId("events"), eventId),
      );

    const build = (projectId: string | null) =>
      withTransaction(dataPool, async (client) =>
        buildNewMeetingEnvelope(client, {
          eventsDatabaseId: await databaseId("events"),
          startMs: Date.parse(RECORDING_START),
          durationSeconds: DURATION_SECONDS,
          clock: await getCalendarClock(client),
          projectId,
          name: null,
          locale: "cs",
        }),
      );

    async function trash(moduleId: string, itemId: string): Promise<void> {
      await createChokePoint(dataPool).softDeleteItem(await databaseId(moduleId), itemId);
    }

    it("is the project of the Event the card recommends", async () => {
      await inTenant(tenant, async () => {
        const { meetingId, projectId } = await createCandidates();

        expect(await resolve(meetingId)).toBe(projectId);
      });
    });

    it("is none without a recommendation", async () => {
      await inTenant(tenant, async () => {
        await createCandidates();

        expect(await resolve(null)).toBeNull();
      });
    });

    it("is none for an Event without a project", async () => {
      await inTenant(tenant, async () => {
        const { standupId } = await createCandidates();

        expect(await resolve(standupId)).toBeNull();
      });
    });

    it("is none for an unknown id, an item of another database and an Event in the Trash", async () => {
      await inTenant(tenant, async () => {
        const { meetingId } = await createCandidates();
        const taskId = await createIn("tasks", { name: "A task" });

        expect(await resolve("00000000-0000-4000-8000-000000000001")).toBeNull();
        expect(await resolve(taskId)).toBeNull();
        await trash("events", meetingId);
        expect(await resolve(meetingId)).toBeNull();
      });
    });

    it("is none when the Event's project is in the Trash", async () => {
      await inTenant(tenant, async () => {
        const { meetingId, projectId } = await createCandidates();
        await trash("projects", projectId);

        expect(await resolve(meetingId)).toBeNull();
      });
    });

    it("is none for the Event of another tenant", async () => {
      const theirs = await inTenant(otherTenant, createCandidates);

      await inTenant(tenant, async () => {
        expect(await resolve(theirs.meetingId)).toBeNull();
      });
    });

    it("is carried by the new-meeting envelope as the project relation, and is absent without a project", async () => {
      await inTenant(tenant, async () => {
        const { projectId } = await createCandidates();
        const eventsDatabaseId = await databaseId("events");
        const properties = {
          name: "Schůzka 1. 3.",
          type: "meeting",
          date: "2024-03-01",
          timeFrom: "13:00",
          timeTo: "14:00",
        };

        expect(await build(projectId)).toEqual({
          entityKind: "database",
          target: eventsDatabaseId,
          properties,
          relations: { project: [projectId] },
        });
        expect(await build(null)).toEqual({ entityKind: "database", target: eventsDatabaseId, properties });
      });
    });

    it("refuses a project that is in the Trash or belongs to another tenant, and a Projects item that is not a project", async () => {
      const theirs = await inTenant(otherTenant, createCandidates);
      await inTenant(tenant, async () => {
        const { projectId } = await createCandidates();
        const taskId = await createIn("tasks", { name: "A task" });
        await trash("projects", projectId);

        for (const invalid of [projectId, theirs.projectId, taskId, "00000000-0000-4000-8000-000000000001"])
          await expect(build(invalid)).rejects.toThrow(ValidationError);
      });
    });
  });

  it("matchTranscriptToEvent reports the ambiguity of the calling tenant only", async () => {
    const mine = await inTenant(tenant, async () => ({
      ...(await createCandidates()),
      transcriptId: await createRecording(),
    }));
    await inTenant(otherTenant, createCandidates);

    const result = await inTenant(tenant, () => matchInTransaction(mine.transcriptId));

    expect(
      typeof result === "string"
        ? []
        : result.candidates.flatMap((candidate) => ("id" in candidate ? candidate.id : [])),
    ).toEqual([mine.meetingId, mine.standupId]);
  });
});
