import { describe, expect, it } from "vitest";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { GENERIC_OPERATION_BINDINGS, GENERIC_OPERATION_NAMES, operationInputJsonSchema } from "@semprec/shared";
import { boundGatewayImagePayload } from "../modelComposition.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const relation = { type: "relation_path_contains", path: ["project", "area"], value: uuid };
const nested = (depth: number): unknown => (depth === 0 ? relation : { type: "not", node: nested(depth - 1) });

describe.each(["database.query", "view.query"] as const)("%s compact agent schema", (operation) => {
  const schema = operationInputJsonSchema(operation, "agent-query-compact");
  const tool = { name: "query", description: "query", parameters: Type.Unsafe(schema) };
  const before = {
    name: "query",
    description: "query",
    parameters: Type.Unsafe(GENERIC_OPERATION_BINDINGS[operation].input.toJSONSchema({ io: "input", reused: "ref" })),
  };
  const identity = operation === "database.query" ? { databaseId: "db1" } : { viewId: "view1" };
  const validate = (args: Record<string, unknown>): unknown =>
    validateToolArguments(tool, { type: "toolCall", id: "test", name: "query", arguments: args });
  const validateBefore = (args: Record<string, unknown>): unknown =>
    validateToolArguments(before, { type: "toolCall", id: "test", name: "query", arguments: args });

  it("validates real generated pointers and preserves the input's optional fields", () => {
    const input = { ...identity, filter: nested(8), sort: [{ property: "name", direction: "asc" }], limit: 10 };
    expect(GENERIC_OPERATION_BINDINGS[operation].input.safeParse(input).success).toBe(true);
    expect(validate(input)).toEqual(input);
    expect(validateBefore(input)).toEqual(input);
    expect(validate(identity)).toEqual(identity);
    expect(validateBefore(identity)).toEqual(identity);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(20_000);
  });

  it.each([
    ["too deep", { filter: nested(9) }],
    ["empty path", { filter: { ...relation, path: [] } }],
    ["short path", { filter: { ...relation, path: ["project"] } }],
    ["long path", { filter: { ...relation, path: ["project", "area", "extra"] } }],
    ["empty key", { filter: { ...relation, path: ["", "area"] } }],
    ["invalid UUID", { filter: { ...relation, value: "bad" } }],
    ["wrong type", { filter: { ...relation, path: "project.area" } }],
    ["extra leaf", { filter: { ...relation, extra: true } }],
    ["extra root", { extra: true }],
    ["empty group", { filter: { type: "and", nodes: [] } }],
    ["group overflow", { filter: { type: "or", nodes: Array.from({ length: 21 }, () => relation) } }],
    ["bad sort", { sort: [{ property: "name", direction: "sideways" }] }],
  ])("rejects %s through both actual validators", (_name, extra) => {
    const input = { ...identity, ...extra };
    expect(GENERIC_OPERATION_BINDINGS[operation].input.safeParse(input).success).toBe(false);
    expect(() => validate(input)).toThrow();
    expect(() => validateBefore(input)).toThrow();
  });

  it("accepts bounded group fanout and scalar filter branches", () => {
    for (const filter of [
      { type: "and", nodes: Array.from({ length: 20 }, () => relation) },
      { type: "or", nodes: [relation] },
      { type: "equals", property: "name", value: "x" },
      { type: "is_empty", property: "name" },
    ]) {
      const input = { ...identity, filter };
      expect(GENERIC_OPERATION_BINDINGS[operation].input.safeParse(input).success).toBe(true);
      expect(validate(input)).toEqual(input);
      expect(validateBefore(input)).toEqual(input);
    }
  });

  it("retains pi coercion and the authoritative Zod-only range refinement", () => {
    const coerced = { ...identity, limit: "10" };
    expect(GENERIC_OPERATION_BINDINGS[operation].input.safeParse(coerced).success).toBe(false);
    expect(validate(coerced)).toEqual({ ...identity, limit: 10 });
    expect(validateBefore(coerced)).toEqual({ ...identity, limit: 10 });
    const reversedRange = {
      ...identity,
      filter: { type: "date_relative", property: "date", preset: { fromDays: 2, toDays: 1 } },
    };
    expect(GENERIC_OPERATION_BINDINGS[operation].input.safeParse(reversedRange).success).toBe(false);
    expect(validate(reversedRange)).toEqual(reversedRange);
    expect(validateBefore(reversedRange)).toEqual(reversedRange);
  });
});

