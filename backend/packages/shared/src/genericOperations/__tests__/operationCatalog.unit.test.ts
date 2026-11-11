import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "../operationNames.js";
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
  it("has exactly 42 entries with no duplicates", () => {
    expect(GENERIC_OPERATION_NAMES).toHaveLength(42);
    expect(new Set(GENERIC_OPERATION_NAMES).size).toBe(42);
  });
});

describe("GENERIC_OPERATION_BINDINGS", () => {
  it("has exactly the 42 catalog rows and no others", () => {
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
