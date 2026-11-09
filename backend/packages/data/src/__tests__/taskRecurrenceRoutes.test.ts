import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { Settings } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { prepareTaskProposal } from "../tasks/taskPreWriteTransform.js";
import {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "../tasks/taskRecurrenceRoutes.js";
import { createSeriesOccurrence } from "../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
const userId = randomUUID();
const USER: WriterIdentity = { writerKind: "user" };

const seriesRow = z.object({
  item_id: z.string(),
  series_id: z.string().nullable(),
  mode: z.string(),
  rule: z.unknown(),
  active: z.boolean(),
  anchor_date: z.string().nullable(),
});

function put(id: string, body: unknown) {
  return runInTenant(tenant, () =>
    createTaskRecurrenceSetRouteHandler(pool)({ params: { id }, body, identity: { user: { id: userId } } }),
  );
}

function remove(id: string) {
  return runInTenant(tenant, () =>
    createTaskRecurrenceClearRouteHandler(pool)({
      params: { id },
      body: undefined,
      identity: { user: { id: userId } },
    }),
  );
}

async function task(properties: Record<string, unknown>): Promise<string> {
  return (
    await runInTenant(tenant, () => cp.createItem({ databaseId: tasksId, properties: { name: "Task", ...properties } }))
  ).id;
}

async function stored(id: string): Promise<Record<string, unknown>> {
  const item = await runInTenant(tenant, () => cp.getItem(tasksId, id));
  if (!item) throw new Error(`Task ${id} missing`);
  return item.properties;
}

async function seriesRows(): Promise<Array<z.infer<typeof seriesRow>>> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT item_id, series_id::text, mode, rule, active, anchor_date::text FROM task_recurrence ORDER BY item_id",
    );
    return rows.map((row) => seriesRow.parse(row));
  });
}

async function taskCount(): Promise<number> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [tasksId],
    );
    return rows[0]?.count ?? -1;
  });
}

async function refusal(write: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  return error;
}

