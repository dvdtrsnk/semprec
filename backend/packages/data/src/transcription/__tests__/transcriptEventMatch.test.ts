import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@alldots/shared";
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
import {
  RECORDING_EVENT_DECISION_NO_EVENT,
  recordRecordingIntake,
  setRecordingEventDecision,
} from "../recordingIntake.js";
import { TRANSCRIPTION_OWNER_PROCESS, transcriptionSourceLink } from "../transcriptionJob.js";
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
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

/** Links into processingProposals/sourceTranscript ($3) of the cards ($2) of a transcript ($1). */
const CARDS_SQL = `SELECT i.id, i.properties FROM items i
  JOIN item_relations r ON (r.item_a = i.id AND r.item_b = $1) OR (r.item_b = i.id AND r.item_a = $1)
  JOIN relation_definitions d ON d.id = r.relation_definition_id
  WHERE i.database_id = $2 AND (d.property_id_a = $3 OR d.property_id_b = $3)`;

/** The other end of each transcript ($1) edge through the transcript's `event` property ($2). */
const EVENT_EDGES_SQL = `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
  FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
  WHERE (d.property_id_a = $2 OR d.property_id_b = $2) AND (r.item_a = $1 OR r.item_b = $1)`;

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

function candidateIds(result: Awaited<ReturnType<typeof matchTranscriptToEvent>>): string[] {
  return typeof result === "string"
    ? []
    : result.candidates.flatMap((candidate) => ("id" in candidate ? candidate.id : []));
}

