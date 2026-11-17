import safeRegex from "safe-regex";
import { ValidationError } from "../errors.js";

/** The AI gateway applies the same bound to its own caller-supplied schemas. */
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;

/**
 * Far above legitimate nesting but below the V8 stack ceiling, so a maximally nested schema within the byte cap
 * throws a catchable `ValidationError` instead of a `RangeError`.
 */
const MAX_SCHEMA_DEPTH = 64;

function assertNoRemoteRef(node: unknown, path: string, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new ValidationError("MCP tool schema is nested too deeply");
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoRemoteRef(item, `${path}/${index}`, depth + 1));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        throw new ValidationError("MCP tool schema contains a remote $ref");
      }
      assertNoRemoteRef(value, `${path}/${key}`, depth + 1);
    }
  }
}

/** Ajv's recommendation for untrusted schemas. */
function assertPatternsSafe(node: unknown, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new ValidationError("MCP tool schema is nested too deeply");
  }
  if (Array.isArray(node)) {
    node.forEach((item) => assertPatternsSafe(item, depth + 1));
    return;
  }
  if (node === null || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "pattern" && typeof value === "string") {
      assertSafePattern(value);
    }
    if (key === "patternProperties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const pattern of Object.keys(value)) {
        assertSafePattern(pattern);
      }
    }
    assertPatternsSafe(value, depth + 1);
  }
}

function assertSafePattern(pattern: string): void {
  let regExp: RegExp;
  try {
    regExp = new RegExp(pattern, "u");
  } catch {
    throw new ValidationError("MCP tool schema contains an invalid regular expression pattern");
  }
  if (!safeRegex(regExp)) {
    throw new ValidationError("MCP tool schema contains a regular expression pattern that is not provably safe");
  }
}

/**
 * Sync-time gate on an advertised `inputSchema`, before any registration is written. Rejects, with a fixed message
 * that never echoes the schema: a non-object, over `MAX_MCP_TOOL_SCHEMA_BYTES`, any non-local ``, a
 * `pattern`/`patternProperties` regex that is invalid or not provably backtracking-safe (`safe-regex`), or nesting
 * beyond `MAX_SCHEMA_DEPTH`. Otherwise a compile or validate could hang the agents process or make Ajv fetch an
 * attacker-controlled reference.
 */
export function assertAcceptableMcpToolSchema(schema: unknown): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ValidationError("MCP tool schema must be a JSON object");
  }

  const serializedSize = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (serializedSize > MAX_MCP_TOOL_SCHEMA_BYTES) {
    throw new ValidationError(`MCP tool schema exceeds the maximum size of ${MAX_MCP_TOOL_SCHEMA_BYTES} bytes`);
  }

  assertNoRemoteRef(schema, "#");
  assertPatternsSafe(schema);
}
