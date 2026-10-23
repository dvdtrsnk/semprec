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
