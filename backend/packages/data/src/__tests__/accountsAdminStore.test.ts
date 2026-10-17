import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { ADMIN_AUDIT_ACTIONS, recordAdminAction, type AdminAuditAction } from "../tenancy/accountsAdminStore.js";

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
