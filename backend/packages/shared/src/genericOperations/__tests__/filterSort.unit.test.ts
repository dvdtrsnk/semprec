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
