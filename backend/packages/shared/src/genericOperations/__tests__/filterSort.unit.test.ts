import { describe, expect, it } from "vitest";
import { filterNodeSchema, type FilterNode } from "../filterSort.js";

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
