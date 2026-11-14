import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { KNOWN_HEARTBEAT_ACTION_IDS } from "../../manifest/knownActionIds.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { manifest as calendarManifest } from "../calendarModuleManifest.js";
import { materializeEventOccurrence } from "../materializeEventOccurrence.js";
import {
  createNextOccurrenceRefreshAction,
  NEXT_OCCURRENCE_REFRESH_ACTION_ID,
} from "../nextOccurrenceRefreshAction.js";

const USER = { writerKind: "user" } as const;
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
const CONTEXT = {
  heartbeatId: "00000000-0000-4000-8000-000000000001",
  projectItemId: "00000000-0000-4000-8000-000000000002",
};
const FRIDAY = new Date("2026-10-16T10:00:00Z");
const SATURDAY = new Date("2026-10-17T10:00:00Z");

const heartbeatRow = z.object({
  name: z.string(),
  rule: z.unknown(),
  action_config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  next_fire_at: z.date().nullable(),
  project_item_id: z.string(),
});
const itemRow = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });

describe("the daily next-occurrence refresh (issue gh-1905)", () => {
  let admin: Pool;
  let data: Pool;
  let zero: string;
  let other: string;

  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    zero = getTenantZeroId();
    other = await createTestTenant(admin);
    await runInTenant(zero, () => seedSystem(data, createViewTypeRegistry()));
    await runInTenant(other, () => seedSystem(data, createViewTypeRegistry()));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRIDAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await data?.end();
    await admin?.end();
  });

  const eventsDatabaseId = (tenantId: string) =>
    runInTenant(tenantId, () =>
      withTransaction(data, async (client) => {
        const events = await getDatabaseByModuleId(client, "events");
        if (!events) throw new Error("Missing the events database");
        return events.id;
      }),
    );

  const createEvent = (tenantId: string, databaseId: string, properties: Record<string, unknown>) =>
    runInTenant(tenantId, () =>
      createChokePoint(data).createItem(
        { databaseId, properties: { name: "Event", ...properties } },
        undefined,
        undefined,
        USER,
      ),
    );

  const refresh = (tenantId: string, databaseId: string) =>
    runInTenant(tenantId, () => createNextOccurrenceRefreshAction(data)({ eventsDatabaseId: databaseId }, CONTEXT));

  /** The stored row, read on the admin pool inside the tenant so row-level security shows it. */
  const row = (tenantId: string, itemId: string) =>
    withTenantTransaction(admin, tenantId, async (client) =>
      itemRow.parse(
        (await client.query("SELECT properties, updated_at::text FROM items WHERE id = $1", [itemId])).rows[0],
      ),
    );

  const value = async (tenantId: string, itemId: string) => (await row(tenantId, itemId)).properties.nextOccurrenceDate;

  async function setTimezone(tenantId: string, timezone: string): Promise<void> {
    await runInTenant(tenantId, async () => {
      const settings = await withTransaction(data, async (client) => ({
        databaseId: await getSystemSettingsDatabaseId(client),
        itemId: await getSystemSettingsItemId(client),
      }));
      await createChokePoint(data).updateItem({ ...settings, propertiesPatch: { timezone } });
    });
  }

  it("moves a stale value to the next occurrence and leaves current values and other Events untouched", async () => {
    const events = await eventsDatabaseId(zero);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const payroll = await createEvent(zero, events, {
      name: "Payroll",
      date: "2026-10-01",
      recurrence: { kind: "monthDates", dates: [31] },
    });
    const dentist = await createEvent(zero, events, { name: "Dentist", date: "2026-10-12" });
    const trashed = await createEvent(zero, events, { name: "Old", date: "2026-10-12", recurrence: WEEKDAYS });
    await runInTenant(zero, () => createChokePoint(data).softDeleteItem(events, trashed.id));
    const before = {
      standup: await row(zero, standup.id),
      payroll: await row(zero, payroll.id),
      dentist: await row(zero, dentist.id),
      trashed: await row(zero, trashed.id),
    };
    expect(before.standup.properties.nextOccurrenceDate).toBe("2026-10-16");
    vi.setSystemTime(SATURDAY);

    await refresh(zero, events);

    const standupAfter = await row(zero, standup.id);
    expect(standupAfter.properties.nextOccurrenceDate).toBe("2026-10-19");
    // The refresh is not a reschedule: the iCalendar sequence of the invitation does not move.
    expect(standupAfter.properties.icalSequence).toBe(before.standup.properties.icalSequence);
    expect(standupAfter.updated_at).not.toBe(before.standup.updated_at);
    expect(await row(zero, payroll.id)).toEqual(before.payroll);
    expect(await row(zero, dentist.id)).toEqual(before.dentist);
    expect(await row(zero, trashed.id)).toEqual(before.trashed);
  });

  it("does not rewrite a recurring Event whose value is today, whole row included", async () => {
    const events = await eventsDatabaseId(zero);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const before = await row(zero, standup.id);
    expect(before.properties.nextOccurrenceDate).toBe("2026-10-16");

    await refresh(zero, events);

    // Friday is the day the series occurs on and the day the value names: it is current, not stale.
    expect(await row(zero, standup.id)).toEqual(before);
  });

  it("names the next occurrence that is not cancelled, and the day an occurrence was moved to", async () => {
    const events = await eventsDatabaseId(zero);
    const cancelled = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const moved = await createEvent(zero, events, { name: "Review", date: "2026-10-12", recurrence: WEEKDAYS });
    const materialize = (seriesId: string, occurrenceDate: string) =>
      runInTenant(zero, () =>
        withTransaction(data, (client) =>
          materializeEventOccurrence(client, { seriesId, occurrenceDate, options: {} }),
        ),
      );
    const monday = await materialize(cancelled.id, "2026-10-19");
    const review = await materialize(moved.id, "2026-10-19");
    const chokePoint = createChokePoint(data);
    await runInTenant(zero, () => chokePoint.softDeleteItem(events, monday.item.id, undefined, USER));
    await runInTenant(zero, () =>
      chokePoint.updateItem(
        { databaseId: events, itemId: review.item.id, propertiesPatch: { date: "2026-10-17" } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect(await value(zero, cancelled.id)).toBe("2026-10-16");
    expect(await value(zero, moved.id)).toBe("2026-10-16");
    vi.setSystemTime(SATURDAY);

    await refresh(zero, events);

    // Rule only, both would name Monday 19 Oct.
    expect(await value(zero, cancelled.id)).toBe("2026-10-20");
    expect(await value(zero, moved.id)).toBe("2026-10-17");
  });

  it("changes nothing when it runs again on the same day", async () => {
    const events = await eventsDatabaseId(zero);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    vi.setSystemTime(SATURDAY);
    await refresh(zero, events);
    const afterFirst = await row(zero, standup.id);

    await refresh(zero, events);

    expect(await row(zero, standup.id)).toEqual(afterFirst);
  });

  it("refreshes every stale Event across batches, in the order of their ids", async () => {
    const events = await eventsDatabaseId(zero);
    await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    // Raw SQL, because 450 writes through the choke point would only make the test slow: 450 copies of a stale series
    // fill two full batches of 200 and a partial one.
    await withTenantTransaction(admin, zero, (client) =>
      client.query(
        `INSERT INTO items (database_id, properties)
         SELECT $1, jsonb_build_object('name', 'Copy ' || n, 'date', '2026-10-12', 'recurrence', $2::jsonb,
                                       'nextOccurrenceDate', '2026-10-16')
           FROM generate_series(1, 450) AS n`,
        [events, JSON.stringify(WEEKDAYS)],
      ),
    );
    vi.setSystemTime(SATURDAY);

    await refresh(zero, events);

    const counts = await withTenantTransaction(
      admin,
      zero,
      async (client) =>
        (
          await client.query<{ value: string; count: number }>(
            `SELECT properties->>'nextOccurrenceDate' AS value, count(*)::int AS count FROM items
            WHERE database_id = $1 GROUP BY 1`,
            [events],
          )
        ).rows,
    );
    expect(counts).toEqual([{ value: "2026-10-19", count: 451 }]);
  });

  it("reads today in the tenant time zone", async () => {
    const events = await eventsDatabaseId(zero);
    await setTimezone(zero, "America/Los_Angeles");
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const created = await row(zero, standup.id);
    // Saturday 01:00 in Prague, but still Friday 22:00 in Los Angeles: Friday's value is current there.
    vi.setSystemTime(new Date("2026-10-17T05:00:00Z"));
    await refresh(zero, events);
    expect(await row(zero, standup.id)).toEqual(created);

    vi.setSystemTime(new Date("2026-10-17T08:00:00Z"));
    await refresh(zero, events);

    expect(await value(zero, standup.id)).toBe("2026-10-19");
  });

  it("refreshes only the tenant it runs in, and sees no Events database of another tenant", async () => {
    const zeroEvents = await eventsDatabaseId(zero);
    const otherEvents = await eventsDatabaseId(other);
    const mine = await createEvent(zero, zeroEvents, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const theirs = await createEvent(other, otherEvents, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    vi.setSystemTime(SATURDAY);

    await refresh(zero, otherEvents);
    expect(await value(zero, mine.id)).toBe("2026-10-16");
    expect(await value(other, theirs.id)).toBe("2026-10-16");

    await refresh(zero, zeroEvents);
    expect(await value(zero, mine.id)).toBe("2026-10-19");
    expect(await value(other, theirs.id)).toBe("2026-10-16");
  });

  it.each([
    ["an empty config", {}],
    ["an Events database id that is not a uuid", { eventsDatabaseId: "events" }],
  ])("refuses %s and writes nothing", async (_label, config) => {
    const events = await eventsDatabaseId(zero);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    vi.setSystemTime(SATURDAY);

    await expect(runInTenant(zero, () => createNextOccurrenceRefreshAction(data)(config, CONTEXT))).rejects.toThrow();

    expect(await value(zero, standup.id)).toBe("2026-10-16");
  });

  it("is a heartbeat action the calendar module declares and the registry knows", () => {
    expect(NEXT_OCCURRENCE_REFRESH_ACTION_ID).toBe("calendar.refreshNextOccurrence");
    expect(calendarManifest.heartbeatActions).toContain(NEXT_OCCURRENCE_REFRESH_ACTION_ID);
    expect(KNOWN_HEARTBEAT_ACTION_IDS.has(NEXT_OCCURRENCE_REFRESH_ACTION_ID)).toBe(true);
  });

  it("is seeded as a daily heartbeat just after midnight on the calendar module's system project", async () => {
    const events = await eventsDatabaseId(zero);
    // The admin pool bypasses row-level security, so the tenant is filtered by hand.
    const { calendarsProject, heartbeats } = await withTenantTransaction(admin, zero, async (client) => {
      const calendars = await client.query<{ project: string | null }>(
        "SELECT owner_project_item_id::text AS project FROM databases WHERE tenant_id = $1 AND owner_module_id = $2",
        [zero, CALENDARS_MODULE_ID],
      );
      const { rows } = await client.query(
        `SELECT name, rule, action_config, enabled, next_fire_at, project_item_id::text
           FROM project_heartbeats WHERE tenant_id = $1 AND action_id = $2`,
        [zero, NEXT_OCCURRENCE_REFRESH_ACTION_ID],
      );
      return { calendarsProject: calendars.rows[0]?.project, heartbeats: z.array(heartbeatRow).parse(rows) };
    });

    expect(heartbeats).toEqual([
      {
        name: "Refresh next occurrence of recurring events",
        rule: { kind: "dailyTime", at: "00:05" },
        action_config: { eventsDatabaseId: events },
        enabled: true,
        next_fire_at: expect.any(Date),
        project_item_id: calendarsProject,
      },
    ]);
  });
});
