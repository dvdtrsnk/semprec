import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { projectTaskOccurrences, type ProjectedTaskOccurrence } from "../tasks/projectTaskOccurrences.js";
import type { TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createSeriesOccurrence, startTaskSeries } from "../testSupport/taskSeriesFixtures.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let other: string;
let cp: ChokePoint;

const daily: TaskRecurrenceRule = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };

async function tasksDatabaseId(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'tasks'");
    if (!rows[0]) throw new Error("Tasks database missing");
    return rows[0].id;
  });
}

function project(tenantId: string, from: string, to: string, today: string): Promise<ProjectedTaskOccurrence[]> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) => projectTaskOccurrences(client, { from, to, today })),
  );
}

/** One line per occurrence: date, then the stored status or `virtual:<status>`. */
function summary(occurrences: ProjectedTaskOccurrence[]): string[] {
  return occurrences.map((o) =>
    o.virtual
      ? `${o.occurrenceDate} virtual:${String(o.properties.status)}`
      : `${o.occurrenceDate} ${String(o.item.properties.status)}`,
  );
}

async function seriesStartingOn(
  tenantId: string,
  date: string,
  rule: TaskRecurrenceRule = daily,
  active = true,
): Promise<{ tasks: string; seriesId: string; firstId: string }> {
  const tasks = await tasksDatabaseId(tenantId);
  const first = await runInTenant(tenantId, () =>
    cp.createItem({ databaseId: tasks, properties: { name: "Stretch", date, flagged: true } }),
  );
  const seriesId = await runInTenant(tenantId, () =>
    startTaskSeries(pool, { databaseId: tasks, itemId: first.id, mode: "fixed", rule, active }),
  );
  return { tasks, seriesId, firstId: first.id };
}

const occurrence = (tenantId: string, tasks: string, seriesId: string, occurrenceDate: string, status: string) =>
  runInTenant(tenantId, () => createSeriesOccurrence(pool, { databaseId: tasks, seriesId, occurrenceDate, status }));

