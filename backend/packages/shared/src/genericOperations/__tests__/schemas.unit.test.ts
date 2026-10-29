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
  RelationPutInputSchema,
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
  RelationDeleteInputSchema,
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
        { key: "link", name: "Link", type: "relation", targetDatabaseId: "db", cardinality: "one_to_many" },
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
