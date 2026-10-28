import { describe, expect, it } from "vitest";
import { compileFilterNode, type FilterProperties, type FilterProperty } from "../views/filterCompiler.js";
import { filterNodeSchema as sharedSchema, FILTER_CONDITION_TYPES as sharedTypes } from "@semprec/shared";
import { filterNodeSchema as dataSchema, FILTER_CONDITION_TYPES, parseFilterNode } from "../views/filterTree.js";
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
        {
          type: "or",
          nodes: [
            { type: "equals", property: "year", value: 1984 },
            { type: "equals", property: "year", value: 1985 },
          ],
        },
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
    expect(() =>
      compileFilterNode(parseFilterNode({ type: "equals", property: "nope", value: "x" }), props, []),
    ).toThrow(ValidationError);
  });

  it("rejects relation_contains against a non-relation property, and equals against a relation property", () => {
    const props = properties([
      ["title", { type: "text" }],
      ["tasks", { type: "relation", relationDefinitionId: "rel-1", relationSide: "a" }],
    ]);

    expect(() =>
      compileFilterNode(
        parseFilterNode({
          type: "relation_contains",
          property: "title",
          value: "00000000-0000-0000-0000-000000000000",
        }),
        props,
        [],
      ),
    ).toThrow(ValidationError);

    expect(() =>
      compileFilterNode(parseFilterNode({ type: "equals", property: "tasks", value: "x" }), props, []),
    ).toThrow(ValidationError);
  });

  it("compiles relation_contains to an EXISTS check over item_relations, binding the definition id and target id, never the raw side", () => {
    const props = properties([["tasks", { type: "relation", relationDefinitionId: "rel-1", relationSide: "b" }]]);
    const params: unknown[] = [];
    const targetId = "11111111-1111-4111-8111-111111111111";

    const sql = compileFilterNode(
      parseFilterNode({ type: "relation_contains", property: "tasks", value: targetId }),
      props,
      params,
    );

    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM item_relations r WHERE r.relation_definition_id = $1 AND r.item_b = items.id AND r.item_a = $2::uuid)",
    );
    expect(params).toEqual(["rel-1", targetId]);
  });

  it("compiles relation_contains for the 'a' side, flipping which column holds items.id versus the target", () => {
    const props = properties([["tasks", { type: "relation", relationDefinitionId: "rel-1", relationSide: "a" }]]);
    const params: unknown[] = [];
    const targetId = "11111111-1111-4111-8111-111111111111";

    const sql = compileFilterNode(
      parseFilterNode({ type: "relation_contains", property: "tasks", value: targetId }),
      props,
      params,
    );

    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM item_relations r WHERE r.relation_definition_id = $1 AND r.item_a = items.id AND r.item_b = $2::uuid)",
    );
    expect(params).toEqual(["rel-1", targetId]);
  });

  it("is_empty/is_not_empty compile against the jsonb form for multi_select but the text form for everything else", () => {
    const props = properties([
      ["tags", { type: "multi_select" }],
      ["title", { type: "text" }],
    ]);

    const multiParams: unknown[] = [];
    const multiSql = compileFilterNode(parseFilterNode({ type: "is_empty", property: "tags" }), props, multiParams);
    expect(multiSql).toBe(
      "(properties -> $1 IS NULL OR properties -> $1 = 'null'::jsonb OR properties -> $1 = '[]'::jsonb)",
    );
    expect(multiParams).toEqual(["tags"]);

    const scalarParams: unknown[] = [];
    const scalarSql = compileFilterNode(parseFilterNode({ type: "is_empty", property: "title" }), props, scalarParams);
    expect(scalarSql).toBe("(properties ->> $1 IS NULL OR properties ->> $1 = '')");
    expect(scalarParams).toEqual(["title"]);
  });

  it("'in' compiles to an overlap check for multi_select but plain membership for a scalar", () => {
    const props = properties([
      ["tags", { type: "multi_select" }],
      ["title", { type: "text" }],
    ]);

    const multiParams: unknown[] = [];
    const multiSql = compileFilterNode(
      parseFilterNode({ type: "in", property: "tags", value: ["a", "b"] }),
      props,
      multiParams,
    );
    expect(multiSql).toBe("properties -> $1 ?| $2::text[]");
    expect(multiParams).toEqual(["tags", ["a", "b"]]);

    const scalarParams: unknown[] = [];
    const scalarSql = compileFilterNode(
      parseFilterNode({ type: "in", property: "title", value: ["a", "b"] }),
      props,
      scalarParams,
    );
    expect(scalarSql).toBe("properties ->> $1 = ANY($2::text[])");
    expect(scalarParams).toEqual(["title", ["a", "b"]]);
  });

  it("reads a rollup property from computed and every other property from properties", () => {
    const props = properties([
      ["total", { type: "rollup" }],
      ["title", { type: "text" }],
    ]);

    const rollupParams: unknown[] = [];
    const rollupSql = compileFilterNode(
      parseFilterNode({ type: "equals", property: "total", value: 5 }),
      props,
      rollupParams,
    );
    expect(rollupSql).toBe("computed ->> $1 = $2");
    expect(rollupParams).toEqual(["total", "5"]);

    const textSql = compileFilterNode(parseFilterNode({ type: "equals", property: "title", value: "x" }), props, []);
    expect(textSql).toBe("properties ->> $1 = $2");
  });
});

