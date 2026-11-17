import { describe, expect, it } from "vitest";
import { AgentRunError, agentRunErrorCodeOf } from "../agentRuns/agentRunErrorCodes.js";

describe("agentRunErrorCodeOf", () => {
  it("returns the code an error carries", () => {
    expect(agentRunErrorCodeOf(new AgentRunError("modelError", "provider failed"))).toBe("modelError");
    expect(agentRunErrorCodeOf(Object.assign(new Error("x"), { agentRunErrorCode: "cancelled" }))).toBe("cancelled");
  });

  it.each([
    ["a plain error", new Error("boom")],
    ["a string", "boom"],
    ["null", null],
    ["an unknown code", Object.assign(new Error("x"), { agentRunErrorCode: "nope" })],
    ["a non-string code", Object.assign(new Error("x"), { agentRunErrorCode: 7 })],
  ])("maps %s to internal", (_label, err) => {
    expect(agentRunErrorCodeOf(err)).toBe("internal");
  });
});
