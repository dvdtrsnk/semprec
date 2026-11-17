import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { firstOccurrenceAfter, latestOccurrenceOnOrBefore } from "../nextDueDate.js";
import type { TaskRecurrenceMode, TaskRecurrenceRule } from "../taskRecurrenceRule.js";

let admin: Pool;
let runtime: Pool;
beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

describe("recurring rollover SQL preselection", () => {
  const cases: {
    mode: TaskRecurrenceMode;
    rule: TaskRecurrenceRule;
    occurrence: string;
    anchor: string;
    today: string;
  }[] = [
    {
      mode: "fixed",
      rule: { kind: "weekdays", days: ["mon"] },
      occurrence: "2026-10-12",
      anchor: "2026-10-12",
      today: "2026-10-18",
    },
    {
      mode: "fixed",
      rule: { kind: "weekdays", days: ["mon"] },
      occurrence: "2026-10-12",
      anchor: "2026-10-12",
      today: "2026-10-19",
    },
    {
      mode: "fixed",
      rule: { kind: "monthDates", dates: [31] },
      occurrence: "2024-01-31",
      anchor: "2024-01-31",
      today: "2024-03-31",
    },
    {
      mode: "fixed",
      rule: { kind: "nthWeekday", n: -1, weekday: "fri" },
      occurrence: "2024-01-26",
      anchor: "2024-01-26",
      today: "2024-02-23",
    },
    {
      mode: "fixed",
      rule: { kind: "nthWeekday", n: 5, weekday: "mon" },
      occurrence: "2024-01-29",
      anchor: "2024-01-29",
      today: "2024-04-29",
    },
    {
      mode: "fixed",
      rule: { kind: "yearDates", month: 2, day: 29 },
      occurrence: "2096-02-29",
      anchor: "2096-02-29",
      today: "2104-02-29",
    },
    {
      mode: "fixed",
      rule: { kind: "yearDates", month: 1, day: 1 },
      occurrence: "9999-01-01",
      anchor: "9999-01-01",
      today: "9999-12-31",
    },
    {
      mode: "floating",
      rule: { unit: "months", n: 1 },
      occurrence: "2024-02-29",
      anchor: "2024-01-31",
      today: "2024-03-31",
    },
    {
      mode: "floating",
      rule: { unit: "weeks", n: 2 },
      occurrence: "2026-01-01",
      anchor: "2026-01-20",
      today: "2026-02-03",
    },
    {
      mode: "floating",
      rule: { unit: "days", n: 7 },
      occurrence: "2026-01-15",
      anchor: "2026-01-01",
      today: "2026-01-21",
    },
  ];
  it.each(cases)(
    "matches the canonical TS owner for $mode $occurrence → $today",
    async ({ mode, rule, occurrence, anchor, today }) => {
      const expected =
        firstOccurrenceAfter(rule, occurrence, occurrence, anchor) <= today &&
        latestOccurrenceOnOrBefore(rule, anchor, today) !== null;
      const actual = await runInTenant(getTenantZeroId(), () =>
        runtime.query<{ due: boolean }>(
          "SELECT task_recurrence_due_for_rollover($1, $2::jsonb, $3::date, $4::date, $5::date) AS due",
          [mode, JSON.stringify(rule), occurrence, anchor, today],
        ),
      );
      expect(actual.rows).toEqual([{ due: expected }]);
    },
  );
  it("rejects an impossible historical ordinal rather than skipping it", async () => {
    const rule: TaskRecurrenceRule = { kind: "nthWeekday", n: 6, weekday: "mon" };
    expect(() => firstOccurrenceAfter(rule, "2026-01-01", "2026-01-01", "2026-01-01")).toThrow();
    await expect(
      runInTenant(getTenantZeroId(), () =>
        runtime.query("SELECT task_recurrence_due_for_rollover($1, $2::jsonb, $3::date, $4::date, $5::date)", [
          "fixed",
          JSON.stringify(rule),
          "2026-01-01",
          "2026-01-01",
          "2026-01-20",
        ]),
      ),
    ).rejects.toThrow();
  });
});
