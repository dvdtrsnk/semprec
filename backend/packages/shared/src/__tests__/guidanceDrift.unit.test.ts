import { describe, expect, it } from "vitest";
import {
  fingerprintGuidanceDriftSubject,
  validateGuidanceDriftContradiction,
  type GuidanceDriftSubject,
} from "../guidanceDrift.js";

const PERMISSION: GuidanceDriftSubject = { operation: "files.delete", databaseId: "db-1" };

describe("fingerprintGuidanceDriftSubject", () => {
  it("is deterministic and a lowercase hex SHA-256 digest", () => {
    const fingerprint = fingerprintGuidanceDriftSubject("p1", "permission", PERMISSION);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintGuidanceDriftSubject("p1", "permission", { ...PERMISSION })).toBe(fingerprint);
  });

  it("does not depend on subject field order", () => {
    const reordered: GuidanceDriftSubject = { databaseId: "db-1", operation: "files.delete" };
    expect(fingerprintGuidanceDriftSubject("p1", "permission", reordered)).toBe(
      fingerprintGuidanceDriftSubject("p1", "permission", PERMISSION),
    );
  });

  it("differs when the project, kind, operation, MCP tool or database differs", () => {
    const base = fingerprintGuidanceDriftSubject("p1", "permission", PERMISSION);
    const others = [
      fingerprintGuidanceDriftSubject("p2", "permission", PERMISSION),
      fingerprintGuidanceDriftSubject("p1", "behavior", PERMISSION),
      fingerprintGuidanceDriftSubject("p1", "permission", { ...PERMISSION, operation: "files.read" }),
      fingerprintGuidanceDriftSubject("p1", "permission", { ...PERMISSION, databaseId: "db-2" }),
      fingerprintGuidanceDriftSubject("p1", "permission", { ...PERMISSION, databaseId: null }),
      fingerprintGuidanceDriftSubject("p1", "behavior", { mcpTool: "files.delete", databaseId: "db-1" }),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe("validateGuidanceDriftContradiction", () => {
  const LEGACY = {
    claim: "The agent may delete files.",
    guidanceExcerpt: "Agents can delete any file.",
    manifestFacts: ["files.delete requires approval"],
    severity: "blocking",
  };

  it("reads a payload without kind as a permission finding with no subject", () => {
    expect(validateGuidanceDriftContradiction(LEGACY, "row")).toEqual({
      ...LEGACY,
      kind: "permission",
      subject: null,
    });
  });

  it("keeps a valid kind and subject", () => {
    const subject = { operation: "files.delete", databaseId: null };
    expect(validateGuidanceDriftContradiction({ ...LEGACY, kind: "permission", subject }, "row")).toMatchObject({
      kind: "permission",
      subject,
    });
  });

  it("rejects an unknown kind and a malformed subject", () => {
    expect(() => validateGuidanceDriftContradiction({ ...LEGACY, kind: "other" }, "row")).toThrow(/kind/);
    expect(() => validateGuidanceDriftContradiction({ ...LEGACY, subject: "x" }, "row")).toThrow(/subject/);
    expect(() =>
      validateGuidanceDriftContradiction({ ...LEGACY, subject: { operation: "", databaseId: null } }, "row"),
    ).toThrow(/operation/);
    expect(() =>
      validateGuidanceDriftContradiction({ ...LEGACY, subject: { operation: "a", databaseId: 3 } }, "row"),
    ).toThrow(/databaseId/);
  });
});
