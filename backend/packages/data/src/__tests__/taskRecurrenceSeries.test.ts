import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import {
  insertValueLink,
  listValueLinkSourcesByLinkIds,
  listValueLinksByItemIds,
} from "../chokePoint/valueLinksStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runTaskRecurrenceSeriesCutoverMigration } from "../tasks/taskRecurrenceSeriesCutoverMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { startTaskSeries } from "../testSupport/taskSeriesFixtures.js";
import type { TaskRecurrenceMode, TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";
import type { ItemRelationRow } from "../types.js";

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

const pidResult = z.object({ rows: z.tuple([z.object({ pid: z.number() })]) });
const blockersResult = z.object({ rows: z.tuple([z.object({ blockers: z.array(z.number()) })]) });
const countResult = z.object({ rows: z.tuple([z.object({ n: z.number() })]) });
const queryText = z.union([z.string(), z.object({ text: z.string() }).transform((query) => query.text)]);

/**
 * A dedicated runtime-role pool for one participant of a concurrency test. Each client it hands out reads its own
 * backend PID once (`pg_backend_pid()`) and runs `before` ahead of every statement; every statement is still sent to
 * the server unchanged and its real result returned. The client's own `query` is restored before the pool takes it
 * back.
 */
async function observedPool(
  before?: (sql: string, values: readonly unknown[]) => Promise<void>,
): Promise<{ pool: Pool; pids: Set<number> }> {
  const observed = await createRuntimeRolePool(admin, "semprec_data");
  const pids = new Set<number>();
  const restore = new Map<object, PropertyDescriptor | undefined>();
  observed.on("acquire", (client) => {
    const delegate: unknown = Reflect.get(client, "query");
    if (typeof delegate !== "function") throw new Error("A pg client without query");
    restore.set(client, Object.getOwnPropertyDescriptor(client, "query"));
    let identified = false;
    Object.defineProperty(client, "query", {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        if (!identified) {
          identified = true;
          const own = pidResult.parse(await Reflect.apply(delegate, client, ["SELECT pg_backend_pid() AS pid"]));
          pids.add(own.rows[0].pid);
        }
        await before?.(queryText.parse(args[0]), Array.isArray(args[1]) ? args[1] : []);
        return Reflect.apply(delegate, client, args);
      },
    });
  });
  observed.on("release", (_error, client) => {
    const own = restore.get(client);
    restore.delete(client);
    if (own) Object.defineProperty(client, "query", own);
    else Reflect.deleteProperty(client, "query");
  });
  return { pool: observed, pids };
}

/** Rejects when `promise` has not settled within `ms`, naming what the test waited for. */
async function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls, at most 200 times 25 ms apart, until every participant has a backend whose blocking PIDs are not empty and
 * all belong to this test (`owned`). Waits are matched by PID, never by a role-wide count.
 */
async function waitUntilBlocked(participants: ReadonlyArray<ReadonlySet<number>>, owned: () => ReadonlySet<number>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ours = owned();
    let blocked = 0;
    for (const pids of participants) {
      for (const pid of pids) {
        const result = blockersResult.parse(await admin.query("SELECT pg_blocking_pids($1) AS blockers", [pid]));
        const { blockers } = result.rows[0];
        if (blockers.length > 0 && blockers.every((blocker) => ours.has(blocker))) {
          blocked++;
          break;
        }
      }
    }
    if (blocked === participants.length) return;
    await sleep(25);
  }
  throw new Error("The test's participants did not all wait on the test's own backends");
}

/** Waits for every started participant and ends every owned pool; the test's own failure is rethrown first. */
async function settle(failure: { error: unknown } | undefined, started: Promise<unknown>[], pools: Pool[]) {
  await Promise.allSettled(started);
  const cleanup: unknown[] = [];
  for (const owned of pools) {
    try {
      await owned.end();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (failure && cleanup.length > 0) throw new AggregateError([failure.error, ...cleanup], "Test and cleanup failed");
  if (failure) throw failure.error;
  if (cleanup.length > 0) throw new AggregateError(cleanup, "Owned pool cleanup failed");
}

/** The count of every core queue task, by identifier: a complete view of the jobs a write may have enqueued. */
async function jobCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const identifier of Object.values(CORE_TASK_NAMES))
    counts[identifier] = await countJobsByIdentifier(admin, identifier);
  return counts;
}