describe("relation_path_contains", () => {
  const value = "11111111-1111-4111-8111-111111111111";
  const node = parseFilterNode({ type: "relation_path_contains", path: ["project", "area"], value });
  const second: FilterProperty = { type: "relation", relationDefinitionId: "second-id", relationSide: "b" };
  const first: FilterProperty = {
    type: "relation",
    relationDefinitionId: "first-id",
    relationSide: "a",
    targetDatabaseId: "22222222-2222-4222-8222-222222222222",
    targetRelationProperties: properties([["area", second]]),
  };

  it.each(["a", "b"] as const)("binds every id and prunes the live intermediate for first side %s", (side) => {
    for (const secondSide of ["a", "b"] as const) {
      const params: unknown[] = ["existing"];
      const sql = compileFilterNode(
        node,
        properties([
          [
            "project",
            {
              ...first,
              relationSide: side,
              targetRelationProperties: properties([["area", { ...second, relationSide: secondSide }]]),
            },
          ],
        ]),
        params,
      );
      expect(params).toEqual(["existing", "first-id", first.targetDatabaseId, "second-id", value]);
      for (const id of params) expect(sql).not.toContain(String(id));
      expect(sql).not.toContain("project");
      expect(sql).not.toContain("area");
      expect(sql).toContain("CROSS JOIN LATERAL");
      expect(sql).toContain("intermediate.database_id = $3::uuid");
      expect(sql).toContain("intermediate.deleted_at IS NULL");
      expect(sql).toContain("OFFSET 0");
      expect(sql).toContain(`path_first.${side === "a" ? "item_a" : "item_b"} = items.id`);
      expect(sql).toContain(`intermediate.id = path_first.${side === "a" ? "item_b" : "item_a"}`);
      expect(sql).toContain(`path_second.${secondSide === "a" ? "item_a" : "item_b"} = path_intermediate.id`);
      expect(sql).toContain(`path_second.${secondSide === "a" ? "item_b" : "item_a"} = $5::uuid`);
      expect(sql).toContain("path_first.relation_definition_id = $2");
      expect(sql).toContain("path_second.relation_definition_id = $4");
    }
  });

  const invalidProperties: Array<[string, FilterProperties]> = [
    ["unknown first key", properties([])],
    ["scalar first key", properties([["project", { type: "text" }]])],
    ["missing first definition", properties([["project", { ...first, relationDefinitionId: undefined }]])],
    ["missing first side", properties([["project", { ...first, relationSide: undefined }]])],
    ["missing target database", properties([["project", { ...first, targetDatabaseId: undefined }]])],
    ["missing target metadata", properties([["project", { ...first, targetRelationProperties: undefined }]])],
    ["unknown second key", properties([["project", { ...first, targetRelationProperties: properties([]) }]])],
    ...(
      [
        ["scalar second key", { type: "text" }],
        ["missing second definition", { ...second, relationDefinitionId: undefined }],
        ["missing second side", { ...second, relationSide: undefined }],
      ] satisfies Array<[string, FilterProperty]>
    ).map(([name, property]): [string, FilterProperties] => [
      name,
      properties([["project", { ...first, targetRelationProperties: properties([["area", property]]) }]]),
    ]),
  ];
  it.each(invalidProperties)("rejects %s on field filter without adding parameters", (_name, props) => {
    const params: unknown[] = [];
    expect(() => compileFilterNode(node, props, params)).toThrow(ValidationError);
    expect(() => compileFilterNode(node, props, params)).toThrow(
      expect.objectContaining({ status: 400, details: { field: "filter" } }),
    );
    expect(params).toEqual([]);
  });

  it("keeps the condition lists and path-condition schema acceptance identical", () => {
    expect(FILTER_CONDITION_TYPES).toEqual(sharedTypes);
    const valid = { type: "relation_path_contains", path: ["project", "area"], value };
    const cases = [
      valid,
      { type: "not", node: valid },
      ...[
        { path: [] },
        { path: ["project"] },
        { path: ["project", "area", "more"] },
        { path: ["", "area"] },
        { path: ["project", ""] },
        { path: [1, "area"] },
        { path: "project.area" },
        { value: "invalid" },
        { value: null },
        { property: "project" },
      ].map((override) => ({ ...valid, ...override })),
    ];
    for (const [index, raw] of cases.entries()) {
      const data = dataSchema.safeParse(raw);
      const shared = sharedSchema.safeParse(raw);
      expect(data.success).toBe(index < 2);
      expect(data.success).toBe(shared.success);
      if (data.success && shared.success) expect(data.data).toEqual(shared.data);
      else
        expect(() => parseFilterNode(raw)).toThrow(
          expect.objectContaining({ status: 400, details: expect.objectContaining({ field: "filter" }) }),
        );
    }
  });
});
