import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { AuthenticatedActor } from "../actor.js";
import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "../catalog.js";
import { GENERIC_OPERATION_BINDINGS, type CapabilityId, type RiskClass } from "../bindings.js";
import { OPERATION_METHODS, type GenericApplicationPort } from "../port.js";
import * as schemas from "../schemas.js";

const ACTOR: AuthenticatedActor = { userId: "user-1" };

/** The catalog exactly as the issue states it: operation, schema, port method, capability, approval metadata. */
const CATALOG: Record<
  GenericOperationName,
  {
    schema: ZodType<unknown>;
    method: keyof GenericApplicationPort;
    requiresCapability: CapabilityId;
    requiresApproval: boolean;
    riskClass: RiskClass | null;
    /** A minimal input that parses, used for the invocation and spoofing tests. */
    input: Record<string, unknown>;
  }
> = {
  "database.list": { schema: schemas.DatabaseListInputSchema, method: "listDatabases", requiresCapability: "core.database.read", requiresApproval: false, riskClass: null, input: {} },
  "database.get": { schema: schemas.DatabaseGetInputSchema, method: "getDatabase", requiresCapability: "core.database.read", requiresApproval: false, riskClass: null, input: { databaseId: "db-1" } },
  "database.create": { schema: schemas.DatabaseCreateInputSchema, method: "createDatabase", requiresCapability: "core.database.write", requiresApproval: false, riskClass: null, input: { name: "Projects" } },
  "database.patch": { schema: schemas.DatabasePatchInputSchema, method: "patchDatabase", requiresCapability: "core.database.write", requiresApproval: false, riskClass: null, input: { databaseId: "db-1", patch: { name: "Renamed" } } },
  "database.archive": { schema: schemas.DatabaseArchiveInputSchema, method: "archiveDatabase", requiresCapability: "core.database.write", requiresApproval: true, riskClass: "destructive", input: { databaseId: "db-1" } },
  "database.restore": { schema: schemas.DatabaseRestoreInputSchema, method: "restoreDatabase", requiresCapability: "core.database.write", requiresApproval: false, riskClass: null, input: { databaseId: "db-1" } },
  "database.query": { schema: schemas.DatabaseQueryInputSchema, method: "queryDatabase", requiresCapability: "core.database.read", requiresApproval: false, riskClass: null, input: { databaseId: "db-1" } },
  "property.list": { schema: schemas.PropertyListInputSchema, method: "listProperties", requiresCapability: "core.schema.read", requiresApproval: false, riskClass: null, input: { databaseId: "db-1" } },
  "property.get": { schema: schemas.PropertyGetInputSchema, method: "getProperty", requiresCapability: "core.schema.read", requiresApproval: false, riskClass: null, input: { propertyId: "prop-1" } },
  "property.create": { schema: schemas.PropertyCreateInputSchema, method: "createProperty", requiresCapability: "core.schema.write", requiresApproval: false, riskClass: null, input: { databaseId: "db-1", key: "status", name: "Status", type: "select" } },
  "property.patch": { schema: schemas.PropertyPatchInputSchema, method: "patchProperty", requiresCapability: "core.schema.write", requiresApproval: false, riskClass: null, input: { propertyId: "prop-1", patch: { name: "Status" } } },
  "property.delete": { schema: schemas.PropertyDeleteInputSchema, method: "deleteProperty", requiresCapability: "core.schema.write", requiresApproval: true, riskClass: "destructive", input: { propertyId: "prop-1" } },
  "view.list": { schema: schemas.ViewListInputSchema, method: "listViews", requiresCapability: "core.view.read", requiresApproval: false, riskClass: null, input: {} },
  "view.get": { schema: schemas.ViewGetInputSchema, method: "getView", requiresCapability: "core.view.read", requiresApproval: false, riskClass: null, input: { viewId: "view-1" } },
  "view.create": { schema: schemas.ViewCreateInputSchema, method: "createView", requiresCapability: "core.view.write", requiresApproval: false, riskClass: null, input: { databaseId: "db-1", type: "table", name: "All" } },
  "view.patch": { schema: schemas.ViewPatchInputSchema, method: "patchView", requiresCapability: "core.view.write", requiresApproval: false, riskClass: null, input: { viewId: "view-1", patch: { name: "All" } } },
  "view.delete": { schema: schemas.ViewDeleteInputSchema, method: "deleteView", requiresCapability: "core.view.write", requiresApproval: true, riskClass: "destructive", input: { viewId: "view-1" } },
  "view.query": { schema: schemas.ViewQueryInputSchema, method: "queryView", requiresCapability: "core.view.read", requiresApproval: false, riskClass: null, input: { viewId: "view-1" } },
  "viewItem.add": { schema: schemas.ViewItemAddInputSchema, method: "addViewItem", requiresCapability: "core.view.write", requiresApproval: false, riskClass: null, input: { viewId: "view-1", itemId: "item-1", position: 1 } },
  "viewItem.remove": { schema: schemas.ViewItemRemoveInputSchema, method: "removeViewItem", requiresCapability: "core.view.write", requiresApproval: false, riskClass: null, input: { viewId: "view-1", itemId: "item-1" } },
  "viewItem.reorder": { schema: schemas.ViewItemReorderInputSchema, method: "reorderViewItem", requiresCapability: "core.view.write", requiresApproval: false, riskClass: null, input: { viewId: "view-1", itemId: "item-1", position: 2 } },
  "item.get": { schema: schemas.ItemGetInputSchema, method: "getItem", requiresCapability: "core.item.read", requiresApproval: false, riskClass: null, input: { itemId: "item-1" } },
  "item.create": { schema: schemas.ItemCreateInputSchema, method: "createItem", requiresCapability: "core.item.write", requiresApproval: false, riskClass: null, input: { databaseId: "db-1", properties: { title: "New" } } },
  "item.patch": { schema: schemas.ItemPatchInputSchema, method: "patchItem", requiresCapability: "core.item.write", requiresApproval: false, riskClass: null, input: { itemId: "item-1", properties: { title: "New" }, ifVersion: "2026-01-01T00:00:00.000Z" } },
  "item.delete": { schema: schemas.ItemDeleteInputSchema, method: "deleteItem", requiresCapability: "core.item.write", requiresApproval: true, riskClass: "destructive", input: { itemId: "item-1" } },
  "item.restore": { schema: schemas.ItemRestoreInputSchema, method: "restoreItem", requiresCapability: "core.item.write", requiresApproval: false, riskClass: null, input: { itemId: "item-1" } },
  "relation.put": { schema: schemas.RelationPutInputSchema, method: "putRelation", requiresCapability: "core.item.write", requiresApproval: false, riskClass: null, input: { relationPropertyId: "prop-1", callerItemId: "item-1", targetItemId: "item-2" } },
  "relation.delete": { schema: schemas.RelationDeleteInputSchema, method: "deleteRelation", requiresCapability: "core.item.write", requiresApproval: true, riskClass: "destructive", input: { relationPropertyId: "prop-1", callerItemId: "item-1", targetItemId: "item-2" } },
};

