import { validationIssueField } from "../validationIssueField.js";
import { describe, expect, it } from "vitest";
import {
  DatabaseArchiveInputSchema,
  DatabaseCreateInputSchema,
  DatabaseGetInputSchema,
  DatabaseListInputSchema,
  DatabasePatchInputSchema,
  DatabaseQueryInputSchema,
  DatabaseRestoreInputSchema,
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
  PageRestoreVersionInputSchema,
  PageCreateSubpageInputSchema,
  PageInsertInputSchema,
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
