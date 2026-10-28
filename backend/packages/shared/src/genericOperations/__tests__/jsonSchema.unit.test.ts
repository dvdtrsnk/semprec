import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GENERIC_OPERATION_BINDINGS } from "../bindings.js";
import { operationInputJsonSchema } from "../jsonSchema.js";
import { validationIssueField } from "../validationIssueField.js";

const objectSchema = z.record(z.string(), z.unknown());
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
