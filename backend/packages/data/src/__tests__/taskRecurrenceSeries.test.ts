import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runTaskRecurrenceSeriesCutoverMigration } from "../tasks/taskRecurrenceSeriesCutoverMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { startTaskSeries } from "../testSupport/taskSeriesFixtures.js";
import type { TaskRecurrenceMode, TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let other: string;

const weeklyMonday: TaskRecurrenceRule = { kind: "weekdays", days: ["mon"] };
const daily: TaskRecurrenceRule = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };

const seriesRow = z.object({
  item_id: z.string(),
  series_id: z.string().nullable(),
  anchor_date: z.string().nullable(),
  template: z.unknown(),
  active: z.boolean(),
});
const occurrenceRow = z.object({ id: z.string(), occurrence_date: z.string().nullable(), status: z.string() });

async function tasksDatabaseId(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'tasks'");
    if (!rows[0]) throw new Error("Tasks database missing");
    return rows[0].id;
  });
}

async function recurrenceRows(tenantId: string): Promise<z.infer<typeof seriesRow>[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT item_id, series_id::text AS series_id, anchor_date::text AS anchor_date, template, active FROM task_recurrence ORDER BY item_id",
    );
    return rows.map((row) => seriesRow.parse(row));
  });
}

async function occurrencesOf(tenantId: string, seriesId: string): Promise<z.infer<typeof occurrenceRow>[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT id, properties->>'occurrenceDate' AS occurrence_date, properties->>'status' AS status FROM items
       WHERE properties->>'seriesId' = $1 AND deleted_at IS NULL ORDER BY properties->>'occurrenceDate', id`,
      [seriesId],
    );
    return rows.map((row) => occurrenceRow.parse(row));
  });
}

/** A `task_recurrence` row in the shape releases before issue #1605 wrote; the series store can no longer write it. */
async function insertLegacyRecurrence(
  tenantId: string,
  itemId: string,
  mode: TaskRecurrenceMode,
  rule: TaskRecurrenceRule,
  active = true,
): Promise<void> {
  await runInTenant(tenantId, () =>
    pool.query("INSERT INTO task_recurrence (item_id, mode, rule, active) VALUES ($1, $2, $3::jsonb, $4)", [
      itemId,
      mode,
      JSON.stringify(rule),
      active,
    ]),
  );
}

describe("recurring task series (issues #1605, #1670)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(pool));
    vi.useFakeTimers({ toFake: ["Date"] });
    // Friday 16 October 2026, 12:00 in the default tenant time zone Europe/Prague.
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  describe("series cutover", () => {
    it("gives every active recurring instance a series and leaves done and inactive ones alone", async () => {
      const tasks = await tasksDatabaseId(tenant);
      const cp = createChokePoint(pool);
      const create = (properties: Record<string, unknown>) =>
        runInTenant(tenant, () => cp.createItem({ databaseId: tasks, properties }));
      const weekly = await create({
        name: "Weekly review",
        date: "2026-10-12",
        flagged: true,
        description: "Look back",
        notifications: true,
      });
      const everyDay = await create({ name: "Stretch", date: "2026-10-14" });
      const workdays = await create({ name: "Inbox zero", date: "2026-10-16" });
      const monthly = await create({ name: "Rent", date: "2026-10-15" });
      const floating = await create({ name: "Water plants", date: "2026-10-15" });
      const offPreset = await create({ name: "Tuesday thing", date: "2026-10-12" });
      const done = await create({ name: "Old chore", date: "2026-10-01", status: "done" });
      const inactive = await create({ name: "Stopped", date: "2026-10-02" });
      const cases: Array<[string, TaskRecurrenceMode, TaskRecurrenceRule, string | null]> = [
        [weekly.id, "fixed", weeklyMonday, "weekly"],
        [everyDay.id, "fixed", daily, "daily"],
        [workdays.id, "fixed", { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] }, "weekdays"],
        [monthly.id, "fixed", { kind: "monthDates", dates: [15] }, "monthly"],
        [floating.id, "floating", { unit: "days", n: 2 }, null],
        [offPreset.id, "fixed", { kind: "weekdays", days: ["tue"] }, null],
      ];
      for (const [itemId, mode, rule] of cases) await insertLegacyRecurrence(tenant, itemId, mode, rule);
      await insertLegacyRecurrence(tenant, done.id, "fixed", weeklyMonday);
      await insertLegacyRecurrence(tenant, inactive.id, "fixed", weeklyMonday, false);
      const otherTasks = await tasksDatabaseId(other);
      const foreign = await runInTenant(other, () =>
        cp.createItem({ databaseId: otherTasks, properties: { name: "Other tenant", date: "2026-10-12" } }),
      );
      await insertLegacyRecurrence(other, foreign.id, "fixed", weeklyMonday);

      await runAsSystem("test cutover", () => runTenantCutoverMigrations(pool));

      const rows = new Map((await recurrenceRows(tenant)).map((row) => [row.item_id, row]));
      const seriesIds = new Set<string>();
      for (const [itemId, mode, rule, preset] of cases) {
        const item = await runInTenant(tenant, () => cp.getItem(tasks, itemId));
        const date = item?.properties.date;
        const row = rows.get(itemId);
        expect(row?.series_id).toEqual(expect.any(String));
        expect(row?.anchor_date).toBe(date);
        expect(item?.properties).toMatchObject({
          seriesId: row?.series_id,
          occurrenceDate: date,
          recurrence: { preset, mode, rule },
        });
        seriesIds.add(String(row?.series_id));
      }
      expect(seriesIds.size).toBe(cases.length);
      expect(rows.get(weekly.id)?.template).toEqual({
        name: "Weekly review",
        timeFrom: null,
        timeTo: null,
        notifications: true,
        persistent: false,
        flagged: true,
        description: "Look back",
      });
      for (const untouched of [done, inactive]) {
        expect(rows.get(untouched.id)).toMatchObject({ series_id: null, anchor_date: null, template: null });
        const item = await runInTenant(tenant, () => cp.getItem(tasks, untouched.id));
        expect(item?.properties.seriesId).toBeUndefined();
        expect(item?.properties.occurrenceDate).toBeUndefined();
        expect(item?.properties.recurrence).toBeUndefined();
      }
      const [foreignRow] = await recurrenceRows(other);
      const foreignItem = await runInTenant(other, () => cp.getItem(otherTasks, foreign.id));
      expect(foreignItem?.properties.seriesId).toBe(foreignRow?.series_id);
      expect(seriesIds.has(String(foreignRow?.series_id))).toBe(false);

      const snapshot = () =>
        Promise.all(
          [tenant, other].map((id) =>
            runInTenant(id, async () => ({
              recurrence: await recurrenceRows(id),
              items: (
                await pool.query(
                  "SELECT id, properties, updated_at FROM items WHERE database_id = ANY($1) ORDER BY id",
                  [[tasks, otherTasks]],
                )
              ).rows,
            })),
          ),
        );
      const before = await snapshot();
      await runAsSystem("test cutover", () => runTenantCutoverMigrations(pool));
      expect(await snapshot()).toEqual(before);
    });

    it("fails a tenant's cutover unchanged when an eligible row has no valid date or no Tasks instance", async () => {
      const tasks = await tasksDatabaseId(tenant);
      const otherTasks = await tasksDatabaseId(other);
      const cp = createChokePoint(pool);
      const valid = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasks, properties: { name: "Weekly review", date: "2026-10-12" } }),
      );
      const dateless = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasks, properties: { name: "No date" } }),
      );
      const done = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasks, properties: { name: "Old chore", status: "done" } }),
      );
      await insertLegacyRecurrence(tenant, valid.id, "fixed", weeklyMonday);
      await insertLegacyRecurrence(tenant, dateless.id, "fixed", weeklyMonday);
      // A done instance without a date stays excluded and does not fail the tenant.
      await insertLegacyRecurrence(tenant, done.id, "fixed", weeklyMonday);
      // A row whose instance was purged without its recurrence row being removed.
      const orphan = "00000000-0000-4000-8000-0000000000aa";
      await insertLegacyRecurrence(tenant, orphan, "fixed", weeklyMonday);
      const foreign = await runInTenant(other, () =>
        cp.createItem({ databaseId: otherTasks, properties: { name: "Other tenant", date: "2026-10-12" } }),
      );
      await insertLegacyRecurrence(other, foreign.id, "fixed", weeklyMonday);
      const state = (id: string, databaseId: string) =>
        runInTenant(id, async () => ({
          recurrence: await recurrenceRows(id),
          items: (
            await pool.query<{ id: string; properties: unknown; updated_at: Date }>(
              "SELECT id, properties, updated_at FROM items WHERE database_id = $1 ORDER BY id",
              [databaseId],
            )
          ).rows,
        }));
      const before = await state(tenant, tasks);

      const failure = await runAsSystem("test cutover", () => runTenantCutoverMigrations(pool)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = failure instanceof AggregateError ? failure.errors : [];
      expect(failure instanceof Error ? failure.message : "").toContain(tenant);
      expect(errors).toHaveLength(1);
      const message = errors[0] instanceof Error ? errors[0].message : "";
      expect(message).toContain(dateless.id);
      expect(message).toContain(orphan);
      expect(message).not.toContain(valid.id);
      expect(message).not.toContain(done.id);
      expect(await state(tenant, tasks)).toEqual(before);
      const [foreignRow] = await recurrenceRows(other);
      expect(foreignRow?.series_id).toEqual(expect.any(String));
      expect((await runInTenant(other, () => cp.getItem(otherTasks, foreign.id)))?.properties.seriesId).toBe(
        foreignRow?.series_id,
      );
    });

    it("fails closed when active recurrence rows exist in a tenant without a Tasks database", async () => {
      const bare = await createTestTenant(admin);
      // A historical state: an active pre-#1605 recurrence row in a tenant whose Tasks database does not exist.
      await insertLegacyRecurrence(bare, "00000000-0000-4000-8000-0000000000bb", "fixed", weeklyMonday);
      await expect(runInTenant(bare, () => runTaskRecurrenceSeriesCutoverMigration(pool))).rejects.toThrow(
        "no Tasks database",
      );
      expect(await recurrenceRows(bare)).toEqual([
        {
          item_id: "00000000-0000-4000-8000-0000000000bb",
          series_id: null,
          anchor_date: null,
          template: null,
          active: true,
        },
      ]);
    });

    it("returns the series fields on read and refuses a client write of each of them with 403 owner_violation", async () => {
      const tasks = await tasksDatabaseId(tenant);
      const cp = createChokePoint(pool);
      const task = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasks, properties: { name: "Weekly review", date: "2026-10-12" } }),
      );
      await insertLegacyRecurrence(tenant, task.id, "fixed", weeklyMonday);
      await runAsSystem("test cutover", () => runTenantCutoverMigrations(pool));
      const read = await runInTenant(tenant, () => cp.getItem(tasks, task.id));
      expect(read?.properties).toMatchObject({
        seriesId: expect.any(String),
        occurrenceDate: "2026-10-12",
        recurrence: { preset: "weekly", mode: "fixed", rule: weeklyMonday },
      });
      for (const patch of [
        { seriesId: "00000000-0000-4000-8000-000000000000" },
        { occurrenceDate: "2026-10-13" },
        { recurrence: { preset: null, mode: "fixed", rule: daily } },
      ]) {
        await expect(
          runInTenant(tenant, () => cp.updateItem({ databaseId: tasks, itemId: task.id, propertiesPatch: patch })),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
      }
      expect(await runInTenant(tenant, () => cp.getItem(tasks, task.id))).toEqual(read);
    });
  });

  describe("advance", () => {
    let cp: ChokePoint;
    let tasks: string;

    beforeEach(async () => {
      cp = createChokePoint(pool);
      tasks = await tasksDatabaseId(tenant);
    });

    async function recurringTask(
      date: string,
      mode: TaskRecurrenceMode,
      rule: TaskRecurrenceRule,
      active = true,
    ): Promise<{ id: string; seriesId: string }> {
      const task = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasks, properties: { name: "Recurring", date } }),
      );
      const seriesId = await runInTenant(tenant, () =>
        startTaskSeries(pool, { databaseId: tasks, itemId: task.id, mode, rule, active }),
      );
      return { id: task.id, seriesId };
    }

    const setStatus = (itemId: string, patch: Record<string, unknown>) =>
      runInTenant(tenant, () => cp.updateItem({ databaseId: tasks, itemId, propertiesPatch: patch }));

    it("done creates the next instance of the same series and moves the one series row to it", async () => {
      const task = await recurringTask("2026-10-12", "fixed", weeklyMonday);
      await setStatus(task.id, { status: "done" });
      const occurrences = await occurrencesOf(tenant, task.seriesId);
      expect(occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
        ["2026-10-12", "done"],
        ["2026-10-19", "notDone"],
      ]);
      const next = occurrences[1]!;
      const nextItem = await runInTenant(tenant, () => cp.getItem(tasks, next.id));
      expect(nextItem?.properties).toMatchObject({
        name: "Recurring",
        date: "2026-10-19",
        occurrenceDate: "2026-10-19",
        seriesId: task.seriesId,
        recurrence: { preset: null, mode: "fixed", rule: weeklyMonday },
      });
      expect(await recurrenceRows(tenant)).toEqual([
        expect.objectContaining({ item_id: next.id, series_id: task.seriesId, active: true }),
      ]);
    });

    it("an early completion of Monday 19 October on Friday 16 October creates Monday 26 October", async () => {
      const task = await recurringTask("2026-10-19", "fixed", weeklyMonday);
      await setStatus(task.id, { status: "done" });
      expect((await occurrencesOf(tenant, task.seriesId)).map((o) => o.occurrence_date)).toEqual([
        "2026-10-19",
        "2026-10-26",
      ]);
    });

    it("done, notDone and done again leave at most one open occurrence per date", async () => {
      const task = await recurringTask("2026-10-12", "fixed", weeklyMonday);
      await setStatus(task.id, { status: "done" });
      await setStatus(task.id, { status: "notDone" });
      await setStatus(task.id, { status: "done" });
      const occurrences = await occurrencesOf(tenant, task.seriesId);
      expect(occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
        ["2026-10-12", "done"],
        ["2026-10-19", "notDone"],
      ]);
    });

    it("a late completion of yesterday's daily occurrence creates today's occurrence", async () => {
      const task = await recurringTask("2026-10-15", "fixed", daily);
      await setStatus(task.id, { status: "done" });
      expect((await occurrencesOf(tenant, task.seriesId)).map((o) => o.occurrence_date)).toEqual([
        "2026-10-15",
        "2026-10-16",
      ]);
    });

    it("a floating rule counts from completedOn, not from the occurrence date", async () => {
      const task = await recurringTask("2026-10-12", "floating", { unit: "weeks", n: 1 });
      await setStatus(task.id, { status: "done", completedOn: "2026-10-14" });
      expect((await occurrencesOf(tenant, task.seriesId)).map((o) => o.occurrence_date)).toEqual([
        "2026-10-12",
        "2026-10-21",
      ]);
    });

    it("wontDo on Monday 19 October on Friday 16 October creates Monday 26 October and keeps the series active", async () => {
      const task = await recurringTask("2026-10-19", "fixed", weeklyMonday);
      await setStatus(task.id, { status: "wontDo" });
      const occurrences = await occurrencesOf(tenant, task.seriesId);
      expect(occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
        ["2026-10-19", "wontDo"],
        ["2026-10-26", "notDone"],
      ]);
      expect(await recurrenceRows(tenant)).toEqual([
        expect.objectContaining({ item_id: occurrences[1]!.id, series_id: task.seriesId, active: true }),
      ]);
    });

    it("wontDo twice, or wontDo then done, creates no second next occurrence", async () => {
      const twice = await recurringTask("2026-10-19", "fixed", weeklyMonday);
      await setStatus(twice.id, { status: "wontDo" });
      await setStatus(twice.id, { status: "wontDo" });
      expect(await occurrencesOf(tenant, twice.seriesId)).toHaveLength(2);
      const thenDone = await recurringTask("2026-10-19", "fixed", weeklyMonday);
      await setStatus(thenDone.id, { status: "wontDo" });
      await setStatus(thenDone.id, { status: "done" });
      expect((await occurrencesOf(tenant, thenDone.seriesId)).map((o) => o.occurrence_date)).toEqual([
        "2026-10-19",
        "2026-10-26",
      ]);
    });

    it("a floating wontDo counts from the day of the write in the tenant time zone", async () => {
      // 23:30 UTC on 15 October is already 16 October in Europe/Prague.
      vi.setSystemTime(new Date("2026-10-15T23:30:00Z"));
      const task = await recurringTask("2026-10-12", "floating", { unit: "days", n: 3 });
      await setStatus(task.id, { status: "wontDo" });
      expect((await occurrencesOf(tenant, task.seriesId)).map((o) => o.occurrence_date)).toEqual([
        "2026-10-12",
        "2026-10-19",
      ]);
    });

    it("an inactive series creates nothing", async () => {
      const task = await recurringTask("2026-10-12", "fixed", weeklyMonday, false);
      await setStatus(task.id, { status: "done" });
      expect(await occurrencesOf(tenant, task.seriesId)).toHaveLength(1);
    });

    it("an occurrence without a valid occurrenceDate fails the completion and writes nothing", async () => {
      const task = await recurringTask("2026-10-12", "fixed", weeklyMonday);
      // A corrupt system-owned value no writer produces; written past the choke point on purpose.
      await runInTenant(tenant, () =>
        pool.query("UPDATE items SET properties = properties - 'occurrenceDate' WHERE id = $1", [task.id]),
      );
      await expect(setStatus(task.id, { status: "done" })).rejects.toThrow(/no valid occurrenceDate/);
      expect(await occurrencesOf(tenant, task.seriesId)).toEqual([
        { id: task.id, occurrence_date: null, status: "notDone" },
      ]);
    });

    it("a template without a usable name creates the next instance without a name", async () => {
      const task = await runInTenant(tenant, () =>
        cp.createItem({ databaseId: tasks, properties: { date: "2026-10-12" } }),
      );
      const seriesId = await runInTenant(tenant, () =>
        startTaskSeries(pool, { databaseId: tasks, itemId: task.id, mode: "fixed", rule: weeklyMonday }),
      );
      await setStatus(task.id, { status: "done" });
      const next = (await occurrencesOf(tenant, seriesId))[1]!;
      const nextItem = await runInTenant(tenant, () => cp.getItem(tasks, next.id));
      expect(nextItem?.properties.name).toBeUndefined();
      expect(nextItem?.properties.occurrenceDate).toBe("2026-10-19");
    });

    it("two concurrent completions of the same occurrence create exactly one next instance", async () => {
      const task = await recurringTask("2026-10-12", "fixed", weeklyMonday);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const blocker = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [task.id]);
          locked();
          await released;
        }),
      );
      await holding;
      const completions = [setStatus(task.id, { status: "done" }), setStatus(task.id, { status: "done" })];
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting < 2; attempt++) {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'semprec_data' AND wait_event_type = 'Lock'",
        );
        waiting = rows[0]?.n ?? 0;
        if (waiting < 2) await sleep(25);
      }
      expect(waiting).toBe(2);
      release();
      await blocker;
      await Promise.all(completions);
      const occurrences = await occurrencesOf(tenant, task.seriesId);
      expect(occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
        ["2026-10-12", "done"],
        ["2026-10-19", "notDone"],
      ]);
      expect(await recurrenceRows(tenant)).toHaveLength(1);
    });
  });
});
