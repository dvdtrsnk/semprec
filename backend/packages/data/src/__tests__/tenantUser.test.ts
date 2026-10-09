import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser, getTenantUserId, getTenantUserLocale } from "../auth/usersStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;

describe("getTenantUserId / getTenantUserLocale (issue #1018)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  it("returns the sole tenant's user with no scope while only tenant zero exists", async () => {
    const user = await createUser(adminPool, {
      email: "zero@example.com",
      passwordHash: "x",
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    expect(await getTenantUserId(pool)).toBe(user.id);
    expect(await getTenantUserLocale(pool)).toBe("en");
  });

  it("returns each tenant's own user and locale inside its scope, and null in a system scope", async () => {
    const tenantB = await createTestTenant(adminPool);
    const userA = await createUser(adminPool, {
      email: "a@example.com",
      passwordHash: "x",
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    const userB = await createUser(adminPool, {
      email: "b@example.com",
      passwordHash: "x",
      locale: "cs",
      tenantId: tenantB,
    });

    expect(await runInTenant(getTenantZeroId(), () => getTenantUserId(pool))).toBe(userA.id);
    expect(await runInTenant(getTenantZeroId(), () => getTenantUserLocale(pool))).toBe("en");
    expect(await runInTenant(tenantB, () => getTenantUserId(pool))).toBe(userB.id);
    expect(await runInTenant(tenantB, () => getTenantUserLocale(pool))).toBe("cs");
    expect(await runAsSystem("tenant user lookup test", () => getTenantUserId(pool))).toBeNull();
    expect(await runAsSystem("tenant user lookup test", () => getTenantUserLocale(pool))).toBeNull();
  });

  it("returns null for a tenant with no bound user, even when another tenant has one", async () => {
    const tenantB = await createTestTenant(adminPool);
    await createUser(adminPool, { email: "a@example.com", passwordHash: "x", tenantId: getTenantZeroId() });

    expect(await runInTenant(tenantB, () => getTenantUserId(pool))).toBeNull();
    expect(await runInTenant(tenantB, () => getTenantUserLocale(pool))).toBeNull();
  });

  it("returns null for an account whose tenant binding is NULL", async () => {
    await createUser(adminPool, { email: "unbound@example.com", passwordHash: "x" });
    expect(await getTenantUserId(pool)).toBeNull();
    expect(await getTenantUserLocale(pool)).toBeNull();
  });
});
