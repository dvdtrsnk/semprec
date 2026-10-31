import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { assertValidBlockInput } from "../docs/assertValidBlockInput.js";

describe("assertValidBlockInput", () => {
  it("raises ValidationError (HTTP 400) with the issues for an unknown type key", () => {
    let thrown: unknown;
    try {
      assertValidBlockInput({ id: "a", type: "callout" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).status).toBe(400);
    expect((thrown as ValidationError).details).toMatchObject({ issues: [{ code: "unknown_type" }] });
  });

  it("passes a valid block", () => {
    expect(() => assertValidBlockInput({ id: "a", type: "h2", text: "title" })).not.toThrow();
  });
});
