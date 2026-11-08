import { describe, expect, it } from "vitest";
import { describeMailFailure } from "../mail/describeMailFailure.js";

describe("describeMailFailure", () => {
  it("keeps the class name, a string code and a numeric response code, and nothing that names the recipient", () => {
    const refusal = Object.assign(new Error("550 <to@example.com>: rejected"), {
      code: "EENVELOPE",
      responseCode: 550,
      response: "550 <to@example.com>: rejected",
      rejected: ["to@example.com"],
    });

    expect(describeMailFailure(refusal)).toEqual({ errorName: "Error", errorCode: "EENVELOPE", responseCode: 550 });
  });

  it("omits a code or response code of any other type instead of stringifying it", () => {
    const err = Object.assign(new TypeError("boom"), { code: 42, responseCode: "550" });

    expect(describeMailFailure(err)).toStrictEqual({ errorName: "TypeError" });
  });

  it("reports only the value's type for a non-Error rejection", () => {
    expect(describeMailFailure("rejected <to@example.com>")).toStrictEqual({ errorName: "string" });
  });
});
