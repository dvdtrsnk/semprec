import { describe, expect, it } from "vitest";
import { fingerprintGuidanceDriftContradiction, type GuidanceDriftContradiction } from "../guidanceDrift.js";

const BASE: GuidanceDriftContradiction = {
  claim: "The agent may delete files without approval.",
  guidanceExcerpt: "Agents can delete any file directly.",
  manifestFacts: ["capability.files.delete requires approval", "capability.files.delete owner: system"],
  severity: "blocking",
};

describe("fingerprintGuidanceDriftContradiction", () => {
  it("is deterministic for the same contradiction", () => {
    expect(fingerprintGuidanceDriftContradiction(BASE)).toBe(fingerprintGuidanceDriftContradiction({ ...BASE }));
  });

  it("is invariant to manifestFacts ordering", () => {
    const reordered: GuidanceDriftContradiction = { ...BASE, manifestFacts: [...BASE.manifestFacts].reverse() };
    expect(fingerprintGuidanceDriftContradiction(reordered)).toBe(fingerprintGuidanceDriftContradiction(BASE));
  });

  it("produces a lowercase hex SHA-256 digest", () => {
    expect(fingerprintGuidanceDriftContradiction(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when claim changes", () => {
    const changed: GuidanceDriftContradiction = { ...BASE, claim: "A different claim entirely." };
    expect(fingerprintGuidanceDriftContradiction(changed)).not.toBe(fingerprintGuidanceDriftContradiction(BASE));
  });

  it("changes when guidanceExcerpt changes", () => {
    const changed: GuidanceDriftContradiction = { ...BASE, guidanceExcerpt: "A different excerpt." };
    expect(fingerprintGuidanceDriftContradiction(changed)).not.toBe(fingerprintGuidanceDriftContradiction(BASE));
  });

  it("changes when severity changes", () => {
    const changed: GuidanceDriftContradiction = { ...BASE, severity: "warning" };
    expect(fingerprintGuidanceDriftContradiction(changed)).not.toBe(fingerprintGuidanceDriftContradiction(BASE));
  });

  it("changes when manifestFacts content changes", () => {
    const changed: GuidanceDriftContradiction = { ...BASE, manifestFacts: [...BASE.manifestFacts, "extra fact"] };
    expect(fingerprintGuidanceDriftContradiction(changed)).not.toBe(fingerprintGuidanceDriftContradiction(BASE));
  });

  it("does not collide across a naive string-concatenation boundary", () => {
    const a: GuidanceDriftContradiction = { ...BASE, claim: "ab", guidanceExcerpt: "c" };
    const b: GuidanceDriftContradiction = { ...BASE, claim: "a", guidanceExcerpt: "bc" };
    expect(fingerprintGuidanceDriftContradiction(a)).not.toBe(fingerprintGuidanceDriftContradiction(b));
  });
});
