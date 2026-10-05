import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({ createLogger: () => ({ warn }) }));

import {
  TenantScopeConflictError,
  TenantScopeMissingError,
  currentTenantScope,
  enforceTenantScope,
  runAsSystem,
  runDetachedAsSystem,
  runInTenant,
} from "../tenantScope.js";

const T = randomUUID();
const U = randomUUID();

describe("scope reporting", () => {
  it("is undefined outside any scope and reports tenant and system scopes inside", () => {
    expect(currentTenantScope()).toBeUndefined();
    runInTenant(T, () => expect(currentTenantScope()).toEqual({ kind: "tenant", tenantId: T }));
    runAsSystem("r", () => expect(currentTenantScope()).toEqual({ kind: "system", reason: "r" }));
  });

  it("stores the tenant id lower-cased", () => {
    runInTenant(T.toUpperCase(), () => expect(currentTenantScope()).toEqual({ kind: "tenant", tenantId: T }));
  });

  it("restores the outer scope after fn returns and after it rejects", async () => {
    await runAsSystem("outer", async () => {
      runInTenant(T, () => undefined);
      expect(currentTenantScope()).toEqual({ kind: "system", reason: "outer" });
      await expect(runInTenant(T, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect(currentTenantScope()).toEqual({ kind: "system", reason: "outer" });
    });
    expect(currentTenantScope()).toBeUndefined();
  });
});

describe("nesting", () => {
  it("re-enters the same tenant", () => {
    const fn = vi.fn(() => currentTenantScope());
    expect(runInTenant(T, () => runInTenant(T, fn))).toEqual({ kind: "tenant", tenantId: T });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("rejects a different tenant and a system scope inside a tenant without calling fn", () => {
    const fn = vi.fn();
    runInTenant(T, () => {
      expect(() => runInTenant(U, fn)).toThrow(TenantScopeConflictError);
      expect(() => runAsSystem("r", fn)).toThrow(TenantScopeConflictError);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("enters a tenant from system and takes the inner reason system-in-system", () => {
    runAsSystem("outer", () => {
      runInTenant(T, () => expect(currentTenantScope()).toEqual({ kind: "tenant", tenantId: T }));
      runAsSystem("inner", () => expect(currentTenantScope()).toEqual({ kind: "system", reason: "inner" }));
    });
  });

  it("names the conflict error", () => {
    expect(() => runInTenant(T, () => runInTenant(U, () => undefined))).toThrow(
      expect.objectContaining({ name: "TenantScopeConflictError" }),
    );
  });
});

describe("argument checks", () => {
  it.each(["abc", "", `${T}x`, ` ${T}`])("runInTenant(%j) throws TypeError without calling fn", (id) => {
    const fn = vi.fn();
    expect(() => runInTenant(id, fn)).toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("runAsSystem and runDetachedAsSystem reject an empty reason without calling fn", () => {
    const fn = vi.fn();
    expect(() => runAsSystem("", fn)).toThrow(TypeError);
    expect(() => runDetachedAsSystem("", fn)).toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("concurrent scopes", () => {
  it("keeps two Promise.all branches isolated across await and setTimeout", async () => {
    const observe = async (delayMs: number): Promise<string[]> => {
      const seen: string[] = [];
      const record = (): void => {
        const scope = currentTenantScope();
        seen.push(scope?.kind === "tenant" ? scope.tenantId : "none");
      };
      record();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      record();
      await Promise.resolve();
      record();
      return seen;
    };
    const [a, b] = await Promise.all([runInTenant(T, () => observe(5)), runInTenant(U, () => observe(1))]);
    expect(a).toEqual([T, T, T]);
    expect(b).toEqual([U, U, U]);
  });
});

describe("enforceTenantScope", () => {
  const original = process.env.SEMPREC_TENANT_SCOPE;

  beforeEach(() => {
    warn.mockClear();
    delete process.env.SEMPREC_TENANT_SCOPE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = original;
  });

  it.each([undefined, "", "warn"])("warns once per call site with SEMPREC_TENANT_SCOPE=%j", async (mode) => {
    // A fresh module per case: the once-per-stack memory is process-wide and these cases share a call site.
    vi.resetModules();
    const fresh = await import("../tenantScope.js");
    if (mode !== undefined) process.env.SEMPREC_TENANT_SCOPE = mode;
    for (let i = 0; i < 2; i += 1) {
      expect(fresh.enforceTenantScope(`site-${String(mode)}`)).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { site: `site-${String(mode)}`, stack: expect.stringContaining("tenantScope") as string },
      "tenant_scope_missing",
    );
  });

  it("throws TenantScopeMissingError naming the site in strict mode", () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    expect(() => enforceTenantScope("the-site")).toThrow(TenantScopeMissingError);
    expect(() => enforceTenantScope("the-site")).toThrow(/the-site/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws an Error naming an unknown mode", () => {
    process.env.SEMPREC_TENANT_SCOPE = "bogus";
    expect(() => enforceTenantScope("x")).toThrow(/bogus/);
  });

  it("returns the active scope and logs nothing", () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    runInTenant(T, () => expect(enforceTenantScope("x")).toEqual({ kind: "tenant", tenantId: T }));
    runAsSystem("r", () => expect(enforceTenantScope("x")).toEqual({ kind: "system", reason: "r" }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("still logs every novel stack once the remembered set is full", () => {
    // Two distinct frames, chosen by the bits of `path`, make 2^11 distinct stacks of bounded depth.
    const viaA = (path: number, depth: number): void => walk(path, depth);
    const viaB = (path: number, depth: number): void => walk(path, depth);
    const walk = (path: number, depth: number): void => {
      if (depth === 0) enforceTenantScope("s");
      else if ((path >> (depth - 1)) & 1) viaA(path, depth - 1);
      else viaB(path, depth - 1);
    };
    const originalLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    try {
      for (let path = 0; path < 1_005; path += 1) walk(path, 11);
      expect(warn).toHaveBeenCalledTimes(1_005);
      warn.mockClear();
      walk(1_004, 11);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      Error.stackTraceLimit = originalLimit;
    }
  });
});

describe("runDetachedAsSystem", () => {
  it("runs in a system scope inside a tenant and restores the tenant afterwards", () => {
    runInTenant(T, () => {
      runDetachedAsSystem("detached", () =>
        expect(currentTenantScope()).toEqual({ kind: "system", reason: "detached" }),
      );
      expect(currentTenantScope()).toEqual({ kind: "tenant", tenantId: T });
    });
  });
});
