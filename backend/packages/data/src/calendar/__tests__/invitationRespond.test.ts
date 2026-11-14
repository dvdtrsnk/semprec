import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../../seed/invitationsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRespondToInvitationRouteHandler } from "../invitationRouteHandlers.js";
import { createInvitation } from "./invitationFixtures.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let userId: string;

const USER = { writerKind: "user" } as const;

const eventRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
});

/** A tenant with one English-speaking user, so its seeded calendars are named `Personal`, `Work` and so on. */
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

describe("respond to an invitation (issue gh-1944)", () => {
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

  /** The ids and reads of the tenant in scope; every write of a test goes through the choke point or the route. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const calendars = z
      .array(z.object({ id: z.string(), properties: z.object({ name: z.string() }).passthrough() }))
      .parse((await cp.listItems(db(CALENDARS_MODULE_ID), { limit: 50 })).items);
    const calendar = (name: string) => {
      const row = calendars.find((candidate) => candidate.properties.name === name);
      if (!row) throw new Error(`Missing calendar ${name}`);
      return row.id;
    };
    const calendarOf = async (eventId: string): Promise<string[]> =>
      ((await cp.listItemRelations(eventId)) ?? [])
        .filter((entry) => entry.propertyKey === "calendar")
        .map((entry) => entry.targetItemId);

    const invitation = (overrides: Record<string, unknown> = {}, suggestedCalendar: string | null = calendar("Work")) =>
      createInvitation(runtime, overrides, suggestedCalendar);

    /** Every Events row, trashed ones included, oldest first. */
    const events = () =>
      withTransaction(runtime, async (client) => {
        const { rows } = await client.query<{
          id: string;
          properties: Record<string, unknown>;
          deleted_at: string | null;
          updated_at: string;
        }>("SELECT id, properties, deleted_at, updated_at FROM items WHERE database_id = $1 ORDER BY created_at, id", [
          db(EVENTS_MODULE_ID),
        ]);
        return rows.map((row) =>
          eventRow.parse({
            id: row.id,
            properties: row.properties,
            deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          }),
        );
      });
    /** The Events the invitation links to, as the ids on its `event` edges. */
    const linkedEvents = (invitationId: string) =>
      withTransaction(runtime, async (client) => {
        const property = await propertiesStore.getPropertyByKey(client, db(INVITATIONS_MODULE_ID), "event");
        const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
        if (!definition) throw new Error("Missing Invitations.event");
        return (await relationsStore.listRelationsForItem(client, definition.id, invitationId)).map((edge) =>
          relationsStore.otherSide(edge, invitationId),
        );
      });
    const read = async (invitationId: string) => {
      const item = await withTransaction(runtime, (client) =>
        itemsStore.getItemById(client, db(INVITATIONS_MODULE_ID), invitationId),
      );
      if (!item) throw new Error("Missing invitation");
      return item;
    };
    const respond = (invitationId: string, body: unknown, identityId: string = userId) =>
      createRespondToInvitationRouteHandler(runtime)({
        params: { id: invitationId },
        body,
        identity: { user: { id: identityId } },
      });
    /** The error a respond fails with, as a `ChokePointError`; a different outcome fails the test. */
    const refused = async (invitationId: string, body: unknown): Promise<ChokePointError> => {
      const error: unknown = await respond(invitationId, body).then(
        () => null,
        (caught: unknown) => caught,
      );
      if (!(error instanceof ChokePointError)) throw new Error(`Expected a ChokePointError, got ${String(error)}`);
      return error;
    };
    const setZone = async (timezone: string): Promise<void> => {
      const { settingsDatabaseId, itemId } = await withTransaction(runtime, async (client) => ({
        settingsDatabaseId: await getSystemSettingsDatabaseId(client),
        itemId: await getSystemSettingsItemId(client),
      }));
      await cp.updateItem({ databaseId: settingsDatabaseId, itemId, propertiesPatch: { timezone } });
    };
    return { cp, db, calendar, calendarOf, invitation, events, linkedEvents, read, respond, refused, setZone };
  }

  /** The invitation and the Events untouched: nothing was created, linked or changed by a refused answer. */
  async function expectUnanswered(f: Awaited<ReturnType<typeof setup>>, id: string, status = "pending") {
    const stored = await f.read(id);
    expect(stored.properties.status).toBe(status);
    expect(stored.properties.respondedAt).toBeUndefined();
    expect(await f.events()).toEqual([]);
    expect(await f.linkedEvents(id)).toEqual([]);
  }

  it("accepting a pending invitation creates one Event with its title, place and wall-clock time in the suggested calendar, links it and sets status and respondedAt", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();

      const result = await f.respond(id, { response: "accepted" });

      const events = await f.events();
      expect(events).toHaveLength(1);
      expect(events[0]?.properties).toMatchObject({
        name: "Sprint review",
        type: "meeting",
        place: "Room 4",
        date: "2026-10-22",
        timeFrom: "13:00",
        timeTo: "14:00",
      });
      expect(events[0]?.properties.endDate).toBeUndefined();
      expect(events[0]?.deletedAt).toBeNull();
      expect(await f.calendarOf(events[0]!.id)).toEqual([f.calendar("Work")]);
      expect(await f.linkedEvents(id)).toEqual([events[0]!.id]);
      expect(result.status).toBe(200);
      expect(result.item).toEqual(await f.read(id));
      expect(result.item.properties.status).toBe("accepted");
      expect(new Date(String(result.item.properties.respondedAt)).toISOString()).toBe(
        result.item.properties.respondedAt,
      );
      expect(result.item.properties.title).toBe("Sprint review");
    }));

  it("tentative creates the same Event as accepted and writes nothing tentative-specific to it", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const accepted = await f.invitation({ uid: "a@example.test" });
      const tentative = await f.invitation({ uid: "b@example.test" });
      await f.respond(accepted, { response: "accepted" });
      const result = await f.respond(tentative, { response: "tentative" });

      const [first, second] = await f.events();
      // The iCalendar identity of an Event is generated for each one.
      const withoutIdentity = (properties: Record<string, unknown> | undefined) => ({
        ...properties,
        icalUid: undefined,
      });
      expect(withoutIdentity(second?.properties)).toEqual(withoutIdentity(first?.properties));
      expect(result.item.properties.status).toBe("tentative");
      expect(await f.linkedEvents(tentative)).toEqual([second!.id]);
      expect(await f.calendarOf(second!.id)).toEqual([f.calendar("Work")]);
    }));

  it("reads the start and end in the tenant zone, not in UTC", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      await f.setZone("America/New_York");
      const id = await f.invitation();

      await f.respond(id, { response: "accepted" });

      const [event] = await f.events();
      expect(event?.properties).toMatchObject({ date: "2026-10-22", timeFrom: "07:00", timeTo: "08:00" });
    }));

  it("gives a timed invitation that ends on another day an endDate and a timeTo", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ startsAt: "2026-10-22T20:00:00.000Z", endsAt: "2026-10-22T23:30:00.000Z" });

      await f.respond(id, { response: "accepted" });

      const [event] = await f.events();
      expect(event?.properties).toMatchObject({
        date: "2026-10-22",
        timeFrom: "22:00",
        endDate: "2026-10-23",
        timeTo: "01:30",
      });
    }));

  it("gives a timed invitation without an end no explicit end: the Events default of one hour applies", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ endsAt: undefined });

      await f.respond(id, { response: "accepted" });

      const [event] = await f.events();
      expect(event?.properties).toMatchObject({ date: "2026-10-22", timeFrom: "13:00", timeTo: "14:00" });
    }));

  it("treats a timed invitation whose end is its start as having no end: the Events default of one hour applies", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ endsAt: "2026-10-22T11:00:00.000Z" });

      await f.respond(id, { response: "accepted" });

      const [event] = await f.events();
      expect(event?.properties).toMatchObject({ date: "2026-10-22", timeFrom: "13:00", timeTo: "14:00" });
      expect(event?.properties).not.toHaveProperty("endDate");
    }));

  it("makes an all-day invitation an all-day Event, with endDate only when the last day differs", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const oneDay = await f.invitation({
        uid: "one-day@example.test",
        allDay: true,
        startsAt: "2026-10-22T00:00:00.000Z",
        endsAt: undefined,
      });
      const severalDays = await f.invitation({
        uid: "several-days@example.test",
        allDay: true,
        startsAt: "2026-10-22T00:00:00.000Z",
        endsAt: "2026-10-24T00:00:00.000Z",
      });
      const sameLastDay = await f.invitation({
        uid: "same-day@example.test",
        allDay: true,
        startsAt: "2026-10-22T00:00:00.000Z",
        endsAt: "2026-10-22T00:00:00.000Z",
      });

      for (const id of [oneDay, severalDays, sameLastDay]) await f.respond(id, { response: "accepted" });

      const [first, second, third] = (await f.events()).map((event) => event.properties);
      expect(first).toMatchObject({ date: "2026-10-22" });
      expect(second).toMatchObject({ date: "2026-10-22", endDate: "2026-10-24" });
      expect(third).toMatchObject({ date: "2026-10-22" });
      for (const properties of [first, second, third]) {
        expect(properties?.timeFrom).toBeUndefined();
        expect(properties?.timeTo).toBeUndefined();
      }
      expect(first?.endDate).toBeUndefined();
      expect(third?.endDate).toBeUndefined();
    }));

  it("creates the Event in the calendar named by calendarId in place of the suggested one", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();

      await f.respond(id, { response: "accepted", calendarId: f.calendar("Personal") });

      const [event] = await f.events();
      expect(await f.calendarOf(event!.id)).toEqual([f.calendar("Personal")]);
    }));

  it("creates the Event in the default calendar when the invitation suggests none and none is named", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({}, null);

      await f.respond(id, { response: "accepted" });

      const [event] = await f.events();
      const calendars = await f.cp.listItems(f.db(CALENDARS_MODULE_ID), { limit: 50 });
      const defaults = calendars.items.filter((item) => item.properties.isDefault === true).map((item) => item.id);
      expect(defaults).toHaveLength(1);
      expect(await f.calendarOf(event!.id)).toEqual(defaults);
    }));

  it("declined for an invitation without an Event leaves no Event and sets status and respondedAt", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();

      const result = await f.respond(id, { response: "declined" });

      expect(result.item.properties.status).toBe("declined");
      expect(typeof result.item.properties.respondedAt).toBe("string");
      expect(await f.events()).toEqual([]);
      expect(await f.linkedEvents(id)).toEqual([]);
    }));

  it("declined after an accepted answer moves the linked Event to the trash, keeps it linked and does not delete it", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      await f.respond(id, { response: "accepted" });
      const [created] = await f.events();

      const result = await f.respond(id, { response: "declined" });

      const [event] = await f.events();
      expect(event?.id).toBe(created!.id);
      expect(event?.deletedAt).not.toBeNull();
      expect(await f.linkedEvents(id)).toEqual([created!.id]);
      expect(result.item.properties.status).toBe("declined");
    }));

  it("declined leaves an Event the user already trashed as it is", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      await f.respond(id, { response: "accepted" });
      const [created] = await f.events();
      await f.cp.softDeleteItem(f.db(EVENTS_MODULE_ID), created!.id);
      const [trashed] = await f.events();

      const result = await f.respond(id, { response: "declined" });

      expect(await f.events()).toEqual([trashed]);
      expect(result.item.properties.status).toBe("declined");
    }));

  it("changing accepted to tentative keeps the same Event unchanged, with the user's own edits, and sets a new respondedAt", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      const first = await f.respond(id, { response: "accepted" });
      const [created] = await f.events();
      await f.cp.updateItem(
        { databaseId: f.db(EVENTS_MODULE_ID), itemId: created!.id, propertiesPatch: { name: "Sprint review (mine)" } },
        userId,
        userId,
        USER,
      );
      const before = await f.events();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await f.respond(id, { response: "tentative", calendarId: f.calendar("Personal") });

      expect(await f.events()).toEqual(before);
      expect(before[0]?.properties.name).toBe("Sprint review (mine)");
      expect(await f.calendarOf(created!.id)).toEqual([f.calendar("Work")]);
      expect(await f.linkedEvents(id)).toEqual([created!.id]);
      expect(second.item.properties.status).toBe("tentative");
      expect(Date.parse(String(second.item.properties.respondedAt))).toBeGreaterThan(
        Date.parse(String(first.item.properties.respondedAt)),
      );
    }));

  it("changing declined to accepted restores the trashed Event instead of creating a second one", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      await f.respond(id, { response: "accepted" });
      const [created] = await f.events();
      await f.respond(id, { response: "declined" });
      expect((await f.events())[0]?.deletedAt).not.toBeNull();

      const result = await f.respond(id, { response: "accepted" });

      const events = await f.events();
      expect(events).toHaveLength(1);
      expect(events[0]?.id).toBe(created!.id);
      expect(events[0]?.deletedAt).toBeNull();
      expect(events[0]?.properties).toEqual(created!.properties);
      expect(await f.linkedEvents(id)).toEqual([created!.id]);
      expect(result.item.properties.status).toBe("accepted");
    }));

  it("answering with the stored answer writes nothing and returns the invitation unchanged, whatever calendarId says", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      await f.respond(id, { response: "tentative" });
      const [invitationBefore, eventsBefore] = [await f.read(id), await f.events()];

      const repeated = await f.respond(id, { response: "tentative", calendarId: randomUUID() });

      expect(repeated.status).toBe(200);
      expect(repeated.item).toEqual(invitationBefore);
      expect(await f.read(id)).toEqual(invitationBefore);
      expect(await f.events()).toEqual(eventsBefore);
    }));

  it("answers 409 conflict for a cancelled invitation and changes nothing, whatever the answer", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ status: "cancelled" });
      for (const response of ["accepted", "tentative", "declined"]) {
        const error = await f.refused(id, { response });
        expect([error.status, error.code]).toEqual([409, "conflict"]);
      }
      await expectUnanswered(f, id, "cancelled");
    }));

  it("answers 409 conflict for a cancelled notice answered acknowledged", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ status: "cancelled", kind: "sharedCalendarNotice" });
      const error = await f.refused(id, { response: "acknowledged" });
      expect([error.status, error.code]).toEqual([409, "conflict"]);
      await expectUnanswered(f, id, "cancelled");
    }));

  it("refuses acknowledged for an invite and the other answers for a notice with 400 on response, and writes nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const invite = await f.invitation({ uid: "invite@example.test" });
      const notice = await f.invitation({ uid: "notice@example.test", kind: "sharedCalendarNotice" });

      const onInvite = await f.refused(invite, { response: "acknowledged" });
      expect([onInvite.status, onInvite.code, onInvite.details]).toEqual([
        400,
        "validation_failed",
        { field: "response" },
      ]);
      for (const response of ["accepted", "tentative", "declined"]) {
        const onNotice = await f.refused(notice, { response });
        expect([onNotice.status, onNotice.code, onNotice.details]).toEqual([
          400,
          "validation_failed",
          { field: "response" },
        ]);
      }

      expect((await f.read(invite)).properties.status).toBe("pending");
      expect((await f.read(notice)).properties.status).toBe("pending");
      expect(await f.events()).toEqual([]);
    }));

  it("acknowledged moves a notice's status and respondedAt only, with no Event", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ kind: "sharedCalendarNotice" });

      const result = await f.respond(id, { response: "acknowledged" });

      expect(result.item.properties.status).toBe("acknowledged");
      expect(typeof result.item.properties.respondedAt).toBe("string");
      expect(await f.events()).toEqual([]);
      expect(await f.linkedEvents(id)).toEqual([]);
      const repeated = await f.respond(id, { response: "acknowledged" });
      expect(repeated.item).toEqual(result.item);
    }));

  it("treats an invitation without a kind as an invite", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ kind: undefined });

      const result = await f.respond(id, { response: "accepted" });

      expect(result.item.properties.status).toBe("accepted");
      expect(await f.events()).toHaveLength(1);
    }));

  it("refuses a calendarId that is unknown, another tenant's, in the trash, a system calendar or not a UUID with 400 on calendarId", async () => {
    const foreignCalendar = await runInTenant(foreign, async () => (await setup()).calendar("Work"));
    await runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      const trashed = f.calendar("Personal");
      const system = z
        .array(z.object({ id: z.string(), properties: z.object({ systemKey: z.string().optional() }).passthrough() }))
        .parse((await f.cp.listItems(f.db(CALENDARS_MODULE_ID), { limit: 50 })).items)
        .find((row) => row.properties.systemKey === "tasks");
      if (!system) throw new Error("Missing the Tasks system calendar");
      await f.cp.softDeleteItem(f.db(CALENDARS_MODULE_ID), trashed);

      for (const calendarId of [randomUUID(), foreignCalendar, trashed, system.id, "not-a-uuid"]) {
        const error = await f.refused(id, { response: "accepted", calendarId });
        expect([error.status, error.code, error.details]).toEqual([400, "validation_failed", { field: "calendarId" }]);
      }
      await expectUnanswered(f, id);
    });
  });

  it("refuses with 400 on calendarId when the suggested calendar is in the trash, and writes nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      await f.cp.softDeleteItem(f.db(CALENDARS_MODULE_ID), f.calendar("Work"));

      const error = await f.refused(id, { response: "accepted" });

      expect([error.status, error.details]).toEqual([400, { field: "calendarId" }]);
      await expectUnanswered(f, id);
    }));

  it("ignores calendarId once the invitation has an Event, a live one or a trashed one", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      await f.respond(id, { response: "accepted" });
      const live = await f.respond(id, { response: "tentative", calendarId: randomUUID() });
      expect(live.item.properties.status).toBe("tentative");
      await f.respond(id, { response: "declined" });

      const restored = await f.respond(id, { response: "accepted", calendarId: randomUUID() });

      expect(restored.item.properties.status).toBe("accepted");
      expect(await f.events()).toHaveLength(1);
    }));

  it("leaves the invitation pending and creates no Event when the Event validation fails", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      // The meeting ends before it starts, so the Events rules refuse the Event's times.
      const id = await f.invitation({ endsAt: "2026-10-22T10:00:00.000Z" });

      const error = await f.refused(id, { response: "accepted" });

      expect([error.status, error.code, error.details]).toEqual([400, "validation_failed", { field: "timeTo" }]);
      await expectUnanswered(f, id);
    }));

  it("answers an unknown id, another tenant's invitation and a trashed invitation with the same 404, and modifies nothing", async () => {
    const other = await runInTenant(foreign, async () => {
      const g = await setup();
      return { g, id: await g.invitation() };
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      const trashed = await f.invitation({ uid: "trashed@example.test" });
      await f.cp.softDeleteItem(f.db(INVITATIONS_MODULE_ID), trashed);

      const answers = [];
      for (const id of [randomUUID(), other.id, trashed]) {
        const error = await f.refused(id, { response: "accepted" });
        answers.push([error.status, error.code, error.message, error.details]);
      }

      expect(answers[0]).toEqual([404, "not_found", "Invitation not found", undefined]);
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      expect(await f.events()).toEqual([]);
    });
    await runInTenant(foreign, async () => {
      expect((await other.g.read(other.id)).properties.status).toBe("pending");
      expect(await other.g.events()).toEqual([]);
      expect(await other.g.linkedEvents(other.id)).toEqual([]);
    });
  });

  it("answers 404 in a tenant that has no invitations database", async () => {
    // A tenant that was never seeded has no Invitations database, as one whose invitations cutover has not run.
    const unseeded = await createTestTenant(admin);
    await runInTenant(unseeded, async () => {
      const error: unknown = await createRespondToInvitationRouteHandler(runtime)({
        params: { id: randomUUID() },
        body: { response: "accepted" },
        identity: { user: { id: userId } },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      if (!(error instanceof ChokePointError)) throw new Error("Expected a ChokePointError");
      expect([error.status, error.code]).toEqual([404, "not_found"]);
    });
  });

  it("keeps a generic write of status refused with 403, so the answer is the only way to change it", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();

      const error: unknown = await f.cp
        .updateItem(
          { databaseId: f.db(INVITATIONS_MODULE_ID), itemId: id, propertiesPatch: { status: "accepted" } },
          userId,
          userId,
          USER,
        )
        .then(
          () => null,
          (caught: unknown) => caught,
        );

      if (!(error instanceof ChokePointError)) throw new Error("Expected a ChokePointError");
      expect([error.status, error.code]).toEqual([403, "owner_violation"]);
      await expectUnanswered(f, id);
    }));

  it("refuses an id that is not a UUID and a body of another shape with 400 on the field, before any write", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();
      const fieldOf = async (invitationId: string, body: unknown): Promise<unknown> => {
        const error = await f.refused(invitationId, body);
        expect([error.status, error.code]).toEqual([400, "validation_failed"]);
        return error.details;
      };

      expect(await fieldOf("not-a-uuid", { response: "accepted" })).toEqual({ field: "id" });
      expect(await fieldOf(id, { response: "maybe" })).toEqual({ field: "response" });
      expect(await fieldOf(id, {})).toEqual({ field: "response" });
      expect(await fieldOf(id, { response: "accepted", calendarId: 7 })).toEqual({ field: "calendarId" });
      expect(await fieldOf(id, { response: "accepted", calender: f.calendar("Work") })).toEqual({ field: "calender" });
      expect(await fieldOf(id, null)).toEqual({ field: "body" });
      await expectUnanswered(f, id);
    }));

  it("fails with a plain error, not a domain status, for an invitation whose stored status is unreadable", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ status: undefined });

      const error: unknown = await f.respond(id, { response: "accepted" }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChokePointError);
      expect(await f.events()).toEqual([]);
    }));

  it("fails with a plain error when the stored start of the invitation is unreadable, and creates nothing", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation({ startsAt: undefined });

      const error: unknown = await f.respond(id, { response: "accepted" }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChokePointError);
      expect((await f.read(id)).properties.status).toBe("pending");
      expect(await f.events()).toEqual([]);
    }));

  it("makes one Event when the same answer arrives twice at once", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const id = await f.invitation();

      const results = await Promise.all([
        f.respond(id, { response: "accepted" }),
        f.respond(id, { response: "accepted" }),
      ]);

      expect(results.map((result) => result.item.properties.status)).toEqual(["accepted", "accepted"]);
      expect(await f.events()).toHaveLength(1);
      expect(await f.linkedEvents(id)).toHaveLength(1);
    }));
});
