import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import {
  ADMIN_AUDIT_ACTIONS,
  changeAccountRole,
  LastAdminError,
  reactivateAccount,
  recordAdminAction,
  suspendAccount,
  type AdminAuditAction,
} from "../tenancy/accountsAdminStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { NotFoundError } from "../errors.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import type { UserRole } from "../auth/types.js";

const ACTOR = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";

interface AuditRow {
  actor_user_id: string;
  action: string;
  target_tenant_id: string | null;
  details: Record<string, string | number | boolean | null>;
}

describe("accountsAdminStore (issue #1037)", () => {
  let pool: Pool;
  let dataPool: Pool;
  let sidePool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await pool.query("DELETE FROM admin_audit_log");
  });

  afterAll(async () => {
    await dataPool.end();
    await sidePool.end();
  });

  async function rows(): Promise<AuditRow[]> {
    const result = await pool.query<AuditRow>(
      "SELECT actor_user_id, action, target_tenant_id, details FROM admin_audit_log ORDER BY id",
    );
    return result.rows;
  }

  it("commits exactly one audit row with the given fields", async () => {
    await runAsSystem("adminAuditTest", async () => {
      await withTransaction(dataPool, (client) =>
        recordAdminAction(client, {
          actorUserId: ACTOR,
          action: "accountSuspended",
          targetTenantId: TARGET,
          details: { reason: "abuse", count: 2, flag: true, none: null },
        }),
      );
      expect(await rows()).toEqual([
        {
          actor_user_id: ACTOR,
          action: "accountSuspended",
          target_tenant_id: TARGET,
          details: { reason: "abuse", count: 2, flag: true, none: null },
        },
      ]);
    });
  });

  it("stores empty details and a null target when omitted", async () => {
    await runAsSystem("adminAuditTest", async () => {
      await withTransaction(dataPool, (client) =>
        recordAdminAction(client, { actorUserId: ACTOR, action: "inviteCreated", targetTenantId: null }),
      );
      expect(await rows()).toEqual([
        { actor_user_id: ACTOR, action: "inviteCreated", target_tenant_id: null, details: {} },
      ]);
    });
  });

  it("leaves no row when the surrounding transaction rolls back", async () => {
    await runAsSystem("adminAuditTest", async () => {
      await expect(
        withTransaction(dataPool, async (client) => {
          await recordAdminAction(client, { actorUserId: ACTOR, action: "inviteRevoked", targetTenantId: null });
          throw new Error("mutation failed");
        }),
      ).rejects.toThrow("mutation failed");
      expect(await rows()).toEqual([]);
    });
  });

  it("throws on an unknown action before any insert", async () => {
    await runAsSystem("adminAuditTest", async () => {
      const unknown = "notAnAction" as unknown as AdminAuditAction;
      expect(ADMIN_AUDIT_ACTIONS).not.toContain(unknown);
      await expect(
        withTransaction(dataPool, (client) =>
          recordAdminAction(client, { actorUserId: ACTOR, action: unknown, targetTenantId: null }),
        ),
      ).rejects.toThrow("admin audit action");
      expect(await rows()).toEqual([]);
    });
  });

  it("lets semprec_data INSERT but not UPDATE or DELETE", async () => {
    await runAsSystem("adminAuditTest", async () => {
      await dataPool.query("INSERT INTO admin_audit_log (actor_user_id, action) VALUES ($1, 'inviteCreated')", [ACTOR]);
      await expect(dataPool.query("UPDATE admin_audit_log SET action = 'inviteRevoked'")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(dataPool.query("DELETE FROM admin_audit_log")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("lets semprec_side SELECT but not INSERT", async () => {
    await runAsSystem("adminAuditTest", async () => {
      await expect(sidePool.query("SELECT count(*) FROM admin_audit_log")).resolves.toBeDefined();
      await expect(
        sidePool.query("INSERT INTO admin_audit_log (actor_user_id, action) VALUES ($1, 'inviteCreated')", [ACTOR]),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});

describe("account mutations (issue #1041)", () => {
  let pool: Pool;
  let dataPool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await pool.query("DELETE FROM admin_audit_log");
  });

  afterAll(async () => {
    await dataPool.end();
  });

  async function makeAccount(role: UserRole): Promise<{ userId: string; tenantId: string }> {
    const tenantId = await createTestTenant(pool);
    const user = await createUser(pool, {
      email: `${role}-${tenantId}@example.test`,
      passwordHash: await hashPassword("s3cret-password"),
      tenantId,
      role,
    });
    return { userId: user.id, tenantId };
  }

  async function auditActions(): Promise<string[]> {
    const { rows } = await pool.query<{ action: string }>("SELECT action FROM admin_audit_log ORDER BY id");
    return rows.map((row) => row.action);
  }

  async function roleOf(userId: string): Promise<string> {
    const { rows } = await pool.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [userId]);
    return rows[0]!.role;
  }

  it("lets exactly one of two admins demote each other concurrently and refuses the other with last_admin", async () => {
    const first = await makeAccount("admin");
    const second = await makeAccount("admin");

    const outcomes = await runAsSystem("accountMutationTest", () =>
      Promise.allSettled([
        withTransaction(dataPool, (client) =>
          changeAccountRole(client, { actorUserId: first.userId, targetUserId: second.userId, role: "member" }),
        ),
        withTransaction(dataPool, (client) =>
          changeAccountRole(client, { actorUserId: second.userId, targetUserId: first.userId, role: "member" }),
        ),
      ]),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(LastAdminError);
    const roles = [await roleOf(first.userId), await roleOf(second.userId)].sort();
    expect(roles).toEqual(["admin", "member"]);
    expect(await auditActions()).toEqual(["accountRoleChanged"]);
  });

  it("lets exactly one of two admins suspend each other concurrently", async () => {
    const first = await makeAccount("admin");
    const second = await makeAccount("admin");

    const outcomes = await runAsSystem("accountMutationTest", () =>
      Promise.allSettled([
        withTransaction(dataPool, (client) =>
          suspendAccount(client, { actorUserId: first.userId, targetUserId: second.userId }),
        ),
        withTransaction(dataPool, (client) =>
          suspendAccount(client, { actorUserId: second.userId, targetUserId: first.userId }),
        ),
      ]),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
    expect(rejected[0]).toBeInstanceOf(LastAdminError);
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = ANY($1) ORDER BY status",
      [[first.tenantId, second.tenantId]],
    );
    expect(rows.map((r) => r.status)).toEqual(["active", "suspended"]);
  });

  it("does not count an admin of a suspended tenant as the remaining admin", async () => {
    const only = await makeAccount("admin");
    const suspendedAdmin = await makeAccount("admin");
    await runAsSystem("accountMutationTest", () =>
      withTransaction(dataPool, (client) =>
        suspendAccount(client, { actorUserId: only.userId, targetUserId: suspendedAdmin.userId }),
      ),
    );
    await pool.query("DELETE FROM admin_audit_log");

    await expect(
      runAsSystem("accountMutationTest", () =>
        withTransaction(dataPool, (client) =>
          changeAccountRole(client, { actorUserId: only.userId, targetUserId: only.userId, role: "member" }),
        ),
      ),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(await roleOf(only.userId)).toBe("admin");
    expect(await auditActions()).toEqual([]);
  });

  it("suspends and reactivates a member without applying the guard", async () => {
    const admin = await makeAccount("admin");
    const member = await makeAccount("member");

    const suspended = await runAsSystem("accountMutationTest", () =>
      withTransaction(dataPool, (client) =>
        suspendAccount(client, { actorUserId: admin.userId, targetUserId: member.userId }),
      ),
    );
    expect(suspended).toMatchObject({ userId: member.userId, status: "suspended" });
    const reactivated = await runAsSystem("accountMutationTest", () =>
      withTransaction(dataPool, (client) =>
        reactivateAccount(client, { actorUserId: admin.userId, targetUserId: member.userId }),
      ),
    );
    expect(reactivated).toMatchObject({ userId: member.userId, status: "active" });
    expect(await auditActions()).toEqual(["accountSuspended", "accountReactivated"]);
  });

  it("answers NotFoundError for an unknown target in each mutation", async () => {
    const admin = await makeAccount("admin");
    const unknown = "99999999-9999-9999-9999-999999999999";
    const run = (fn: (client: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<unknown>) =>
      runAsSystem("accountMutationTest", () => withTransaction(dataPool, fn));

    await expect(
      run((c) => suspendAccount(c, { actorUserId: admin.userId, targetUserId: unknown })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run((c) => reactivateAccount(c, { actorUserId: admin.userId, targetUserId: unknown })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run((c) => changeAccountRole(c, { actorUserId: admin.userId, targetUserId: unknown, role: "member" })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await auditActions()).toEqual([]);
  });
});
