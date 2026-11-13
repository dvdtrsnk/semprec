import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GENERIC_OPERATION_BINDINGS } from "../bindings.js";
import { operationInputJsonSchema } from "../jsonSchema.js";
import { validationIssueField } from "../validationIssueField.js";
import { GENERIC_OPERATION_NAMES } from "../operationNames.js";

const objectSchema = z.record(z.string(), z.unknown());
it("advertises a nonempty strict database patch", () => {
  const root = operationInputJsonSchema("database.patch");
  const patch = objectSchema.parse(objectSchema.parse(root.properties).patch);
  expect(patch).toMatchObject({ type: "object", minProperties: 1, additionalProperties: false });
});
it("advertises overviewHidden as an optional boolean of the database patch (issue #2002)", () => {
  const root = operationInputJsonSchema("database.patch");
  const patch = objectSchema.parse(objectSchema.parse(root.properties).patch);
  expect(objectSchema.parse(patch.properties).overviewHidden).toEqual({ type: "boolean" });
  expect(z.array(z.string()).optional().parse(patch.required) ?? []).not.toContain("overviewHidden");
});
const value = "11111111-1111-4111-8111-111111111111";
const validLeaf = { type: "relation_path_contains", path: ["project", "area"], value };
const invalidLeaves = [
  { name: "missing path and value", leaf: { type: validLeaf.type } },
  { name: "missing path", leaf: { type: validLeaf.type, value } },
  { name: "missing value", leaf: { type: validLeaf.type, path: validLeaf.path } },
  { name: "empty path", leaf: { ...validLeaf, path: [] } },
  { name: "short path", leaf: { ...validLeaf, path: ["project"] } },
  { name: "long path", leaf: { ...validLeaf, path: ["project", "area", "extra"] } },
  { name: "non-array path", leaf: { ...validLeaf, path: "project.area" } },
  { name: "empty first key", leaf: { ...validLeaf, path: ["", "area"] } },
  { name: "empty second key", leaf: { ...validLeaf, path: ["project", ""] } },
  { name: "non-string first key", leaf: { ...validLeaf, path: [0, "area"] } },
  { name: "non-string second key", leaf: { ...validLeaf, path: ["project", null] } },
  { name: "invalid UUID", leaf: { ...validLeaf, value: "not-a-uuid" } },
  { name: "non-string UUID", leaf: { ...validLeaf, value: 123 } },
  { name: "extra field", leaf: { ...validLeaf, extra: true } },
];