describe("item.count agent schema", () => {
  const schema = operationInputJsonSchema("item.count");
  const tool = { name: "count", description: "count", parameters: Type.Unsafe(schema) };
  const databaseId = "22222222-2222-4222-8222-222222222222";
  const validate = (args: Record<string, unknown>): unknown =>
    validateToolArguments(tool, { type: "toolCall", id: "test", name: "count", arguments: args });

  it("validates real generated pointers through the pi validator, for one and for twenty entries", () => {
    const entry = { databaseId, filter: nested(8), groupBy: "project", collection: true };
    const single = { items: [entry] };
    expect(GENERIC_OPERATION_BINDINGS["item.count"].input.safeParse(single).success).toBe(true);
    expect(validate(single)).toEqual(single);
    const full = { items: Array.from({ length: 20 }, () => ({ databaseId })) };
    expect(validate(full)).toEqual(full);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(20_000);
  });

  it.each([
    ["no entries", { items: [] }],
    ["twenty-one entries", { items: Array.from({ length: 21 }, () => ({ databaseId })) }],
    ["a too deep filter", { items: [{ databaseId, filter: nested(9) }] }],
    ["a short relation path", { items: [{ databaseId, filter: { ...relation, path: ["project"] } }] }],
    ["a group overflow", { items: [{ databaseId, filter: { type: "or", nodes: Array(21).fill(relation) } }] }],
    ["an empty groupBy", { items: [{ databaseId, groupBy: "" }] }],
    ["an extra entry key", { items: [{ databaseId, inTrash: true }] }],
    ["an extra root key", { items: [{ databaseId }], extra: true }],
    ["a missing database", { items: [{ groupBy: "project" }] }],
  ])("rejects %s through both actual validators", (_name, input) => {
    expect(GENERIC_OPERATION_BINDINGS["item.count"].input.safeParse(input).success).toBe(false);
    expect(() => validate(input)).toThrow();
  });
});

describe("database.facets agent schema", () => {
  const schema = operationInputJsonSchema("database.facets");
  const tool = { name: "facets", description: "facets", parameters: Type.Unsafe(schema) };
  const databaseId = "22222222-2222-4222-8222-222222222222";
  const validate = (args: Record<string, unknown>): unknown =>
    validateToolArguments(tool, { type: "toolCall", id: "test", name: "facets", arguments: args });

  it("validates real generated pointers through the pi validator, for the filter, the open filter and twenty facets", () => {
    const full = {
      databaseId,
      filter: nested(8),
      facets: ["status", { path: ["project", "area"] }],
      extra: { open: nested(8) },
    };
    expect(GENERIC_OPERATION_BINDINGS["database.facets"].input.safeParse(full).success).toBe(true);
    expect(validate(full)).toEqual(full);
    const many = { databaseId, facets: Array.from({ length: 20 }, (_, index) => `property${index}`) };
    expect(validate(many)).toEqual(many);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(20_000);
  });

  it.each([
    ["no facets", { databaseId, facets: [] }],
    ["twenty-one facets", { databaseId, facets: Array.from({ length: 21 }, (_, index) => `property${index}`) }],
    ["a missing facet list", { databaseId }],
    ["a missing database", { facets: ["status"] }],
    ["an empty facet key", { databaseId, facets: [""] }],
    ["a path of one key", { databaseId, facets: [{ path: ["project"] }] }],
    ["a path of three keys", { databaseId, facets: [{ path: ["project", "area", "name"] }] }],
    ["a too deep filter", { databaseId, facets: ["status"], filter: nested(9) }],
    ["a too deep open filter", { databaseId, facets: ["status"], extra: { open: nested(9) } }],
    ["a group overflow", { databaseId, facets: ["status"], filter: { type: "or", nodes: Array(21).fill(relation) } }],
    ["an extra without an open filter", { databaseId, facets: ["status"], extra: {} }],
    ["an extra root key", { databaseId, facets: ["status"], q: "text" }],
  ])("rejects %s through both actual validators", (_name, input) => {
    expect(GENERIC_OPERATION_BINDINGS["database.facets"].input.safeParse(input).success).toBe(false);
    expect(() => validate(input)).toThrow();
  });
});

it("fits the actual complete catalog payload without dropping tools and retains the strict guard", () => {
  const tools = GENERIC_OPERATION_NAMES.map((operation) => ({
    name: operation,
    parameters:
      operation === "database.query" || operation === "view.query"
        ? operationInputJsonSchema(operation, "agent-query-compact")
        : operationInputJsonSchema(operation),
  }));
  const payload = { context: { systemPrompt: "test", tools, messages: [{ role: "user", content: "test" }] } };
  expect(boundGatewayImagePayload(payload)).toBe(payload);
  expect(tools).toHaveLength(GENERIC_OPERATION_NAMES.length);
  const size = Buffer.byteLength(JSON.stringify(payload));
  expect(size).toBeLessThan(4 * 1024 * 1024);
  const build = (length: number) => ({ context: { tools, messages: [{ role: "user", content: "x".repeat(length) }] } });
  const overhead = Buffer.byteLength(JSON.stringify(build(0)));
  const below = build(4 * 1024 * 1024 - overhead - 1);
  const exact = build(4 * 1024 * 1024 - overhead);
  expect(Buffer.byteLength(JSON.stringify(below))).toBe(4 * 1024 * 1024 - 1);
  expect(boundGatewayImagePayload(below)).toBe(below);
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(4 * 1024 * 1024);
  expect(() => boundGatewayImagePayload(exact)).toThrow("Gateway request exceeds the size limit");
});
