import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { routeGraphSubscription } from "../mail/mailAccountSyncStateStore.js";
import { handleGraphChangeNotification } from "../mail/graphWebhookNotifications.js";

let pool: Pool;
let dataPool: Pool | undefined;

async function registerMailbox(tenantId: string, subscriptionId: string, clientState: string): Promise<string> {
  const itemId = randomUUID();
  await withTenantTransaction(pool, tenantId, async (client) => {
    await ensureMailAccountSyncState(client, { itemId, syncMode: "graph_api" });
    await client.query(
      `UPDATE mail_account_sync_state SET graph_subscription_id = $2, graph_client_state = $3 WHERE item_id = $1`,
      [itemId, subscriptionId, clientState],
    );
  });
  return itemId;
}

async function jobTenants(itemId: string): Promise<Array<string | null>> {
  const { rows } = await pool.query<{ tenant_id: string | null }>(
    `SELECT j.payload->>'tenantId' AS tenant_id FROM graphile_worker._private_jobs j WHERE j.key = $1`,
    [`mail-account-sync:${itemId}`],
  );
  return rows.map((row) => row.tenant_id);
}

describe("route_graph_subscription (issue #997)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    await dataPool?.end();
    dataPool = undefined;
  });

  it("is a SECURITY DEFINER function owned by a NOLOGIN BYPASSRLS role with a pinned search_path", async () => {
    const { rows } = await pool.query<{ secdef: boolean; owner: string; config: string[] | null }>(
      `SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
       FROM pg_proc p WHERE p.proname = 'route_graph_subscription'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      secdef: true,
      owner: "semprec_router",
      config: ["search_path=pg_catalog, public"],
    });

    const role = await pool.query<{ rolbypassrls: boolean; rolcanlogin: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'semprec_router'",
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: true, rolcanlogin: false, rolsuper: false });
  });

  it("grants EXECUTE to semprec_data only", async () => {
    const { rows } = await pool.query<{ data: boolean; side: boolean; pub: boolean }>(
      `SELECT has_function_privilege('semprec_data', 'route_graph_subscription(text)', 'EXECUTE') AS data,
              has_function_privilege('semprec_side', 'route_graph_subscription(text)', 'EXECUTE') AS side,
              has_function_privilege('public', 'route_graph_subscription(text)', 'EXECUTE') AS pub`,
    );
    expect(rows[0]).toEqual({ data: true, side: false, pub: false });
  });

  it("limits semprec_router to column-level SELECT on the two columns it reads", async () => {
    const { rows } = await pool.query<{ table_select: boolean; last_error: boolean; sub: boolean; tenant: boolean }>(
      `SELECT has_table_privilege('semprec_router', 'mail_account_sync_state', 'SELECT') AS table_select,
              has_column_privilege('semprec_router', 'mail_account_sync_state', 'last_error', 'SELECT') AS last_error,
              has_column_privilege('semprec_router', 'mail_account_sync_state', 'graph_subscription_id', 'SELECT') AS sub,
              has_column_privilege('semprec_router', 'mail_account_sync_state', 'tenant_id', 'SELECT') AS tenant`,
    );
    expect(rows[0]).toEqual({ table_select: false, last_error: false, sub: true, tenant: true });
  });

  it("routes past RLS for semprec_data under an unrelated tenant, and refuses semprec_side", async () => {
    const tenantZero = getTenantZeroId();
    await registerMailbox(tenantZero, "sub-zero", "state-zero");
    const unrelated = randomUUID();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");

    const result = await withTenantTransaction(dataPool, unrelated, async (client) => {
      const visible = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mail_account_sync_state",
      );
      return {
        visible: visible.rows[0]?.count,
        routed: await routeGraphSubscription(client, "sub-zero"),
        unknown: await routeGraphSubscription(client, "sub-unknown"),
      };
    });
    expect(result).toEqual({ visible: "0", routed: tenantZero, unknown: null });

    const sidePool = await createRuntimeRolePool(pool, "semprec_side");
    try {
      await expect(sidePool.query("SELECT route_graph_subscription('sub-zero')")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await sidePool.end();
    }
  });

  it("enqueues a tenant B notification in tenant B and never accepts it with another tenant's clientState", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const itemZero = await registerMailbox(tenantZero, "sub-zero", "state-zero");
    const itemB = await registerMailbox(tenantB, "sub-b", "state-b");
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    const scopedPool = dataPool;

    const outcome = await runAsSystem("test", () =>
      handleGraphChangeNotification(scopedPool, { subscriptionId: "sub-b", clientState: "state-b" }),
    );
    expect(outcome).toBe("accepted");
    expect(await jobTenants(itemB)).toEqual([tenantB]);
    expect(await jobTenants(itemZero)).toEqual([]);

    const crossed = await runAsSystem("test", () =>
      handleGraphChangeNotification(scopedPool, { subscriptionId: "sub-b", clientState: "state-zero" }),
    );
    expect(crossed).toBe("invalidClientState");
    expect(await jobTenants(itemZero)).toEqual([]);
  });

  it("returns the id through the store wrapper inside a plain transaction", async () => {
    const tenantZero = getTenantZeroId();
    await registerMailbox(tenantZero, "sub-wrap", "state");
    const routed = await withTransaction(pool, (client) => routeGraphSubscription(client, "sub-wrap"));
    expect(routed).toBe(tenantZero);
  });
});
