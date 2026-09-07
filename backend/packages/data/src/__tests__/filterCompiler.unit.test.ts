import { describe, expect, it } from "vitest";
import { compileFilterNode, type FilterProperties, type FilterProperty } from "../views/filterCompiler.js";
import { parseFilterNode } from "../views/filterTree.js";
import { ValidationError } from "../errors.js";

function properties(entries: Array<[string, FilterProperty]>): FilterProperties {
  return new Map(entries);
}

describe("compileFilterNode", () => {
  it("compiles a scalar condition to a parameterized predicate, never inlining the value", () => {
    const props = properties([["title", { type: "text" }]]);
    const params: unknown[] = [];
    const sql = compileFilterNode(parseFilterNode({ type: "equals", property: "title", value: "Dune" }), props, params);

    expect(sql).toBe("properties ->> $1 = $2");
    expect(params).toEqual(["title", "Dune"]);
  });

  it("compiles and/or/not into nested parenthesized groups sharing one params array", () => {
    const props = properties([
      ["title", { type: "text" }],
      ["year", { type: "number" }],
    ]);
    const params: unknown[] = [];
    const node = parseFilterNode({
      type: "and",
      nodes: [
        { type: "not", node: { type: "is_empty", property: "title" } },
        { type: "or", nodes: [{ type: "equals", property: "year", value: 1984 }, { type: "equals", property: "year", value: 1985 }] },
      ],
    });

    const sql = compileFilterNode(node, props, params);

    expect(sql).toBe(
      "((NOT (properties ->> $1 IS NULL OR properties ->> $1 = '')) AND (properties ->> $2 = $3 OR properties ->> $4 = $5))",
    );
    expect(params).toEqual(["title", "year", "1984", "year", "1985"]);
  });

  it("escapes LIKE metacharacters in contains/starts_with/ends_with so a value can never inject its own wildcard", () => {
    const props = properties([["title", { type: "text" }]]);
    const params: unknown[] = [];
    compileFilterNode(parseFilterNode({ type: "contains", property: "title", value: "50%_off\\" }), props, params);

    expect(params).toEqual(["title", "%50\\%\\_off\\\\%"]);
  });

  it("rejects a filter that references an unknown property", () => {
    const props = properties([["title", { type: "text" }]]);
    expect(() => compileFilterNode(parseFilterNode({ type: "equals", property: "nope", value: "x" }), props, [])).toThrow(
      ValidationError,
    );
  });

  it("rejects relation_contains against a non-relation property, and equals against a relation property", () => {
    const props = properties([
      ["title", { type: "text" }],
      ["tasks", { type: "relation", relationDefinitionId: "rel-1", relationSide: "a" }],
    ]);

    expect(() =>
      compileFilterNode(
        parseFilterNode({ type: "relation_contains", property: "title", value: "00000000-0000-0000-0000-000000000000" }),
        props,
        [],
      ),
    ).toThrow(ValidationError);

    expect(() => compileFilterNode(parseFilterNode({ type: "equals", property: "tasks", value: "x" }), props, [])).toThrow(
      ValidationError,
    );
  });

  it("compiles relation_contains to an EXISTS check over item_relations, binding the definition id and target id, never the raw side", () => {
    const props = properties([["tasks", { type: "relation", relationDefinitionId: "rel-1", relationSide: "b" }]]);
    const params: unknown[] = [];
    const targetId = "11111111-1111-4111-8111-111111111111";

    const sql = compileFilterNode(parseFilterNode({ type: "relation_contains", property: "tasks", value: targetId }), props, params);

    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM item_relations r WHERE r.relation_definition_id = $1 AND r.item_b = items.id AND r.item_a = $2::uuid)",
    );
    expect(params).toEqual(["rel-1", targetId]);
  });

  it("is_empty/is_not_empty compile against the jsonb form for multi_select but the text form for everything else", () => {
    const props = properties([
      ["tags", { type: "multi_select" }],
      ["title", { type: "text" }],
    ]);

    const multiSql = compileFilterNode(parseFilterNode({ type: "is_empty", property: "tags" }), props, []);
    expect(multiSql).toBe("(properties -> $1 IS NULL OR properties -> $1 = 'null'::jsonb OR properties -> $1 = '[]'::jsonb)");

    const scalarSql = compileFilterNode(parseFilterNode({ type: "is_empty", property: "title" }), props, []);
    expect(scalarSql).toBe("(properties ->> $1 IS NULL OR properties ->> $1 = '')");
  });

  it("'in' compiles to an overlap check for multi_select but plain membership for a scalar", () => {
    const props = properties([
      ["tags", { type: "multi_select" }],
      ["title", { type: "text" }],
    ]);

    const multiSql = compileFilterNode(parseFilterNode({ type: "in", property: "tags", value: ["a", "b"] }), props, []);
    expect(multiSql).toBe("properties -> $1 ?| $2::text[]");

    const scalarSql = compileFilterNode(parseFilterNode({ type: "in", property: "title", value: ["a", "b"] }), props, []);
    expect(scalarSql).toBe("properties ->> $1 = ANY($2::text[])");
  });
});
