import { describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { resolveAgentRunLane } from "../scheduler/actions.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

describe("resolveAgentRunLane", () => {
  it("gives each tenant its own agent-run lane for core.agentRun", () => {
    expect(runInTenant(TENANT_A, () => resolveAgentRunLane("core.agentRun"))).toBe(`agent-run:${TENANT_A}`);
    expect(runInTenant(TENANT_B, () => resolveAgentRunLane("core.agentRun"))).toBe(`agent-run:${TENANT_B}`);
  });

  it("leaves non-agent heartbeat actions on their existing queue name", () => {
    expect(runInTenant(TENANT_A, () => resolveAgentRunLane("semprec.tick"))).toBeUndefined();
  });

  it("returns undefined outside a tenant scope, so the job keeps a NULL queue_name", () => {
    expect(resolveAgentRunLane("core.agentRun")).toBeUndefined();
  });
});
