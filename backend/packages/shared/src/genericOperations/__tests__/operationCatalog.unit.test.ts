import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GENERIC_OPERATION_NAMES, REST_ONLY_OPERATION_NAMES, type GenericOperationName } from "../operationNames.js";
import { GENERIC_OPERATION_BINDINGS } from "../bindings.js";
import {
  OPERATION_METADATA,
  RISK_CLASSES,
  deriveApprovalRiskLevel,
  isRiskClass,
  type CapabilityId,
  type RiskClass,
} from "../capabilities.js";
import type { GenericApplicationPort } from "../port.js";
import * as schemas from "../schemas.js";

const EXPECTED_ROWS: Record<
  GenericOperationName,
  { schema: z.ZodType<unknown>; method: keyof GenericApplicationPort }
> = {
  "database.list": { schema: schemas.DatabaseListInputSchema, method: "listDatabases" },
  "database.get": { schema: schemas.DatabaseGetInputSchema, method: "getDatabase" },
  "database.create": { schema: schemas.DatabaseCreateInputSchema, method: "createDatabase" },
  "database.patch": { schema: schemas.DatabasePatchInputSchema, method: "patchDatabase" },
  "database.archive": { schema: schemas.DatabaseArchiveInputSchema, method: "archiveDatabase" },
  "database.restore": { schema: schemas.DatabaseRestoreInputSchema, method: "restoreDatabase" },
  "property.list": { schema: schemas.PropertyListInputSchema, method: "listProperties" },
  "property.get": { schema: schemas.PropertyGetInputSchema, method: "getProperty" },
  "property.getByKey": { schema: schemas.PropertyGetByKeyInputSchema, method: "getPropertyByKey" },
  "property.create": { schema: schemas.PropertyCreateInputSchema, method: "createProperty" },
  "property.patch": { schema: schemas.PropertyPatchInputSchema, method: "patchProperty" },
  "property.delete": { schema: schemas.PropertyDeleteInputSchema, method: "deleteProperty" },
  "property.option.add": { schema: schemas.PropertyOptionAddInputSchema, method: "addPropertyOption" },
  "property.option.update": { schema: schemas.PropertyOptionUpdateInputSchema, method: "updatePropertyOption" },
  "view.list": { schema: schemas.ViewListInputSchema, method: "listViews" },
  "view.get": { schema: schemas.ViewGetInputSchema, method: "getView" },
  "view.create": { schema: schemas.ViewCreateInputSchema, method: "createView" },
  "view.patch": { schema: schemas.ViewPatchInputSchema, method: "patchView" },
  "view.delete": { schema: schemas.ViewDeleteInputSchema, method: "deleteView" },
  "view.query": { schema: schemas.ViewQueryInputSchema, method: "queryView" },
  "viewItem.add": { schema: schemas.ViewItemAddInputSchema, method: "addViewItem" },
  "viewItem.remove": { schema: schemas.ViewItemRemoveInputSchema, method: "removeViewItem" },
  "viewItem.reorder": { schema: schemas.ViewItemReorderInputSchema, method: "reorderViewItem" },
  "item.get": { schema: schemas.ItemGetInputSchema, method: "getItem" },
  "item.create": { schema: schemas.ItemCreateInputSchema, method: "createItem" },
  "item.patch": { schema: schemas.ItemPatchInputSchema, method: "patchItem" },
  "item.delete": { schema: schemas.ItemDeleteInputSchema, method: "deleteItem" },
  "item.restore": { schema: schemas.ItemRestoreInputSchema, method: "restoreItem" },
  "database.query": { schema: schemas.DatabaseQueryInputSchema, method: "queryDatabase" },
  "relation.put": { schema: schemas.RelationPutInputSchema, method: "putRelation" },
  "relation.set": { schema: schemas.RelationSetInputSchema, method: "setRelation" },
  "relation.delete": { schema: schemas.RelationDeleteInputSchema, method: "deleteRelation" },
  "relation.list": { schema: schemas.RelationListInputSchema, method: "listRelations" },
  "page.ensure": { schema: schemas.PageEnsureInputSchema, method: "ensurePage" },
  "page.createSubpage": { schema: schemas.PageCreateSubpageInputSchema, method: "createSubpage" },
  "page.duplicate": { schema: schemas.PageDuplicateInputSchema, method: "duplicatePage" },
  "page.rename": { schema: schemas.PageRenameInputSchema, method: "renamePage" },
  "page.insert": { schema: schemas.PageInsertInputSchema, method: "insertPage" },
  "page.get": { schema: schemas.PageGetInputSchema, method: "getPage" },
  "page.changes": { schema: schemas.PageChangesInputSchema, method: "listPageChanges" },
  "link.unlink": { schema: schemas.ValueLinkInputSchema, method: "unlinkValue" },
  "link.relink": { schema: schemas.ValueLinkInputSchema, method: "relinkValue" },
  "page.restoreVersion": { schema: schemas.PageRestoreVersionInputSchema, method: "restorePageVersion" },
  "item.count": { schema: schemas.ItemCountInputSchema, method: "countItems" },
};

