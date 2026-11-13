import { validationIssueField } from "../validationIssueField.js";
import { describe, expect, it } from "vitest";
import {
  DatabaseArchiveInputSchema,
  DatabaseCreateInputSchema,
  DatabaseFacetsInputSchema,
  DatabaseGetInputSchema,
  DatabaseListInputSchema,
  DatabasePatchInputSchema,
  DatabaseQueryInputSchema,
  DatabaseRestoreInputSchema,
  ItemCountInputSchema,
  ItemCreateInputSchema,
  ItemDeleteInputSchema,
  ItemGetInputSchema,
  ItemPatchInputSchema,
  ItemRestoreInputSchema,
  PropertyCreateInputSchema,
  PropertyDeleteInputSchema,
  PropertyGetByKeyInputSchema,
  PropertyGetInputSchema,
  PropertyListInputSchema,
  PropertyPatchInputSchema,
  RelationDeleteInputSchema,
  RelationListInputSchema,
  RelationPutInputSchema,
  RelationSetInputSchema,
  SearchInputSchema,
  SearchOutputSchema,
  SEARCH_GROUP_TYPES,
  PageRestoreVersionInputSchema,
  PageCreateSubpageInputSchema,
  PageInsertInputSchema,
  PageChangesInputSchema,
  ViewCreateInputSchema,
  ViewDeleteInputSchema,
  ViewGetInputSchema,
  ViewItemAddInputSchema,
  ViewItemRemoveInputSchema,
  ViewItemReorderInputSchema,
  ViewListInputSchema,
  ViewPatchInputSchema,
  ViewQueryInputSchema,
} from "../schemas.js";

const ALL_SCHEMAS = [
  DatabaseListInputSchema,
  DatabaseGetInputSchema,
  DatabaseCreateInputSchema,
  DatabasePatchInputSchema,
  DatabaseArchiveInputSchema,
  DatabaseRestoreInputSchema,
  PropertyListInputSchema,
  PropertyGetInputSchema,
  PropertyGetByKeyInputSchema,
  PropertyCreateInputSchema,
  PropertyPatchInputSchema,
  PropertyDeleteInputSchema,
  ViewListInputSchema,
  ViewGetInputSchema,
  ViewCreateInputSchema,
  ViewPatchInputSchema,
  ViewDeleteInputSchema,
  ViewQueryInputSchema,
  ViewItemAddInputSchema,
  ViewItemRemoveInputSchema,
  ViewItemReorderInputSchema,
  ItemGetInputSchema,
  ItemCreateInputSchema,
  ItemPatchInputSchema,
  ItemDeleteInputSchema,
  ItemRestoreInputSchema,
  DatabaseQueryInputSchema,
  RelationPutInputSchema,
  RelationSetInputSchema,
  RelationDeleteInputSchema,
  RelationListInputSchema,
  PageRestoreVersionInputSchema,
  PageCreateSubpageInputSchema,
  PageInsertInputSchema,
  ItemCountInputSchema,
  DatabaseFacetsInputSchema,
  SearchInputSchema,
];

describe("every generic-operation input schema", () => {
  it.each(["actor", "userId", "agentProjectItemId", "runId"])(
    "is a strict object that rejects a spoofed top-level '%s' field",
    (identityField) => {
      for (const schema of ALL_SCHEMAS) {
        expect(schema.safeParse({ [identityField]: "spoofed" }).success).toBe(false);
      }
    },
  );
});

