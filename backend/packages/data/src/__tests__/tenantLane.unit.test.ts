import { describe, expect, it } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { tenantLane } from "../tenancy/tenantLane.js";

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

describe("tenantLane", () => {
  it("appends the tenant id inside a tenant scope", () => {
    expect(runInTenant(TENANT_A, () => tenantLane("x"))).toBe(`x:${TENANT_A}`);
  });

  it("yields different names for different tenants", () => {
    const a = runInTenant(TENANT_A, () => tenantLane("x"));
    const b = runInTenant(TENANT_B, () => tenantLane("x"));
    expect(a).not.toBe(b);
  });

  it("is undefined inside a system scope", () => {
    expect(runAsSystem("test", () => tenantLane("x"))).toBeUndefined();
  });

  it("is undefined with no scope", () => {
    expect(tenantLane("x")).toBeUndefined();
  });
});
