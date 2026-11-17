import { describe, expect, it } from "vitest";
import { assertAcceptableMcpToolSchema, MAX_MCP_TOOL_SCHEMA_BYTES } from "../mcp/mcpToolSchemaPolicy.js";
import { ValidationError } from "../errors.js";

describe("assertAcceptableMcpToolSchema (issue #696)", () => {
  it("accepts a benign object schema with a safe pattern", () => {
    expect(() =>
      assertAcceptableMcpToolSchema({
        type: "object",
        properties: { q: { type: "string", pattern: "^[a-z]+$" } },
      }),
    ).not.toThrow();
  });

  it("accepts a schema with a local $ref", () => {
    expect(() =>
      assertAcceptableMcpToolSchema({
        type: "object",
        properties: { a: { $ref: "#/definitions/a" } },
        definitions: { a: { type: "string" } },
      }),
    ).not.toThrow();
  });

  it("rejects a non-object schema", () => {
    expect(() => assertAcceptableMcpToolSchema("not an object")).toThrow(ValidationError);
    expect(() => assertAcceptableMcpToolSchema(null)).toThrow(ValidationError);
    expect(() => assertAcceptableMcpToolSchema([1, 2, 3])).toThrow(ValidationError);
  });

  it("rejects a schema larger than the maximum byte size", () => {
    const schema = {
      type: "object",
      properties: { big: { type: "string", description: "x".repeat(MAX_MCP_TOOL_SCHEMA_BYTES) } },
    };
    expect(() => assertAcceptableMcpToolSchema(schema)).toThrow(ValidationError);
  });

  it("rejects a remote $ref anywhere in the document", () => {
    const schema = { type: "object", properties: { a: { $ref: "https://evil.example/schema.json" } } };
    expect(() => assertAcceptableMcpToolSchema(schema)).toThrow(ValidationError);
  });

  it("rejects a catastrophic-backtracking pattern", () => {
    const schema = { type: "object", properties: { a: { type: "string", pattern: "(a+)+$" } } };
    expect(() => assertAcceptableMcpToolSchema(schema)).toThrow(ValidationError);
  });

  it("rejects a catastrophic-backtracking patternProperties key", () => {
    const schema = { type: "object", patternProperties: { "(a+)+$": { type: "string" } } };
    expect(() => assertAcceptableMcpToolSchema(schema)).toThrow(ValidationError);
  });

  it("rejects an invalid regular expression pattern", () => {
    const schema = { type: "object", properties: { a: { type: "string", pattern: "(unclosed" } } };
    expect(() => assertAcceptableMcpToolSchema(schema)).toThrow(ValidationError);
  });

  it("rejects a schema nested deeper than the maximum depth without exceeding the byte cap", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 200; i++) {
      schema = { type: "object", properties: { a: schema } };
    }
    expect(() => assertAcceptableMcpToolSchema(schema)).toThrow(ValidationError);
  });
});
