import { describe, expect, it } from "vitest";
import { filterNodeSchema as sharedSchema } from "@semprec/shared";
import { ValidationError } from "../errors.js";
import { compileFilterNode, type FilterProperties } from "../views/filterCompiler.js";
import { parseFilterNode } from "../views/filterTree.js";
import { resolveDayRange, type FilterCompileContext } from "../views/relativeDates.js";

// Thursday 22 Oct 2026, noon in Prague.
const thursday: FilterCompileContext = { zone: "Europe/Prague", now: new Date("2026-10-22T10:00:00Z") };
const props: FilterProperties = new Map([
  ["due", { type: "date" }],
  ["until", { type: "date" }],
  ["title", { type: "text" }],
]);

describe("resolveDayRange", () => {
  it.each([
    ["today", { from: "2026-10-22", to: "2026-10-22" }],
    ["tomorrow", { from: "2026-10-23", to: "2026-10-23" }],
    ["thisWeek", { from: "2026-10-22", to: "2026-10-25" }],
    ["nextWeek", { from: "2026-10-26", to: "2026-11-01" }],
    ["thisMonth", { from: "2026-10-22", to: "2026-10-31" }],
    ["upcoming", { from: "2026-10-22" }],
    ["past", { to: "2026-10-21" }],
    ["onOrBeforeToday", { to: "2026-10-22" }],
    ["last7", { from: "2026-10-15", to: "2026-10-22" }],
    ["last30", { from: "2026-09-22", to: "2026-10-22" }],
    ["thisYear", { from: "2026-01-01", to: "2026-12-31" }],
    ["olderThan30", { to: "2026-09-21" }],
    ["beforeNow", { to: "2026-10-21" }],
  ] as const)("resolves %s on Thursday 22 Oct 2026", (preset, expected) => {
    expect(resolveDayRange(preset, thursday)).toEqual({ from: undefined, to: undefined, ...expected });
  });

  it("resolves a day range and an open-ended one", () => {
    expect(resolveDayRange({ fromDays: 2, toDays: 9 }, thursday)).toEqual({ from: "2026-10-24", to: "2026-10-31" });
    expect(resolveDayRange({ fromDays: -3 }, thursday)).toEqual({ from: "2026-10-19", to: undefined });
  });

  it("uses the tenant zone, not UTC, for the day boundary", () => {
    // 22:30 UTC on the 21st is 00:30 on the 22nd in Prague.
    const justAfterMidnight = { zone: "Europe/Prague", now: new Date("2026-10-21T22:30:00Z") };
    expect(resolveDayRange("today", justAfterMidnight)).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(resolveDayRange("today", { ...justAfterMidnight, zone: "UTC" })).toEqual({
      from: "2026-10-21",
      to: "2026-10-21",
    });
  });

  it("moves a stored upcoming bound when the day changes", () => {
    const nextDay = { ...thursday, now: new Date("2026-10-23T10:00:00Z") };
    expect(resolveDayRange("upcoming", nextDay)).toEqual({ from: "2026-10-23" });
  });
});

describe("date_relative compilation", () => {
  it("binds the zone and day bounds as parameters and calls no clock in SQL", () => {
    const params: unknown[] = [];
    const sql = compileFilterNode(
      parseFilterNode({ type: "date_relative", property: "due", preset: "thisWeek" }),
      props,
      params,
      thursday,
    );
    expect(params).toEqual(["Europe/Prague", "due", "2026-10-22", "2026-10-25"]);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
    expect(sql).toContain("AT TIME ZONE $1::text");
    expect(sql).toContain(">= $3::date");
    expect(sql).toContain("<= $4::date");
  });

  it("with endProperty compiles an interval intersection over both properties", () => {
    const params: unknown[] = [];
    const sql = compileFilterNode(
      parseFilterNode({ type: "date_relative", property: "due", endProperty: "until", preset: "today" }),
      props,
      params,
      thursday,
    );
    expect(params).toEqual(["Europe/Prague", "due", "until", "2026-10-22", "2026-10-22"]);
    expect(sql).toContain("COALESCE(");
  });

  it("compares beforeNow timestamps as instants against the bound clock", () => {
    const params: unknown[] = [];
    compileFilterNode(parseFilterNode({ type: "date_relative", property: "due", preset: "beforeNow" }), props, params, {
      ...thursday,
    });
    expect(params).toEqual(["Europe/Prague", "due", "2026-10-22T10:00:00.000Z", "2026-10-21"]);
  });

  it("rejects a non-date property with the property as field", () => {
    const node = parseFilterNode({ type: "date_relative", property: "title", preset: "today" });
    expect(() => compileFilterNode(node, props, [], thursday)).toThrow(ValidationError);
    expect(() => compileFilterNode(node, props, [], thursday)).toThrow(
      expect.objectContaining({ details: { field: "title" } }),
    );
    const end = parseFilterNode({ type: "date_relative", property: "due", endProperty: "title", preset: "today" });
    expect(() => compileFilterNode(end, props, [], thursday)).toThrow(
      expect.objectContaining({ details: { field: "title" } }),
    );
  });

  it("rejects an unknown property and a missing context", () => {
    const unknown = parseFilterNode({ type: "date_relative", property: "nope", preset: "today" });
    expect(() => compileFilterNode(unknown, props, [], thursday)).toThrow(
      expect.objectContaining({ details: { field: "nope" } }),
    );
    const node = parseFilterNode({ type: "date_relative", property: "due", preset: "today" });
    expect(() => compileFilterNode(node, props, [])).toThrow(ValidationError);
  });
});

describe("date_relative schema", () => {
  const schemas = [
    ["data", (raw: unknown) => parseFilterNodeSafe(raw)],
    ["shared", (raw: unknown) => sharedSchema.safeParse(raw).success],
  ] as const;

  function parseFilterNodeSafe(raw: unknown): boolean {
    try {
      parseFilterNode(raw);
      return true;
    } catch (err) {
      if (err instanceof ValidationError) return false;
      throw err;
    }
  }

  it.each(schemas)("%s accepts presets and ranges", (_name, accepts) => {
    expect(accepts({ type: "date_relative", property: "due", preset: "last7" })).toBe(true);
    expect(accepts({ type: "date_relative", property: "due", endProperty: "until", preset: "today" })).toBe(true);
    expect(accepts({ type: "date_relative", property: "due", preset: { fromDays: -2 } })).toBe(true);
    expect(accepts({ type: "date_relative", property: "due", preset: { fromDays: 2, toDays: 2 } })).toBe(true);
    expect(accepts({ type: "date_relative", property: "due", preset: { fromDays: -36500, toDays: 36500 } })).toBe(true);
  });

  it.each(schemas)("%s rejects invalid presets", (_name, accepts) => {
    for (const preset of [
      "yesterday",
      { fromDays: 3, toDays: 2 },
      { fromDays: 1.5 },
      { fromDays: 36501 },
      { fromDays: 0, toDays: 36501 },
      { fromDays: -36501 },
      { toDays: 3 },
      null,
    ]) {
      expect(accepts({ type: "date_relative", property: "due", preset })).toBe(false);
    }
    expect(accepts({ type: "date_relative", property: "due", preset: "today", extra: true })).toBe(false);
    expect(accepts({ type: "date_relative", property: "due", preset: { fromDays: 0, extra: true } })).toBe(false);
    expect(accepts({ type: "date_relative", property: "due" })).toBe(false);
    expect(accepts({ type: "date_relative", property: "", preset: "today" })).toBe(false);
  });
});
