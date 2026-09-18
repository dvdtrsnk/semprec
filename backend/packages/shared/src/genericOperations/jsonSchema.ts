import { z } from "zod";
import { GENERIC_OPERATION_BINDINGS } from "./bindings.js";
import type { GenericOperationName } from "./operationNames.js";

/**
 * The JSON Schema an MCP `tools/list` response advertises for one operation's real input shape
 * (issue #220) — derived from the same `GENERIC_OPERATION_BINDINGS[operation].input` Zod schema
 * `tools/call` validates against, so the two can never drift apart. `io: "input"` reports what a
 * caller must actually supply (a field with a Zod `.default()` is not `required`), rather than
 * `z.toJSONSchema`'s own default of describing the parsed *output* shape.
 */
export function operationInputJsonSchema(operation: GenericOperationName): Record<string, unknown> {
  return z.toJSONSchema(GENERIC_OPERATION_BINDINGS[operation].input, { io: "input" });
}