describe("projectTaskOccurrences (issue #1672)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(pool));
    cp = createChokePoint(pool);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("12 to 18 October of a daily series gives done, done, done, missed, open, virtual, virtual", async () => {
    const { tasks, seriesId, firstId } = await seriesStartingOn(tenant, "2026-10-12");
    const done = [];
    for (const date of ["2026-10-13", "2026-10-14"]) done.push(await occurrence(tenant, tasks, seriesId, date, "done"));
    const missed = await occurrence(tenant, tasks, seriesId, "2026-10-15", "missed");
    const open = await occurrence(tenant, tasks, seriesId, "2026-10-16", "notDone");
    // Completing the 12 October occurrence on 16 October finds today's occurrence already stored.
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: tasks, itemId: firstId, propertiesPatch: { status: "done" } }),
    );

    const projected = await project(tenant, "2026-10-12", "2026-10-18", "2026-10-16");
    expect(summary(projected)).toEqual([
      "2026-10-12 done",
      "2026-10-13 done",
      "2026-10-14 done",
      "2026-10-15 missed",
      "2026-10-16 notDone",
      "2026-10-17 virtual:notDone",
      "2026-10-18 virtual:notDone",
    ]);
    expect(projected.map((o) => (o.virtual ? o.id : o.item.id))).toEqual([
      firstId,
      ...done,
      missed,
      open,
      `${seriesId}@2026-10-17`,
      `${seriesId}@2026-10-18`,
    ]);
    const stored = projected.find((o) => o.occurrenceDate === "2026-10-16");
    expect(stored).toMatchObject({ virtual: false, seriesId, item: { id: open } });
    expect(projected.find((o) => o.occurrenceDate === "2026-10-17")).toEqual({
      virtual: true,
      id: `${seriesId}@2026-10-17`,
      seriesId,
      occurrenceDate: "2026-10-17",
      properties: {
        name: "Stretch",
        timeFrom: null,
        timeTo: null,
        notifications: false,
        flagged: true,
        description: null,
        date: "2026-10-17",
        status: "notDone",
      },
    });
  });

  it("a stored missed occurrence is returned as the item", async () => {
    const { tasks, seriesId } = await seriesStartingOn(tenant, "2026-10-14");
    await occurrence(tenant, tasks, seriesId, "2026-10-15", "missed");
    expect(summary(await project(tenant, "2026-10-14", "2026-10-15", "2026-10-16"))).toEqual([
      "2026-10-14 notDone",
      "2026-10-15 missed",
    ]);
  });

  it("a daily series whose last occurrence is 13 October projects 14 and 15 October as missed on 16 October", async () => {
    await seriesStartingOn(tenant, "2026-10-13");
    expect(summary(await project(tenant, "2026-10-12", "2026-10-18", "2026-10-16"))).toEqual([
      "2026-10-13 notDone",
      "2026-10-14 virtual:missed",
      "2026-10-15 virtual:missed",
      "2026-10-16 virtual:notDone",
      "2026-10-17 virtual:notDone",
      "2026-10-18 virtual:notDone",
    ]);
  });

  it("returns the materialized 17 October occurrence instead of a virtual one", async () => {
    const { tasks, seriesId } = await seriesStartingOn(tenant, "2026-10-16");
    const before = await project(tenant, "2026-10-17", "2026-10-17", "2026-10-16");
    expect(before).toEqual([expect.objectContaining({ virtual: true, id: `${seriesId}@2026-10-17` })]);
    const materialized = await occurrence(tenant, tasks, seriesId, "2026-10-17", "done");
    expect(await project(tenant, "2026-10-17", "2026-10-17", "2026-10-16")).toEqual([
      expect.objectContaining({
        virtual: false,
        seriesId,
        occurrenceDate: "2026-10-17",
        item: expect.objectContaining({ id: materialized }),
      }),
    ]);
  });

  it("projects a trashed occurrence's date as virtual again", async () => {
    const { tasks, seriesId } = await seriesStartingOn(tenant, "2026-10-16");
    const trashed = await occurrence(tenant, tasks, seriesId, "2026-10-17", "done");
    await runInTenant(tenant, () => cp.softDeleteItem(tasks, trashed));
    expect(summary(await project(tenant, "2026-10-17", "2026-10-17", "2026-10-16"))).toEqual([
      "2026-10-17 virtual:notDone",
    ]);
  });

  it("produces no date before the anchor and keeps a stored occurrence whose date is not a rule date", async () => {
    const mondays: TaskRecurrenceRule = { kind: "weekdays", days: ["mon"] };
    const { tasks, seriesId } = await seriesStartingOn(tenant, "2026-10-12", mondays);
    await occurrence(tenant, tasks, seriesId, "2026-10-14", "done");
    expect(summary(await project(tenant, "2026-10-01", "2026-10-20", "2026-10-16"))).toEqual([
      "2026-10-12 notDone",
      "2026-10-14 done",
      "2026-10-19 virtual:notDone",
    ]);
  });

  it("projects a floating series from its anchor in whole intervals, with a stored off-rule occurrence kept", async () => {
    const tasks = await tasksDatabaseId(tenant);
    const first = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasks, properties: { name: "Water plants", date: "2026-10-12" } }),
    );
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(pool, { databaseId: tasks, itemId: first.id, mode: "floating", rule: { unit: "days", n: 3 } }),
    );
    const offRule = await occurrence(tenant, tasks, seriesId, "2026-10-14", "done");
    const projected = await project(tenant, "2026-10-10", "2026-10-20", "2026-10-16");
    expect(summary(projected)).toEqual([
      "2026-10-12 notDone",
      "2026-10-14 done",
      "2026-10-15 virtual:missed",
      "2026-10-18 virtual:notDone",
    ]);
    expect(projected.map((o) => (o.virtual ? o.id : o.item.id))).toEqual([
      first.id,
      offRule,
      `${seriesId}@2026-10-15`,
      `${seriesId}@2026-10-18`,
    ]);
  });

  it("generates no virtual date before the anchor but returns a stored occurrence dated before it", async () => {
    const { tasks, seriesId, firstId } = await seriesStartingOn(tenant, "2026-10-12");
    // A materialized fixture dated before the anchor; no delivered writer produces one (#1720 is not built).
    const early = await occurrence(tenant, tasks, seriesId, "2026-10-10", "done");
    const projected = await project(tenant, "2026-10-09", "2026-10-13", "2026-10-16");
    expect(summary(projected)).toEqual(["2026-10-10 done", "2026-10-12 notDone", "2026-10-13 virtual:missed"]);
    expect(projected.map((o) => (o.virtual ? o.id : o.item.id))).toEqual([early, firstId, `${seriesId}@2026-10-13`]);
  });

  it("a turned-off series produces nothing after its last materialized occurrence", async () => {
    const { tasks, seriesId } = await seriesStartingOn(tenant, "2026-10-12", daily, false);
    await occurrence(tenant, tasks, seriesId, "2026-10-14", "done");
    expect(summary(await project(tenant, "2026-10-10", "2026-10-18", "2026-10-16"))).toEqual([
      "2026-10-12 notDone",
      "2026-10-13 virtual:missed",
      "2026-10-14 done",
    ]);
  });

  it("a turned-off series whose last occurrence is trashed produces nothing", async () => {
    const { tasks, firstId } = await seriesStartingOn(tenant, "2026-10-12", daily, false);
    await runInTenant(tenant, () => cp.softDeleteItem(tasks, firstId));
    expect(await project(tenant, "2026-10-10", "2026-10-18", "2026-10-16")).toEqual([]);
  });

  it("reads with one query per kind whatever the range, and with one when there is no series", async () => {
    const counted = await createRuntimeRolePool(admin, "semprec_data");
    try {
      const countQueries = (from: string, to: string) =>
        runInTenant(tenant, () =>
          withTransaction(counted, async (client) => {
            const spy = vi.spyOn(client, "query");
            try {
              await projectTaskOccurrences(client, { from, to, today: "2026-10-16" });
              return spy.mock.calls.length;
            } finally {
              spy.mockRestore();
            }
          }),
        );
      expect(await countQueries("2026-10-01", "2026-10-31")).toBe(1);
      await seriesStartingOn(tenant, "2026-10-12");
      await seriesStartingOn(tenant, "2026-10-13", { kind: "weekdays", days: ["mon"] });
      expect(await countQueries("2026-10-12", "2026-10-13")).toBe(2);
      expect(await countQueries("2026-01-01", "2027-02-04")).toBe(2);
    } finally {
      await counted.end();
    }
  });

  it("accepts 400 days and rejects 401 days, an inverted range and a value that is not a calendar date", async () => {
    await seriesStartingOn(tenant, "2026-10-12");
    await expect(project(tenant, "2026-01-01", "2027-02-04", "2026-10-16")).resolves.toEqual(expect.any(Array));
    for (const [from, to, today, field] of [
      ["2026-01-01", "2027-02-05", "2026-10-16", "to"],
      ["2026-10-18", "2026-10-12", "2026-10-16", "to"],
      ["2026-02-30", "2026-03-02", "2026-10-16", "from"],
      ["2026-10-12", "18.10.2026", "2026-10-16", "to"],
      ["2026-10-12", "2026-10-18", "", "today"],
    ] as const) {
      const rejected = project(tenant, from, to, today);
      await expect(rejected).rejects.toBeInstanceOf(ValidationError);
      await expect(rejected).rejects.toMatchObject({ details: { field } });
    }
  });

  it("projects only the caller's tenant", async () => {
    await seriesStartingOn(other, "2026-10-12");
    expect(await project(tenant, "2026-10-12", "2026-10-18", "2026-10-16")).toEqual([]);
    expect(await project(other, "2026-10-12", "2026-10-12", "2026-10-16")).toHaveLength(1);
  });
});
