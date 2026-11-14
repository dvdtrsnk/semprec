import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../../seed/invitationsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createMaterializeEventOccurrenceRouteHandler } from "../eventOccurrenceRouteHandlers.js";
import { createRespondToInvitationRouteHandler } from "../invitationRouteHandlers.js";
import { readCalendarTimeline, readTentativeEventIds } from "../timelineRead.js";
import { createInvitation } from "./invitationFixtures.js";
import { hideSleepInCalendar } from "./hideSleepInCalendar.js";

let admin: Pool;
let runtime: Pool;

const USER = { writerKind: "user" } as const;
const DAY = "2026-10-22";

/** What the timeline answers for an Event, in either shape. */
const entrySchema = z.object({ id: z.string(), kind: z.string(), attendance: z.literal("tentative").nullable() });

interface Seeded {
  tenantId: string;
  userId: string;
}

async function seededTenant(): Promise<Seeded> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime));
  // The sleep nights of a seeded tenant have their own tests (issue #1806); these keep to Events.
  await hideSleepInCalendar(runtime, tenantId);
  return { tenantId, userId: user.id };
}

/** The writes and reads of the tenant in scope; the answers go through the respond route, as a user's do. */
async function setup(userId: string) {
  const cp = createChokePoint(runtime);
  const calendars = z
    .array(z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() }))
    .parse(
      (await cp.listItems((await cp.listDatabases()).find((d) => d.ownerModuleId === CALENDARS_MODULE_ID)!.id)).items,
    );
  const work = calendars.find((calendar) => calendar.properties.name === "Work")?.id;
  if (!work) throw new Error("Missing the Work calendar");
  const eventsDatabaseId = (await cp.listDatabases()).find((d) => d.ownerModuleId === "events")?.id;
  if (!eventsDatabaseId) throw new Error("Missing the Events database");

  const event = async (properties: Record<string, unknown>): Promise<string> =>
    (await cp.createItem({ databaseId: eventsDatabaseId, properties }, userId, userId, USER)).id;
  /** Creates an invitation and answers it; returns the invitation and the Event the answer made. */
  const answered = async (response: "accepted" | "tentative" | "declined", uid: string, title = "Sprint review") => {
    const invitationId = await createInvitation(runtime, { uid, title }, work);
    const result = await respond(invitationId, response);
    return { invitationId, result };
  };
  const respond = (invitationId: string, response: string) =>
    createRespondToInvitationRouteHandler(runtime)({
      params: { id: invitationId },
      body: { response },
      identity: { user: { id: userId } },
    });
  /** The id of the Event an invitation links to, through the Events created by its answer. */
  const eventOf = async (before: Set<string>): Promise<string> => {
    const ids = (await cp.listItems(eventsDatabaseId, { limit: 100 })).items.map((item) => item.id);
    const created = ids.filter((id) => !before.has(id));
    if (created.length !== 1 || created[0] === undefined) throw new Error("Expected exactly one new Event");
    return created[0];
  };
  const eventIds = async (): Promise<Set<string>> =>
    new Set((await cp.listItems(eventsDatabaseId, { limit: 100 })).items.map((item) => item.id));
  const read = async (shape: "full" | "compact", from = DAY, to = DAY) => {
    const timeline = await withTransaction(runtime, (client) => readCalendarTimeline(client, { from, to, shape }));
    return z.array(entrySchema.passthrough()).parse(timeline.items);
  };
  const attendanceOf = async (shape: "full" | "compact", eventId: string) => {
    const entry = (await read(shape)).find((item) => item.id === eventId);
    if (!entry) throw new Error(`The timeline has no entry ${eventId}`);
    return entry.attendance;
  };
  return { cp, work, event, answered, respond, eventOf, eventIds, read, attendanceOf, eventsDatabaseId };
}

