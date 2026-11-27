import { describe, expect, it } from "vitest";
import { filterNodeSchema, sortSpecSchema, type FilterNode } from "../filterSort.js";
import { DatabaseQueryInputSchema } from "../schemas.js";

function buildNotChain(depth: number): FilterNode {
  let node: FilterNode = { type: "equals", property: "status", value: "done" };
  for (let i = 0; i < depth; i++) {
    node = { type: "not", node };
  }
  return node;
}

describe("filterNodeSchema depth bound", () => {
  it("accepts a tree at the maximum allowed nesting depth", () => {
    expect(filterNodeSchema.safeParse(buildNotChain(8)).success).toBe(true);
  });

  it("rejects a tree deeper than the maximum allowed nesting depth", () => {
    expect(filterNodeSchema.safeParse(buildNotChain(9)).success).toBe(false);
  });

  it("rejects a tree nested thousands of levels deep without overflowing the stack", () => {
    expect(() => filterNodeSchema.safeParse(buildNotChain(5000))).not.toThrow();
    expect(filterNodeSchema.safeParse(buildNotChain(5000)).success).toBe(false);
  });

  it("rejects an and/or node fan-out beyond the per-level cap", () => {
    const tooManyNodes: FilterNode = {
      type: "and",
      nodes: Array.from({ length: 21 }, () => ({ type: "equals", property: "status", value: "done" })),
    };
    expect(filterNodeSchema.safeParse(tooManyNodes).success).toBe(false);
  });
});

describe("relation_path_contains schema", () => {
  const value = "11111111-1111-4111-8111-111111111111";

  it("accepts exactly two relation keys and a UUID, including inside a group", () => {
    const node = { type: "relation_path_contains", path: ["project", "area"], value };
    expect(filterNodeSchema.parse(node)).toEqual(node);
    expect(filterNodeSchema.safeParse({ type: "not", node }).success).toBe(true);
  });

  it.each([
    { path: [] },
    { path: ["project"] },
    { path: ["project", "area", "projects"] },
    { path: ["", "area"] },
    { path: ["project", ""] },
    { path: [42, "area"] },
    { path: "project.area" },
    { value: "not-a-uuid" },
    { value: null },
    { property: "project" },
  ])("rejects malformed path condition %j", (override) => {
    expect(
      filterNodeSchema.safeParse({ type: "relation_path_contains", path: ["project", "area"], value, ...override })
        .success,
    ).toBe(false);
  });
});

describe("numeric comparison schema", () => {
  it.each(["lt", "lte", "gt", "gte"] as const)("accepts %s with a finite number", (type) => {
    expect(filterNodeSchema.safeParse({ type, property: "rating", value: 4 }).success).toBe(true);
    expect(filterNodeSchema.safeParse({ type, property: "rating", value: -0.5 }).success).toBe(true);
  });

  it.each([["4"], [null], [Number.POSITIVE_INFINITY], [Number.NaN], [true]])("rejects value %j", (value) => {
    expect(filterNodeSchema.safeParse({ type: "gte", property: "rating", value }).success).toBe(false);
  });
});

describe("relation emptiness schema", () => {
  it.each(["relation_is_empty", "relation_is_not_empty"])(
    "accepts %s with a property only, also in a group",
    (type) => {
      const node = { type, property: "projects" };
      expect(filterNodeSchema.parse(node)).toEqual(node);
      expect(filterNodeSchema.safeParse({ type: "and", nodes: [node] }).success).toBe(true);
    },
  );

  it.each([{ property: undefined }, { property: "" }, { property: 1 }, { value: "x" }, { path: ["a", "b"] }])(
    "rejects malformed emptiness condition %j",
    (override) => {
      expect(filterNodeSchema.safeParse({ type: "relation_is_empty", property: "projects", ...override }).success).toBe(
        false,
      );
    },
  );
});

describe("date_relative schema", () => {
  it.each([
    { type: "date_relative", property: "due", preset: "today" },
    { type: "date_relative", property: "due", endProperty: "until", preset: { fromDays: -2, toDays: 3 } },
  ])("accepts %j", (node) => {
    expect(filterNodeSchema.parse(node)).toEqual(node);
  });

  it.each([
    { type: "date_relative", property: "due", preset: "today", extra: true },
    { type: "date_relative", property: "due", preset: { fromDays: 0, extra: true } },
    { type: "date_relative", property: "due", preset: { fromDays: 2, toDays: 1 } },
    { type: "date_relative", property: "due", preset: "unknown" },
  ])("rejects %j", (node) => {
    expect(filterNodeSchema.safeParse(node).success).toBe(false);
  });
});

describe("sort spec schema (issue #1594)", () => {
  it.each([
    [{ property: "createdAt", direction: "asc" }],
    [{ system: "createdAt", direction: "desc" }],
    [{ system: "updatedAt", direction: "asc" }],
  ])("accepts %j", (spec) => {
    expect(sortSpecSchema.safeParse(spec).success).toBe(true);
  });

  it.each([
    [{ property: "title", system: "createdAt", direction: "asc" }],
    [{ system: "deletedAt", direction: "asc" }],
    [{ system: "createdAt" }],
    [{ system: "", direction: "asc" }],
    [{ direction: "asc" }],
  ])("rejects %j, also inside a database query input", (spec) => {
    expect(sortSpecSchema.safeParse(spec).success).toBe(false);
    expect(DatabaseQueryInputSchema.safeParse({ databaseId: "db", sort: [spec] }).success).toBe(false);
  });
});