const EXPECTED_METADATA: Record<
  GenericOperationName,
  { requiresCapability: CapabilityId; requiresApproval: boolean; riskClass: RiskClass; reversible: boolean }
> = {
  "database.list": {
    requiresCapability: "core.database.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "database.get": {
    requiresCapability: "core.database.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "database.query": {
    requiresCapability: "core.database.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "database.create": {
    requiresCapability: "core.database.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "database.patch": {
    requiresCapability: "core.database.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "database.archive": {
    requiresCapability: "core.database.write",
    requiresApproval: true,
    riskClass: "destructive",
    reversible: true,
  },
  "database.restore": {
    requiresCapability: "core.database.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "property.list": {
    requiresCapability: "core.schema.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "property.get": {
    requiresCapability: "core.schema.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "property.getByKey": {
    requiresCapability: "core.schema.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "property.create": {
    requiresCapability: "core.schema.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "property.patch": {
    requiresCapability: "core.schema.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "property.delete": {
    requiresCapability: "core.schema.write",
    requiresApproval: true,
    riskClass: "destructive",
    reversible: false,
  },
  "property.option.add": {
    requiresCapability: "core.schema.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "property.option.update": {
    requiresCapability: "core.schema.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "view.list": { requiresCapability: "core.view.read", requiresApproval: false, riskClass: "read", reversible: true },
  "view.get": { requiresCapability: "core.view.read", requiresApproval: false, riskClass: "read", reversible: true },
  "view.query": { requiresCapability: "core.view.read", requiresApproval: false, riskClass: "read", reversible: true },
  "view.create": {
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "view.patch": {
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "view.delete": {
    requiresCapability: "core.view.write",
    requiresApproval: true,
    riskClass: "destructive",
    reversible: false,
  },
  "viewItem.add": {
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "viewItem.remove": {
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "viewItem.reorder": {
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "item.get": { requiresCapability: "core.item.read", requiresApproval: false, riskClass: "read", reversible: true },
  "item.create": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "item.patch": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "item.delete": {
    requiresCapability: "core.item.write",
    requiresApproval: true,
    riskClass: "destructive",
    reversible: true,
  },
  "item.restore": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "relation.put": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "relation.set": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "relation.delete": {
    requiresCapability: "core.item.write",
    requiresApproval: true,
    riskClass: "destructive",
    reversible: false,
  },
  "relation.list": {
    requiresCapability: "core.item.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "link.unlink": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "link.relink": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "page.ensure": {
    requiresCapability: "core.page.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "page.get": { requiresCapability: "core.page.read", requiresApproval: false, riskClass: "read", reversible: true },
  "page.changes": {
    requiresCapability: "core.page.read",
    requiresApproval: false,
    riskClass: "read",
    reversible: true,
  },
  "page.insert": {
    requiresCapability: "core.page.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "page.createSubpage": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "page.duplicate": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "page.rename": {
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: "write",
    reversible: true,
  },
  "page.restoreVersion": {
    requiresCapability: "core.page.write",
    requiresApproval: true,
    riskClass: "destructive",
    reversible: true,
  },
  "item.count": { requiresCapability: "core.item.read", requiresApproval: false, riskClass: "read", reversible: true },
};

describe("GENERIC_OPERATION_NAMES", () => {
  it("has exactly 44 entries with no duplicates", () => {
    expect(GENERIC_OPERATION_NAMES).toHaveLength(44);
    expect(new Set(GENERIC_OPERATION_NAMES).size).toBe(44);
  });
});

describe("REST_ONLY_OPERATION_NAMES", () => {
  it("names exactly the two select-option operations", () => {
    expect([...REST_ONLY_OPERATION_NAMES]).toEqual(["property.option.add", "property.option.update"]);
  });
});

describe("select-option input schemas (issue #1699)", () => {
  const propertyId = "11111111-1111-4111-8111-111111111111";

  it("trims the label and writes the color in upper case", () => {
    expect(schemas.PropertyOptionAddInputSchema.parse({ propertyId, label: "  Bylinky  ", color: "#34c759" })).toEqual({
      propertyId,
      label: "Bylinky",
      color: "#34C759",
    });
    expect(
      schemas.PropertyOptionUpdateInputSchema.parse({ propertyId, key: "bylinky", label: " Herbs ", color: "#ff9500" }),
    ).toEqual({ propertyId, key: "bylinky", label: "Herbs", color: "#FF9500" });
  });

  it("accepts a label of 60 characters and an update that names only a color or only a label", () => {
    const label = "a".repeat(60);
    expect(schemas.PropertyOptionAddInputSchema.parse({ propertyId, label })).toEqual({ propertyId, label });
    expect(schemas.PropertyOptionUpdateInputSchema.parse({ propertyId, key: "a", color: "#000000" })).toEqual({
      propertyId,
      key: "a",
      color: "#000000",
    });
    expect(schemas.PropertyOptionUpdateInputSchema.parse({ propertyId, key: "a", label })).toEqual({
      propertyId,
      key: "a",
      label,
    });
  });

  it("accepts a label whose surrogates are all paired, up to 60 UTF-16 code units", () => {
    // U+1F48A, one character outside the Basic Multilingual Plane: a high surrogate followed by its low surrogate.
    const pill = String.fromCodePoint(0x1f48a);
    const label = pill.repeat(30);
    expect(label).toHaveLength(60);
    expect(schemas.PropertyOptionAddInputSchema.parse({ propertyId, label })).toEqual({ propertyId, label });
    expect(schemas.PropertyOptionUpdateInputSchema.parse({ propertyId, key: "a", label: `Pills ${pill}` })).toEqual({
      propertyId,
      key: "a",
      label: `Pills ${pill}`,
    });
  });

  it.each([
    ["an empty label", { propertyId, label: "" }, "label"],
    ["a label of only whitespace", { propertyId, label: "   " }, "label"],
    ["a label of 61 characters", { propertyId, label: "a".repeat(61) }, "label"],
    ["a label that holds U+0000", { propertyId, label: "Byl\u0000inky" }, "label"],
    ["a label of 60 code units cut inside a surrogate pair", { propertyId, label: `${"a".repeat(59)}\ud83d` }, "label"],
    ["a label that holds a low surrogate without its pair", { propertyId, label: "\udc8a Bylinky" }, "label"],
    ["a missing label", { propertyId }, "label"],
    ["a color that is not #RRGGBB", { propertyId, label: "Bylinky", color: "green" }, "color"],
    ["a property id that is not a UUID", { propertyId: "tags", label: "Bylinky" }, "propertyId"],
    ["a caller-chosen key", { propertyId, label: "Bylinky", key: "herbs" }, ""],
  ])("refuses an add with %s", (_label, input, field) => {
    const parsed = schemas.PropertyOptionAddInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join(".")).toBe(field);
  });

  it.each([
    ["an empty key", { propertyId, key: "", label: "Herbs" }, "key"],
    ["a label of 61 characters", { propertyId, key: "bylinky", label: "a".repeat(61) }, "label"],
    ["a label that holds U+0000", { propertyId, key: "bylinky", label: "Her\u0000bs" }, "label"],
    ["a label that is one high surrogate without its pair", { propertyId, key: "bylinky", label: "\ud83d" }, "label"],
    [
      "a label that ends in a low surrogate without its pair",
      { propertyId, key: "bylinky", label: "Herbs \udc8a" },
      "label",
    ],
    ["a color that is not #RRGGBB", { propertyId, key: "bylinky", color: "#12345" }, "color"],
    ["a property id that is not a UUID", { propertyId: "tags", key: "bylinky", label: "Herbs" }, "propertyId"],
  ])("refuses an update with %s", (_label, input, field) => {
    const parsed = schemas.PropertyOptionUpdateInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join(".")).toBe(field);
  });
});

describe("GENERIC_OPERATION_BINDINGS", () => {
  it("has exactly the 44 catalog rows and no others", () => {
    expect(Object.keys(GENERIC_OPERATION_BINDINGS).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  });

  it.each(GENERIC_OPERATION_NAMES)("'%s' uses its named schema and calls the named port method", async (name) => {
    const binding = GENERIC_OPERATION_BINDINGS[name];
    const expected = EXPECTED_ROWS[name];
    expect(binding.input).toBe(expected.schema);

    const calls: Array<{ method: string; args: unknown[] }> = [];
    const service = new Proxy(
      {},
      {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return Promise.resolve("sentinel-result");
          };
        },
      },
    ) as unknown as GenericApplicationPort;

    const actor = { userId: "actor-1" };
    const input = {};
    const result = await binding.invoke(service, actor, input as never);

    expect(calls).toEqual([{ method: expected.method, args: [actor, input] }]);
    expect(result).toBe("sentinel-result");
  });
});

describe("RISK_CLASSES", () => {
  it("is the closed set of six classes", () => {
    expect([...RISK_CLASSES]).toEqual(["unclassified", "read", "write", "destructive", "outbound", "breaksLink"]);
  });

  it("isRiskClass accepts exactly the six values", () => {
    for (const value of RISK_CLASSES) expect(isRiskClass(value)).toBe(true);
    for (const value of ["", "low", "high", "moderate", "Read", "destructive ", "breakslink"]) {
      expect(isRiskClass(value)).toBe(false);
    }
  });

  it("classifies every operation: reads read, approval-gated destructive, others write", () => {
    for (const name of GENERIC_OPERATION_NAMES) {
      const metadata = OPERATION_METADATA[name];
      if (metadata.requiresApproval) expect(metadata.riskClass).toBe("destructive");
      else if (metadata.requiresCapability.endsWith(".read")) expect(metadata.riskClass).toBe("read");
      else expect(metadata.riskClass).toBe("write");
    }
  });
});

describe("OPERATION_METADATA", () => {
  it.each(GENERIC_OPERATION_NAMES)("'%s' carries the exact capability/approval/riskClass metadata", (name) => {
    expect(OPERATION_METADATA[name]).toEqual(EXPECTED_METADATA[name]);
  });
});

describe("deriveApprovalRiskLevel", () => {
  const cases: Array<[string, Parameters<typeof deriveApprovalRiskLevel>[0], string]> = [
    ["item.delete", { riskClass: "destructive", operationName: "item.delete" }, "write"],
    ["database.archive", { riskClass: "destructive", operationName: "database.archive" }, "write"],
    ["property.delete", { riskClass: "destructive", operationName: "property.delete" }, "irreversible"],
    ["view.delete", { riskClass: "destructive", operationName: "view.delete" }, "irreversible"],
    ["relation.delete", { riskClass: "destructive", operationName: "relation.delete" }, "irreversible"],
    ["page.restoreVersion", { riskClass: "destructive", operationName: "page.restoreVersion" }, "write"],
    ["MCP destructive tool", { riskClass: "destructive" }, "irreversible"],
    ["destructive unknown operation name", { riskClass: "destructive", operationName: "toString" }, "irreversible"],
    ["outbound tool", { riskClass: "outbound" }, "outbound"],
    ["breaksLink request", { riskClass: "breaksLink" }, "breaksLink"],
    ["write", { riskClass: "write" }, "write"],
    ["read", { riskClass: "read" }, "write"],
    ["unclassified", { riskClass: "unclassified" }, "write"],
  ];
  it.each(cases)("%s", (_label, input, expected) => {
    expect(deriveApprovalRiskLevel(input)).toBe(expected);
  });
});
