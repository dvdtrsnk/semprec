import { z } from "zod";
import { GENERIC_OPERATION_BINDINGS } from "./bindings.js";
import type { GenericOperationName } from "./operationNames.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Move generated definitions under the top-level property `holder`, which the native tool projection
 * preserves, and point every local reference at them there.
 */
function shareLocalDefinitions(schema: Record<string, unknown>, holder: "filter" | "items"): Record<string, unknown> {
  const properties = schema.properties;
  const definitions = schema.$defs;
  const holderSchema = isRecord(properties) ? properties[holder] : undefined;
  if (
    schema.type !== "object" ||
    !isRecord(holderSchema) ||
    !isRecord(definitions) ||
    Object.hasOwn(holderSchema, "$defs") ||
    Object.keys(definitions).length === 0
  )
    throw new Error("Unsupported generated query schema");

  const checkedDefinitions = definitions;
  const dependencies = new Map<string, Set<string>>();
  const seen = new Set<object>();
  let visited = 0;
  function visit(value: unknown, owner: string | undefined, depth: number): void {
    if (typeof value !== "object" || value === null) return;
    if (++visited > 10_000 || depth > 128 || seen.has(value)) throw new Error("Unsupported generated query schema");
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (["$id", "$anchor", "$dynamicAnchor", "$dynamicRef"].includes(key))
        throw new Error("Unsupported generated query schema");
      if (key === "$defs" && value !== schema) throw new Error("Unsupported generated query schema");
      if (key === "$ref") {
        if (typeof entry !== "string" || !/^#\/\$defs\/(?:[^/~]|~[01])+$/.test(entry))
          throw new Error("Unsupported generated query schema reference");
        const encoded = entry.slice("#/$defs/".length);
        const target = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!Object.hasOwn(checkedDefinitions, target) || !isRecord(checkedDefinitions[target]))
          throw new Error("Unsupported generated query schema reference");
        if (owner) dependencies.get(owner)?.add(target);
        if (!isRecord(value)) throw new Error("Unsupported generated query schema");
        value[key] = `#/properties/${holder}/$defs/${encoded}`;
      } else if (key === "$defs" && value === schema) {
        for (const [name, definition] of Object.entries(checkedDefinitions)) {
          if (!isRecord(definition)) throw new Error("Unsupported generated query schema");
          dependencies.set(name, new Set());
          visit(definition, name, depth + 1);
        }
      } else {
        visit(entry, owner, depth + 1);
      }
    }
    seen.delete(value);
  }
  visit(schema, undefined, 0);
  const active = new Set<string>();
  const checked = new Set<string>();
  function check(name: string): void {
    if (active.has(name)) throw new Error("Unsupported cyclic query schema");
    if (checked.has(name)) return;
    active.add(name);
    for (const target of dependencies.get(name) ?? []) check(target);
    active.delete(name);
    checked.add(name);
  }
  for (const name of dependencies.keys()) check(name);
  holderSchema.$defs = definitions;
  delete schema.$defs;
  return schema;
}

/**
 * The JSON Schema MCP `tools/list` advertises for an operation, derived from the same Zod schema `tools/call` validates
 * against, so the two cannot drift. `io: "input"` describes what a caller must supply (a `.default()` field is not
 * `required`), not the parsed output.
 *
 * Operations carrying the filter tree in nested positions share local definitions under one property: `item.count`
 * under `properties.items`, `database.facets` (filter in `filter` and again in `extra.open`) under `properties.filter`.
 * Each has one schema and no compact mode.
 */
export function operationInputJsonSchema(
  operation: GenericOperationName,
  mode?: "agent-query-compact",
): Record<string, unknown> {
  const input = GENERIC_OPERATION_BINDINGS[operation].input;
  if (mode) {
    if (operation !== "database.query" && operation !== "view.query")
      throw new Error("Compact agent schema requires a query operation");
    return shareLocalDefinitions(z.toJSONSchema(input, { io: "input", reused: "ref" }), "filter");
  }
  if (operation === "item.count")
    return shareLocalDefinitions(z.toJSONSchema(input, { io: "input", reused: "ref" }), "items");
  if (operation === "database.facets")
    return shareLocalDefinitions(z.toJSONSchema(input, { io: "input", reused: "ref" }), "filter");
  return z.toJSONSchema(input, { io: "input" });
}