const OPERATIONS = GENERIC_OPERATION_NAMES.map((name) => [name, CATALOG[name]] as const);

/** A port that records the single method it was called on, so a binding cannot quietly call a different one. */
function createRecordingPort(result: unknown): { port: GenericApplicationPort; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const port = new Proxy(
    {},
    {
      get(_target, method: string) {
        return async (...args: unknown[]) => {
          calls.push({ method, args });
          return result;
        };
      },
    },
  ) as GenericApplicationPort;
  return { port, calls };
}

function isStrictObjectSchema(schema: ZodType<unknown>): boolean {
  const def = (schema as unknown as { def: { type: string; catchall?: { def: { type: string } }; options?: ZodType<unknown>[] } }).def;
  if (def.type === "union") return def.options!.every(isStrictObjectSchema);
  return def.type === "object" && def.catchall?.def.type === "never";
}

describe("the generic operation catalog", () => {
  it("is exactly the 28 operations, with no duplicates", () => {
    expect(GENERIC_OPERATION_NAMES).toHaveLength(28);
    expect(new Set(GENERIC_OPERATION_NAMES).size).toBe(28);
  });

  it("binds every catalog operation and nothing else", () => {
    expect(Object.keys(GENERIC_OPERATION_BINDINGS).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
    expect(Object.keys(OPERATION_METHODS).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  it("maps every operation to a distinct port method", () => {
    expect(new Set(Object.values(OPERATION_METHODS)).size).toBe(28);
  });
});

describe.each(OPERATIONS)("binding %s", (operation, expected) => {
  const binding = GENERIC_OPERATION_BINDINGS[operation];

  it("uses the named input schema", () => {
    expect(binding.input).toBe(expected.schema);
  });

  it("declares the mapped port method", () => {
    expect(OPERATION_METHODS[operation]).toBe(expected.method);
  });

  it("invokes service[method](actor, input) and returns its result", async () => {
    const result = { sentinel: operation };
    const { port, calls } = createRecordingPort(result);
    const input = expected.schema.parse(expected.input);

    await expect(binding.invoke(port, ACTOR, input as never)).resolves.toBe(result);
    expect(calls).toEqual([{ method: expected.method, args: [ACTOR, input] }]);
  });

  it("carries the mapped capability and approval metadata", () => {
    expect(binding.requiresCapability).toBe(expected.requiresCapability);
    expect(binding.requiresApproval).toBe(expected.requiresApproval);
    expect(binding.riskClass).toBe(expected.riskClass);
  });

  it("is a strict object schema that accepts its minimal input", () => {
    expect(isStrictObjectSchema(binding.input)).toBe(true);
    expect(binding.input.safeParse(expected.input).success).toBe(true);
  });

  it.each(["actor", "userId", "agentProjectItemId", "runId"])("rejects a spoofed %s field", (field) => {
    expect(binding.input.safeParse({ ...expected.input, [field]: "spoofed" }).success).toBe(false);
  });

  it.each(["system", "schemaLocked", "ownerProjectItemId", "ownerModuleId", "owner", "ownerProcess", "locked", "createdBy", "creatorProjectItemId"])(
    "rejects the server-derived %s field",
    (field) => {
      expect(binding.input.safeParse({ ...expected.input, [field]: "spoofed" }).success).toBe(false);
    },
  );
});

describe("pagination and query inputs", () => {
  it("defaults limit to 50 and rejects more than 200", () => {
    expect(schemas.DatabaseListInputSchema.parse({})).toEqual({ limit: 50 });
    expect(schemas.ViewListInputSchema.parse({}).limit).toBe(50);
    expect(schemas.DatabaseQueryInputSchema.safeParse({ databaseId: "db-1", limit: 201 }).success).toBe(false);
    expect(schemas.DatabaseQueryInputSchema.parse({ databaseId: "db-1", limit: 200 }).limit).toBe(200);
  });

  it("excludes trashed rows unless the caller opts in, and carries the filter/sort tree", () => {
    const parsed = schemas.ViewQueryInputSchema.parse({
      viewId: "view-1",
      filter: { type: "equals", property: "status", value: "done" },
      sort: [{ property: "status", direction: "asc" }],
    });
    expect(parsed.inTrash).toBe(false);
    expect(parsed.filter).toEqual({ type: "equals", property: "status", value: "done" });
    expect(parsed.sort).toEqual([{ property: "status", direction: "asc" }]);
    expect(schemas.DatabaseQueryInputSchema.parse({ databaseId: "db-1", inTrash: true }).inTrash).toBe(true);
    expect(schemas.ViewQueryInputSchema.safeParse({ viewId: "view-1", filter: { type: "nonsense" } }).success).toBe(false);
  });
});

describe("metadata command inputs", () => {
  it("accepts the relation branch of property.create with its required lock flags", () => {
    const relation = {
      databaseId: "db-1",
      key: "project",
      name: "Project",
      type: "relation",
      targetDatabaseId: "db-2",
      cardinality: "one_to_many",
      locked: true,
      inverse: { key: "tasks", name: "Tasks", locked: false },
    };
    expect(schemas.PropertyCreateInputSchema.parse(relation)).toEqual(relation);
    expect(schemas.PropertyCreateInputSchema.safeParse({ ...relation, cardinality: "one_to_none" }).success).toBe(false);
    expect(schemas.PropertyCreateInputSchema.safeParse({ databaseId: "db-1", key: "p", name: "P", type: "relation" }).success).toBe(false);
  });

  it("refuses to turn a property into a relation through a patch", () => {
    expect(schemas.PropertyPatchInputSchema.safeParse({ propertyId: "prop-1", patch: { type: "relation" } }).success).toBe(false);
    expect(schemas.PropertyPatchInputSchema.parse({ propertyId: "prop-1", patch: { type: "number" } }).patch.type).toBe("number");
  });

  it("leaves empty patch objects to the service, which rejects them as empty_patch", () => {
    expect(schemas.DatabasePatchInputSchema.safeParse({ databaseId: "db-1", patch: {} }).success).toBe(true);
    expect(schemas.PropertyPatchInputSchema.safeParse({ propertyId: "prop-1", patch: {} }).success).toBe(true);
    expect(schemas.ViewPatchInputSchema.safeParse({ viewId: "view-1", patch: {} }).success).toBe(true);
  });

  it("has no ifVersion outside the item property patch", () => {
    expect(schemas.DatabasePatchInputSchema.safeParse({ databaseId: "db-1", patch: {}, ifVersion: "v1" }).success).toBe(false);
    expect(schemas.ItemPatchInputSchema.safeParse({ itemId: "item-1", properties: {} }).success).toBe(false);
  });

  it("allows a curated view to be created without a database", () => {
    expect(schemas.ViewCreateInputSchema.parse({ databaseId: null, type: "board", name: "Curated" }).databaseId).toBeNull();
    expect(schemas.ViewCreateInputSchema.parse({ type: "board", name: "Curated" }).databaseId).toBeUndefined();
  });

  it("makes item.create dedup opt-in through idempotencyKey", () => {
    expect(schemas.ItemCreateInputSchema.parse({ databaseId: "db-1", properties: {} }).idempotencyKey).toBeUndefined();
    expect(schemas.ItemCreateInputSchema.parse({ databaseId: "db-1", properties: {}, idempotencyKey: "k1" }).idempotencyKey).toBe("k1");
  });

  it("keeps relation.delete to the edge identity, without metadata", () => {
    const edge = { relationPropertyId: "prop-1", callerItemId: "item-1", targetItemId: "item-2" };
    expect(schemas.RelationPutInputSchema.parse({ ...edge, metadata: { role: "owner" } }).metadata).toEqual({ role: "owner" });
    expect(schemas.RelationDeleteInputSchema.safeParse({ ...edge, metadata: {} }).success).toBe(false);
  });
});