describe("attendance of an Event in the calendar timeline (issue gh-2008)", () => {
  let tenant: Seeded;
  let foreign: Seeded;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    foreign = await seededTenant();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("marks the Event of a tentative answer with attendance tentative, in the full and the compact shape", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const before = await f.eventIds();
      await f.answered("tentative", "tentative@example.test");
      const eventId = await f.eventOf(before);

      expect(await f.attendanceOf("full", eventId)).toBe("tentative");
      expect(await f.attendanceOf("compact", eventId)).toBe("tentative");
      const compact = (await f.read("compact")).find((item) => item.id === eventId);
      expect(compact).toMatchObject({ kind: "event", attendance: "tentative" });
    }));

  it("returns attendance null once the answer is changed to accepted", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const before = await f.eventIds();
      const { invitationId } = await f.answered("tentative", "changing@example.test");
      const eventId = await f.eventOf(before);
      expect(await f.attendanceOf("full", eventId)).toBe("tentative");

      await f.respond(invitationId, "accepted");

      expect(await f.attendanceOf("full", eventId)).toBeNull();
      expect(await f.attendanceOf("compact", eventId)).toBeNull();
    }));

  it("returns attendance null for an Event without an invitation, an Event of an accepted invitation and a Task", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const plain = await f.event({ name: "Dentist", date: DAY, timeFrom: "08:00" });
      const before = await f.eventIds();
      await f.answered("accepted", "accepted@example.test");
      const accepted = await f.eventOf(before);
      const task = (
        await f.cp.createItem(
          {
            databaseId: (await f.cp.listDatabases()).find((d) => d.ownerModuleId === "tasks")!.id,
            properties: { name: "Pay rent", date: DAY },
          },
          tenant.userId,
          tenant.userId,
          USER,
        )
      ).id;

      for (const shape of ["full", "compact"] as const) {
        expect(await f.attendanceOf(shape, plain)).toBeNull();
        expect(await f.attendanceOf(shape, accepted)).toBeNull();
        expect(await f.attendanceOf(shape, task)).toBeNull();
      }
    }));

  it("marks only the Event of the tentative invitation when other Events share the day", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const plain = await f.event({ name: "Dentist", date: DAY, timeFrom: "08:00" });
      const before = await f.eventIds();
      await f.answered("tentative", "marked@example.test", "Marked");
      const marked = await f.eventOf(before);

      const entries = (await f.read("full")).filter((item) => item.kind === "event");

      expect(entries.map((item) => [item.id, item.attendance]).sort()).toEqual(
        [
          [plain, null],
          [marked, "tentative"],
        ].sort(),
      );
    }));

  it("does not mark the Event of a trashed invitation", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const before = await f.eventIds();
      const { invitationId } = await f.answered("tentative", "trashed@example.test");
      const eventId = await f.eventOf(before);
      expect(await f.attendanceOf("full", eventId)).toBe("tentative");
      const invitationsDatabaseId = (await f.cp.listDatabases()).find(
        (d) => d.ownerModuleId === INVITATIONS_MODULE_ID,
      )?.id;
      if (!invitationsDatabaseId) throw new Error("Missing the Invitations database");

      await f.cp.softDeleteItem(invitationsDatabaseId, invitationId);

      expect(await f.attendanceOf("full", eventId)).toBeNull();
      expect(await f.attendanceOf("compact", eventId)).toBeNull();
    }));

  it("returns attendance null for a virtual occurrence of a series and for a stored occurrence of it", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const series = await f.event({
        name: "Standup",
        date: "2026-10-12",
        timeFrom: "09:00",
        timeTo: "09:30",
        recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
      });
      const materialized = await createMaterializeEventOccurrenceRouteHandler(runtime)({
        params: { seriesId: series, date: "2026-10-14" },
        identity: { user: { id: tenant.userId } },
      });

      const entries = (await f.read("full", "2026-10-13", "2026-10-15")).filter((item) => item.kind === "event");

      expect(entries.map((item) => item.id)).toEqual([
        `${series}@2026-10-13`,
        materialized.item.id,
        `${series}@2026-10-15`,
      ]);
      expect(entries.map((item) => item.attendance)).toEqual([null, null, null]);
    }));

  it("sends the same number of statements for any number of Events, and none for the attendance of a range without a stored Event", () =>
    runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const countStatements = (from: string, to: string): Promise<number> =>
        withTransaction(runtime, async (client) => {
          let count = 0;
          const observed: PoolClient = new Proxy(client, {
            get(target, property, receiver) {
              const value: unknown = Reflect.get(target, property, receiver);
              if (property !== "query" || typeof value !== "function") return value;
              return (...args: unknown[]): unknown => {
                count += 1;
                return Reflect.apply(value, target, args);
              };
            },
          });
          await readCalendarTimeline(observed, { from, to, shape: "full" });
          return count;
        });
      const empty = await countStatements("2026-10-22", "2026-10-22");
      await f.answered("tentative", "one@example.test", "One");
      const one = await countStatements("2026-10-22", "2026-10-22");
      for (const [index, response] of (["tentative", "tentative", "accepted", "declined"] as const).entries()) {
        await f.answered(response, `many-${index}@example.test`, `Many ${index}`);
        await f.event({ name: `Plain ${index}`, date: DAY, timeFrom: "07:00" });
      }

      const many = await countStatements("2026-10-22", "2026-10-22");

      expect(many).toBe(one);
      // The attendance read is the invitations database lookup and its one statement, both absent without a stored Event.
      expect(one - empty).toBeGreaterThanOrEqual(2);
    }));

  it("marks no Event of this tenant because of another tenant's invitations", async () => {
    const foreignEventId = await runInTenant(foreign.tenantId, async () => {
      const f = await setup(foreign.userId);
      const before = await f.eventIds();
      await f.answered("tentative", "foreign@example.test", "Foreign review");
      const eventId = await f.eventOf(before);
      expect(await f.attendanceOf("full", eventId)).toBe("tentative");
      return eventId;
    });

    await runInTenant(tenant.tenantId, async () => {
      const f = await setup(tenant.userId);
      const own = await f.event({ name: "Foreign review", date: DAY, timeFrom: "13:00" });

      const entries = await f.read("full");

      expect(entries.map((item) => item.id)).not.toContain(foreignEventId);
      expect(entries.find((item) => item.id === own)?.attendance).toBeNull();
      // Asked directly for the other tenant's Event, the reader finds no invitation of that tenant: row-level security hides it.
      const tentative = await withTransaction(runtime, (client) =>
        readTentativeEventIds(client, [foreignEventId, own]),
      );
      expect([...tentative]).toEqual([]);
    });
  });

  it("reads nothing and returns an empty set for no Event id, for ids that are not item ids and in a tenant without an Invitations database", async () => {
    const unseeded = await createTestTenant(admin);
    const answers = await runInTenant(unseeded, async () => {
      const statements: string[] = [];
      const answer = (ids: string[]) =>
        withTransaction(runtime, async (client) => {
          const observed: PoolClient = new Proxy(client, {
            get(target, property, receiver) {
              const value: unknown = Reflect.get(target, property, receiver);
              if (property !== "query" || typeof value !== "function") return value;
              return (...args: unknown[]): unknown => {
                statements.push(typeof args[0] === "string" ? args[0] : "");
                return Reflect.apply(value, target, args);
              };
            },
          });
          return [...(await readTentativeEventIds(observed, ids))];
        });
      const results = [
        await answer([]),
        await answer([`${randomUUID()}@2026-10-14`, "not-an-id"]),
        await answer([randomUUID()]),
      ];
      return { results, statements };
    });

    expect(answers.results).toEqual([[], [], []]);
    // Only the last call looks for the Invitations database, and finds none.
    expect(answers.statements).toHaveLength(1);
  });
});