describe("DatabaseCreateInputSchema", () => {
  it("accepts titlePropertyName and a properties list of the allowed types", () => {
    const result = DatabaseCreateInputSchema.safeParse({
      name: "Gifts",
      titlePropertyName: "Název",
      properties: [
        { key: "recipient", name: "Recipient", type: "text" },
        {
          key: "link",
          name: "Link",
          type: "relation",
          targetDatabaseId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          cardinality: "one_to_many",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate keys naming the key, the title key, more than 50 entries and disallowed types", () => {
    const dup = DatabaseCreateInputSchema.safeParse({
      name: "G",
      properties: [
        { key: "a", name: "A", type: "text" },
        { key: "a", name: "B", type: "text" },
      ],
    });
    expect(dup.success).toBe(false);
    expect(JSON.stringify(dup.error?.issues)).toContain("'a'");
    expect(
      DatabaseCreateInputSchema.safeParse({ name: "G", properties: [{ key: "name", name: "N", type: "text" }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, name: "K", type: "text" }));
    expect(DatabaseCreateInputSchema.safeParse({ name: "G", properties: many }).success).toBe(false);
    for (const type of ["rollup", "title", "multi_select"]) {
      expect(
        DatabaseCreateInputSchema.safeParse({ name: "G", properties: [{ key: "k", name: "K", type }] }).success,
      ).toBe(false);
    }
    expect(
      DatabaseCreateInputSchema.safeParse({ name: "G", properties: [{ key: "k", name: "K", type: "relation" }] })
        .success,
    ).toBe(false);
  });

  it("accepts a bare name", () => {
    expect(DatabaseCreateInputSchema.safeParse({ name: "Tasks" }).success).toBe(true);
  });

  it.each(["system", "schemaLocked", "ownerProjectItemId", "ownerModuleId", "archivedAt", "key"])(
    "rejects the server-derived field '%s'",
    (field) => {
      expect(DatabaseCreateInputSchema.safeParse({ name: "Tasks", [field]: "x" }).success).toBe(false);
    },
  );
});

describe("database icon and color inputs", () => {
  it("rejects an empty database patch", () => {
    const result = DatabasePatchInputSchema.safeParse({ databaseId: "d", patch: {} });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["patch"]);
  });
  it("normalizes a create color to upper case and keeps a valid icon", () => {
    const parsed = DatabaseCreateInputSchema.parse({ name: "Gifts", icon: "gift", color: "#34c759" });
    expect(parsed).toEqual({ name: "Gifts", icon: "gift", color: "#34C759" });
  });

  it.each([{ color: "red" }, { color: "#12345" }, { color: "#GGGGGG" }, { icon: "my icon" }, { icon: "Gift" }])(
    "rejects the create input %j",
    (extra) => {
      expect(DatabaseCreateInputSchema.safeParse({ name: "Gifts", ...extra }).success).toBe(false);
    },
  );

  it("accepts null to reset icon and color in a patch, and normalizes the color", () => {
    expect(DatabasePatchInputSchema.parse({ databaseId: "d", patch: { icon: null, color: null } }).patch).toEqual({
      icon: null,
      color: null,
    });
    expect(DatabasePatchInputSchema.parse({ databaseId: "d", patch: { color: "#007aff" } }).patch).toEqual({
      color: "#007AFF",
    });
  });

  it.each([{ color: "red" }, { color: "#12345" }, { icon: "my icon" }, { icon: "" }, { unknown: 1 }])(
    "rejects the patch %j",
    (patch) => {
      expect(DatabasePatchInputSchema.safeParse({ databaseId: "d", patch }).success).toBe(false);
    },
  );
});

describe("database overviewHidden patch input (issue #2002)", () => {
  it.each([true, false])("accepts overviewHidden %s as a patch of its own", (overviewHidden) => {
    expect(DatabasePatchInputSchema.parse({ databaseId: "d", patch: { overviewHidden } }).patch).toEqual({
      overviewHidden,
    });
  });

  it("accepts overviewHidden beside the other patch fields", () => {
    expect(
      DatabasePatchInputSchema.parse({ databaseId: "d", patch: { name: "Cookbook", overviewHidden: true } }).patch,
    ).toEqual({ name: "Cookbook", overviewHidden: true });
  });

  it.each([["true"], ["false"], [1], [0], [null], [[]], [{}]])(
    "rejects the non-boolean overviewHidden %j and names the field",
    (overviewHidden) => {
      const result = DatabasePatchInputSchema.safeParse({ databaseId: "d", patch: { overviewHidden } });
      expect(result.success).toBe(false);
      if (!result.success) expect(validationIssueField(result.error.issues)).toBe("patch.overviewHidden");
    },
  );

  it("does not accept overviewHidden when a database is created", () => {
    expect(DatabaseCreateInputSchema.safeParse({ name: "Gifts", overviewHidden: true }).success).toBe(false);
  });
});

describe("PropertyGetByKeyInputSchema", () => {
  it("accepts a database id and key, with or without a type filter", () => {
    expect(PropertyGetByKeyInputSchema.safeParse({ databaseId: "db1", key: "assignedTo" }).success).toBe(true);
    expect(
      PropertyGetByKeyInputSchema.safeParse({ databaseId: "db1", key: "assignedTo", type: "relation" }).success,
    ).toBe(true);
  });

  it("rejects a type outside the property-type enum", () => {
    expect(PropertyGetByKeyInputSchema.safeParse({ databaseId: "db1", key: "k", type: "nonsense" }).success).toBe(
      false,
    );
  });

  it.each(["databaseId", "key"])("requires '%s'", (field) => {
    const input: Record<string, string> = { databaseId: "db1", key: "k" };
    delete input[field];
    expect(PropertyGetByKeyInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("PropertyPatchInputSchema", () => {
  it("rejects patching to relation", () => {
    expect(PropertyPatchInputSchema.safeParse({ propertyId: "p1", patch: { type: "relation" } }).success).toBe(false);
  });

  it.each(["locked", "owner", "ownerProcess", "createdBy"])("rejects the protected patch field '%s'", (field) => {
    expect(PropertyPatchInputSchema.safeParse({ propertyId: "p1", patch: { [field]: "x" } }).success).toBe(false);
  });
});

describe("PropertyCreateInputSchema relation branch", () => {
  it("requires source and inverse locked booleans", () => {
    const result = PropertyCreateInputSchema.safeParse({
      databaseId: "db1",
      key: "linkedTasks",
      name: "Linked Tasks",
      type: "relation",
      targetDatabaseId: "db2",
      cardinality: "many_to_many",
      locked: true,
      inverse: { key: "linkedFrom", name: "Linked From", locked: false },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a relation input missing the required source locked flag", () => {
    const result = PropertyCreateInputSchema.safeParse({
      databaseId: "db1",
      key: "linkedTasks",
      name: "Linked Tasks",
      type: "relation",
      targetDatabaseId: "db2",
      cardinality: "many_to_many",
    });
    expect(result.success).toBe(false);
  });
});

describe("ItemPatchInputSchema", () => {
  it("requires ifVersion", () => {
    expect(ItemPatchInputSchema.safeParse({ itemId: "i1", properties: {} }).success).toBe(false);
  });

  it("accepts itemId/properties/ifVersion", () => {
    expect(ItemPatchInputSchema.safeParse({ itemId: "i1", properties: { title: "x" }, ifVersion: "v1" }).success).toBe(
      true,
    );
  });
});

describe("ViewQueryInputSchema", () => {
  it("accepts filter/sort/inTrash/cursor/limit alongside viewId", () => {
    const result = ViewQueryInputSchema.safeParse({
      viewId: "v1",
      cursor: "c1",
      limit: 50,
      inTrash: true,
      sort: [{ property: "name", direction: "asc" }],
      filter: { type: "and", nodes: [{ type: "equals", property: "status", value: "done" }] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a limit above 200", () => {
    expect(ViewQueryInputSchema.safeParse({ viewId: "v1", limit: 201 }).success).toBe(false);
  });

  it("defaults limit to 50 when omitted", () => {
    const result = ViewQueryInputSchema.safeParse({ viewId: "v1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it("rejects a sort array beyond the max-length cap", () => {
    const tooManySortSpecs = Array.from({ length: 11 }, (_, i) => ({ property: `p${i}`, direction: "asc" as const }));
    expect(ViewQueryInputSchema.safeParse({ viewId: "v1", sort: tooManySortSpecs }).success).toBe(false);
  });

  it("accepts a sort array at the max-length cap", () => {
    const maxSortSpecs = Array.from({ length: 10 }, (_, i) => ({ property: `p${i}`, direction: "asc" as const }));
    expect(ViewQueryInputSchema.safeParse({ viewId: "v1", sort: maxSortSpecs }).success).toBe(true);
  });
});

describe("ViewItemAddInputSchema / ViewItemReorderInputSchema position bound", () => {
  it("rejects a position beyond the Postgres int4 range", () => {
    expect(ViewItemAddInputSchema.safeParse({ viewId: "v1", itemId: "i1", position: 2147483648 }).success).toBe(false);
    expect(ViewItemReorderInputSchema.safeParse({ viewId: "v1", itemId: "i1", position: 2147483648 }).success).toBe(
      false,
    );
  });

  it("accepts a position at the top of the int4 range", () => {
    expect(ViewItemAddInputSchema.safeParse({ viewId: "v1", itemId: "i1", position: 2147483647 }).success).toBe(true);
  });
});

describe("RelationDeleteInputSchema", () => {
  it("has the same endpoint fields as RelationPutInputSchema, without metadata", () => {
    expect(
      RelationDeleteInputSchema.safeParse({ relationPropertyId: "p1", callerItemId: "i1", targetItemId: "i2" }).success,
    ).toBe(true);
    expect(
      RelationDeleteInputSchema.safeParse({
        relationPropertyId: "p1",
        callerItemId: "i1",
        targetItemId: "i2",
        metadata: {},
      }).success,
    ).toBe(false);
  });
});

describe("RelationListInputSchema (issue #1404)", () => {
  it("rejects malformed identifiers while accepting uppercase UUIDs", () => {
    const uuid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
    expect(RelationListInputSchema.safeParse({ itemId: uuid, relationPropertyId: uuid }).success).toBe(true);
    for (const input of [{ itemId: "bad" }, { itemId: uuid, relationPropertyId: "bad" }]) {
      expect(RelationListInputSchema.safeParse(input).success).toBe(false);
    }
    expect(PageRestoreVersionInputSchema.safeParse({ itemId: "bad", at: "2026-10-01T10:00:00Z" }).success).toBe(false);
    expect(
      DatabaseCreateInputSchema.safeParse({
        name: "X",
        properties: [
          { key: "link", name: "Link", type: "relation", targetDatabaseId: "bad", cardinality: "one_to_one" },
        ],
      }).success,
    ).toBe(false);
  });
  it("requires an itemId and takes the relation property as an optional narrowing", () => {
    expect(RelationListInputSchema.safeParse({ itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }).success).toBe(true);
    expect(
      RelationListInputSchema.safeParse({
        itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        relationPropertyId: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      }).success,
    ).toBe(true);
    expect(
      RelationListInputSchema.safeParse({ relationPropertyId: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB" }).success,
    ).toBe(false);
  });

  it("rejects an unknown key, such as a relation direction or a metadata field", () => {
    expect(
      RelationListInputSchema.safeParse({ itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", propertyKey: "assignedTo" })
        .success,
    ).toBe(false);
    expect(
      RelationListInputSchema.safeParse({ itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", direction: "out" }).success,
    ).toBe(false);
  });
});

describe("PageRestoreVersionInputSchema (issue #1617)", () => {
  it("requires an itemId and an ISO 8601 timestamp with an offset", () => {
    expect(
      PageRestoreVersionInputSchema.safeParse({
        itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        at: "2026-10-01T10:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      PageRestoreVersionInputSchema.safeParse({
        itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        at: "2026-10-01T10:00:00.250+02:00",
      }).success,
    ).toBe(true);
  });

  it("rejects a missing itemId, a missing or non-ISO at, and an at without an offset", () => {
    expect(PageRestoreVersionInputSchema.safeParse({ at: "2026-10-01T10:00:00Z" }).success).toBe(false);
    expect(PageRestoreVersionInputSchema.safeParse({ itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }).success).toBe(
      false,
    );
    expect(
      PageRestoreVersionInputSchema.safeParse({ itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", at: "yesterday" })
        .success,
    ).toBe(false);
    expect(
      PageRestoreVersionInputSchema.safeParse({
        itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        at: "2026-10-01T10:00:00",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key, such as a page id or a userId", () => {
    expect(
      PageRestoreVersionInputSchema.safeParse({
        itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        at: "2026-10-01T10:00:00Z",
        pageId: "p",
      }).success,
    ).toBe(false);
    expect(
      PageRestoreVersionInputSchema.safeParse({
        itemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        at: "2026-10-01T10:00:00Z",
        userId: "u",
      }).success,
    ).toBe(false);
  });
});

describe("include on item reads (issue #1403)", () => {
  it.each([
    ["item.get", ItemGetInputSchema, { itemId: "i1" }],
    ["database.query", DatabaseQueryInputSchema, { databaseId: "d1" }],
    ["view.query", ViewQueryInputSchema, { viewId: "v1" }],
  ] as const)("%s accepts include links and rejects an unknown include value", (_name, schema, base) => {
    expect(schema.safeParse({ ...base, include: ["links"] }).success).toBe(true);
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, include: ["comments"] }).success).toBe(false);
  });
});

describe("relation expansion include contract", () => {
  for (const [schema, base] of [
    [ItemGetInputSchema, { itemId: "i" }],
    [DatabaseQueryInputSchema, { databaseId: "d" }],
    [ViewQueryInputSchema, { viewId: "v" }],
  ] as const) {
    it("accepts legacy links and combined object includes", () => {
      for (const include of [
        [],
        ["links"],
        { links: true },
        { links: false },
        { relations: {} },
        { links: true, relations: { projects: ["area"] } },
      ]) {
        expect(schema.safeParse({ ...base, include }).success).toBe(true);
      }
    });
    it("bounds keys/projections and rejects malformed object includes", () => {
      for (const include of [
        { relations: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`r${i}`, []])) },
        { relations: { projects: Array(11).fill("name") } },
        { relations: { projects: [""] } },
        { unknown: true },
        { links: "yes" },
      ]) {
        expect(schema.safeParse({ ...base, include }).success).toBe(false);
      }
    });
  }
});

it("names the offending relation include field in schema failures", () => {
  for (const [relations, field] of [
    [Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`r${i}`, []])), "include.relations"],
    [{ companies: Array(11).fill("name") }, "include.relations.companies"],
  ] as const) {
    const parsed = ItemGetInputSchema.safeParse({ itemId: "id", include: { relations } });
    if (parsed.success) throw new Error("Expected invalid relation include");
    expect(validationIssueField(parsed.error.issues)).toBe(field);
  }
});

describe("RelationSetInputSchema", () => {
  it("accepts an edge or clear and rejects missing and extra fields", () => {
    const input = {
      relationPropertyId: "00000000-0000-4000-8000-000000000001",
      callerItemId: "00000000-0000-4000-8000-000000000002",
      targetItemId: "00000000-0000-4000-8000-000000000003",
    };
    expect(RelationSetInputSchema.safeParse(input).success).toBe(true);
    expect(RelationSetInputSchema.safeParse({ ...input, targetItemId: null }).success).toBe(true);
    expect(
      RelationSetInputSchema.safeParse({
        relationPropertyId: input.relationPropertyId,
        callerItemId: input.callerItemId,
      }).success,
    ).toBe(false);
    expect(RelationSetInputSchema.safeParse({ ...input, metadata: {} }).success).toBe(false);
  });
});

describe("item.create initial relations", () => {
  it("enforces strict entries, unique keys and bounded target lists", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const relation = { propertyKey: "project", targetItemIds: [id] };
    const base = { databaseId: id, properties: {} };
    expect(ItemCreateInputSchema.safeParse({ ...base, relations: [relation] }).success).toBe(true);
    expect(ItemCreateInputSchema.safeParse({ ...base, relations: [relation, relation] }).success).toBe(false);
    expect(
      ItemCreateInputSchema.safeParse({
        ...base,
        relations: Array.from({ length: 11 }, (_, i) => ({ ...relation, propertyKey: `key${i}` })),
      }).success,
    ).toBe(false);
    expect(
      ItemCreateInputSchema.safeParse({ ...base, relations: [{ ...relation, targetItemIds: Array(51).fill(id) }] })
        .success,
    ).toBe(false);
    expect(ItemCreateInputSchema.safeParse({ ...base, relations: [{ ...relation, extra: true }] }).success).toBe(false);
  });
});

describe("PageCreateSubpageInputSchema (issue #1676)", () => {
  const itemId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("accepts an item parent or a Journal period parent, with optional placement and title", () => {
    expect(PageCreateSubpageInputSchema.safeParse({ parent: { itemId } }).success).toBe(true);
    expect(
      PageCreateSubpageInputSchema.safeParse({ parent: { itemId }, afterBlockId: "b1", title: "Notes" }).success,
    ).toBe(true);
    expect(
      PageCreateSubpageInputSchema.safeParse({ parent: { journal: { type: "day", period: "2026-10-16" } } }).success,
    ).toBe(true);
    expect(PageCreateSubpageInputSchema.safeParse({ parent: { itemId }, title: "" }).success).toBe(true);
    expect(PageCreateSubpageInputSchema.safeParse({ parent: { itemId }, fromBlockIds: ["a", "b"] }).success).toBe(true);
    expect(
      PageCreateSubpageInputSchema.safeParse({
        parent: { itemId },
        fromBlockIds: Array.from({ length: 200 }, (_, i) => `b${i}`),
      }).success,
    ).toBe(true);
  });

  it("refuses a missing, malformed, mixed or unknown parent and unknown keys", () => {
    for (const input of [
      {},
      { parent: {} },
      { parent: { itemId: "not-a-uuid" } },
      { parent: { itemId, journal: { type: "day", period: "2026-10-16" } } },
      { parent: { itemId, extra: true } },
      { parent: { journal: { type: "decade", period: "2020" } } },
      { parent: { journal: { type: "day", period: "" } } },
      { parent: { journal: { type: "day", period: "2026-10-16", extra: true } } },
      { parent: { itemId }, afterBlockId: "" },
      { parent: { itemId }, title: 5 },
      { parent: { itemId }, unexpected: true },
      { parent: { itemId }, fromBlockIds: [] },
      { parent: { itemId }, fromBlockIds: ["a", "a"] },
      { parent: { itemId }, fromBlockIds: [""] },
      { parent: { itemId }, fromBlockIds: Array.from({ length: 201 }, (_, i) => `b${i}`) },
    ]) {
      expect(PageCreateSubpageInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe("PageInsertInputSchema (issue #1679)", () => {
  const itemId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("accepts the three placements, optional caller ids and empty Markdown", () => {
    for (const placement of ["start", "end", { afterBlockId: "b1" }]) {
      expect(PageInsertInputSchema.safeParse({ itemId, placement, markdown: "Text" }).success).toBe(true);
    }
    expect(
      PageInsertInputSchema.safeParse({ itemId, placement: "end", markdown: "", blockIds: ["a", "b"] }).success,
    ).toBe(true);
  });

  it("refuses a missing or malformed field, an unknown placement and an oversized body or id list", () => {
    for (const input of [
      { placement: "end", markdown: "x" },
      { itemId: "bad", placement: "end", markdown: "x" },
      { itemId, markdown: "x" },
      { itemId, placement: "middle", markdown: "x" },
      { itemId, placement: { afterBlockId: "" }, markdown: "x" },
      { itemId, placement: { afterBlockId: "b1", extra: true }, markdown: "x" },
      { itemId, placement: "end" },
      { itemId, placement: "end", markdown: 7 },
      { itemId, placement: "end", markdown: "x".repeat(1_000_001) },
      { itemId, placement: "end", markdown: "x", blockIds: [""] },
      { itemId, placement: "end", markdown: "x", blockIds: Array.from({ length: 10_001 }, (_, i) => `b${i}`) },
      { itemId, placement: "end", markdown: "x", extra: true },
    ]) {
      expect(PageInsertInputSchema.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false);
    }
  });
});

describe("PageChangesInputSchema (issue #1680)", () => {
  const itemId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const since = "2026-11-09T10:00:00.000Z";

  it("defaults the author to the assistant and the limit to 100, and accepts every author and the limit bounds", () => {
    expect(PageChangesInputSchema.parse({ itemId, since })).toEqual({ itemId, since, by: "ai_agent", limit: 100 });
    for (const by of ["user", "ai_agent", "system"]) {
      expect(PageChangesInputSchema.safeParse({ itemId, since, by }).success, by).toBe(true);
    }
    for (const limit of [1, 500]) {
      expect(PageChangesInputSchema.safeParse({ itemId, since, limit }).success, String(limit)).toBe(true);
    }
    expect(PageChangesInputSchema.safeParse({ itemId, since: "2026-11-09T12:00:00+02:00" }).success).toBe(true);
  });

  it("refuses a missing or malformed field, an unknown author, an out-of-range limit and an unknown key", () => {
    for (const input of [
      { since },
      { itemId },
      { itemId: "bad", since },
      { itemId, since: "yesterday" },
      { itemId, since: "2026-11-09" },
      { itemId, since, by: "robot" },
      { itemId, since, limit: 0 },
      { itemId, since, limit: 501 },
      { itemId, since, limit: 1.5 },
      { itemId, since, extra: true },
    ]) {
      expect(PageChangesInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe("ItemCountInputSchema (issue #1709)", () => {
  const databaseId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const entries = (length: number) => Array.from({ length }, () => ({ databaseId }));

  it("accepts one to twenty entries and refuses none or twenty-one, naming items", () => {
    for (const length of [1, 20]) {
      expect(ItemCountInputSchema.safeParse({ items: entries(length) }).success, String(length)).toBe(true);
    }
    for (const length of [0, 21]) {
      const parsed = ItemCountInputSchema.safeParse({ items: entries(length) });
      expect(parsed.success, String(length)).toBe(false);
      if (parsed.success) throw new Error("Expected the entry count to be refused");
      expect(validationIssueField(parsed.error.issues)).toBe("items");
    }
  });

  it("accepts an entry with a filter tree, a groupBy key and the collection flag", () => {
    const entry = {
      databaseId: databaseId.toUpperCase(),
      filter: { type: "and", nodes: [{ type: "equals", property: "status", value: "notDone" }] },
      groupBy: "project",
      collection: true,
    };
    expect(ItemCountInputSchema.parse({ items: [entry] })).toEqual({ items: [entry] });
  });

  it.each([
    ["a missing items list", {}, "items"],
    ["a non-array items value", { items: { databaseId } }, "items"],
    ["an unknown top-level key", { items: [{ databaseId }], inTrash: true }, undefined],
    ["an entry without a database", { items: [{}] }, "items.0.databaseId"],
    ["a malformed database id", { items: [{ databaseId: "bad" }] }, "items.0.databaseId"],
    ["an empty groupBy", { items: [{ databaseId, groupBy: "" }] }, "items.0.groupBy"],
    ["a non-string groupBy", { items: [{ databaseId, groupBy: 1 }] }, "items.0.groupBy"],
    ["a non-boolean collection", { items: [{ databaseId, collection: "yes" }] }, "items.0.collection"],
    ["an unknown entry key", { items: [{ databaseId }, { databaseId, inTrash: true }] }, "items.1"],
  ])("refuses %s", (_name, input, field) => {
    const parsed = ItemCountInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected the input to be refused");
    expect(validationIssueField(parsed.error.issues)).toBe(field);
  });

  it("refuses the filter trees database.query refuses", () => {
    const relation = {
      type: "relation_path_contains",
      path: ["project", "area"],
      value: "11111111-1111-4111-8111-111111111111",
    };
    const nested = (depth: number): unknown => (depth === 0 ? relation : { type: "not", node: nested(depth - 1) });
    expect(ItemCountInputSchema.safeParse({ items: [{ databaseId, filter: nested(8) }] }).success).toBe(true);
    for (const filter of [
      nested(9),
      { type: "unknown", property: "name" },
      { type: "and", nodes: [] },
      { type: "equals", property: "name", value: "x", extra: true },
    ]) {
      const forCount = ItemCountInputSchema.safeParse({ items: [{ databaseId, filter }] });
      expect(forCount.success, JSON.stringify(filter).slice(0, 80)).toBe(false);
      expect(DatabaseQueryInputSchema.safeParse({ databaseId, filter }).success).toBe(false);
    }
  });
});

describe("DatabaseFacetsInputSchema (issue #1759)", () => {
  const databaseId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const relation = {
    type: "relation_path_contains",
    path: ["project", "area"],
    value: "11111111-1111-4111-8111-111111111111",
  };
  const nested = (depth: number): unknown => (depth === 0 ? relation : { type: "not", node: nested(depth - 1) });

  it("accepts one to twenty facets and refuses none or twenty-one, naming facets", () => {
    for (const length of [1, 20]) {
      const facets = Array.from({ length }, (_, index) => `property${index}`);
      expect(DatabaseFacetsInputSchema.safeParse({ databaseId, facets }).success, String(length)).toBe(true);
    }
    for (const length of [0, 21]) {
      const facets = Array.from({ length }, (_, index) => `property${index}`);
      const parsed = DatabaseFacetsInputSchema.safeParse({ databaseId, facets });
      expect(parsed.success, String(length)).toBe(false);
      if (parsed.success) throw new Error("Expected the facet count to be refused");
      expect(validationIssueField(parsed.error.issues)).toBe("facets");
    }
  });

  it("accepts property keys and two-key paths together with a filter tree and an open filter", () => {
    const input = {
      databaseId: databaseId.toUpperCase(),
      filter: { type: "and", nodes: [{ type: "equals", property: "status", value: "inProgress" }, relation] },
      facets: ["status", { path: ["project", "area"] }],
      extra: { open: { type: "equals", property: "status", value: "notDone" } },
    };
    expect(DatabaseFacetsInputSchema.parse(input)).toEqual(input);
  });

  it.each([
    ["a missing facet list", { databaseId }, "facets"],
    ["a facet list that is not an array", { databaseId, facets: "status" }, "facets"],
    ["a missing database", { facets: ["status"] }, "databaseId"],
    ["a malformed database id", { databaseId: "bad", facets: ["status"] }, "databaseId"],
    ["an unknown top-level key", { databaseId, facets: ["status"], q: "text" }, undefined],
    ["an empty property key", { databaseId, facets: ["status", ""] }, "facets.1"],
    ["a path with an empty key", { databaseId, facets: [{ path: ["project", ""] }] }, "facets.0.path.1"],
    // A facet that matches neither form fails the union as a whole, which the field mapper reports without a field.
    ["a facet that is a number", { databaseId, facets: [1] }, undefined],
    ["a path of one key", { databaseId, facets: [{ path: ["project"] }] }, undefined],
    ["a path of three keys", { databaseId, facets: [{ path: ["project", "area", "name"] }] }, undefined],
    ["a path object with another key", { databaseId, facets: [{ path: ["project", "area"], top: 5 }] }, undefined],
    // A missing open filter fails the filter union the same way.
    ["an extra without an open filter", { databaseId, facets: ["status"], extra: {} }, undefined],
    [
      "an extra with another key",
      { databaseId, facets: ["status"], extra: { open: relation, closed: relation } },
      "extra",
    ],
  ])("refuses %s", (_name, input, field) => {
    const parsed = DatabaseFacetsInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected the input to be refused");
    expect(validationIssueField(parsed.error.issues)).toBe(field);
  });

  it("refuses in filter and in extra.open the filter trees database.query refuses", () => {
    expect(DatabaseFacetsInputSchema.safeParse({ databaseId, facets: ["status"], filter: nested(8) }).success).toBe(
      true,
    );
    expect(
      DatabaseFacetsInputSchema.safeParse({ databaseId, facets: ["status"], extra: { open: nested(8) } }).success,
    ).toBe(true);
    for (const filter of [
      nested(9),
      { type: "unknown", property: "name" },
      { type: "and", nodes: [] },
      { type: "or", nodes: Array.from({ length: 21 }, () => relation) },
      { type: "equals", property: "name", value: "x", extra: true },
    ]) {
      const label = JSON.stringify(filter).slice(0, 80);
      expect(DatabaseQueryInputSchema.safeParse({ databaseId, filter }).success, label).toBe(false);
      expect(DatabaseFacetsInputSchema.safeParse({ databaseId, facets: ["status"], filter }).success, label).toBe(
        false,
      );
      expect(
        DatabaseFacetsInputSchema.safeParse({ databaseId, facets: ["status"], extra: { open: filter } }).success,
        label,
      ).toBe(false);
    }
  });
});

describe("SearchInputSchema (issue #1842)", () => {
  it("defaults the scope to every group in the fixed order and the limit per group to 4", () => {
    expect(SearchInputSchema.parse({ q: "faktura" })).toEqual({
      q: "faktura",
      scope: ["task", "event", "project", "area", "contact", "journal", "file", "mail", "chat"],
      perGroupLimit: 4,
    });
    expect([...SEARCH_GROUP_TYPES]).toEqual(SearchInputSchema.parse({ q: "x" }).scope);
  });

  it("accepts a query of 1 and of 200 characters, a limit of 1 and of 50, and a cursor with exactly one scope type", () => {
    expect(SearchInputSchema.safeParse({ q: "a" }).success).toBe(true);
    expect(SearchInputSchema.safeParse({ q: "a".repeat(200) }).success).toBe(true);
    for (const perGroupLimit of [1, 50]) {
      expect(SearchInputSchema.safeParse({ q: "a", perGroupLimit }).success, String(perGroupLimit)).toBe(true);
    }
    expect(SearchInputSchema.safeParse({ q: "a", scope: ["task"], cursor: "opaque" }).success).toBe(true);
    expect(SearchInputSchema.safeParse({ q: "a", scope: ["mail", "chat"] }).success).toBe(true);
  });

  it("refuses an empty or missing query, a query over 200 characters and names the field", () => {
    for (const input of [{ q: "" }, {}, { q: "a".repeat(201) }, { q: 5 }]) {
      const parsed = SearchInputSchema.safeParse(input);
      expect(parsed.success, JSON.stringify(input).slice(0, 40)).toBe(false);
      if (parsed.success) throw new Error("Expected the query to be refused");
      expect(validationIssueField(parsed.error.issues)).toBe("q");
    }
  });

  it("refuses a limit outside 1 to 50 and a non-integer limit, naming perGroupLimit", () => {
    for (const perGroupLimit of [0, 51, 1.5, "4"]) {
      const parsed = SearchInputSchema.safeParse({ q: "a", perGroupLimit });
      expect(parsed.success, String(perGroupLimit)).toBe(false);
      if (parsed.success) throw new Error("Expected the limit to be refused");
      expect(validationIssueField(parsed.error.issues)).toBe("perGroupLimit");
    }
  });

  it("refuses an empty, repeating or unknown scope", () => {
    for (const scope of [[], ["task", "task"], ["unknown"], ["contacts"], "task"]) {
      const parsed = SearchInputSchema.safeParse({ q: "a", scope });
      expect(parsed.success, JSON.stringify(scope)).toBe(false);
      if (parsed.success) throw new Error("Expected the scope to be refused");
      expect(validationIssueField(parsed.error.issues)).toMatch(/^scope(\.\d+)?$/);
    }
  });

  it("refuses a cursor with two scope types and with the default scope, naming cursor, and an empty cursor", () => {
    for (const input of [
      { q: "a", scope: ["task", "event"], cursor: "opaque" },
      { q: "a", cursor: "opaque" },
      { q: "a", scope: ["task"], cursor: "" },
    ]) {
      const parsed = SearchInputSchema.safeParse(input);
      expect(parsed.success, JSON.stringify(input)).toBe(false);
      if (parsed.success) throw new Error("Expected the cursor to be refused");
      expect(validationIssueField(parsed.error.issues)).toBe("cursor");
    }
  });

  it("does not repeat the query in any refusal message", () => {
    const secret = "tajny-dotaz-".repeat(30);
    const parsed = SearchInputSchema.safeParse({ q: secret, perGroupLimit: 99, scope: ["task", "task"] });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected the input to be refused");
    expect(JSON.stringify(parsed.error.issues)).not.toContain("tajny-dotaz");
  });
});

describe("SearchOutputSchema (issue #1842)", () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const itemResult = {
    itemId: id,
    databaseId: id,
    databaseKey: "tasks",
    title: "Odeslat fakturu",
    subtitleParts: [{ kind: "date", value: "2026-10-16" }],
    snippet: null,
  };

  it("accepts an item group, a thread group and an empty answer", () => {
    expect(SearchOutputSchema.safeParse({ groups: [] }).success).toBe(true);
    expect(
      SearchOutputSchema.safeParse({ groups: [{ type: "task", total: 9, items: [itemResult], nextCursor: "c" }] })
        .success,
    ).toBe(true);
    expect(
      SearchOutputSchema.safeParse({
        groups: [
          {
            type: "mail",
            total: 1,
            items: [
              {
                threadId: id,
                title: "Re: faktura",
                subtitleParts: [{ kind: "sender", value: "a@b.cz" }],
                snippet: null,
              },
            ],
            nextCursor: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses a thread result in an item group, an item result in a thread group and an unknown group type", () => {
    const threadResult = { threadId: id, title: "t", subtitleParts: [], snippet: null };
    for (const group of [
      { type: "task", total: 1, items: [threadResult], nextCursor: null },
      { type: "mail", total: 1, items: [itemResult], nextCursor: null },
      { type: "recipe", total: 1, items: [], nextCursor: null },
    ]) {
      expect(SearchOutputSchema.safeParse({ groups: [group] }).success, group.type).toBe(false);
    }
  });

  it("refuses an unknown subtitle kind, an unknown key and a missing snippet", () => {
    for (const result of [
      { ...itemResult, subtitleParts: [{ kind: "company", value: "x" }] },
      { ...itemResult, extra: true },
      { itemId: id, databaseId: id, databaseKey: "tasks", title: "t", subtitleParts: [] },
    ]) {
      expect(
        SearchOutputSchema.safeParse({ groups: [{ type: "task", total: 1, items: [result], nextCursor: null }] })
          .success,
      ).toBe(false);
    }
  });
});
