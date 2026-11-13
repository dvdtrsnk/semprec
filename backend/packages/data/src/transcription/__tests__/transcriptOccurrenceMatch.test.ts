import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../../auth/usersStore.js";
import { materializeEventOccurrence } from "../../calendar/materializeEventOccurrence.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { CardinalityViolationError } from "../../errors.js";
import { confirmProposalWithClient } from "../../inbox/proposalActions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import {
  createTranscriptEventCard,
  matchTranscriptToEvent,
  type EventRecommendation,
} from "../transcriptEventMatch.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let userId: string;

const USER: WriterIdentity = { writerKind: "user" };
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
const EVERY_DAY = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };

/** A Standup that repeats Monday to Friday from Monday 12 October 2026, 9:00-9:30. */
const STANDUP = {
  name: "Standup",
  type: "standup",
  date: "2026-10-12",
  timeFrom: "09:00",
  timeTo: "09:30",
  recurrence: WEEKDAYS,
};

// A seeded tenant's zone is Europe/Prague, which is UTC+2 on 14 October 2026: 9:01 local is 07:01Z.
const WEDNESDAY_9_01 = "2026-10-14T07:01:00.000Z";
const TWENTY_MINUTES = 20 * 60;

/** A tenant with one English-speaking user, seeded as production seeds one. */
async function seededTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return { tenantId, userId: user.id };
}

