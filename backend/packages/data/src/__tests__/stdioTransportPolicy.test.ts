import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  withTenantTransaction,
} from "../testSupport/tenantFixtures.js";
import { createUser } from "../auth/usersStore.js";
import { tenantAllowsStdio } from "../mcp/stdioTransportPolicy.js";

let pool: Pool;

async function setRole(userId: string, role: "admin" | "member"): Promise<void> {
  await pool.query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);
}

describe("tenantAllowsStdio (issue #1030)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("is true for an admin bound to the current tenant", async () => {
    const user = await createTenantZeroUser(pool);
    await setRole(user.id, "admin");
    expect(await tenantAllowsStdio(pool, user.id)).toBe(true);
  });

  it("is false for a member of the current tenant", async () => {
    const user = await createTenantZeroUser(pool);
    await setRole(user.id, "member");
    expect(await tenantAllowsStdio(pool, user.id)).toBe(false);
  });

  it("is false for an admin bound to another tenant", async () => {
    // With a second tenant present `app_tenant_default()` no longer falls back to the sole tenant,
    // so the current tenant is set explicitly; the tenant-zero admin is the positive control.
    const tenantZeroAdmin = await createTenantZeroUser(pool);
    await setRole(tenantZeroAdmin.id, "admin");
    const otherTenantId = await createTestTenant(pool);
    const otherTenantAdmin = await createUser(pool, {
      email: "other-tenant-admin@example.com",
      passwordHash: "unused",
      tenantId: otherTenantId,
      role: "admin",
    });
    await withTenantTransaction(pool, getTenantZeroId(), async (client) => {
      expect(await tenantAllowsStdio(client, tenantZeroAdmin.id)).toBe(true);
      expect(await tenantAllowsStdio(client, otherTenantAdmin.id)).toBe(false);
    });
    await withTenantTransaction(pool, otherTenantId, async (client) => {
      expect(await tenantAllowsStdio(client, otherTenantAdmin.id)).toBe(true);
      expect(await tenantAllowsStdio(client, tenantZeroAdmin.id)).toBe(false);
    });
  });

  it("is false for an unknown user id", async () => {
    const user = await createTenantZeroUser(pool);
    await setRole(user.id, "admin");
    expect(await tenantAllowsStdio(pool, "00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("without a user id is true exactly when the tenant has an admin", async () => {
    const user = await createTenantZeroUser(pool);
    await setRole(user.id, "member");
    expect(await tenantAllowsStdio(pool)).toBe(false);
    await setRole(user.id, "admin");
    expect(await tenantAllowsStdio(pool)).toBe(true);
  });
});
