import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/pool.js";
import { createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { bootstrapFirstAccount } from "../auth/authActions.js";
import { getSoleTenantId } from "../tenancy/tenantsStore.js";

describe("tenant entity (issue #968)", () => {
  describe("on the shared test database", () => {
    const pool = getTestPool();
    beforeEach(async () => {
      await resetDatabase(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    it("binds the bootstrapped account to the sole tenant as admin without changing the result shape", async () => {
      const account = await bootstrapFirstAccount(pool, "tok", "tok", {
        email: "owner@example.com",
        password: "s3cret-password",
      });

      expect(Object.keys(account).sort()).toEqual(["createdAt", "displayName", "email", "id", "locale"]);
      const { rows } = await pool.query<{ tenant_id: string; role: string }>(
        "SELECT tenant_id, role FROM users WHERE id = $1",
        [account.id],
      );
      expect(rows).toEqual([{ tenant_id: await getSoleTenantId(pool), role: "admin" }]);
    });

    it("throws the invariant error when no tenant exists", async () => {
      await expect(
        withTransaction(pool, async (client) => {
          await client.query("UPDATE users SET tenant_id = NULL");
          await client.query("DELETE FROM tenants");
          await getSoleTenantId(client);
          throw new Error("unreachable: getSoleTenantId should have thrown");
        }),
      ).rejects.toThrow("Expected exactly one tenant, found none or several");
      // The delete was rolled back with the transaction.
      expect(await getSoleTenantId(pool)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("createUser stores member by default and the given tenant and role when passed", async () => {
      const tenantId = await getSoleTenantId(pool);
      const otherTenantId = await createTestTenant(pool);
      const a = await createUser(pool, { email: "a@example.com", passwordHash: "x", tenantId: otherTenantId });
      const c = await createUser(pool, { email: "c@example.com", passwordHash: "x", tenantId, role: "admin" });

      const { rows } = await pool.query<{ id: string; tenant_id: string | null; role: string }>(
        "SELECT id, tenant_id, role FROM users WHERE id = ANY($1)",
        [[a.id, c.id]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(a.id)).toMatchObject({ tenant_id: otherTenantId, role: "member" });
      expect(byId.get(c.id)).toMatchObject({ tenant_id: tenantId, role: "admin" });
    });

    it("createUser without a tenant is refused by users.tenant_id NOT NULL (issue #1067)", async () => {
      await expect(createUser(pool, { email: "a@example.com", passwordHash: "x" })).rejects.toMatchObject({
        code: "23502",
      });
      const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
      expect(rows).toEqual([{ count: "0" }]);
    });
  });
});
