import safeRegex from "safe-regex";
import { ValidationError } from "../errors.js";

/**
 * Issue #696: an MCP server's `tools/list` `inputSchema` is untrusted input — the AI gateway
 * applies the same bound to its own caller-supplied schemas (`schemaValidation.ts`,
 * `MAX_RESPONSE_SCHEMA_BYTES`).
 */
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;

/**
 * Far above any legitimate JSON Schema's nesting depth, but well short of the V8 call-stack
 * ceiling — bounds `assertNoRemoteRef`/`assertPatternsSafe` recursion so a maximally nested
 * schema within `MAX_MCP_TOOL_SCHEMA_BYTES` (e.g. `{"a":{"a":{...}}}`, ~10 900 levels) throws a
 * catchable `ValidationError` instead of a `RangeError: Maximum call stack size exceeded`.
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

/** Ajv's own recommendation for untrusted schemas: reject a `pattern`/`patternProperties` regex that isn't provably safe from catastrophic backtracking. */
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
 * Sync-time gate (issue #696) on a remote MCP server's advertised `inputSchema`, called by
 * `mcpSync.ts`'s `validateListedTools` before any registration is written. Throws
 * `ValidationError` with a fixed, secret-free message — never echoing the schema itself, which
 * originates from a not-fully-trusted server — when the schema:
 *
 * - is not a plain object;
 * - serializes to more than `MAX_MCP_TOOL_SCHEMA_BYTES`;
 * - contains a `$ref` anywhere that does not resolve locally (does not start with `#`);
 * - contains a `pattern` or `patternProperties` key whose regular expression is invalid or not
 *   provably safe from catastrophic backtracking (`safe-regex`);
 * - nests more than `MAX_SCHEMA_DEPTH` levels deep.
 *
 * A schema that fails any of these checks would otherwise let a compile or a validate call hang
 * the agents process (`mcpInvokeTool.ts`'s `validateArguments`) or make Ajv attempt to resolve an
 * attacker-controlled remote reference.
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
