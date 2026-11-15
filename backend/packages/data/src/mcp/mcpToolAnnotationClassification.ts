import type { RiskClass } from "@semprec/shared";

/** The three boolean hints of an MCP tool's `annotations` that choose a default classification. */
export interface McpToolAnnotationHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** The default `risk_class` and `requires_approval` of a tool registration. */
export interface McpToolClassification {
  riskClass: RiskClass;
  requiresApproval: boolean;
}

/**
 * Derives a tool's default classification from the annotations its server advertised. Annotations are hints,
 * not guarantees, so the result only chooses the default of a registration whose classification no person set.
 *
 * `null` is a tool that advertised no annotations object: it stays `unclassified` and asks for approval. For a
 * present object the first matching rule wins:
 *
 * 1. `readOnlyHint` true: `read`, no approval.
 * 2. `destructiveHint` not explicitly false (the MCP default is true): `destructive`, approval.
 * 3. `openWorldHint` explicitly true: `outbound`, approval. An absent value does not count, although the MCP
 *    default is also true, because nearly every tool would then be `outbound`.
 * 4. Otherwise `write`, approval.
 *
 * So `outbound` and `write` need `destructiveHint` explicitly false. A present object with no `destructiveHint`
 * (`{}`, a title only, or `{ openWorldHint: true }` alone) is `destructive`, which is also what the issue's
 * mapping says although its first acceptance criterion words "only `openWorldHint: true`" as `outbound`.
 */
export function classifyMcpToolFromAnnotations(hints: McpToolAnnotationHints | null): McpToolClassification {
  if (hints === null) return { riskClass: "unclassified", requiresApproval: true };
  if (hints.readOnlyHint === true) return { riskClass: "read", requiresApproval: false };
  if (hints.destructiveHint !== false) return { riskClass: "destructive", requiresApproval: true };
  if (hints.openWorldHint === true) return { riskClass: "outbound", requiresApproval: true };
  return { riskClass: "write", requiresApproval: true };
}