describe.each(["database.query", "view.query"] as const)("%s generated relation-path input", (operation) => {
  const root = operationInputJsonSchema(operation);
  const binding = GENERIC_OPERATION_BINDINGS[operation];
  const identity = operation === "database.query" ? { databaseId: "db1" } : { viewId: "v1" };

  function resolve(input: unknown): Record<string, unknown> {
    const schema = objectSchema.parse(input);
    if (typeof schema.$ref !== "string") return schema;
    expect(schema.$ref).toMatch(/^#\//);
    let target: unknown = root;
    for (const key of schema.$ref.slice(2).split("/")) {
      target = objectSchema.parse(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    return resolve(target);
  }

  function branch(input: unknown, type: string): Record<string, unknown> {
    const found = findBranch(input, type);
    if (found === undefined) throw new Error(`Missing generated filter branch: ${type}`);
    return found;
  }

  function findBranch(input: unknown, type: string): Record<string, unknown> | undefined {
    const schema = resolve(input);
    if (schema.properties !== undefined) {
      const properties = objectSchema.parse(schema.properties);
      if (properties.type !== undefined && resolve(properties.type).const === type) return schema;
    }
    for (const member of z.array(z.unknown()).parse(schema.anyOf ?? [])) {
      const found = findBranch(member, type);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const groups of [[], ["and"], ["or"], ["not", "and", "or"]]) {
    describe(groups.join("/") || "leaf", () => {
      let filterSchema: unknown = objectSchema.parse(root.properties).filter;
      for (const type of groups) {
        const properties = objectSchema.parse(branch(filterSchema, type).properties);
        filterSchema = type === "not" ? properties.node : resolve(properties.nodes).items;
      }
      function wrap(leaf: unknown): unknown {
        let filter = leaf;
        for (const type of [...groups].reverse()) {
          filter = type === "not" ? { type, node: filter } : { type, nodes: [filter] };
        }
        return filter;
      }
      const leaf = branch(filterSchema, "relation_path_contains");
      const properties = objectSchema.parse(leaf.properties);

      it("advertises a strict object requiring type, path and value", () => {
        expect(leaf.type).toBe("object");
        expect(leaf.required).toEqual(["type", "path", "value"]);
        expect(leaf.additionalProperties).toBe(false);
        expect(Object.keys(properties).sort()).toEqual(["path", "type", "value"]);
      });

      it("advertises exactly two nonempty string keys", () => {
        const path = resolve(properties.path);
        expect(path).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
        const keys = z.array(z.unknown()).parse(path.prefixItems).map(resolve);
        expect(keys).toEqual([
          { type: "string", minLength: 1 },
          { type: "string", minLength: 1 },
        ]);
      });

      it("advertises a UUID string with its validation pattern", () => {
        const uuid = resolve(properties.value);
        expect(uuid).toMatchObject({ type: "string", format: "uuid" });
        const pattern = new RegExp(z.string().parse(uuid.pattern));
        expect(pattern.test(value)).toBe(true);
        expect(pattern.test("not-a-uuid")).toBe(false);
        expect(pattern.test("11111111-1111-1111-1111-111111111111")).toBe(false);
      });

      it("accepts the advertised valid input through the real operation binding", () => {
        expect(binding.input.safeParse({ ...identity, filter: wrap(validLeaf) }).success).toBe(true);
      });

      it.each(invalidLeaves)("rejects $name on filter at the operation binding", ({ leaf }) => {
        const parsed = binding.input.safeParse({ ...identity, filter: wrap(leaf) });
        expect(parsed.success).toBe(false);
        if (parsed.success) throw new Error("Expected malformed relation path to fail");
        expect(validationIssueField(parsed.error.issues)).toBe("filter");
      });
    });
  }
});

// Recorded from the unchanged compiled shared generator at the repair base. `page.get` was re-recorded when issue #1678
// added the `markdown` format to its `format` enum (an additive change), and `page.createSubpage` (#1676),
// `page.insert` (#1679), `page.replace` (#1765), `page.changes` (#1680), `page.duplicate` (#1722) and `page.rename`
// (#1725) were recorded when they joined the catalog, and so was `item.count` (#1709), whose one schema shares local definitions, and so were the
// REST-only `property.option.add` and `property.option.update` (#1699), whose schemas no MCP listing advertises.
// `database.patch` was re-recorded when issue #2002 added the optional boolean `overviewHidden` to its patch (an
// additive change). `database.facets` (#1759) was recorded when it joined the catalog; its one schema shares local
// definitions under `properties.filter`.
const defaultHashes: Record<string, string> = {
  "database.list": "630c495e682d0545e7a780bc9b220ca45b18532d028f75c6c53b2e466c900c17",
  "database.get": "a396e67551c443d8954162aff82b55ec5ca6ade7c921a12925cb8a13f6ecbf78",
  "database.create": "064856dd34ac71c38f6a0bd719eceace3430804f25f060feafc2adc7bba1f52c",
  "database.patch": "f8e9f1a5b60509b0b1c03a54ae44b3aeaa164c804974814287dfcd5d11907e3f",
  "database.archive": "a396e67551c443d8954162aff82b55ec5ca6ade7c921a12925cb8a13f6ecbf78",
  "database.restore": "a396e67551c443d8954162aff82b55ec5ca6ade7c921a12925cb8a13f6ecbf78",
  "property.list": "a396e67551c443d8954162aff82b55ec5ca6ade7c921a12925cb8a13f6ecbf78",
  "property.get": "3ec9951c274d2a39f8bcb97e988d1c6db52f925747d827a4c6dc44a6a6009b0a",
  "property.getByKey": "c48b0fc7f5b9821ef4ffe8bfe61f485726ca3a4969e7b62dd1cd6e7424873af3",
  "property.create": "d2e456112e03d6967cdc9ad0500df375c8444fae39dbbffaa3eb02e74b22114d",
  "property.patch": "1849c9f5848ffb08a62f25255e7c81dc7547cd458a486440464b14b960f1f942",
  "property.delete": "3ec9951c274d2a39f8bcb97e988d1c6db52f925747d827a4c6dc44a6a6009b0a",
  "property.option.add": "ef192f416ee0d3847dd865f8df602dc1c449edf6aa87255e59468b1542f7f2f4",
  "property.option.update": "9729f94bc6a8a391595961b6e0facecdfcfe90777136aaaeb57ff5372126fd8a",
  "view.list": "630c495e682d0545e7a780bc9b220ca45b18532d028f75c6c53b2e466c900c17",
  "view.get": "559a12505aff3c7f9f61c27fec8615a10d0416ebccb3801031274c7cacc8c06f",
  "view.create": "b3c015042164623a164a5518c20d6e5994ad15593d408e181bf636cf03fca2db",
  "view.patch": "9ea9bfeb0347d676822308742a8dfc719874fac1934ecc6e25a2cd214873e633",
  "view.delete": "559a12505aff3c7f9f61c27fec8615a10d0416ebccb3801031274c7cacc8c06f",
  "view.query": "cd7522924503fd71de142aace0077b23310d6eb123b6e75c3b7fbb94ff0b5cee",
  "viewItem.add": "7c1a08c7a43834890265f05daa68566b6f3a9ede91f749f1fa9ee1ee0e11869b",
  "viewItem.remove": "735a1c61b7d6a92a7554e2b17bfd21870f0d476552ce489345ebb265ebb605aa",
  "viewItem.reorder": "475435983eaf7460f719e32b3a825a4fa6a51ef95200fb8bee8888b40b15bf2f",
  "item.get": "3f26830e84efba37a3c2fce8a5dd1d9ee8c59773d3342b89ddc3e87bbd0af2ab",
  "item.create": "d4f6a4a0a6913630af1009c740c59bbf4e2f07aa705fd2f3114d8447441671af",
  "item.patch": "c51920e126609bbf7274539ae78f24378dc2fc69617115a62c1311f95da7a9c4",
  "item.delete": "aca85070b3e100d43691feaae3c16695f3b5d298dd304c172556cf791ae2c6bc",
  "item.restore": "aca85070b3e100d43691feaae3c16695f3b5d298dd304c172556cf791ae2c6bc",
  "database.query": "7e288eda2fe8008367e39d4374bd9ca2a71e18a3ea210b5f2d763078bf5a5c29",
  "relation.put": "a5cd0b56db1557899074cc744175bf291a11f3e65bf3c5ec9cfe74bd49a01583",
  "relation.set": "34c432f51073f989eebaf8ed5072e5e77b734f480bc54be9e3996f9ac1e2883f",
  "relation.delete": "5f146bb4d95f59339ba11786dda563a0630e42ec81f66ad3890c183cfb0441ac",
  "relation.list": "5d7b253f36e0c095ac8989134058724e61e9ad85b4379946e3abdb9b40d1188b",
  "page.restoreVersion": "8f4d0d081a4199f72ac2e85fda15d9aaef51dc2db3973929793dcded071473e2",
  "link.unlink": "fea9b8c02ad5d53090ec11bcab522ac5fbe5d990dc04790ef343ada683da248c",
  "link.relink": "fea9b8c02ad5d53090ec11bcab522ac5fbe5d990dc04790ef343ada683da248c",
  "page.get": "f6b7a7f43962cc441e6522563dac68deb4d6f9b26c14c4a75c068dd0628edcfa",
  "page.ensure": "d6c9e966fecd84b2add61a085f59ddf1d655d12d61ad36eff683abb96accb1fb",
  "page.createSubpage": "cc97079ec654aec1f2804c23835b13a78a08edaed8ed7c94813ff2ad0587b9ab",
  "page.insert": "d284651aff522abffd1f21dabefe7ff196fca8e5c028ef37316f3c5d51ea0ac8",
  "page.replace": "f9ebb337c6fffa32c997dbe897847a45c251a851a7ae41d3916c739dd65a9b93",
  "page.changes": "f0ff5e6ad26a100a3ab35d676dcf5541d2a7906700cd94b225623e8f7865a384",
  "item.count": "2b1b1cac530e8917c376fee63e66098c6d8640341935e58b4b38ab14c2ed823f",
  "page.duplicate": "cf496713017be99d4da1acbc5863c5c057e45606f6d644070ca62c6708e990e6",
  "page.rename": "75be99147d9267ad2db8c9a90c6b2b76161ea30b7bbeb18d5a9c45aa41d667cb",
  "database.facets": "235227f7c8f084dacb50f7f510123fec368bc59519700b48202c4cfae366ad56",
};

it("preserves every default operation schema byte for MCP callers", () => {
  expect(Object.keys(defaultHashes).sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
  for (const operation of GENERIC_OPERATION_NAMES) {
    const hash = createHash("sha256")
      .update(JSON.stringify(operationInputJsonSchema(operation)))
      .digest("hex");
    expect(hash, operation).toBe(defaultHashes[operation]);
  }
});

/** Expects `root` to keep its definitions under `properties.<holder>` only, small, with every reference local and resolvable. */
function expectFiniteLocalReferenceGraph(root: Record<string, unknown>, holder: "filter" | "items"): void {
  const properties = objectSchema.parse(root.properties);
  const definitions = objectSchema.parse(objectSchema.parse(properties[holder]).$defs);
  expect(root.$defs).toBeUndefined();
  expect(Object.keys(definitions).length).toBeGreaterThan(0);
  expect(root.additionalProperties).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(root))).toBeLessThan(20_000);
  const pending: unknown[] = [root];
  let references = 0;
  let nodes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    expect(++nodes).toBeLessThan(10_000);
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        const ref = z.string().parse(child);
        expect(ref.startsWith(`#/properties/${holder}/$defs/`)).toBe(true);
        expect(ref.slice(`#/properties/${holder}/$defs/`.length)).toMatch(/^(?:[^/~]|~[01])+$/);
        let target: unknown = root;
        for (const part of ref.slice(2).split("/"))
          target = objectSchema.parse(target)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
        expect(objectSchema.safeParse(target).success).toBe(true);
        references += 1;
      } else if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  expect(references).toBeGreaterThan(0);
}

describe.each(["database.query", "view.query"] as const)("%s compact schema references", (operation) => {
  it("retains a finite, entirely local reference graph under the existing filter", () => {
    expectFiniteLocalReferenceGraph(operationInputJsonSchema(operation, "agent-query-compact"), "filter");
  });
});

it("does not allow compact mode for a non-query operation", () => {
  expect(() => operationInputJsonSchema("database.patch", "agent-query-compact")).toThrow();
  expect(() => operationInputJsonSchema("item.count", "agent-query-compact")).toThrow();
  expect(() => operationInputJsonSchema("database.facets", "agent-query-compact")).toThrow();
});

describe("item.count generated input", () => {
  const root = operationInputJsonSchema("item.count");
  const items = objectSchema.parse(objectSchema.parse(root.properties).items);

  function resolve(input: unknown): Record<string, unknown> {
    const schema = objectSchema.parse(input);
    if (typeof schema.$ref !== "string") return schema;
    let target: unknown = root;
    for (const key of schema.$ref.slice(2).split("/")) {
      target = objectSchema.parse(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    return resolve(target);
  }

  it("keeps a finite, entirely local reference graph under the entry list", () => {
    expectFiniteLocalReferenceGraph(root, "items");
  });

  it("advertises one to twenty strict entries that require only the database", () => {
    expect(root.required).toEqual(["items"]);
    expect(items).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    const entry = resolve(items.items);
    expect(entry).toMatchObject({ type: "object", required: ["databaseId"], additionalProperties: false });
    const properties = objectSchema.parse(entry.properties);
    expect(Object.keys(properties).sort()).toEqual(["collection", "databaseId", "filter", "groupBy"]);
    expect(resolve(properties.groupBy)).toEqual({ type: "string", minLength: 1 });
    expect(resolve(properties.collection)).toEqual({ type: "boolean" });
  });

  it("advertises the entry filter with its and, or and not groups", () => {
    const filter = resolve(objectSchema.parse(resolve(items.items).properties).filter);
    const groups = z
      .array(z.unknown())
      .parse(filter.anyOf)
      .map(resolve)
      .flatMap((member) => {
        const type = member.properties === undefined ? undefined : objectSchema.parse(member.properties).type;
        return type === undefined ? [] : [resolve(type).const];
      });
    expect(groups).toEqual(["and", "or", "not"]);
  });
});

describe("database.facets generated input", () => {
  const root = operationInputJsonSchema("database.facets");
  const properties = objectSchema.parse(root.properties);

  function resolve(input: unknown): Record<string, unknown> {
    const schema = objectSchema.parse(input);
    if (typeof schema.$ref !== "string") return schema;
    let target: unknown = root;
    for (const key of schema.$ref.slice(2).split("/")) {
      target = objectSchema.parse(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    return resolve(target);
  }

  /** The `type` constants of the `and`, `or` and `not` groups a filter schema offers, in order. */
  function groupTypes(filter: Record<string, unknown>): unknown[] {
    return z
      .array(z.unknown())
      .parse(filter.anyOf)
      .map(resolve)
      .flatMap((member) => {
        const type = member.properties === undefined ? undefined : objectSchema.parse(member.properties).type;
        return type === undefined ? [] : [resolve(type).const];
      });
  }

  it("keeps a finite, entirely local reference graph under the filter", () => {
    expectFiniteLocalReferenceGraph(root, "filter");
  });

  it("requires the database and the facets, and offers the filter and the extra open filter", () => {
    expect(root.required).toEqual(["databaseId", "facets"]);
    expect(Object.keys(properties).sort()).toEqual(["databaseId", "extra", "facets", "filter"]);
  });

  it("advertises one to twenty facets, each a property key or a path of exactly two keys", () => {
    const facets = resolve(properties.facets);
    expect(facets).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
    const [key, path] = z.array(z.unknown()).parse(resolve(facets.items).anyOf).map(resolve);
    expect(key).toEqual({ type: "string", minLength: 1 });
    expect(path).toMatchObject({ type: "object", required: ["path"], additionalProperties: false });
    const keys = resolve(objectSchema.parse(path?.properties).path);
    expect(keys).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
    expect(z.array(z.unknown()).parse(keys.prefixItems).map(resolve)).toEqual([
      { type: "string", minLength: 1 },
      { type: "string", minLength: 1 },
    ]);
  });

  it("advertises the same filter tree for the filter and for the open filter of a strict extra", () => {
    const extra = resolve(properties.extra);
    expect(extra).toMatchObject({ type: "object", required: ["open"], additionalProperties: false });
    // Both name one shared definition, so neither carries a copy of the tree.
    const openReference = z.string().parse(objectSchema.parse(objectSchema.parse(extra.properties).open).$ref);
    expect(openReference).toBe(objectSchema.parse(properties.filter).$ref);
    expect(groupTypes(resolve(properties.filter))).toEqual(["and", "or", "not"]);
  });
});
