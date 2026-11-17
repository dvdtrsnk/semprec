import type { RiskClass } from "@semprec/shared";

/** The three boolean hints of an MCP tool's `annotations` that choose a default classification. */
export interface McpToolAnnotationHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolClassification {
  riskClass: RiskClass;
  requiresApproval: boolean;
}

/**
 * Annotations are hints, not guarantees, so this only picks the default for a registration no person classified.
 *
 * `null` (no annotations object) stays `unclassified` with approval. Otherwise the first matching rule wins:
 *
 * 1. `readOnlyHint` true: `read`, no approval.
 * 2. `destructiveHint` not explicitly false (the MCP default is true): `destructive`, approval.
 * 3. `openWorldHint` explicitly true: `outbound`, approval. Absent does not count, although the MCP default is
 *    true, because nearly every tool would then be `outbound`.
 * 4. Otherwise `write`, approval.
 *
 * So `outbound` and `write` need `destructiveHint` explicitly false; `{}` or `{ openWorldHint: true }` alone is
 * `destructive`.
 */
export function classifyMcpToolFromAnnotations(hints: McpToolAnnotationHints | null): McpToolClassification {
  if (hints === null) return { riskClass: "unclassified", requiresApproval: true };
  if (hints.readOnlyHint === true) return { riskClass: "read", requiresApproval: false };
  if (hints.destructiveHint !== false) return { riskClass: "destructive", requiresApproval: true };
  if (hints.openWorldHint === true) return { riskClass: "outbound", requiresApproval: true };
  return { riskClass: "write", requiresApproval: true };
}