describe("PUT and DELETE /api/tasks/:id/recurrence (issue #1665)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    tasksId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!rows[0]) throw new Error("Tasks not seeded");
      return rows[0].id;
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("accepts a generic recurrence command and keeps identical commands as no-ops", async () => {
    const id = await task({ date: "2026-10-22" });
    const first = await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { recurrence: { preset: "weekly" } } }),
    );
    expect(first.properties.recurrence).toEqual({
      preset: "weekly",
      mode: "fixed",
      rule: { kind: "weekdays", days: ["thu"] },
    });
    const same = await runInTenant(tenant, () =>
      cp.updateItem({
        databaseId: tasksId,
        itemId: id,
        ifVersion: first.updatedAt,
        propertiesPatch: { recurrence: { preset: "weekly" } },
      }),
    );
    expect(same.updatedAt).toBe(first.updatedAt);
    expect(await seriesRows()).toHaveLength(1);
    const ended = await runInTenant(tenant, () =>
      cp.updateItem({
        databaseId: tasksId,
        itemId: id,
        ifVersion: same.updatedAt,
        propertiesPatch: { recurrence: null },
      }),
    );
    expect(ended.properties.recurrence).toBeNull();
    expect((await seriesRows())[0]?.active).toBe(false);
  });

  it("defers an agent's change of an active series without modifying it", async () => {
    const id = await task({ date: "2026-10-22" });
    await put(id, { preset: "weekly" });
    const before = await seriesRows();
    const beforeItem = await stored(id);
    await expect(inTenantWrite()).rejects.toMatchObject({
      name: "ApprovalRequiredForWrite",
      reasons: [expect.objectContaining({ kind: "changesSeries", to: { kind: "monthDates", dates: [22] } })],
    });
    expect(await seriesRows()).toEqual(before);
    expect(await stored(id)).toEqual(beforeItem);
    function inTenantWrite() {
      return runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: tasksId, itemId: id, propertiesPatch: { recurrence: { preset: "monthly" } } },
            { writer: { writerKind: "agent", agentRunId: randomUUID() } },
          ),
        ),
      );
    }
  });

  it("rejects stale generic recurrence changes before touching the series", async () => {
    const id = await task({ date: "2026-10-22" });
    await put(id, { preset: "weekly" });
    const before = await seriesRows();
    await expect(
      runInTenant(tenant, () =>
        cp.updateItem({
          databaseId: tasksId,
          itemId: id,
          ifVersion: "stale",
          propertiesPatch: { recurrence: { preset: "monthly" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(await seriesRows()).toEqual(before);
  });

  it("stores weekdays [thu] for preset weekly on a task dated Thursday 22 October and returns recurrence and seriesId", async () => {
    const id = await task({ date: "2026-10-22" });
    const response = await put(id, { preset: "weekly" });
    expect(response.status).toBe(200);
    const rule = { kind: "weekdays", days: ["thu"] };
    expect(response.item.properties.recurrence).toEqual({ preset: "weekly", mode: "fixed", rule });
    expect(response.item.properties.seriesId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(response.item.properties.occurrenceDate).toBe("2026-10-22");
    expect(await seriesRows()).toEqual([
      {
        item_id: id,
        series_id: response.item.properties.seriesId,
        mode: "fixed",
        rule,
        active: true,
        anchor_date: "2026-10-22",
      },
    ]);
  });

  it.each([
    ["daily", { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }],
    ["weekdays", { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] }],
    ["monthly", { kind: "monthDates", dates: [22] }],
    ["yearly", { kind: "yearDates", month: 10, day: 22 }],
  ])("maps preset %s on 22 October to a fixed rule", async (preset, rule) => {
    const id = await task({ date: "2026-10-22" });
    const response = await put(id, { preset });
    expect(response.item.properties.recurrence).toEqual({ preset, mode: "fixed", rule });
    expect((await seriesRows())[0]).toMatchObject({ mode: "fixed", rule });
  });

  it("accepts a mode and rule in the existing rule schema, with no preset", async () => {
    const id = await task({ date: "2026-10-22" });
    const rule = { unit: "days", n: 2 };
    const response = await put(id, { mode: "floating", rule });
    expect(response.item.properties.recurrence).toEqual({ preset: null, mode: "floating", rule });
    expect((await seriesRows())[0]).toMatchObject({ mode: "floating", rule });
  });

  it("refuses a task without a date with 400 on date and writes no series", async () => {
    const id = await task({});
    const before = await stored(id);
    const error = await refusal(put(id, { preset: "weekly" }));
    expect(error.details).toEqual({ field: "date" });
    expect(await seriesRows()).toEqual([]);
    expect(await stored(id)).toEqual(before);
  });

  it("advances a completed yearly occurrence to the next year", async () => {
    const id = await task({ date: "2026-10-22" });
    const first = await put(id, { preset: "yearly" });
    const previousNow = Settings.now;
    Settings.now = () => Date.parse("2026-10-22T12:00:00Z");
    try {
      await runInTenant(tenant, () =>
        cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { status: "done" } }),
      );
    } finally {
      Settings.now = previousNow;
    }
    const [series] = await seriesRows();
    if (!series) throw new Error("Missing series");
    expect(series.item_id).not.toBe(id);
    expect(await stored(series.item_id)).toMatchObject({
      date: "2027-10-22",
      occurrenceDate: "2027-10-22",
      seriesId: first.item.properties.seriesId,
    });
  });

  it("uses the supplied date for the yearly preset and refuses impossible dates without writes", async () => {
    const id = await task({ date: "2026-10-22" });
    const response = await put(id, { preset: "yearly", date: "2026-12-24" });
    expect(response.item.properties.recurrence).toEqual({
      preset: "yearly",
      mode: "fixed",
      rule: { kind: "yearDates", month: 12, day: 24 },
    });
    const before = await stored(id);
    const rows = await seriesRows();
    for (const rule of [
      { kind: "yearDates", month: 4, day: 31 },
      { kind: "yearDates", month: 13, day: 1 },
    ]) {
      await expect(put(id, { mode: "fixed", rule })).rejects.toMatchObject({ status: 400 });
      expect(await stored(id)).toEqual(before);
      expect(await seriesRows()).toEqual(rows);
    }
  });

  it("sets date, anchor and occurrence date to 5 November and the rule to day 5 for monthly with a date", async () => {
    const id = await task({ date: "2026-10-22" });
    const response = await put(id, { preset: "monthly", date: "2026-11-05" });
    expect(response.item.properties).toMatchObject({
      date: "2026-11-05",
      occurrenceDate: "2026-11-05",
      recurrence: { preset: "monthly", mode: "fixed", rule: { kind: "monthDates", dates: [5] } },
    });
    expect(await seriesRows()).toEqual([
      expect.objectContaining({ anchor_date: "2026-11-05", rule: { kind: "monthDates", dates: [5] } }),
    ]);
  });

  it("replaces the rule of an existing series in place and refreshes recurrence, moving the anchor only with a date", async () => {
    const id = await task({ date: "2026-10-22" });
    const first = await put(id, { preset: "weekly" });
    const seriesId = first.item.properties.seriesId;
    const second = await put(id, { preset: "daily" });
    expect(second.item.properties.seriesId).toBe(seriesId);
    expect(second.item.properties.occurrenceDate).toBe("2026-10-22");
    expect(second.item.properties.recurrence).toMatchObject({ preset: "daily" });
    const rows = await seriesRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ series_id: seriesId, anchor_date: "2026-10-22", active: true });

    const moved = await put(id, { preset: "weekly", date: "2026-10-27" });
    expect(moved.item.properties).toMatchObject({
      seriesId,
      date: "2026-10-27",
      occurrenceDate: "2026-10-27",
      recurrence: { preset: "weekly", rule: { kind: "weekdays", days: ["tue"] } },
    });
    expect((await seriesRows())[0]).toMatchObject({ series_id: seriesId, anchor_date: "2026-10-27" });
  });

  it("turns recurrence off with DELETE: the task keeps its date, and completing it creates no next instance", async () => {
    const id = await task({ date: "2026-10-22" });
    await put(id, { preset: "weekly" });
    const response = await remove(id);
    expect(response.status).toBe(200);
    expect(response.item.properties).toMatchObject({
      date: "2026-10-22",
      seriesId: null,
      occurrenceDate: null,
      recurrence: null,
    });
    expect((await seriesRows())[0]).toMatchObject({ item_id: id, active: false });

    const before = await taskCount();
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { status: "done" } }),
    );
    expect(await taskCount()).toBe(before);
  });

  it("restarts a turned-off task in its own row with a new series id, leaving the old occurrences' id alone", async () => {
    const id = await task({ date: "2026-10-22" });
    const first = await put(id, { preset: "weekly" });
    await remove(id);
    const again = await put(id, { preset: "monthly" });
    expect(again.item.properties.seriesId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(again.item.properties.seriesId).not.toBe(first.item.properties.seriesId);
    expect(await seriesRows()).toEqual([
      expect.objectContaining({
        item_id: id,
        series_id: again.item.properties.seriesId,
        active: true,
        rule: { kind: "monthDates", dates: [22] },
      }),
    ]);
  });

  it("refuses PUT and DELETE on an occurrence that is no longer the series' current one, on id", async () => {
    const id = await task({ date: "2026-10-22" });
    await put(id, { preset: "weekly" });
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch: { status: "done" } }),
    );
    const before = await seriesRows();
    expect((await refusal(put(id, { preset: "daily" }))).details).toEqual({ field: "id" });
    expect((await refusal(remove(id))).details).toEqual({ field: "id" });
    expect(await seriesRows()).toEqual(before);
  });

  it("returns a task without a series unchanged on DELETE", async () => {
    const id = await task({ date: "2026-10-22" });
    const before = await stored(id);
    const response = await remove(id);
    expect(response.item.properties).toEqual(before);
    expect(await seriesRows()).toEqual([]);
  });

  it("answers a missing task with not found on both routes", async () => {
    const missing = randomUUID();
    await expect(put(missing, { preset: "weekly" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(remove(missing)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ["a body that is no object", null, "body"],
    ["an unknown field", { preset: "weekly", every: 2 }, "every"],
    ["an unknown preset", { preset: "biennial" }, "preset"],
    ["a preset with a mode", { preset: "weekly", mode: "fixed", rule: { kind: "weekdays", days: ["mon"] } }, "preset"],
    ["an unknown mode", { mode: "sometimes", rule: {} }, "mode"],
    ["a mode without a rule", { mode: "fixed" }, "rule"],
    ["a rule outside the schema", { mode: "fixed", rule: { kind: "weekdays", days: [] } }, "rule"],
    ["a date that is no calendar date", { preset: "weekly", date: "2026-02-30" }, "date"],
  ])("refuses %s with 400 naming the field and writes nothing", async (_label, body, field) => {
    const id = await task({ date: "2026-10-22" });
    const before = await stored(id);
    expect((await refusal(put(id, body))).details).toEqual({ field });
    expect(await seriesRows()).toEqual([]);
    expect(await stored(id)).toEqual(before);
  });

  it("refuses an id that is no UUID on id", async () => {
    expect((await refusal(put("not-a-uuid", { preset: "weekly" }))).details).toEqual({ field: "id" });
    expect((await refusal(remove("not-a-uuid"))).details).toEqual({ field: "id" });
  });

  describe("clearing the date of a recurring task through the generic write (R1, gh-1665 decision)", () => {
    function patch(id: string, propertiesPatch: Record<string, unknown>) {
      return runInTenant(tenant, () =>
        cp.updateItem({ databaseId: tasksId, itemId: id, propertiesPatch }, undefined, undefined, USER),
      );
    }

    it.each([
      ["null", null],
      ["an empty string", ""],
    ])(
      "refuses a date of %s on a recurring task with 400 on date, changing neither task nor series",
      async (_label, date) => {
        const id = await task({ date: "2026-10-22", timeFrom: "09:00", timeTo: "10:00" });
        await put(id, { preset: "weekly" });
        const before = await stored(id);
        const series = await seriesRows();
        expect((await refusal(patch(id, { date }))).details).toEqual({ field: "date" });
        expect(await stored(id)).toEqual(before);
        expect(await seriesRows()).toEqual(series);
      },
    );

    it("refuses it for a past occurrence that keeps its series id", async () => {
      const id = await task({ date: "2026-10-22" });
      const seriesId = (await put(id, { preset: "daily" })).item.properties.seriesId;
      if (typeof seriesId !== "string") throw new Error("No series id");
      const past = await runInTenant(tenant, () =>
        createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: "2026-10-20", status: "done" }),
      );
      const before = await stored(past);
      expect((await refusal(patch(past, { date: null }))).details).toEqual({ field: "date" });
      expect(await stored(past)).toEqual(before);
    });

    it("refuses an agent proposal that would clear the date of a recurring task", async () => {
      const id = await task({ date: "2026-10-22" });
      await put(id, { preset: "weekly" });
      const item = await runInTenant(tenant, () => cp.getItem(tasksId, id));
      if (!item) throw new Error("Task missing");
      expect((await refusal(prepareTaskProposal({ stored: item, patch: { date: null } }))).details).toEqual({
        field: "date",
      });
    });

    it("clears the date and times of a task without a series", async () => {
      const id = await task({ date: "2026-10-22", timeFrom: "09:00", timeTo: "10:00" });
      await patch(id, { date: null });
      expect(await stored(id)).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    });

    it("clears the date once DELETE turned recurrence off", async () => {
      const id = await task({ date: "2026-10-22" });
      await put(id, { preset: "weekly" });
      await remove(id);
      await patch(id, { date: "" });
      expect(await stored(id)).toMatchObject({ date: null, seriesId: null });
    });

    it("lets the Tasks module clear the series identity and the date in one write", async () => {
      const id = await task({ date: "2026-10-22" });
      await put(id, { preset: "weekly" });
      await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: tasksId,
              itemId: id,
              propertiesPatch: { seriesId: null, occurrenceDate: null, recurrence: null, date: null },
            },
            { allowedSystemKeys: ["seriesId", "occurrenceDate", "recurrence"], systemOwnerProcess: TASKS_MODULE_ID },
          ),
        ),
      );
      expect(await stored(id)).toMatchObject({ date: null, seriesId: null, occurrenceDate: null, recurrence: null });
    });
  });
});
