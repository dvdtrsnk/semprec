import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { logger } from "../logger.js";
import { createCalendarTimelineRouteHandler } from "../timelineRouteHandler.js";

let adminPool: Pool;
let dataPool: Pool;
let tenantId: string;

const USER = { writerKind: "user" } as const;
const DAY = "2026-10-16";

const wallClockSchema = z.object({ date: z.string(), time: z.string() }).strict();

const fullBodySchema = z
  .object({
    timezone: z.string(),
    today: z.string(),
    now: wallClockSchema,
    from: z.string(),
    to: z.string(),
    items: z.array(
      z
        .object({
          kind: z.enum(["event", "task"]),
          id: z.string(),
          databaseId: z.string(),
          title: z.string(),
          type: z.string().nullable(),
          date: z.string(),
          endDate: z.string().nullable(),
          timeFrom: z.string().nullable(),
          timeTo: z.string().nullable(),
          effectiveTo: z.string().nullable(),
          hasEnd: z.boolean(),
          allDay: z.boolean(),
          calendarId: z.string().nullable(),
          status: z.string().nullable(),
          place: z.string().nullable(),
          project: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).strict().nullable(),
          people: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
          updatedAt: z.string(),
          readOnly: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const compactBodySchema = fullBodySchema.extend({
  items: z.array(
    z
      .object({
        id: z.string(),
        kind: z.enum(["event", "task"]),
        title: z.string(),
        calendarId: z.string().nullable(),
        allDay: z.boolean(),
        date: z.string(),
        endDate: z.string().nullable(),
        timeFrom: z.string().nullable(),
        status: z.string().nullable(),
        updatedAt: z.string(),
        readOnly: z.boolean(),
      })
      .strict(),
  ),
});

/** Calls the handler as the adapter does: inside the tenant's scope, with the request URL. */
function request(query: string): Promise<{ status: number; body: unknown }> {
  return runInTenant(tenantId, () =>
    createCalendarTimelineRouteHandler(dataPool)({ req: { url: `/api/calendar/timeline${query}` } }),
  );
}

/** The response body as JSON carries it, so a value JSON cannot represent would be noticed. */
function wire(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body));
}

async function create(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(dataPool, (client) =>
      databasesStore.getDatabaseByModuleId(client, moduleId),
    );
    if (!database) throw new Error(`No ${moduleId} database`);
    const item = await createChokePoint(dataPool).createItem(
      { databaseId: database.id, properties },
      undefined,
      undefined,
      USER,
    );
    return item.id;
  });
}

describe("GET /api/calendar/timeline (issue #1717)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("answers 200 with the tenant zone, today, now, the range and the full items", async () => {
    const event = await create("events", { name: "Standup", date: DAY, timeFrom: "09:00", timeTo: "09:30" });
    const task = await create("tasks", { name: "Pay rent", date: DAY });

    const result = await request(`?from=${DAY}&to=${DAY}`);

    expect(result.status).toBe(200);
    const body = fullBodySchema.parse(wire(result.body));
    expect({ timezone: body.timezone, from: body.from, to: body.to }).toEqual({
      timezone: "Europe/Prague",
      from: DAY,
      to: DAY,
    });
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.now.date).toBe(body.today);
    expect(body.now.time).toMatch(/^\d{2}:\d{2}$/);
    expect(body.items.map((item) => [item.id, item.kind, item.timeFrom, item.timeTo])).toEqual([
      [task, "task", null, null],
      [event, "event", "09:00", "09:30"],
    ]);
  });

  it("answers the compact shape with updatedAt and readOnly on every item", async () => {
    const event = await create("events", { name: "Standup", date: DAY, timeFrom: "09:00" });

    const result = await request(`?from=${DAY}&to=${DAY}&shape=compact`);

    expect(result.status).toBe(200);
    const body = compactBodySchema.parse(wire(result.body));
    expect(body.items.map((item) => [item.id, item.readOnly])).toEqual([[event, false]]);
    expect(Number.isNaN(Date.parse(body.items[0]?.updatedAt ?? ""))).toBe(false);
  });

  it("answers 200 without an Event whose stored date is abc", async () => {
    const valid = await create("events", { name: "Valid", date: DAY });
    const broken = await create("events", { name: "Broken", date: DAY });
    // Raw SQL: the Events write rules (issue #1663) refuse this value, so only an older row can hold it.
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE items SET properties = properties || '{"date": "abc"}'::jsonb WHERE id = $1`,
        [broken],
      );
      expect(updated.rowCount).toBe(1);
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await request(`?from=${DAY}&to=${DAY}`);

    expect(result.status).toBe(200);
    expect(fullBodySchema.parse(wire(result.body)).items.map((item) => item.id)).toEqual([valid]);
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      expect.objectContaining({ itemId: broken, property: "date" }),
    ]);
  });

  it("accepts a range of 93 days and refuses one of 94", async () => {
    // 1 January to 3 April 2026 is 31 + 28 + 31 + 3 = 93 days, both included.
    expect((await request("?from=2026-01-01&to=2026-04-03")).status).toBe(200);
    await expect(request("?from=2026-01-01&to=2026-04-04")).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "to" },
    });
  });

  it.each([
    ["an inverted range", `?from=2026-10-17&to=${DAY}`, "to"],
    ["a from that is no date", `?from=abc&to=${DAY}`, "from"],
    ["a from that does not exist", `?from=2026-02-30&to=2026-03-01`, "from"],
    ["a from with a time", `?from=${DAY}T10:00&to=${DAY}`, "from"],
    ["a to that is no date", `?from=${DAY}&to=16.10.2026`, "to"],
    ["a missing from", `?to=${DAY}`, "from"],
    ["a missing to", `?from=${DAY}`, "to"],
    ["no query string", "", "from"],
    ["an unknown shape", `?from=${DAY}&to=${DAY}&shape=wide`, "shape"],
    ["the shape full spelled out", `?from=${DAY}&to=${DAY}&shape=full`, "shape"],
  ])("refuses %s with 400 validation_failed", async (_name, query, field) => {
    await expect(request(query)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field },
    });
  });

  it("refuses a request without a URL like one without a query string", async () => {
    await expect(
      runInTenant(tenantId, () => createCalendarTimelineRouteHandler(dataPool)({ req: {} })),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "from" } });
  });
});
