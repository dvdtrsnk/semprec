import { describe, expect, it } from "vitest";
import { orderTablesForPurge } from "../tenancy/tenantPurgeOrder.js";

describe("orderTablesForPurge", () => {
  it("orders a child before the parent it references", () => {
    expect(orderTablesForPurge(["parent", "child"], [{ table: "child", referencedTable: "parent" }])).toEqual([
      "child",
      "parent",
    ]);
  });

  it("orders a chain from the leaf to the root and breaks ties alphabetically", () => {
    const order = orderTablesForPurge(
      ["root", "mid", "leaf", "alone"],
      [
        { table: "leaf", referencedTable: "mid" },
        { table: "mid", referencedTable: "root" },
      ],
    );
    expect(order).toEqual(["alone", "leaf", "mid", "root"]);
  });

  it("accepts a self-reference", () => {
    expect(orderTablesForPurge(["runs"], [{ table: "runs", referencedTable: "runs" }])).toEqual(["runs"]);
  });

  it("ignores a foreign key to a table outside the set", () => {
    expect(orderTablesForPurge(["child"], [{ table: "child", referencedTable: "users" }])).toEqual(["child"]);
  });

  it("treats several foreign keys between the same two tables as one dependency", () => {
    const order = orderTablesForPurge(
      ["parent", "child"],
      [
        { table: "child", referencedTable: "parent" },
        { table: "child", referencedTable: "parent" },
      ],
    );
    expect(order).toEqual(["child", "parent"]);
  });

  it("throws naming both tables of a two-table cycle", () => {
    expect(() =>
      orderTablesForPurge(
        ["a", "b", "c"],
        [
          { table: "a", referencedTable: "b" },
          { table: "b", referencedTable: "a" },
        ],
      ),
    ).toThrow(/a, b/);
  });
});
