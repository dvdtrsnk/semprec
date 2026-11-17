import { describe, expect, it } from "vitest";
import { compileFilterNode, type FilterProperties, type FilterProperty } from "../views/filterCompiler.js";
import { filterNodeSchema as sharedSchema, FILTER_CONDITION_TYPES as sharedTypes } from "@semprec/shared";
import { filterNodeSchema as dataSchema, FILTER_CONDITION_TYPES, parseFilterNode } from "../views/filterTree.js";
import { ForbiddenError, ValidationError } from "../errors.js";

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

  it("compiles `in status [monitoring]` against the option key, independent of the option's display label", () => {
    const props = properties([["status", { type: "select" }]]);
    const params: unknown[] = [];
    const sql = compileFilterNode(
      parseFilterNode({ type: "in", property: "status", value: ["monitoring"] }),
      props,
      params,
    );

    expect(sql).toBe("properties ->> $1 = ANY($2::text[])");
    expect(params).toEqual(["status", ["monitoring"]]);
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

describe("relation emptiness conditions", () => {
  const databaseId = "22222222-2222-4222-8222-222222222222";
  const relation = (side: "a" | "b"): FilterProperty => ({
    type: "relation",
    relationDefinitionId: "def-1",
    relationSide: side,
    targetDatabaseId: databaseId,
  });

  it.each([
    ["relation_is_empty", "a", true],
    ["relation_is_empty", "b", true],
    ["relation_is_not_empty", "a", false],
    ["relation_is_not_empty", "b", false],
  ] as const)("compiles %s on side %s with bound ids and a live target", (type, side, negated) => {
    const params: unknown[] = ["existing"];
    const sql = compileFilterNode(
      parseFilterNode({ type, property: "projects" }),
      properties([["projects", relation(side)]]),
      params,
    );
    expect(params).toEqual(["existing", "def-1", databaseId]);
    expect(sql.startsWith("(NOT EXISTS")).toBe(negated);
    expect(sql.startsWith("EXISTS")).toBe(!negated);
    expect(sql).toContain("r.relation_definition_id = $2");
    expect(sql).toContain("live.database_id = $3::uuid");
    expect(sql).toContain("live.deleted_at IS NULL");
    expect(sql).toContain("OFFSET 0");
    expect(sql).toContain(`r.${side === "a" ? "item_a" : "item_b"} = items.id`);
    expect(sql).toContain(`live.id = r.${side === "a" ? "item_b" : "item_a"}`);
    expect(sql).not.toContain("def-1");
    expect(sql).not.toContain(databaseId);
  });

  it.each(["relation_is_empty", "relation_is_not_empty"] as const)("rejects %s on a non-relation property", (type) => {
    const params: unknown[] = [];
    expect(() =>
      compileFilterNode(
        parseFilterNode({ type, property: "title" }),
        properties([["title", { type: "text" }]]),
        params,
      ),
    ).toThrow(expect.objectContaining({ status: 400, details: { field: "title" } }));
    expect(params).toEqual([]);
  });

  it("rejects an unresolved relation definition or target database without adding parameters", () => {
    for (const broken of [
      { ...relation("a"), relationDefinitionId: undefined },
      { ...relation("a"), relationSide: undefined },
      { ...relation("a"), targetDatabaseId: undefined },
    ]) {
      const params: unknown[] = [];
      expect(() =>
        compileFilterNode(
          parseFilterNode({ type: "relation_is_empty", property: "projects" }),
          properties([["projects", broken]]),
          params,
        ),
      ).toThrow(expect.objectContaining({ status: 400, details: { field: "projects" } }));
      expect(params).toEqual([]);
    }
  });

  it("still rejects is_empty on a relation and names the relation conditions", () => {
    expect(() =>
      compileFilterNode(
        parseFilterNode({ type: "is_empty", property: "projects" }),
        properties([["projects", relation("a")]]),
        [],
      ),
    ).toThrow(/relation_is_empty\/relation_is_not_empty/);
  });

  it("accepts and rejects the same inputs as the shared schema", () => {
    expect(FILTER_CONDITION_TYPES).toEqual(sharedTypes);
    const cases: unknown[] = [
      { type: "relation_is_empty", property: "projects" },
      { type: "not", node: { type: "relation_is_not_empty", property: "projects" } },
      { type: "relation_is_empty" },
      { type: "relation_is_empty", property: "" },
      { type: "relation_is_empty", property: 1 },
      { type: "relation_is_not_empty", property: "projects", value: "x" },
      { type: "relation_is_not_empty", property: "projects", value: "11111111-1111-4111-8111-111111111111" },
    ];
    for (const raw of cases) {
      expect(dataSchema.safeParse(raw).success).toBe(sharedSchema.safeParse(raw).success);
    }
    expect(cases.map((raw) => dataSchema.safeParse(raw).success)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("a closed sensitive database (issue #2000)", () => {
  const CLOSED = "33333333-3333-4333-8333-333333333333";
  const OPEN = "44444444-4444-4444-8444-444444444444";
  const value = "11111111-1111-4111-8111-111111111111";
  const FORBIDDEN = { status: 403, code: "forbidden" };
  const closed = new Set([CLOSED]);
  const relation = (targetDatabaseId: string | undefined): FilterProperty => ({
    type: "relation",
    relationDefinitionId: "definition-id",
    relationSide: "a",
    targetDatabaseId,
  });
  const rollup = (sourceDatabaseId: string | undefined): FilterProperty => ({
    type: "rollup",
    numericRollup: true,
    sourceDatabaseId,
  });
  const compile = (raw: unknown, props: FilterProperties, closedDatabaseIds?: ReadonlySet<string>) =>
    compileFilterNode(parseFilterNode(raw), props, [], undefined, closedDatabaseIds);

  it.each([
    { type: "relation_contains", property: "link", value },
    { type: "relation_not_contains", property: "link", value },
    { type: "relation_is_empty", property: "link" },
    { type: "relation_is_not_empty", property: "link" },
  ])("refuses $type on a relation into a closed database and compiles it into an open one", (condition) => {
    expect(() => compile(condition, properties([["link", relation(CLOSED)]]), closed)).toThrow(
      expect.objectContaining(FORBIDDEN),
    );
    expect(() => compile(condition, properties([["link", relation(OPEN)]]), closed)).not.toThrow();
  });

  it("compiles a relation into the database as before when no database is closed, and when the target is unresolved", () => {
    const condition = { type: "relation_contains", property: "link", value };
    const expected = compile(condition, properties([["link", relation(CLOSED)]]));
    expect(compile(condition, properties([["link", relation(CLOSED)]]), new Set())).toBe(expected);
    expect(() => compile(condition, properties([["link", relation(undefined)]]), closed)).not.toThrow();
  });

  it.each([
    { type: "equals", property: "total", value: 2 },
    { type: "gt", property: "total", value: 1 },
    { type: "is_empty", property: "total" },
  ])("refuses $type on a rollup that aggregates a closed database and compiles it over an open one", (condition) => {
    expect(() => compile(condition, properties([["total", rollup(CLOSED)]]), closed)).toThrow(
      expect.objectContaining(FORBIDDEN),
    );
    expect(() => compile(condition, properties([["total", rollup(OPEN)]]), closed)).not.toThrow();
    expect(() => compile(condition, properties([["total", rollup(CLOSED)]]))).not.toThrow();
    expect(() => compile(condition, properties([["total", rollup(undefined)]]), closed)).not.toThrow();
  });

  it("refuses a closed condition nested in and, or and not, naming the property and the database but no value", () => {
    const refused = { type: "relation_contains", property: "link", value };
    const props = properties([
      ["link", relation(CLOSED)],
      ["title", { type: "text" }],
    ]);
    for (const nested of [
      { type: "and", nodes: [{ type: "equals", property: "title", value: "x" }, refused] },
      { type: "or", nodes: [refused] },
      { type: "not", node: refused },
    ]) {
      expect(() => compile(nested, props, closed)).toThrow(expect.objectContaining(FORBIDDEN));
    }
    let thrown: unknown;
    try {
      compile(refused, props, closed);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect(thrown).toMatchObject({ message: expect.stringContaining(`'link'`) as unknown });
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(value);
  });

  it("refuses a path whose first hop or second hop reaches a closed database, and compiles one over open databases", () => {
    const path = { type: "relation_path_contains", path: ["project", "area"], value };
    const pathProperties = (firstTarget: string, secondTarget: string) =>
      properties([
        [
          "project",
          {
            ...relation(firstTarget),
            targetRelationProperties: properties([["area", relation(secondTarget)]]),
          },
        ],
      ]);
    expect(() => compile(path, pathProperties(CLOSED, OPEN), closed)).toThrow(expect.objectContaining(FORBIDDEN));
    expect(() => compile(path, pathProperties(OPEN, CLOSED), closed)).toThrow(expect.objectContaining(FORBIDDEN));
    expect(() => compile(path, pathProperties(OPEN, OPEN), closed)).not.toThrow();
    expect(() => compile(path, pathProperties(CLOSED, CLOSED))).not.toThrow();
  });
});