describe("matching a recording to a virtual occurrence of a recurring Event (issue gh-1850)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    const seeded = await seededTenant();
    tenant = seeded.tenantId;
    userId = seeded.userId;
    foreign = (await seededTenant()).tenantId;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The ids of the tenant in scope and its writes; every write of a test goes through the choke point or a store. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const event = async (properties: Record<string, unknown>) =>
      (await cp.createItem({ databaseId: db("events"), properties }, userId, userId, USER)).id;
    /** A transcript with the computed values steps 1 and 4 leave, which the card reads for its recording facts. */
    const transcript = async (date: string) =>
      withTransaction(runtime, async (client) => {
        const item = await createItemWithClient(
          client,
          { databaseId: db("transcripts"), properties: { date } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await itemsStore.writeComputed(client, item.databaseId, item.id, "segments", [
          { speaker: "SPEAKER_00", text: "Good morning everyone." },
        ]);
        await itemsStore.writeComputed(client, item.databaseId, item.id, "durationSeconds", TWENTY_MINUTES);
        return item.id;
      });
    const match = (transcriptId: string, durationSeconds = TWENTY_MINUTES) =>
      withTransaction(runtime, (client) => matchTranscriptToEvent(client, { transcriptId, durationSeconds }));
    /** What the worker's match step does with an ambiguous match: the card of its candidates, in one transaction. */
    const propose = (transcriptId: string, recommendation: EventRecommendation | null = null) =>
      withTransaction(runtime, async (client) => {
        const result = await matchTranscriptToEvent(client, { transcriptId, durationSeconds: TWENTY_MINUTES });
        if (typeof result === "string" || result.outcome !== "ambiguous")
          throw new Error(`Expected an ambiguous match, got ${JSON.stringify(result)}`);
        return createTranscriptEventCard(client, { transcriptId, candidates: result.candidates, recommendation });
      });
    const card = async (cardId: string) => {
      const item = await withTransaction(runtime, (client) =>
        itemsStore.getItemById(client, db("processingProposals"), cardId),
      );
      if (!item) throw new Error(`Missing card ${cardId}`);
      return item.properties;
    };
    const confirm = (cardId: string) =>
      withTransaction(runtime, (client) =>
        confirmProposalWithClient(
          client,
          { processingProposalsDatabaseId: db("processingProposals") },
          cardId,
          undefined,
          userId,
        ),
      );
    const materialize = (seriesId: string, occurrenceDate: string) =>
      withTransaction(runtime, (client) =>
        materializeEventOccurrence(client, { seriesId, occurrenceDate, options: { writer: USER } }),
      );
    const eventIds = async () => (await cp.listItems(db("events"), { limit: 100 })).items.map((item) => item.id).sort();
    const cardIds = async () =>
      (await cp.listItems(db("processingProposals"), { limit: 100 })).items.map((item) => item.id).sort();
    /** The Event ids linked to the transcript through Transcripts.event. */
    const linked = async (transcriptId: string) =>
      ((await cp.listItemRelations(transcriptId)) ?? [])
        .filter((entry) => entry.propertyKey === "event")
        .map((entry) => entry.targetItemId)
        .sort();
    return { cp, db, event, transcript, match, propose, card, confirm, materialize, eventIds, cardIds, linked };
  }

  it("creates a card with the occurrence as a candidate and writes no Event and no edge when a recording overlaps a virtual occurrence", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const transcript = await f.transcript(WEDNESDAY_9_01);
      const eventsBefore = await f.eventIds();

      expect(await f.match(transcript)).toEqual({
        outcome: "ambiguous",
        candidates: [{ seriesId: series, occurrenceDate: "2026-10-14" }],
      });
      expect(await f.eventIds()).toEqual(eventsBefore);
      expect(await f.linked(transcript)).toEqual([]);
      expect(await f.cardIds()).toEqual([]);

      const created = await f.propose(transcript);

      expect(created.recommendedEventId).toBeNull();
      const stored = await f.card(created.cardId);
      const proposal = { entityKind: "relation", target: `${series}@2026-10-14`, properties: { propertyKey: "event" } };
      expect(stored).toMatchObject({
        kind: "transcript",
        status: "proposed",
        proposal,
        aiProposal: proposal,
        context: {
          role: "event",
          candidates: [{ seriesId: series, occurrenceDate: "2026-10-14" }],
          reason: null,
          recommendedEventId: null,
        },
        history: [expect.objectContaining({ author: "ai", message: expect.stringContaining("One occurrence") })],
      });
      // The worker wrote the card and nothing else: no Event, no edge, and the occurrence is still virtual.
      expect(await f.eventIds()).toEqual(eventsBefore);
      expect(await f.linked(transcript)).toEqual([]);
      expect(await f.cardIds()).toEqual([created.cardId]);
    }));

  it("keeps the same card on a rerun and reports the transcript as already suggested", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      await f.event(STANDUP);
      const transcript = await f.transcript(WEDNESDAY_9_01);
      const created = await f.propose(transcript);

      expect(await f.match(transcript)).toBe("alreadySuggested");

      expect(await f.cardIds()).toEqual([created.cardId]);
    }));

  it("materializes the occurrence when the card is confirmed and links the recording only to it, the other occurrences staying virtual", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const transcript = await f.transcript(WEDNESDAY_9_01);
      const { cardId } = await f.propose(transcript);
      const eventsBefore = await f.eventIds();

      const confirmed = await f.confirm(cardId);

      const created = (await f.eventIds()).filter((id) => !eventsBefore.includes(id));
      expect(created).toHaveLength(1);
      const [occurrenceId] = created;
      expect(await f.linked(transcript)).toEqual([occurrenceId]);
      expect(await f.cp.getItem(f.db("events"), occurrenceId ?? "")).toMatchObject({
        properties: { seriesId: series, occurrenceDate: "2026-10-14", date: "2026-10-14", timeFrom: "09:00" },
      });
      // Nothing is linked to the series Event, and no other date got an item: 12, 13, 15 and 16 October are virtual.
      expect(await f.eventIds()).toEqual([...eventsBefore, occurrenceId].sort());
      expect(confirmed.properties).toMatchObject({
        status: "confirmed",
        results: [expect.objectContaining({ itemId: transcript, linkLabels: ["Standup"] })],
      });
    }));

  it("links the same Event and creates no second one when the card is confirmed again", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      await f.event(STANDUP);
      const transcript = await f.transcript(WEDNESDAY_9_01);
      const { cardId } = await f.propose(transcript);
      await f.confirm(cardId);
      const eventsAfterFirst = await f.eventIds();
      const linkedAfterFirst = await f.linked(transcript);

      const second = await f.confirm(cardId);

      expect(second.properties.status).toBe("confirmed");
      expect(await f.eventIds()).toEqual(eventsAfterFirst);
      expect(await f.linked(transcript)).toEqual(linkedAfterFirst);
      expect(linkedAfterFirst).toHaveLength(1);
    }));

  it("links a second recording's confirmed card to the occurrence item that already exists instead of creating another", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const first = await f.transcript(WEDNESDAY_9_01);
      const second = await f.transcript("2026-10-14T07:05:00.000Z");
      const firstCard = await f.propose(first);
      const secondCard = await f.propose(second);
      await f.confirm(firstCard.cardId);
      const eventsAfterFirst = await f.eventIds();

      await f.confirm(secondCard.cardId);

      expect(await f.eventIds()).toEqual(eventsAfterFirst);
      expect(await f.linked(second)).toEqual(await f.linked(first));
      expect(await f.linked(second)).toHaveLength(1);
      expect(await f.linked(second)).not.toContain(series);
    }));

  it("matches a materialized occurrence as a stored Event, linking it directly without a card when it is the only candidate", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const { item } = await f.materialize(series, "2026-10-14");
      const transcript = await f.transcript(WEDNESDAY_9_01);

      expect(await f.match(transcript)).toBe("linked");

      expect(await f.linked(transcript)).toEqual([item.id]);
      expect(await f.cardIds()).toEqual([]);
    }));

  it("offers neither a cancelled date nor a stored occurrence as a virtual candidate, and still offers the next date", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const { item } = await f.materialize(series, "2026-10-14");
      await f.cp.softDeleteItem(f.db("events"), item.id);
      const wednesday = await f.transcript(WEDNESDAY_9_01);
      const thursday = await f.transcript("2026-10-15T07:01:00.000Z");

      // The cancelled 14 October gives no candidate, so the recording gets the new-meeting card.
      expect(await f.match(wednesday)).toBe("suggested");
      // 15 October is not cancelled, so the same series is a candidate on that day.
      expect(await f.match(thursday)).toEqual({
        outcome: "ambiguous",
        candidates: [{ seriesId: series, occurrenceDate: "2026-10-15" }],
      });
    }));

  it.each([
    { type: "standup", offered: true },
    { type: "meeting", offered: true },
    { type: "event", offered: false },
  ])("offers a series of type $type as a candidate: $offered", ({ type, offered }) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event({ ...STANDUP, type });
      const transcript = await f.transcript(WEDNESDAY_9_01);

      expect(await f.match(transcript)).toEqual(
        offered
          ? { outcome: "ambiguous", candidates: [{ seriesId: series, occurrenceDate: "2026-10-14" }] }
          : "suggested",
      );
    }),
  );

  it("offers the occurrence of the first day of the series, not the series Event itself", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const transcript = await f.transcript("2026-10-12T07:01:00.000Z");

      expect(await f.match(transcript)).toEqual({
        outcome: "ambiguous",
        candidates: [{ seriesId: series, occurrenceDate: "2026-10-12" }],
      });
    }));

  it("keeps a series whose own day its rule skips as a stored candidate and offers its other occurrences", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      // Tuesday 13 October 2026, although the rule gives Mondays only: the series Event is the only thing on that day.
      const series = await f.event({ ...STANDUP, date: "2026-10-13", recurrence: { kind: "weekdays", days: ["mon"] } });
      const onItsOwnDay = await f.transcript("2026-10-13T07:01:00.000Z");
      const onARuleDay = await f.transcript("2026-10-19T07:01:00.000Z");

      // The series Event is a stored candidate there, and the only one, so the recording is linked to it without a card.
      expect(await f.match(onItsOwnDay)).toBe("linked");
      expect(await f.linked(onItsOwnDay)).toEqual([series]);
      expect(await f.match(onARuleDay)).toEqual({
        outcome: "ambiguous",
        candidates: [{ seriesId: series, occurrenceDate: "2026-10-19" }],
      });
    }));

  it.each([
    { why: "ends as the occurrence starts", date: "2026-10-14T06:30:00.000Z", durationSeconds: 30 * 60 },
    { why: "starts as the occurrence ends", date: "2026-10-14T07:30:00.000Z", durationSeconds: 30 * 60 },
    { why: "falls on a Saturday, a day the rule skips", date: "2026-10-17T07:01:00.000Z", durationSeconds: 20 * 60 },
  ])("offers no occurrence when the recording $why", ({ date, durationSeconds }) =>
    runInTenant(tenant, async () => {
      const f = await setup();
      await f.event(STANDUP);
      const transcript = await f.transcript(date);

      expect(await f.match(transcript, durationSeconds)).toBe("suggested");
    }),
  );

  it("offers the occurrence of the next day when a recording crosses local midnight into it", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event({
        name: "Night shift",
        type: "meeting",
        date: "2026-10-12",
        timeFrom: "00:00",
        timeTo: "00:30",
        recurrence: EVERY_DAY,
      });
      // 23:50 local on Tuesday 13 October to 00:10 on Wednesday the 14th.
      const transcript = await f.transcript("2026-10-13T21:50:00.000Z");

      expect(await f.match(transcript)).toEqual({
        outcome: "ambiguous",
        candidates: [{ seriesId: series, occurrenceDate: "2026-10-14" }],
      });
    }));

  it("lists the stored Events before the occurrences and links none of them when a stored Event overlaps as well", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);
      const stored = await f.event({
        name: "Review",
        type: "meeting",
        date: "2026-10-14",
        timeFrom: "09:10",
        timeTo: "09:20",
      });
      const transcript = await f.transcript(WEDNESDAY_9_01);

      const result = await f.match(transcript);

      expect(result).toEqual({
        outcome: "ambiguous",
        candidates: [
          expect.objectContaining({ id: stored, name: "Review", date: "2026-10-14", timeFrom: "09:10" }),
          { seriesId: series, occurrenceDate: "2026-10-14" },
        ],
      });
      expect(await f.linked(transcript)).toEqual([]);
    }));

  it("offers no occurrence of another tenant's series", async () => {
    await runInTenant(foreign, async () => {
      const theirs = await setup();
      await theirs.event(STANDUP);
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      const transcript = await f.transcript(WEDNESDAY_9_01);

      expect(await f.match(transcript)).toBe("suggested");
    });
  });

  describe("the card of a recording with several candidates", () => {
    it("proposes the recommended stored Event and lists the occurrence next to it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const series = await f.event(STANDUP);
        const stored = await f.event({
          name: "Review",
          type: "meeting",
          date: "2026-10-14",
          timeFrom: "09:10",
          timeTo: "09:20",
        });
        const transcript = await f.transcript(WEDNESDAY_9_01);

        const created = await f.propose(transcript, { eventId: stored, reason: "About the review." });

        expect(created).toMatchObject({ recommendedEventId: stored, reason: "About the review." });
        expect(await f.card(created.cardId)).toMatchObject({
          proposal: { entityKind: "relation", target: stored, properties: { propertyKey: "event" } },
          context: {
            candidates: [expect.objectContaining({ id: stored }), { seriesId: series, occurrenceDate: "2026-10-14" }],
            recommendedEventId: stored,
          },
        });
      }));

    it("drops a recommendation that names the occurrence, because only a stored Event can be recommended, and proposes a new Event", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const series = await f.event(STANDUP);
        await f.event({ name: "Review", type: "meeting", date: "2026-10-14", timeFrom: "09:10", timeTo: "09:20" });
        const transcript = await f.transcript(WEDNESDAY_9_01);

        const created = await f.propose(transcript, { eventId: `${series}@2026-10-14`, reason: "The standup." });

        expect(created).toMatchObject({ recommendedEventId: null, reason: null });
        expect(await f.card(created.cardId)).toMatchObject({
          proposal: { entityKind: "database", properties: { type: "meeting" } },
        });
      }));

    it("keeps the reason of a no-answer recommendation and still proposes the one occurrence", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const series = await f.event(STANDUP);
        const transcript = await f.transcript(WEDNESDAY_9_01);

        const created = await f.propose(transcript, { eventId: null, reason: "Cannot tell." });

        expect(created).toMatchObject({ recommendedEventId: null, reason: "Cannot tell." });
        expect(await f.card(created.cardId)).toMatchObject({
          proposal: { entityKind: "relation", target: `${series}@2026-10-14` },
          context: { reason: "Cannot tell." },
        });
      }));

    it("proposes a new Event when two series overlap and none is recommended", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const first = await f.event(STANDUP);
        const second = await f.event({ ...STANDUP, name: "Planning", type: "meeting" });
        const transcript = await f.transcript(WEDNESDAY_9_01);

        const created = await f.propose(transcript);

        const expectedOrder = [first, second].sort();
        expect(await f.card(created.cardId)).toMatchObject({
          proposal: { entityKind: "database", properties: { type: "meeting" } },
          context: {
            candidates: expectedOrder.map((seriesId) => ({ seriesId, occurrenceDate: "2026-10-14" })),
          },
        });
      }));
  });

  describe("confirming a card whose occurrence changed since the card was made", () => {
    it("refuses the link and writes nothing when the occurrence was cancelled in the meantime", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const series = await f.event(STANDUP);
        const transcript = await f.transcript(WEDNESDAY_9_01);
        const { cardId } = await f.propose(transcript);
        const { item } = await f.materialize(series, "2026-10-14");
        await f.cp.softDeleteItem(f.db("events"), item.id);
        const eventsBefore = await f.eventIds();

        await expect(f.confirm(cardId)).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "targetItemId" },
        });

        expect((await f.card(cardId)).status).toBe("proposed");
        expect(await f.linked(transcript)).toEqual([]);
        expect(await f.eventIds()).toEqual(eventsBefore);
      }));

    it("links the occurrence item somebody else materialized in the meantime", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const series = await f.event(STANDUP);
        const transcript = await f.transcript(WEDNESDAY_9_01);
        const { cardId } = await f.propose(transcript);
        const { item } = await f.materialize(series, "2026-10-14");
        const eventsBefore = await f.eventIds();

        await f.confirm(cardId);

        expect(await f.linked(transcript)).toEqual([item.id]);
        expect(await f.eventIds()).toEqual(eventsBefore);
      }));

    it("refuses the confirm and materializes nothing when the series was trashed in the meantime", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const series = await f.event(STANDUP);
        const transcript = await f.transcript(WEDNESDAY_9_01);
        const { cardId } = await f.propose(transcript);
        await f.cp.softDeleteItem(f.db("events"), series);
        const eventsBefore = await f.eventIds();

        await expect(f.confirm(cardId)).rejects.toMatchObject({ details: { field: "target" } });

        expect((await f.card(cardId)).status).toBe("proposed");
        expect(await f.linked(transcript)).toEqual([]);
        expect(await f.eventIds()).toEqual(eventsBefore);
      }));

    it("refuses the confirm and materializes nothing when the transcript is linked to another Event meanwhile", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.event(STANDUP);
        const other = await f.event({ name: "Other", type: "event", date: "2026-10-20" });
        const transcript = await f.transcript(WEDNESDAY_9_01);
        const { cardId } = await f.propose(transcript);
        await f.cp.createRelation(
          {
            relationPropertyId:
              (await f.cp.listProperties(f.db("transcripts"))).find((property) => property.key === "event")?.id ?? "",
            callerItemId: transcript,
            targetItemId: other,
          },
          USER,
        );
        const eventsBefore = await f.eventIds();

        await expect(f.confirm(cardId)).rejects.toBeInstanceOf(CardinalityViolationError);

        expect((await f.card(cardId)).status).toBe("proposed");
        expect(await f.linked(transcript)).toEqual([other]);
        expect(await f.eventIds()).toEqual(eventsBefore);
      }));
  });
});
