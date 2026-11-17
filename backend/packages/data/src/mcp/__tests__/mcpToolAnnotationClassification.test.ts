import { describe, expect, it } from "vitest";
import { isRiskClass } from "@semprec/shared";
import {
  classifyMcpToolFromAnnotations,
  type McpToolAnnotationHints,
  type McpToolClassification,
} from "../mcpToolAnnotationClassification.js";

const UNCLASSIFIED: McpToolClassification = { riskClass: "unclassified", requiresApproval: true };
const READ: McpToolClassification = { riskClass: "read", requiresApproval: false };
const DESTRUCTIVE: McpToolClassification = { riskClass: "destructive", requiresApproval: true };
const OUTBOUND: McpToolClassification = { riskClass: "outbound", requiresApproval: true };
const WRITE: McpToolClassification = { riskClass: "write", requiresApproval: true };

describe("classifyMcpToolFromAnnotations (issue gh-1979)", () => {
  const table: [string, McpToolAnnotationHints | null, McpToolClassification][] = [
    ["no annotations object", null, UNCLASSIFIED],
    ["readOnlyHint true", { readOnlyHint: true }, READ],
    ["readOnlyHint true wins over destructiveHint true", { readOnlyHint: true, destructiveHint: true }, READ],
    ["readOnlyHint true wins over openWorldHint true", { readOnlyHint: true, openWorldHint: true }, READ],
    [
      "readOnlyHint false, destructiveHint absent: the MCP default is destructive",
      { readOnlyHint: false },
      DESTRUCTIVE,
    ],
    ["an annotations object with no hint at all: the MCP default is destructive", {}, DESTRUCTIVE],
    [
      // Rule 2 precedes rule 3 and an absent destructiveHint is the MCP default true, so outbound needs destructiveHint
      // explicitly false (the row after the next).
      "only openWorldHint true: the MCP default of destructiveHint (true) wins over it",
      { openWorldHint: true },
      DESTRUCTIVE,
    ],
    ["destructiveHint true", { destructiveHint: true }, DESTRUCTIVE],
    ["destructiveHint true wins over openWorldHint true", { destructiveHint: true, openWorldHint: true }, DESTRUCTIVE],
    ["destructiveHint false and openWorldHint true", { destructiveHint: false, openWorldHint: true }, OUTBOUND],
    ["destructiveHint false and openWorldHint false", { destructiveHint: false, openWorldHint: false }, WRITE],
    [
      "destructiveHint false and openWorldHint absent: an absent value is not outbound",
      { destructiveHint: false },
      WRITE,
    ],
    ["readOnlyHint false, destructiveHint false", { readOnlyHint: false, destructiveHint: false }, WRITE],
  ];

  it.each(table)("%s", (_name, hints, expected) => {
    expect(classifyMcpToolFromAnnotations(hints)).toEqual(expected);
  });

  it("only ever yields a class of the closed set of risk classes", () => {
    for (const [, hints] of table) {
      expect(isRiskClass(classifyMcpToolFromAnnotations(hints).riskClass)).toBe(true);
    }
  });
});
