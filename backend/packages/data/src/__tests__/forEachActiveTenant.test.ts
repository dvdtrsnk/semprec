import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { currentTenantScope, runInTenant, TenantScopeConflictError, type TenantScope } from "@semprec/shared";
import { forEachActiveTenant } from "../index.js";
import { withTransaction } from "../db/pool.js";
import { logger } from "../tenancy/logger.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;

/** Tenant zero plus two more active tenants, in the order `forEachActiveTenant` sorts them. */
async function threeActiveTenants(): Promise<string[]> {
  const ids = [getTenantZeroId(), await createTestTenant(pool), await createTestTenant(pool)];
  return ids.sort();
}

async function collectVisits(): Promise<string[]> {
  const visited: string[] = [];
  await forEachActiveTenant(pool, async (id) => {
    visited.push(id);
  });
  return visited;
}

describe("forEachActiveTenant (issue #983)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("visits each active tenant once, inside that tenant's scope", async () => {
    const ids = await threeActiveTenants();
    const seen: { id: string; scope: TenantScope | undefined; dbTenant: string | null }[] = [];

    await forEachActiveTenant(pool, async (id) => {
      const dbTenant = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ tenant: string | null }>("SELECT app_current_tenant() AS tenant");
        return rows[0]?.tenant ?? null;
      });
      seen.push({ id, scope: currentTenantScope(), dbTenant });
    });

    expect(seen.map((s) => s.id).sort()).toEqual(ids);
    for (const s of seen) {
      expect(s.scope).toEqual({ kind: "tenant", tenantId: s.id });
      expect(s.dbTenant).toBe(s.id);
    }
  });

  it("never passes suspended, provisioning or deleting tenants to work", async () => {
    const active = await createTestTenant(pool);
    await createTestTenant(pool, { status: "suspended" });
    await createTestTenant(pool, { status: "provisioning" });
    await createTestTenant(pool, { status: "deleting" });

    expect((await collectVisits()).sort()).toEqual([getTenantZeroId(), active].sort());
  });

  it("resolves without calling work when no tenant is active", async () => {
    await pool.query("UPDATE tenants SET status = 'suspended'");
    const work = vi.fn(async () => {});

    await expect(forEachActiveTenant(pool, work)).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
  });

  it("logs, continues past a failing tenant and rejects with an AggregateError of the original error", async () => {
    await threeActiveTenants();
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    const visited: string[] = [];

    const failure = await forEachActiveTenant(pool, async (id) => {
      visited.push(id);
      if (visited.length === 2) throw boom;
    }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(visited).toHaveLength(3);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(1);
    expect(aggregate.errors[0]).toBe(boom);
    expect(aggregate.message).toContain("1 of 3");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, tenantId: visited[1] }),
      expect.any(String),
    );
    errorSpy.mockRestore();
  });

  it("rotates the starting tenant across consecutive calls", async () => {
    const ids = await threeActiveTenants();

    const runs = [await collectVisits(), await collectVisits(), await collectVisits()];

    for (const run of runs) expect([...run].sort()).toEqual(ids);
    expect(runs.map((run) => run[0]).sort()).toEqual(ids);
  });

  it("rejects with TenantScopeConflictError from a tenant scope without calling work", async () => {
    const work = vi.fn(async () => {});

    await expect(runInTenant(getTenantZeroId(), () => forEachActiveTenant(pool, work))).rejects.toBeInstanceOf(
      TenantScopeConflictError,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("leaves the caller's scope unchanged whether it resolves or rejects", async () => {
    await threeActiveTenants();
    expect(currentTenantScope()).toBeUndefined();

    await forEachActiveTenant(pool, async () => {});
    expect(currentTenantScope()).toBeUndefined();

    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await expect(
      forEachActiveTenant(pool, async () => {
        throw new Error("fail");
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(currentTenantScope()).toBeUndefined();
    errorSpy.mockRestore();
  });
});
