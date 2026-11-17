import { describe, expect, it } from "vitest";
import { describeModuleToolFailure } from "../agentTools/describeModuleToolFailure.js";

describe("describeModuleToolFailure", () => {
  it("keeps the class name and the SQLSTATE of a database error, and nothing that holds a column value", () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint "t_title_key"'), {
      code: "23505",
      detail: "Key (title)=(secret customer title) already exists.",
      constraint: "t_title_key",
    });

    expect(describeModuleToolFailure(violation)).toStrictEqual({ errorName: "Error", errorCode: "23505" });
  });

  it("keeps the class name of a validation error and none of its issues", () => {
    class ZodLikeError extends Error {
      override name = "ZodError";
      issues = [{ message: "Invalid input: secret customer title" }];
    }

    expect(describeModuleToolFailure(new ZodLikeError("secret customer title"))).toStrictEqual({
      errorName: "ZodError",
    });
  });

  it("drops a name or a code that is not a short identifier instead of writing its text", () => {
    const err = Object.assign(new Error("boom"), { code: "Key (title)=(secret) exists" });
    err.name = "failed for secret customer title";

    expect(describeModuleToolFailure(err)).toStrictEqual({ errorName: "Error" });
    expect(describeModuleToolFailure(Object.assign(new TypeError("boom"), { code: 42 }))).toStrictEqual({
      errorName: "TypeError",
    });
  });

  it("reports only the value's type for a non-Error rejection", () => {
    expect(describeModuleToolFailure("secret customer title")).toStrictEqual({ errorName: "string" });
  });
});