async function notificationCount(tenantId: string): Promise<number> {
  return runInTenant(
    tenantId,
    async () => countResult.parse(await pool.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n,
  );
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
                await pool.query<{ id: string; properties: unknown; updated_at: Date }>(
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

    it("fails a tenant's cutover unchanged when an eligible row's date is not a calendar day", async () => {
      const tasks = await tasksDatabaseId(tenant);
      const otherTasks = await tasksDatabaseId(other);
      const cp = createChokePoint(pool);
      const create = (properties: Record<string, unknown>) =>
        runInTenant(tenant, () => cp.createItem({ databaseId: tasks, properties }));
      const valid = await create({ name: "Weekly review", date: "2026-10-12" });
      const invalid = await create({ name: "Leap day", date: "2026-10-13" });
      // A stored date from before the Tasks date rule: the transform refuses 2026-02-30, so no writer can store it now.
      await runInTenant(tenant, () =>
        pool.query(`UPDATE items SET properties = jsonb_set(properties, '{date}', '"2026-02-30"') WHERE id = $1`, [
          invalid.id,
        ]),
      );
      for (const item of [valid, invalid]) await insertLegacyRecurrence(tenant, item.id, "fixed", weeklyMonday);
      const foreign = await runInTenant(other, () =>
        cp.createItem({ databaseId: otherTasks, properties: { name: "Other tenant", date: "2026-10-12" } }),
      );
      await insertLegacyRecurrence(other, foreign.id, "fixed", weeklyMonday);
      const state = () =>
        runInTenant(tenant, async () => ({
          recurrence: await recurrenceRows(tenant),
          items: (
            await pool.query<{ id: string; properties: unknown; updated_at: Date }>(
              "SELECT id, properties, updated_at FROM items WHERE database_id = $1 ORDER BY id",
              [tasks],
            )
          ).rows,
        }));
      const before = await state();

      const failure = await runAsSystem("test cutover", () => runTenantCutoverMigrations(pool)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = failure instanceof AggregateError ? failure.errors : [];
      expect(errors).toHaveLength(1);
      const message = errors[0] instanceof Error ? errors[0].message : "";
      expect(message).toContain(invalid.id);
      expect(message).not.toContain(valid.id);
      expect(await state()).toEqual(before);
      const [foreignRow] = await recurrenceRows(other);
      expect(foreignRow?.series_id).toEqual(expect.any(String));
    });

    it("converts 501 rows in committed batches of 500, keeps the first batch when the second fails its locked re-check, and resumes", async () => {
      const tasks = await tasksDatabaseId(tenant);
      const cp = createChokePoint(pool);
      const created: string[] = [];
      for (let start = 0; start < 501; start += 20) {
        const chunk = Array.from({ length: Math.min(20, 501 - start) }, (_unused, offset) => start + offset);
        const items = await Promise.all(
          chunk.map((index) =>
            runInTenant(tenant, () =>
              cp.createItem({ databaseId: tasks, properties: { name: `Chore ${index}`, date: "2026-10-12" } }),
            ),
          ),
        );
        created.push(...items.map((item) => item.id));
      }
      // 501 rows in the shape releases before issue #1605 wrote, in one statement.
      await runInTenant(tenant, () =>
        pool.query(
          "INSERT INTO task_recurrence (item_id, mode, rule, active) SELECT id, 'fixed', $2::jsonb, true FROM unnest($1::uuid[]) AS id",
          [created, JSON.stringify(weeklyMonday)],
        ),
      );
      const ordered = [...created].sort();
      const last = ordered.at(-1);
      if (last === undefined) throw new Error("No candidates were created");
      const converted = async () =>
        runInTenant(
          tenant,
          async () =>
            countResult.parse(
              await pool.query("SELECT count(*)::int AS n FROM task_recurrence WHERE series_id IS NOT NULL"),
            ).rows[0].n,
        );

      let reached!: () => void;
      const atSecondBatch = new Promise<void>((resolve) => (reached = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      // Holds the second conversion transaction after its candidate read and before it locks its one candidate.
      const observed = await observedPool(async (sql, values) => {
        const ids = values[1];
        if (
          sql.includes("FROM items") &&
          sql.includes("ORDER BY id FOR UPDATE") &&
          Array.isArray(ids) &&
          ids[0] === last
        ) {
          reached();
          await released;
        }
      });
      const started: Promise<unknown>[] = [];
      let failure: { error: unknown } | undefined;
      try {
        const run = runInTenant(tenant, () => runTaskRecurrenceSeriesCutoverMigration(observed.pool)).then(
          () => null,
          (error: unknown) => error,
        );
        started.push(run);
        await bounded(atSecondBatch, "the second conversion transaction");
        expect(await converted()).toBe(500);
        // The Tasks owner clears the last candidate's date after the preflight checked it.
        await runInTenant(tenant, () =>
          cp.updateItem({ databaseId: tasks, itemId: last, propertiesPatch: { date: null } }),
        );
        release();
        const error = await bounded(run, "the cutover run");
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error ? error.message : "").toContain(last);

        const rows = new Map((await recurrenceRows(tenant)).map((row) => [row.item_id, row]));
        expect(ordered.slice(0, 500).every((id) => typeof rows.get(id)?.series_id === "string")).toBe(true);
        expect(rows.get(last)).toMatchObject({ series_id: null, anchor_date: null, template: null, active: true });
        const lastItem = await runInTenant(tenant, () => cp.getItem(tasks, last));
        expect(lastItem?.properties.seriesId).toBeUndefined();
        expect(lastItem?.properties.date ?? null).toBeNull();

        await runInTenant(tenant, () =>
          cp.updateItem({ databaseId: tasks, itemId: last, propertiesPatch: { date: "2026-10-12" } }),
        );
        await runInTenant(tenant, () => runTaskRecurrenceSeriesCutoverMigration(pool));
        expect(await converted()).toBe(501);
        expect((await runInTenant(tenant, () => cp.getItem(tasks, last)))?.properties).toMatchObject({
          seriesId: expect.any(String),
          occurrenceDate: "2026-10-12",
        });
        const snapshot = () =>
          runInTenant(tenant, async () => ({
            recurrence: await recurrenceRows(tenant),
            items: (
              await pool.query<{ id: string; properties: unknown; updated_at: Date }>(
                "SELECT id, properties, updated_at FROM items WHERE database_id = $1 ORDER BY id",
                [tasks],
              )
            ).rows,
          }));
        const complete = await snapshot();
        await runInTenant(tenant, () => runTaskRecurrenceSeriesCutoverMigration(pool));
        expect(await snapshot()).toEqual(complete);
      } catch (error) {
        failure = { error };
      }
      release();
      await settle(failure, started, [observed.pool]);
    });

    it("returns series fields and accepts recurrence while refusing seriesId and occurrenceDate", async () => {
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
      for (const patch of [{ seriesId: "00000000-0000-4000-8000-000000000000" }, { occurrenceDate: "2026-10-13" }]) {
        await expect(
          runInTenant(tenant, () => cp.updateItem({ databaseId: tasks, itemId: task.id, propertiesPatch: patch })),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
      }
      await expect(
        runInTenant(tenant, () =>
          cp.updateItem({
            databaseId: tasks,
            itemId: task.id,
            propertiesPatch: { recurrence: { preset: null, mode: "fixed", rule: daily } },
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await runInTenant(tenant, () => cp.getItem(tasks, task.id))).toEqual(read);
      const changed = await runInTenant(tenant, () =>
        cp.updateItem({
          databaseId: tasks,
          itemId: task.id,
          propertiesPatch: { recurrence: { mode: "fixed", rule: daily } },
        }),
      );
      expect(changed.properties.recurrence).toMatchObject({ mode: "fixed", rule: daily });
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

    it("a template without a name creates the next instance without a name", async () => {
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

    it("refuses to complete when the template's stored title is blank and leaves every effect as it was", async () => {
      for (const blank of ["", " \t "]) {
        const task = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: tasks, properties: { name: "Recurring", date: "2026-10-12" } }),
        );
        // A template the series cutover copied from a stored blank title, written before the Tasks title rule.
        const seriesId = await runInTenant(tenant, () =>
          startTaskSeries(pool, {
            databaseId: tasks,
            itemId: task.id,
            mode: "fixed",
            rule: weeklyMonday,
            template: { name: blank },
          }),
        );
        const effects = async () => ({
          occurrences: await occurrencesOf(tenant, seriesId),
          task: await runInTenant(tenant, () => cp.getItem(tasks, task.id)),
          recurrence: (await recurrenceRows(tenant)).filter((row) => row.series_id === seriesId),
          jobs: await jobCounts(),
          notifications: await notificationCount(tenant),
        });
        const before = await effects();
        expect(before.recurrence).toEqual([
          expect.objectContaining({ item_id: task.id, template: expect.objectContaining({ name: blank }) }),
        ]);
        await expect(setStatus(task.id, { status: "done" })).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "name" },
        });
        expect(await effects()).toEqual(before);
      }
    });

    it("takes name, times and notifications from the template and flag and description from the completed item", async () => {
      const task = await runInTenant(tenant, () =>
        cp.createItem({
          databaseId: tasks,
          properties: {
            name: "Current name",
            date: "2026-10-12",
            timeFrom: "11:00",
            timeTo: "12:00",
            notifications: false,
            flagged: true,
            description: "Current notes",
          },
        }),
      );
      const seriesId = await runInTenant(tenant, () =>
        startTaskSeries(pool, {
          databaseId: tasks,
          itemId: task.id,
          mode: "fixed",
          rule: weeklyMonday,
          template: {
            name: "Template name",
            timeFrom: "09:00",
            timeTo: "10:30",
            notifications: true,
            persistent: true,
            flagged: false,
            description: "Template notes",
          },
        }),
      );
      await setStatus(task.id, { status: "done" });
      const next = (await occurrencesOf(tenant, seriesId)).find((o) => o.id !== task.id);
      if (!next) throw new Error("No next occurrence");
      const nextProperties = (await runInTenant(tenant, () => cp.getItem(tasks, next.id)))?.properties;
      // The legacy template's `persistent: true` is not copied: the Tasks property is gone (issue #2009).
      expect(nextProperties && Object.hasOwn(nextProperties, "persistent")).toBe(false);
      expect(nextProperties).toMatchObject({
        name: "Template name",
        timeFrom: "09:00",
        timeTo: "10:30",
        notifications: true,
        flagged: true,
        description: "Current notes",
        date: "2026-10-19",
        occurrenceDate: "2026-10-19",
        status: "notDone",
      });
    });

    describe("an older occurrence written again on a later day", () => {
      /** A recurring task with a project edge and a file whose value link is sourced from the task. */
      async function linkedRecurringTask(date: string) {
        const task = await recurringTask(date, "fixed", weeklyMonday);
        const databaseOf = async (moduleId: string) => {
          const { rows } = await runInTenant(tenant, () =>
            pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]),
          );
          if (!rows[0]) throw new Error(`Missing ${moduleId} database`);
          return rows[0].id;
        };
        const projects = await databaseOf("projects");
        const files = await databaseOf("files");
        const { rows } = await runInTenant(tenant, () =>
          pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = 'project'", [tasks]),
        );
        if (!rows[0]) throw new Error("Missing Tasks.project");
        const relationPropertyId = rows[0].id;
        const project = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: projects, properties: { name: "Home" } }),
        );
        await runInTenant(tenant, () =>
          cp.createRelation({ relationPropertyId, callerItemId: task.id, targetItemId: project.id }),
        );
        const file = await runInTenant(tenant, () =>
          cp.createItem({ databaseId: files, properties: { name: "Plan.pdf" } }),
        );
        // The value-link store's own write; no manifest declares a Tasks-sourced link rule yet.
        await runInTenant(tenant, () =>
          withTransaction(pool, (client) =>
            insertValueLink(client, {
              itemId: file.id,
              propertyKey: "projects",
              ruleKey: "test.taskProjectToFiles",
              sources: [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" }],
            }),
          ),
        );
        return { ...task, fileId: file.id };
      }

      /** Every occurrence, the series row, every edge of every occurrence and the file's value-link sources. */
      async function seriesState(seriesId: string, fileId: string) {
        const occurrences = await occurrencesOf(tenant, seriesId);
        const recurrence = (await recurrenceRows(tenant)).filter((row) => row.series_id === seriesId);
        const linked = await runInTenant(tenant, () =>
          withTransaction(pool, async (client) => {
            const edges = new Map<string, ItemRelationRow>();
            for (const occurrence of occurrences) {
              for (const edge of await relationsStore.listAllRelationsForItem(client, occurrence.id)) {
                edges.set(edge.id, edge);
              }
            }
            const links = await listValueLinksByItemIds(client, [fileId]);
            const sources = await listValueLinkSourcesByLinkIds(
              client,
              links.map((l) => l.id),
            );
            return {
              edges: [...edges.values()]
                .map((edge) => `${edge.itemA} ${edge.itemB} ${JSON.stringify(edge.metadata)}`)
                .sort(),
              sources: sources
                .map((source) =>
                  source.kind === "item"
                    ? `item ${source.sourceItemId} ${source.sourcePropertyKey}`
                    : `${source.kind} ${source.domain} ${source.sourcePropertyKey}`,
                )
                .sort(),
            };
          }),
        );
        return { occurrences, recurrence, ...linked };
      }

      it("a second wontDo of the 19 October occurrence on 27 October creates nothing and leaves pointer, edges and links", async () => {
        const task = await linkedRecurringTask("2026-10-19");
        await setStatus(task.id, { status: "wontDo" });
        const advanced = await seriesState(task.seriesId, task.fileId);
        expect(advanced.occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
          ["2026-10-19", "wontDo"],
          ["2026-10-26", "notDone"],
        ]);
        const next = advanced.occurrences[1]!;
        expect(advanced.recurrence).toEqual([expect.objectContaining({ item_id: next.id })]);
        expect(advanced.sources).toEqual([`item ${next.id} project`]);
        vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
        await setStatus(task.id, { status: "wontDo" });
        expect(await seriesState(task.seriesId, task.fileId)).toEqual(advanced);
      });

      it("done, reopen and done of the 12 October occurrence on 20 October creates nothing and leaves the pointer", async () => {
        const task = await linkedRecurringTask("2026-10-12");
        await setStatus(task.id, { status: "done" });
        await setStatus(task.id, { status: "notDone" });
        const reopened = await seriesState(task.seriesId, task.fileId);
        expect(reopened.occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
          ["2026-10-12", "notDone"],
          ["2026-10-19", "notDone"],
        ]);
        expect(reopened.recurrence).toEqual([expect.objectContaining({ item_id: reopened.occurrences[1]!.id })]);
        vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
        await setStatus(task.id, { status: "done" });
        const after = await seriesState(task.seriesId, task.fileId);
        expect(after.occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
          ["2026-10-12", "done"],
          ["2026-10-19", "notDone"],
        ]);
        expect({ ...after, occurrences: [] }).toEqual({ ...reopened, occurrences: [] });
      });

      it("wontDo of the 19 October occurrence on 16 October, then done on 27 October, creates nothing more", async () => {
        const task = await linkedRecurringTask("2026-10-19");
        await setStatus(task.id, { status: "wontDo" });
        const advanced = await seriesState(task.seriesId, task.fileId);
        vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
        await setStatus(task.id, { status: "done" });
        const after = await seriesState(task.seriesId, task.fileId);
        expect(after.occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
          ["2026-10-19", "done"],
          ["2026-10-26", "notDone"],
        ]);
        expect({ ...after, occurrences: [] }).toEqual({ ...advanced, occurrences: [] });
      });
    });

    it("two concurrent completions of the same occurrence create exactly one next instance", async () => {
      const task = await recurringTask("2026-10-12", "fixed", weeklyMonday);
      const holder = await observedPool();
      const first = await observedPool();
      const second = await observedPool();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const started: Promise<unknown>[] = [];
      let failure: { error: unknown } | undefined;
      try {
        const blocker = runInTenant(tenant, () =>
          withTransaction(holder.pool, async (client) => {
            await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [task.id]);
            locked();
            await released;
          }),
        );
        started.push(blocker);
        await bounded(holding, "the holder's item lock");
        const completions = [first, second].map((participant) =>
          runInTenant(tenant, () =>
            createChokePoint(participant.pool).updateItem({
              databaseId: tasks,
              itemId: task.id,
              propertiesPatch: { status: "done" },
            }),
          ),
        );
        started.push(...completions);
        await waitUntilBlocked(
          [first.pids, second.pids],
          () => new Set([...holder.pids, ...first.pids, ...second.pids]),
        );
        release();
        await bounded(blocker, "the holder");
        await bounded(Promise.all(completions), "both completions");
        const occurrences = await occurrencesOf(tenant, task.seriesId);
        expect(occurrences.map((o) => [o.occurrence_date, o.status])).toEqual([
          ["2026-10-12", "done"],
          ["2026-10-19", "notDone"],
        ]);
        expect(await recurrenceRows(tenant)).toEqual([expect.objectContaining({ item_id: occurrences[1]!.id })]);
      } catch (error) {
        failure = { error };
      }
      release();
      await settle(failure, started, [holder.pool, first.pool, second.pool]);
    });
  });
});