describe("matchTranscriptToEvent", () => {
  let transcriptsId: string;
  let eventsId: string;
  let proposalsId: string;

  async function databaseIdFor(moduleId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
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

  async function storedStart(eventId: string): Promise<{ date: unknown; timeFrom: unknown }> {
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
      [eventsId, eventId],
    );
    if (!rows[0]) throw new Error("Event row missing");
    return { date: rows[0].properties.date, timeFrom: rows[0].properties.timeFrom };
  }

  /**
   * Raw SQL on a valid Event: every write path normalizes or refuses values such as a malformed date,
   * a `24:00` start, an end before the start or a start without an end, so only an old row can hold
   * them; the matcher must still read them defensively.
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

  async function linkedEventIds(transcriptId: string): Promise<string[]> {
    const { rows } = await pool.query<{ other: string }>(EVENT_EDGES_SQL, [
      transcriptId,
      await propertyIdFor(transcriptsId, "event"),
    ]);
    return rows.map((row) => row.other);
  }

  async function cardsFor(transcriptId: string) {
    const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(CARDS_SQL, [
      transcriptId,
      proposalsId,
      await propertyIdFor(proposalsId, "sourceTranscript"),
    ]);
    return rows;
  }

  async function proposalCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    return Number(rows[0]?.count);
  }

  /** Runs the match and asserts it either linked exactly `linkedId` or suggested exactly one announced card. */
  async function expectOutcome(transcriptId: string, linkedId: string | null, durationSeconds?: number) {
    const announced = await capturingInboxCards(async () =>
      expect(await match(transcriptId, durationSeconds)).toBe(linkedId ? "linked" : "suggested"),
    );
    expect(await linkedEventIds(transcriptId)).toEqual(linkedId ? [linkedId] : []);
    const cards = await cardsFor(transcriptId);
    expect(cards).toHaveLength(linkedId ? 0 : 1);
    expect(await proposalCount()).toBe(cards.length);
    expect(announced).toEqual(cards.map((card) => ({ op: "created", cardId: card.id })));
  }

  it("announces nothing when a run converges on its suggestion card or its transaction rolls back", async () => {
    const transcriptId = await createTranscript();
    await match(transcriptId);
    const again = await capturingInboxCards(async () => expect(await match(transcriptId)).toBe("alreadySuggested"));
    expect(again).toEqual([]);

    const rolledBack = await createTranscript();
    const events = await capturingInboxCards(async () => {
      await expect(
        withTransaction(pool, async (client) => {
          const result = await matchTranscriptToEvent(client, {
            transcriptId: rolledBack,
            durationSeconds: DURATION_SECONDS,
          });
          expect(result).toBe("suggested");
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
    });
    expect(events).toEqual([]);
    expect(await cardsFor(rolledBack)).toEqual([]);
  });

  it("creates one proposed transcript card with the new-meeting proposal, also as aiProposal, when no Event matches", async () => {
    const transcriptId = await createTranscript();
    await expectOutcome(transcriptId, null);
    const proposal = {
      entityKind: "database",
      target: eventsId,
      properties: { name: "Schůzka 1. 3.", type: "meeting", date: "2024-03-01", timeFrom: "13:00", timeTo: "14:00" },
    };
    const [card] = await cardsFor(transcriptId);
    expect(card?.properties).toMatchObject({
      kind: "transcript",
      status: "proposed",
      proposal,
      aiVersion: 1,
      referencedItemIds: [],
      history: [
        expect.objectContaining({
          author: "ai",
          message: "0 Events overlapped the recording's time interval, so none was linked; proposed a new Event.",
        }),
      ],
    });
    expect(card?.properties.aiProposal).toEqual(proposal);
    // Without a candidate Event there is no project to propose.
    expect(card?.properties.proposal).not.toHaveProperty("relations");
  });

  it("returns the two overlapping Events as ambiguous and writes neither a card nor an edge, on every run", async () => {
    const transcriptId = await createTranscript();
    const meetingId = await createEvent("meeting", "2024-03-01", {
      timeFrom: "13:00",
      timeTo: "13:30",
      endDate: "2024-03-01",
    });
    const standupId = await createEvent("standup", "2024-03-01", { timeFrom: "13:10" });
    const projectId = (
      await withTransaction(pool, async (client) =>
        createItemWithClient(client, { databaseId: await databaseIdFor("projects"), properties: { name: "Apollo" } }),
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

  it("reports a stored Event without timeTo as a candidate whose timeTo is null", async () => {
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

  interface EventSpec {
    type?: string;
    /** Defaults to 2024-03-01; created through the write path with `at` as its time properties. */
    date?: string;
    at?: Record<string, unknown>;
    /** Stored as is through raw SQL instead (see createRawEvent). */
    raw?: Record<string, unknown>;
    trashed?: boolean;
    /** The start the write path normalized the Event to. */
    stored?: { date: string; timeFrom: string };
    /** This Event is the one the recording links. */
    links?: boolean;
  }

  const span = (timeFrom: string, timeTo: string, more: Record<string, unknown> = {}) => ({
    timeFrom,
    timeTo,
    ...more,
  });
  const VALID_RAW: EventSpec = { type: "standup", raw: { date: "2024-03-01", ...span("13:20", "13:40") }, links: true };
  // Europe/Prague on 2024-03-01 is UTC+1: a recording at 12:52Z for 47 minutes runs 13:52-14:39 local.
  const AFTERNOON = { recording: "2024-03-01T12:52:00.000Z", duration: 47 * 60 };

  // Unless stated, the tenant zone is Europe/Prague and the recording runs 13:00-14:00 local on 2024-03-01.
  it.each<{ why: string; zone?: string; recording?: string; duration?: number; events: EventSpec[] }>([
    { why: "links the one Event whose interval overlaps", events: [{ date: "2024-03-01T11:45:00.000Z", links: true }] },
    {
      why: "links a meeting 12:30-14:00 to a recording 13:52-14:39",
      ...AFTERNOON,
      events: [{ at: span("12:30", "14:00"), links: true }],
    },
    {
      why: "does not link a meeting 13:25-13:40 that ended before a recording 13:52-14:39",
      ...AFTERNOON,
      events: [{ at: span("13:25", "13:40") }],
    },
    {
      why: "links a meeting that began hours before and runs through it",
      events: [{ at: span("09:00", "17:00"), links: true }],
    },
    // Touching boundaries do not overlap; one minute more does.
    { why: "does not link an Event that ends when the recording starts", events: [{ at: span("12:00", "13:00") }] },
    { why: "does not link an Event that starts when the recording ends", events: [{ at: span("14:00", "15:00") }] },
    {
      why: "links an Event that ends one minute after the start",
      events: [{ at: span("12:00", "13:01"), links: true }],
    },
    {
      why: "links an Event that starts one minute before the end",
      events: [{ at: span("13:59", "15:00"), links: true }],
    },
    { why: "considers a meeting", events: [{ type: "meeting", at: span("13:10", "13:50"), links: true }] },
    { why: "considers a standup", events: [{ type: "standup", at: span("13:10", "13:50"), links: true }] },
    { why: "never considers an Event of type event", events: [{ type: "event", at: span("13:10", "13:50") }] },
    { why: "never considers an all-day Event, whatever its type", events: [{ type: "meeting" }, { type: "standup" }] },
    {
      why: "never considers an Event in the Trash",
      events: [{ type: "standup", at: span("13:10", "13:50"), trashed: true }],
    },
    { why: "never considers an Event on another day", events: [{ date: "2024-03-02", at: span("13:10", "13:50") }] },
    {
      // 13:30-14:30 in Prague (UTC+2) is 11:30Z-12:30Z, so it overlaps the recording 11:45Z-12:45Z.
      why: "compares an Event 13:30-14:30 in Europe/Prague (UTC+2) with a recording at 11:45 UTC",
      recording: "2026-10-14T11:45:00.000Z",
      events: [{ date: "2026-10-14", at: span("13:30", "14:30"), links: true }],
    },
    {
      why: "reads the same Event in a UTC tenant as 13:30Z-14:30Z, which the recording misses",
      zone: "UTC",
      recording: "2026-10-14T11:45:00.000Z",
      events: [{ date: "2026-10-14", at: span("13:30", "14:30") }],
    },
    {
      // 22:00 on 2026-10-14 to 02:00 on 2026-10-15 in Prague (UTC+2) is 20:00Z to 00:00Z.
      why: "ends an overnight Event on its endDate: a recording after local midnight is inside it",
      recording: "2026-10-14T23:30:00.000Z",
      duration: 1800,
      events: [{ date: "2026-10-14", at: span("22:00", "02:00", { endDate: "2026-10-15" }), links: true }],
    },
    {
      why: "does not link an overnight Event to a recording that starts after its end on the endDate",
      recording: "2026-10-15T00:30:00.000Z",
      duration: 1800,
      events: [{ date: "2026-10-14", at: span("22:00", "02:00", { endDate: "2026-10-15" }) }],
    },
    // A start with no end is a point: the write rules always add an end, so only an older row lacks one.
    ...[
      { moment: "inside the recording", timeFrom: "13:30", links: true },
      { moment: "exactly at the recording's start", timeFrom: "13:00", links: false },
      { moment: "exactly at the recording's end", timeFrom: "14:00", links: false },
      { moment: "after the recording", timeFrom: "14:30", links: false },
    ].map(({ moment, timeFrom, links }) => ({
      why: `${links ? "links" : "does not link"} an Event without timeTo whose start is ${moment}`,
      events: [{ raw: { date: "2024-03-01", timeFrom }, links }],
    })),
    // Each stored value below would overlap the recording if it were read.
    ...[
      { why: "a date that is not on the calendar", stored: { date: "2024-02-30", ...span("13:10", "13:50") } },
      { why: "a missing date", stored: { date: null, ...span("13:10", "13:50") } },
      { why: "a start that is not a time", stored: { date: "2024-03-01", ...span("nine", "13:50") } },
      { why: "an end that is not a time", stored: { date: "2024-03-01", ...span("13:10", "later") } },
      {
        why: "an endDate not on the calendar",
        stored: { date: "2024-03-01", ...span("13:10", "13:50", { endDate: "2024-03-32" }) },
      },
      {
        why: "a date still carrying an offset",
        stored: { date: "2024-03-01T12:10:00.000Z", ...span("13:10", "13:50") },
      },
      { why: "an end before the start", stored: { date: "2024-03-01", ...span("13:50", "13:10") } },
    ].map(({ why, stored }) => ({
      why: `leaves out an Event with ${why} and still links the valid one`,
      events: [{ raw: stored }, VALID_RAW],
    })),
    {
      // Recording 23:30-00:30 local. A 24:00 start would be the point at midnight, inside it.
      why: "leaves out an Event starting at 24:00 and reads an end of 24:00 as the midnight ending its day",
      recording: "2024-03-01T22:30:00.000Z",
      events: [
        { raw: { date: "2024-03-01", ...span("24:00", "24:00") } },
        { type: "standup", at: span("23:40", "24:00"), links: true },
      ],
    },
    {
      // 12:45 in Prague is 11:45Z, inside the window; 11:20 in Prague is 10:20Z, before it.
      why: "matches an Event normalized to a date and timeFrom by that wall-clock start in Europe/Prague",
      events: [
        { date: "2024-03-01T11:45:00.000Z", stored: { date: "2024-03-01", timeFrom: "12:45" }, links: true },
        { type: "standup", at: { timeFrom: "11:20" }, stored: { date: "2024-03-01", timeFrom: "11:20" } },
      ],
    },
    {
      why: "matches an Event normalized in the America/New_York tenant zone",
      zone: "America/New_York",
      events: [{ date: "2024-03-01T12:10:00.000Z", stored: { date: "2024-03-01", timeFrom: "07:10" }, links: true }],
    },
  ])("$why", async ({ zone, recording = RECORDING_START, duration, events }) => {
    if (zone) await setTenantZone(zone);
    const transcriptId = await createTranscript({ date: recording });
    let linkedId: string | null = null;
    for (const spec of events) {
      const type = spec.type ?? "meeting";
      const id = spec.raw
        ? await createRawEvent(type, spec.raw)
        : await createEvent(type, spec.date ?? "2024-03-01", spec.at);
      if (spec.trashed) await pool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [id]);
      if (spec.stored) expect(await storedStart(id)).toEqual(spec.stored);
      if (spec.links) linkedId = id;
    }
    await expectOutcome(transcriptId, linkedId, duration);
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
      const later = await createEvent("meeting", "2024-03-01", span("13:30", "13:40"));
      const firstOfTie = await createEvent("standup", "2024-03-01", span("13:10", "13:20"));
      const secondOfTie = await createEvent("meeting", "2024-03-01", span("13:10", "13:50"));
      const earliest = await createEvent("meeting", "2024-03-01", span("09:00", "17:00"));

      expect(await list()).toEqual([earliest, ...[firstOfTie, secondOfTie].sort(), later]);
    });

    it("lets a failure other than a refused date or time propagate", async () => {
      await createEvent("meeting", "2024-03-01", span("13:10", "13:50"));
      const broken = (clock: CalendarClock) => ({
        ...clock,
        wallClockToInstant: () => {
          throw new TypeError("clock broke");
        },
      });
      await expect(list(broken)).rejects.toThrow(new TypeError("clock broke"));
    });
  });

  it("links a second recording directly to the one Event that already holds a transcript, and creates no card", async () => {
    const otherTranscriptId = await createTranscript();
    const eventId = await createEvent("meeting", "2024-03-01T12:00:00.000Z");
    expect(await match(otherTranscriptId)).toBe("linked");
    const transcriptId = await createTranscript();

    await expectOutcome(transcriptId, eventId);
    expect(await linkedEventIds(otherTranscriptId)).toEqual([eventId]);
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

  it("re-running on a suggested transcript converges on the same card, even once one Event now matches", async () => {
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

  it("rejects a transcript without a recording date, and an unknown transcript, writing nothing", async () => {
    const transcriptId = await createTranscript({});
    await createEvent("meeting", "2024-03-01T12:00:00.000Z");

    await expect(match(transcriptId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(match(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it("reads the same stored start in the tenant zone: it matches in Europe/Prague and is outside the window in UTC", async () => {
    const pragueEventId = await createEvent("meeting", "2024-03-01", { timeFrom: "13:30" });
    await expectOutcome(await createTranscript(), pragueEventId);

    await setTenantZone("UTC");
    const utcEventId = await createEvent("meeting", "2024-03-01", { timeFrom: "12:15" });
    // In UTC the 13:30 start is after the recording's 13:00 end; only the 12:15 Event is a candidate.
    await expectOutcome(await createTranscript(), utcEventId);
  });

  it("propagates an invalid tenant zone, writing neither an edge nor a card", async () => {
    // An Event write reads the tenant zone (it derives the next occurrence date), so the Event is
    // created while the zone is still valid and the zone is corrupted only afterwards.
    await createEvent("meeting", "2024-03-01", span("12:30", "14:00"));
    const transcriptId = await createTranscript();
    // Raw SQL: the settings write refuses an invalid zone, so only a corrupted row holds one.
    const settingsUpdate = await pool.query(
      'UPDATE items SET properties = properties || \'{"timezone": "Not/AZone"}\'::jsonb WHERE database_id = $1',
      [await withTransaction(pool, (client) => getSystemSettingsDatabaseId(client))],
    );
    expect(settingsUpdate.rowCount).toBe(1);

    const failure = await match(transcriptId).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({ details: { field: "timezone" } });
    expect(await linkedEventIds(transcriptId)).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  async function createUserWithLocale(locale: string): Promise<void> {
    await pool.query("INSERT INTO users (email, password_hash, locale, tenant_id) VALUES ($1, 'unused', $2, $3)", [
      `${locale}@example.com`,
      locale,
      getTenantZeroId(),
    ]);
  }

  async function proposedMeeting(startsAt: string, durationSeconds = DURATION_SECONDS): Promise<unknown> {
    const transcriptId = await createTranscript({ date: startsAt });
    expect(await match(transcriptId, durationSeconds)).toBe("suggested");
    const [card] = await cardsFor(transcriptId);
    return z.object({ properties: z.record(z.string(), z.unknown()) }).parse(card?.properties.proposal).properties;
  }

  const meeting = (name: string, date: string, timeFrom: string, timeTo: string, endDate?: string) => ({
    name,
    type: "meeting",
    date,
    timeFrom,
    timeTo,
    ...(endDate ? { endDate } : {}),
  });
  const [OCT_14, OCT_4] = ["Schůzka 14. 10.", "2024-10-04"];

  // Prague is on summer time (UTC+2) in October 2024 and on winter time (UTC+1) in March. Starts are UTC.
  it.each<[string, string, number | undefined, object, { zone?: string; locale?: string }?]>([
    ["runs 13:52 + 47:10 to 14:39", "2024-10-14T11:52", 47 * 60 + 10, meeting(OCT_14, "2024-10-14", "13:52", "14:39")],
    [
      "is named for an en user",
      "2024-10-04T11:52",
      1800,
      meeting("Meeting 4/10", OCT_4, "13:52", "14:22"),
      { locale: "en" },
    ],
    [
      "is named for a cs user",
      "2024-10-04T11:52",
      1800,
      meeting("Schůzka 4. 10.", OCT_4, "13:52", "14:22"),
      { locale: "cs" },
    ],
    [
      "is named for a de user",
      "2024-10-04T11:52",
      1800,
      meeting("Meeting 4/10", OCT_4, "13:52", "14:22"),
      { locale: "de" },
    ],
    [
      "crossing local midnight ends the next day",
      "2024-10-14T21:50",
      1800,
      meeting(OCT_14, "2024-10-14", "23:50", "00:20", "2024-10-15"),
    ],
    [
      "ending at local midnight ends the next day",
      "2024-10-14T21:30",
      1800,
      meeting(OCT_14, "2024-10-14", "23:30", "00:00", "2024-10-15"),
    ],
    // A span the Events rules accept: a recording shorter than a minute ends one minute after its start.
    [
      "of 20 seconds ends a minute after its start",
      "2024-10-14T11:52:30",
      20,
      meeting(OCT_14, "2024-10-14", "13:52", "13:53"),
    ],
    // At 23:30 UTC on 2024-03-01 it is already the 2nd in Prague, still the 1st in UTC, where it crosses midnight.
    [
      "is on the local date in Europe/Prague",
      "2024-03-01T23:30",
      undefined,
      meeting("Schůzka 2. 3.", "2024-03-02", "00:30", "01:30"),
    ],
    [
      "is on the local date in UTC",
      "2024-03-01T23:30",
      undefined,
      meeting("Schůzka 1. 3.", "2024-03-01", "23:30", "00:30", "2024-03-02"),
      { zone: "UTC" },
    ],
  ])("the proposed meeting %s", async (_why, startsAt, duration, expected, tenantSetup = {}) => {
    if (tenantSetup.zone) await setTenantZone(tenantSetup.zone);
    if (tenantSetup.locale) await createUserWithLocale(tenantSetup.locale);
    expect(await proposedMeeting(new Date(`${startsAt}Z`).toISOString(), duration)).toEqual(expected);
  });

  const PROPOSED_NOTES = {
    title: "Pricing review with {SPEAKER_00}",
    summary: "{SPEAKER_00} presents the pricing.",
    shortSummary: "Pricing reviewed.",
    decisions: [],
    actionItems: [],
  };

  const BLANK_TITLE = { ...PROPOSED_NOTES, title: "  " };
  it.each<[string, string | undefined, Record<string, unknown> | undefined, string, string?]>([
    ["after the transcript's own name, ahead of the title", "Pricing call", PROPOSED_NOTES, "Pricing call"],
    [
      "after the generated title with speaker tokens replaced",
      undefined,
      PROPOSED_NOTES,
      "Pricing review with Mluvčí 1",
    ],
    [
      "after the generated title in the user's English",
      undefined,
      PROPOSED_NOTES,
      "Pricing review with Speaker 1",
      "en",
    ],
    ["after the generated title for a blank transcript name", "   ", PROPOSED_NOTES, "Pricing review with Mluvčí 1"],
    ["by the recording's day for a blank name and no notes", "", undefined, "Schůzka 1. 3."],
    ["by the recording's day for a blank name and title", "", BLANK_TITLE, "Schůzka 1. 3."],
  ])("names the new meeting %s", async (_why, name, notes, expected, locale) => {
    if (locale) await createUserWithLocale(locale);
    const transcriptId = await createTranscript({ date: RECORDING_START, ...(name === undefined ? {} : { name }) });
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
    expect(card?.properties.proposal).toMatchObject({ properties: { name: expected } });
  });
});

describe("transcript Event matching per tenant, through the runtime role", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let tenant: string;
  let otherTenant: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
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

  const createMeeting = (name: string, timeFrom = "13:00", timeTo: string | null = "13:45") =>
    createIn("events", { name, type: "meeting", date: "2024-03-01", timeFrom, ...(timeTo ? { timeTo } : {}) });

  /** 13:00-14:00 Prague time (12:00Z, an hour long), with the computed values the pipeline stores. */
  async function createRecording(
    computed: Record<string, unknown> = {},
    name: string | null = "Planning call",
    fileItemId: string | null = null,
  ): Promise<string> {
    const transcriptsId = await databaseId("transcripts");
    return withTransaction(dataPool, async (client) => {
      const item = await createItemWithClient(
        client,
        {
          databaseId: transcriptsId,
          properties: {
            ...(name === null ? {} : { name }),
            date: RECORDING_START,
            ...(fileItemId === null ? {} : { link: transcriptionSourceLink(fileItemId) }),
          },
        },
        { allowedSystemKeys: ["date", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
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

  async function createCandidates() {
    const meetingId = await createMeeting("Sprint planning");
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

  const withRecording = async () => ({ ...(await createCandidates()), transcriptId: await createRecording() });

  /** The two candidates of createCandidates as the card context and the recommendation context report them. */
  const expectedCandidates = (c: { meetingId: string; standupId: string; projectId: string }) => [
    {
      id: c.meetingId,
      name: "Sprint planning",
      date: "2024-03-01",
      timeFrom: "13:00",
      timeTo: "13:45",
      endDate: null,
      projectId: c.projectId,
      projectName: "Apollo",
    },
    {
      id: c.standupId,
      name: "Accountant call",
      date: "2024-03-01",
      timeFrom: "13:30",
      timeTo: "14:00",
      endDate: null,
      projectId: null,
      projectName: null,
    },
  ];

  const readContext = (transcriptId: string) =>
    withTransaction(dataPool, (client) =>
      readEventRecommendationContext(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
    );

  const match = (transcriptId: string) =>
    withTransaction(dataPool, (client) =>
      matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS }),
    );

  async function createCard(transcriptId: string, recommendation: EventRecommendation | null) {
    return withTransaction(dataPool, async (client) => {
      const matched = await matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS });
      if (typeof matched === "string") throw new Error(`Expected an ambiguous match, got '${matched}'`);
      return createTranscriptEventCard(client, { transcriptId, candidates: matched.candidates, recommendation });
    });
  }

  async function cardsOf(transcriptId: string) {
    const { rows } = await dataPool.query<{ id: string; properties: Record<string, unknown> }>(CARDS_SQL, [
      transcriptId,
      await databaseId("processingProposals"),
      await relationPropertyId("processingProposals", "sourceTranscript"),
    ]);
    return rows;
  }

  async function eventEdgeCount(transcriptId: string): Promise<number> {
    const { rows } = await dataPool.query<{ other: string }>(EVENT_EDGES_SQL, [
      transcriptId,
      await relationPropertyId("transcripts", "event"),
    ]);
    return rows.length;
  }

  it("converts each tenant's Event start in its own zone and links only that tenant's Event, once", async () => {
    // 12:45 in Prague and 06:45 in New York are both 11:45Z, inside the window. Read in the other
    // tenant's zone either start would be outside it, and a visible foreign Event would make two candidates.
    const arrange = (tenantId: string, zone: string | null, timeFrom: string) =>
      runInTenant(tenantId, async () => {
        if (zone) {
          const settings = await withTransaction(dataPool, async (client) => ({
            databaseId: await getSystemSettingsDatabaseId(client),
            itemId: await getSystemSettingsItemId(client),
          }));
          await createChokePoint(dataPool).updateItem({ ...settings, propertiesPatch: { timezone: zone } });
        }
        return { eventId: await createMeeting("Sync", timeFrom, null), transcriptId: await createRecording() };
      });
    const prague = await arrange(tenant, null, "12:45");
    const newYork = await arrange(otherTenant, "America/New_York", "06:45");
    const edgesOf = (tenantId: string, transcriptId: string) =>
      runInTenant(tenantId, async () => {
        const { rows } = await dataPool.query<{ other: string }>(EVENT_EDGES_SQL, [
          transcriptId,
          await relationPropertyId("transcripts", "event"),
        ]);
        return rows.map((row) => row.other);
      });

    expect(await runInTenant(tenant, () => match(prague.transcriptId))).toBe("linked");
    expect(await runInTenant(otherTenant, () => match(newYork.transcriptId))).toBe("linked");
    expect(await edgesOf(tenant, prague.transcriptId)).toEqual([prague.eventId]);
    expect(await edgesOf(otherTenant, newYork.transcriptId)).toEqual([newYork.eventId]);

    expect(await runInTenant(tenant, () => match(prague.transcriptId))).toBe("alreadyLinked");
    expect(await edgesOf(tenant, prague.transcriptId)).toEqual([prague.eventId]);
  });

  it("reports the ambiguity of the calling tenant only", async () => {
    const mine = await runInTenant(tenant, withRecording);
    await runInTenant(otherTenant, createCandidates);

    expect(candidateIds(await runInTenant(tenant, () => match(mine.transcriptId)))).toEqual([
      mine.meetingId,
      mine.standupId,
    ]);
  });

  describe("readEventRecommendationContext", () => {
    it("returns the candidates with their project and sorted participant names, the rendered notes and the locale", async () => {
      await adminPool.query(
        "INSERT INTO users (email, password_hash, locale, tenant_id) VALUES ($1, 'unused', 'en', $2)",
        ["reader@example.com", tenant],
      );
      await runInTenant(tenant, async () => {
        const fixture = await withRecording();
        const [meeting, standup] = expectedCandidates(fixture);
        expect(await readContext(fixture.transcriptId)).toEqual({
          candidates: [
            { ...meeting, participantNames: ["Alice", "Zora"] },
            { ...standup, participantNames: [] },
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
      await runInTenant(tenant, async () => {
        expect((await readContext((await withRecording()).transcriptId))?.locale).toBe("cs");
      });
    });

    it("leaves a project in the Trash and a participant in the Trash out", async () => {
      await runInTenant(tenant, async () => {
        const { meetingId, projectId } = await createCandidates();
        const [alice] = (
          await dataPool.query<{ id: string }>("SELECT id FROM items WHERE properties ->> 'name' = 'Alice'")
        ).rows;
        if (!alice) throw new Error("Missing Alice");
        const chokePoint = createChokePoint(dataPool);
        await chokePoint.softDeleteItem(await databaseId("projects"), projectId);
        await chokePoint.softDeleteItem(await databaseId("people"), alice.id);

        const candidate = (await readContext(await createRecording()))?.candidates.find(({ id }) => id === meetingId);

        expect(candidate).toMatchObject({ projectId: null, projectName: null, participantNames: ["Zora"] });
      });
    });

    it("returns null when no Event or only one overlaps, or once the transcript is linked or has its card", async () => {
      await runInTenant(tenant, async () => {
        expect(await readContext(await createRecording())).toBeNull();
        await createMeeting("Only", "13:00", "13:30");
        expect(await readContext(await createRecording())).toBeNull();
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
      await runInTenant(tenant, async () => {
        await createCandidates();
        await expect(readContext(await createRecording({ meetingNotes: undefined }))).rejects.toThrow(NotFoundError);
        await expect(readContext(UNKNOWN_ID)).rejects.toThrow(NotFoundError);
      });
    });

    it("reads only the calling tenant's Events, participants and projects", async () => {
      const mine = await runInTenant(tenant, withRecording);
      const theirs = await runInTenant(otherTenant, withRecording);
      const contextIds = (tenantId: string, transcriptId: string) =>
        runInTenant(tenantId, async () => (await readContext(transcriptId))?.candidates.map(({ id }) => id));

      expect(await contextIds(tenant, mine.transcriptId)).toEqual([mine.meetingId, mine.standupId]);
      expect(await contextIds(otherTenant, theirs.transcriptId)).toEqual([theirs.meetingId, theirs.standupId]);
      await runInTenant(tenant, async () => {
        await expect(readContext(theirs.transcriptId)).rejects.toThrow(NotFoundError);
      });
    });
  });

  describe("createTranscriptEventCard", () => {
    it("proposes the recommended Event as a relation, with the complete context and no Event edge", async () => {
      await runInTenant(tenant, async () => {
        const fixture = await withRecording();
        const { meetingId, transcriptId } = fixture;

        const created = await createCard(transcriptId, { eventId: meetingId, reason: " It is about the sprint. " });

        const cards = await cardsOf(transcriptId);
        expect(cards).toHaveLength(1);
        const properties = cards[0]?.properties;
        expect(created).toEqual({
          cardId: cards[0]?.id,
          recommendedEventId: meetingId,
          reason: "It is about the sprint.",
        });
        // The card links the recommended Event, which already has its project (Apollo): it proposes no project of its own.
        expect(properties?.proposal).not.toHaveProperty("relations");
        const proposal = { entityKind: "relation", target: meetingId, properties: { propertyKey: "event" } };
        expect(properties).toMatchObject({
          kind: "transcript",
          status: "proposed",
          proposal,
          aiProposal: proposal,
          aiVersion: 1,
          referencedItemIds: [meetingId],
          history: [
            expect.objectContaining({
              message:
                "2 Events overlapped the recording's time interval, so none was linked; recommended one of them from the recording's content.",
            }),
          ],
          context: {
            role: "event",
            candidates: expectedCandidates(fixture),
            reason: "It is about the sprint.",
            recommendedEventId: meetingId,
            recording: {
              durationSeconds: DURATION_SECONDS,
              speakerCount: 2,
              quote: { segmentIndex: 1, text: "Let us plan the next sprint for iOS today." },
            },
          },
        });
        expect(properties).not.toHaveProperty("candidates");
        expect(properties).not.toHaveProperty("reason");
        expect(await eventEdgeCount(transcriptId)).toBe(0);
      });
    });

    it.each<[string, EventRecommendation | null, string | null]>([
      ["answers null", { eventId: null, reason: "Cannot tell." }, "Cannot tell."],
      ["answers null with a blank reason", { eventId: null, reason: "   " }, null],
      [
        "answers an id that is not a candidate",
        { eventId: "00000000-0000-4000-8000-000000000001", reason: "It was this one." },
        null,
      ],
      ["gives no recommendation", null, null],
    ])(
      "keeps the new-meeting proposal and recommends nothing when the model %s",
      async (_label, recommendation, expectedReason) => {
        await runInTenant(tenant, async () => {
          const { transcriptId } = await withRecording();

          const created = await createCard(transcriptId, recommendation);

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

    it("names the new meeting after the generated title when the transcript has no name of its own", async () => {
      await runInTenant(tenant, async () => {
        await createCandidates();
        const transcriptId = await createRecording({}, null);

        await createCard(transcriptId, null);

        expect((await cardsOf(transcriptId))[0]?.properties).toMatchObject({
          proposal: { entityKind: "database", properties: { name: "Sprint planning" } },
        });
      });
    });

    it("recommends the second candidate as well, so the membership test looks at every candidate", async () => {
      await runInTenant(tenant, async () => {
        const { standupId, transcriptId } = await withRecording();

        await createCard(transcriptId, { eventId: standupId, reason: "Names the accountant." });

        expect((await cardsOf(transcriptId))[0]?.properties).toMatchObject({
          proposal: { entityKind: "relation", target: standupId },
          context: { recommendedEventId: standupId },
        });
      });
    });

    it("picks the first segment of at least five words as the quote and cuts it to 120 characters by code point", async () => {
      await runInTenant(tenant, async () => {
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

        const { recording } = z
          .object({
            recording: z.object({
              speakerCount: z.number(),
              quote: z.object({ segmentIndex: z.number(), text: z.string() }),
            }),
          })
          .parse((await cardsOf(transcriptId))[0]?.properties.context);
        expect(recording.speakerCount).toBe(2);
        expect(recording.quote.segmentIndex).toBe(1);
        expect(Array.from(recording.quote.text)).toHaveLength(120);
        expect(recording.quote.text).toBe(Array.from(long).slice(0, 120).join(""));
        expect(recording.quote.text.endsWith("😀")).toBe(true);
      });
    });

    it("has no quote when no segment has five words", async () => {
      await runInTenant(tenant, async () => {
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
      await runInTenant(tenant, async () => {
        await createCandidates();
        const transcriptId = await createRecording(computed);

        await expect(createCard(transcriptId, null)).rejects.toThrow(NotFoundError);

        expect(await cardsOf(transcriptId)).toEqual([]);
      });
    });

    it("throws ConflictError for a transcript that already has its card and NotFoundError for an unknown one", async () => {
      await runInTenant(tenant, async () => {
        const { meetingId, transcriptId } = await withRecording();
        await createCard(transcriptId, { eventId: meetingId, reason: "First." });
        const [first] = await cardsOf(transcriptId);
        const create = (id: string) =>
          withTransaction(dataPool, (client) =>
            createTranscriptEventCard(client, {
              transcriptId: id,
              candidates: [],
              recommendation: { eventId: null, reason: "Second." },
            }),
          );

        await expect(create(transcriptId)).rejects.toThrow(ConflictError);
        expect(await cardsOf(transcriptId)).toEqual([first]);
        await expect(create(UNKNOWN_ID)).rejects.toThrow(NotFoundError);
      });
    });

    it("announces the card once after commit and none when its transaction rolls back", async () => {
      await runInTenant(tenant, async () => {
        await createCandidates();
        const rolledBack = await createRecording();
        const kept = await createRecording();
        const rolledBackEvents = await capturingInboxCards(() =>
          expect(
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
          ).rejects.toThrow("force rollback"),
        );
        expect(rolledBackEvents).toEqual([]);

        const keptEvents = await capturingInboxCards(() => createCard(kept, null));
        const [card] = await cardsOf(kept);
        expect(keptEvents).toEqual([{ op: "created", cardId: card?.id }]);
      });
    });

    it("writes the card only in the calling tenant", async () => {
      const mine = await runInTenant(tenant, withRecording);
      await runInTenant(otherTenant, createCandidates);

      await runInTenant(tenant, () => createCard(mine.transcriptId, { eventId: mine.meetingId, reason: "Mine." }));

      expect(await runInTenant(tenant, () => cardsOf(mine.transcriptId))).toHaveLength(1);
      const foreignCards = await runInTenant(otherTenant, async () => {
        const { rows } = await dataPool.query<{ count: string }>("SELECT count(*) FROM items WHERE database_id = $1", [
          await databaseId("processingProposals"),
        ]);
        return Number(rows[0]?.count);
      });
      expect(foreignCards).toBe(0);
    });
  });

  describe("the project of the recommended Event", () => {
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

    type Candidates = Awaited<ReturnType<typeof createCandidates>>;
    it.each<[string, (c: Candidates) => Promise<string | null>, boolean]>([
      ["is the project of the Event the card recommends", async (c) => c.meetingId, true],
      ["is none without a recommendation", async () => null, false],
      ["is none for an Event without a project", async (c) => c.standupId, false],
      ["is none for an unknown id", async () => "00000000-0000-4000-8000-000000000001", false],
      ["is none for an item of another database", () => createIn("tasks", { name: "A task" }), false],
      [
        "is none for an Event in the Trash",
        async (c) => {
          await trash("events", c.meetingId);
          return c.meetingId;
        },
        false,
      ],
      [
        "is none when the Event's project is in the Trash",
        async (c) => {
          await trash("projects", c.projectId);
          return c.meetingId;
        },
        false,
      ],
    ])("%s", async (_label, arrange, hasProject) => {
      await runInTenant(tenant, async () => {
        const candidates = await createCandidates();
        expect(await resolve(await arrange(candidates))).toBe(hasProject ? candidates.projectId : null);
      });
    });

    it("is none for the Event of another tenant", async () => {
      const theirs = await runInTenant(otherTenant, createCandidates);
      expect(await runInTenant(tenant, () => resolve(theirs.meetingId))).toBeNull();
    });

    it("is carried by the new-meeting envelope as the project relation, and is absent without a project", async () => {
      await runInTenant(tenant, async () => {
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
      const theirs = await runInTenant(otherTenant, createCandidates);
      await runInTenant(tenant, async () => {
        const { projectId } = await createCandidates();
        const taskId = await createIn("tasks", { name: "A task" });
        await trash("projects", projectId);

        for (const invalid of [projectId, theirs.projectId, taskId, "00000000-0000-4000-8000-000000000001"])
          await expect(build(invalid)).rejects.toThrow(ValidationError);
      });
    });
  });

  describe("the explicit no-event decision of a recording request", () => {
    async function createRecordingFile(withRequest = true, eventId: string | null = null): Promise<string> {
      return withTransaction(dataPool, async (client) => {
        const file = await createItemWithClient(client, {
          databaseId: await databaseId("files"),
          properties: { name: "Call.mp3" },
        });
        if (withRequest) await recordRecordingIntake(client, { fileItemId: file.id, eventId, recordedAt: null });
        return file.id;
      });
    }

    const transcriptOf = (fileItemId: string | null) => createRecording({}, "Planning call", fileItemId);

    const decideNoEvent = (fileItemId: string) =>
      withTransaction(dataPool, (client) =>
        setRecordingEventDecision(client, fileItemId, RECORDING_EVENT_DECISION_NO_EVENT),
      );

    const counts = async (transcriptId: string) => ({
      cards: (await cardsOf(transcriptId)).length,
      edges: await eventEdgeCount(transcriptId),
    });

    it("creates no card and no edge when the decision is noEvent, also on a rerun of the transcription", async () => {
      await runInTenant(tenant, async () => {
        const fileId = await createRecordingFile();
        await decideNoEvent(fileId);
        const transcriptId = await transcriptOf(fileId);

        expect(await match(transcriptId)).toBe("noEventChosen");
        expect(await match(transcriptId)).toBe("noEventChosen");
        expect(await counts(transcriptId)).toEqual({ cards: 0, edges: 0 });
      });
    });

    it("links nothing and asks no recommendation when Events overlap the recording and the decision is noEvent", async () => {
      await runInTenant(tenant, async () => {
        const fileId = await createRecordingFile();
        const transcriptId = await transcriptOf(fileId);
        await createMeeting("Sprint planning");
        await decideNoEvent(fileId);

        expect(await match(transcriptId)).toBe("noEventChosen");
        expect(await eventEdgeCount(transcriptId)).toBe(0);

        await createMeeting("Accountant call");
        expect(await readContext(transcriptId)).toBeNull();
        expect(await match(transcriptId)).toBe("noEventChosen");
        expect(await counts(transcriptId)).toEqual({ cards: 0, edges: 0 });
      });
    });

    it("still reads the recommendation context for two overlapping Events when the decision is the default", async () => {
      await runInTenant(tenant, async () => {
        const transcriptId = await transcriptOf(await createRecordingFile());
        await createMeeting("Sprint planning");
        await createMeeting("Accountant call");

        expect((await readContext(transcriptId))?.candidates).toHaveLength(2);
      });
    });

    it("returns noEventChosen before alreadyLinked and before alreadySuggested, and leaves the edge and the card as they are", async () => {
      await runInTenant(tenant, async () => {
        const linkedFile = await createRecordingFile();
        const linkedTranscript = await transcriptOf(linkedFile);
        await createMeeting("Sprint planning");
        expect(await match(linkedTranscript)).toBe("linked");
        await decideNoEvent(linkedFile);
        expect(await match(linkedTranscript)).toBe("noEventChosen");
        expect(await eventEdgeCount(linkedTranscript)).toBe(1);

        const suggestedFile = await createRecordingFile();
        const suggestedTranscript = await transcriptOf(suggestedFile);
        // Raw SQL: moves the recording a day later, so the Event of the first recording does not overlap it.
        await dataPool.query(
          'UPDATE items SET properties = properties || \'{"date":"2024-03-02T12:00:00.000Z"}\'::jsonb WHERE database_id = $1 AND id = $2',
          [await databaseId("transcripts"), suggestedTranscript],
        );
        expect(await match(suggestedTranscript)).toBe("suggested");
        await decideNoEvent(suggestedFile);
        expect(await match(suggestedTranscript)).toBe("noEventChosen");
        expect((await cardsOf(suggestedTranscript)).length).toBe(1);
      });
    });

    it("creates the recording-without-an-event card with the default decision, and converges on it on a rerun", async () => {
      await runInTenant(tenant, async () => {
        const transcriptId = await transcriptOf(await createRecordingFile());

        expect(await match(transcriptId)).toBe("suggested");
        expect(await match(transcriptId)).toBe("alreadySuggested");
        expect(await counts(transcriptId)).toEqual({ cards: 1, edges: 0 });
      });
    });

    it("changes nothing for a request that names an Event with the default decision: the edge stays and no card follows", async () => {
      await runInTenant(tenant, async () => {
        const eventId = await createMeeting("Sprint planning");
        const transcriptId = await transcriptOf(await createRecordingFile(true, eventId));
        await link("transcripts", "event", transcriptId, eventId);

        expect(await match(transcriptId)).toBe("alreadyLinked");
        expect(await match(transcriptId)).toBe("alreadyLinked");
        expect(await counts(transcriptId)).toEqual({ cards: 0, edges: 1 });
        expect(await readContext(transcriptId)).toBeNull();
      });
    });

    it("is not affected by a stored value other than noEvent", async () => {
      await runInTenant(tenant, async () => {
        const fileId = await createRecordingFile();
        // No writer of another value exists; this fixture creates the stored shape the match must not honor.
        const updated = await dataPool.query(
          "UPDATE recording_requests SET event_decision = 'someFutureValue' WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
          [fileId],
        );
        expect(updated.rowCount).toBe(1);

        expect(await match(await transcriptOf(fileId))).toBe("suggested");
      });
    });

    it("is not affected for a transcript whose Files item has no recording request, and for one with no link", async () => {
      await runInTenant(tenant, async () => {
        expect(await match(await transcriptOf(await createRecordingFile(false)))).toBe("suggested");
        expect(await match(await transcriptOf(null))).toBe("suggested");
      });
    });

    it("does not honor another tenant's decision for the same Files item id", async () => {
      const foreignFileId = await runInTenant(otherTenant, async () => {
        const fileId = await createRecordingFile();
        await decideNoEvent(fileId);
        return fileId;
      });
      await runInTenant(tenant, async () => {
        expect(await match(await transcriptOf(foreignFileId))).toBe("suggested");
      });
    });
  });
});
