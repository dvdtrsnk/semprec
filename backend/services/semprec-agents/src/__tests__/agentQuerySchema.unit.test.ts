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
  const identity = operation === "database.query" ? { databaseId: "db1" } : { viewId: "view1" };
  const validate = (args: Record<string, unknown>): unknown =>
    validateToolArguments(tool, { type: "toolCall", id: "test", name: "query", arguments: args });

  it("validates real generated pointers and preserves the input's optional fields", () => {
    const input = { ...identity, filter: nested(8), sort: [{ property: "name", direction: "asc" }], limit: 10 };
    expect(GENERIC_OPERATION_BINDINGS[operation].input.safeParse(input).success).toBe(true);
    expect(validate(input)).toEqual(input);
    expect(validate(identity)).toEqual(identity);
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
    }
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
