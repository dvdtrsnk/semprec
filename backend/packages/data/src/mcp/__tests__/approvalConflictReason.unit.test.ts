import { describe, expect, it } from "vitest";
import { approvalConflictReason } from "../approvalConflictReason.js";

function genericConflict(details: Record<string, unknown>) {
  return { error: { code: "version_conflict", details } };
}

describe("approvalConflictReason", () => {
  it("returns null unless the request ended in conflict", () => {
    for (const status of ["queued", "succeeded"] as const) {
      expect(approvalConflictReason(status, genericConflict({ reason: "not_found" }))).toBeNull();
    }
  });

  it("maps a generic conflict without a reason to changed", () => {
    expect(approvalConflictReason("conflict", genericConflict({ currentResource: { id: "x" } }))).toEqual({
      key: "approval.conflict.changed",
    });
  });

  it.each([
    ["not_found", "approval.conflict.deleted"],
    ["owner_violation", "approval.conflict.provenanceChanged"],
    ["database_archived", "approval.conflict.archived"],
    ["something_else", "approval.conflict.other"],
  ])("maps generic reason %s to %s", (reason, key) => {
    expect(approvalConflictReason("conflict", genericConflict({ reason }))).toEqual({ key });
  });

  it.each([
    ["toolUnavailable", "approval.conflict.toolUnavailable"],
    ["callFailed", "approval.outcome.failed"],
    ["staleClaim", "approval.conflict.other"],
    ["sourceChanged", "approval.conflict.changed"],
  ])("maps outcome kind %s to %s", (outcomeKind, key) => {
    expect(approvalConflictReason("conflict", { text: "secret text", outcomeKind })).toEqual({ key });
  });

  it("falls back to other for legacy plain-string MCP results and unknown shapes", () => {
    expect(approvalConflictReason("conflict", "old plain text")).toEqual({ key: "approval.conflict.other" });
    expect(approvalConflictReason("conflict", null)).toEqual({ key: "approval.conflict.other" });
    expect(approvalConflictReason("conflict", { text: "x", outcomeKind: "unknown" })).toEqual({
      key: "approval.conflict.other",
    });
  });
});
