import { describe, expect, it } from "vitest";
import { PropertyCreateInputSchema } from "../schemas.js";
import { validationIssueField, type ValidationIssueLike } from "../validationIssueField.js";

const union = (...errors: ValidationIssueLike[][]): ValidationIssueLike => ({
  code: "invalid_union",
  path: [],
  errors,
});

describe("validationIssueField", () => {
  it("joins the path of a non-union first issue", () => {
    expect(validationIssueField([{ code: "too_small", path: ["properties", "title", 0] }])).toBe("properties.title.0");
  });

  it("returns undefined for a non-union first issue without a path", () => {
    expect(validationIssueField([{ code: "unrecognized_keys", path: [] }])).toBeUndefined();
  });

  it("returns undefined when there are no issues", () => {
    expect(validationIssueField([])).toBeUndefined();
  });

  it("names filter for a relation-path issue inside nested union members", () => {
    const issue = union(
      [{ code: "invalid_type", path: ["filter", "property"] }],
      [union([{ code: "custom", path: [], params: { relationPathFilter: true } }])],
    );
    expect(validationIssueField([issue])).toBe("filter");
  });

  it("keeps ordinary custom issues on their own field", () => {
    expect(validationIssueField([{ code: "custom", path: ["other"], params: { relationPathFilter: false } }])).toBe(
      "other",
    );
  });

  it("does not replace an earlier unrelated issue's field", () => {
    expect(
      validationIssueField([
        { code: "invalid_type", path: ["limit"] },
        { code: "custom", path: ["filter"], params: { relationPathFilter: true } },
      ]),
    ).toBe("limit");
  });

  it("recognizes a later marker on the first issue's condition", () => {
    expect(
      validationIssueField([
        { code: "too_small", path: ["filter", "nodes", 0, "path", 1] },
        { code: "custom", path: ["filter", "nodes", 0], params: { relationPathFilter: true } },
      ]),
    ).toBe("filter");
  });

  it("does not replace an earlier sibling condition's field", () => {
    expect(
      validationIssueField([
        { code: "invalid_format", path: ["filter", "nodes", 0, "value"] },
        { code: "custom", path: ["filter", "nodes", 1], params: { relationPathFilter: true } },
      ]),
    ).toBe("filter.nodes.0.value");
  });

  it("does not match a marker below the first issue's path", () => {
    expect(
      validationIssueField([
        { code: "custom", path: ["other"] },
        { code: "custom", path: ["other", "nodes", 0], params: { relationPathFilter: true } },
      ]),
    ).toBe("other");
  });

  it("resolves an invalid_union through the member with the fewest issues", () => {
    const issue = union(
      [
        { code: "invalid_value", path: ["type"] },
        { code: "unrecognized_keys", path: [] },
      ],
      [{ code: "invalid_type", path: ["targetDatabaseId"] }],
    );
    expect(validationIssueField([issue])).toBe("targetDatabaseId");
  });

  it("takes the first member in declaration order on a tie", () => {
    const issue = union([{ code: "invalid_type", path: ["first"] }], [{ code: "invalid_type", path: ["second"] }]);
    expect(validationIssueField([issue])).toBe("first");
  });

  it("returns undefined when the chosen member has no path-bearing issue", () => {
    const issue = union(
      [{ code: "unrecognized_keys", path: [] }],
      [
        { code: "invalid_type", path: ["a"] },
        { code: "invalid_type", path: ["b"] },
      ],
    );
    expect(validationIssueField([issue])).toBeUndefined();
  });

  it("names the field for the real property.create union schema", () => {
    const base = { databaseId: "00000000-0000-4000-8000-000000000000", key: "k", name: "N" };
    const fieldOf = (input: unknown): string | undefined => {
      const parsed = PropertyCreateInputSchema.safeParse(input);
      if (parsed.success) throw new Error("expected a validation failure");
      return validationIssueField(parsed.error.issues);
    };
    expect(fieldOf({ ...base, type: "bogus" })).toBe("type");
    expect(fieldOf({ ...base, type: "relation", cardinality: "one_to_many", locked: false })).toBe("targetDatabaseId");
    expect(fieldOf({ ...base, name: "", type: "text" })).toBe("name");
  });
});
