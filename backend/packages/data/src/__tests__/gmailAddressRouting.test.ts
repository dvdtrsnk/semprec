import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
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
import { routeGmailAddress } from "../mail/mailAccountSyncStateStore.js";
import {
  createGmailPubSubDispatcher,
  type GmailPubSubNotification,
  type GmailWatchTransport,
} from "../mail/gmailWatchLifecycle.js";

let pool: Pool;
let dataPool: Pool | undefined;

async function registerMailbox(tenantId: string, address: string | null, syncMode = "gmail_api"): Promise<string> {
  const itemId = randomUUID();
  await withTenantTransaction(pool, tenantId, async (client) => {
    await ensureMailAccountSyncState(client, { itemId, syncMode: syncMode as "gmail_api" | "imap" });
    await client.query("UPDATE mail_account_sync_state SET gmail_watch_email_address = $2 WHERE item_id = $1", [
      itemId,
      address,
    ]);
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

function fakeTransport(notifications: GmailPubSubNotification[]): { transport: GmailWatchTransport; acks: string[][] } {
  const acks: string[][] = [];
  const queue = [notifications];
  return {
    acks,
    transport: {
      registerWatch: async () => ({ historyId: "1", expiresAt: new Date() }),
      pull: async () => queue.shift() ?? [],
      acknowledge: async (ackIds) => {
        acks.push(ackIds);
      },
    },
  };
}

describe("route_gmail_address (issue #998)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await dataPool?.end();
    dataPool = undefined;
  });

  it("is a SECURITY DEFINER function owned by semprec_router with a pinned search_path", async () => {
    const { rows } = await pool.query<{ secdef: boolean; owner: string; config: string[] | null }>(
      `SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
       FROM pg_proc p WHERE p.proname = 'route_gmail_address'`,
    );
    expect(rows).toEqual([{ secdef: true, owner: "semprec_router", config: ["search_path=pg_catalog, public"] }]);
  });

  it("grants EXECUTE to semprec_data only, and semprec_router cannot read last_error", async () => {
    const { rows } = await pool.query<{ data: boolean; side: boolean; pub: boolean; last_error: boolean }>(
      `SELECT has_function_privilege('semprec_data', 'route_gmail_address(text)', 'EXECUTE') AS data,
              has_function_privilege('semprec_side', 'route_gmail_address(text)', 'EXECUTE') AS side,
              has_function_privilege('public', 'route_gmail_address(text)', 'EXECUTE') AS pub,
              has_column_privilege('semprec_router', 'mail_account_sync_state', 'last_error', 'SELECT') AS last_error`,
    );
    expect(rows[0]).toEqual({ data: true, side: false, pub: false, last_error: false });
  });

  it("routes past RLS for semprec_data under an unrelated tenant, only for gmail_api rows, and refuses semprec_side", async () => {
    const tenantZero = getTenantZeroId();
    const gmail = await registerMailbox(tenantZero, "user@example.com");
    await registerMailbox(tenantZero, "user@example.com", "imap");
    dataPool = await createRuntimeRolePool(pool, "semprec_data");

    const result = await withTenantTransaction(dataPool, randomUUID(), async (client) => {
      const visible = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mail_account_sync_state",
      );
      return {
        visible: visible.rows[0]?.count,
        routed: await routeGmailAddress(client, " User@Example.com "),
        unknown: await routeGmailAddress(client, "nobody@example.com"),
      };
    });
    expect(result).toEqual({
      visible: "0",
      routed: [{ tenantId: tenantZero, mailboxItemId: gmail }],
      unknown: [],
    });

    const sidePool = await createRuntimeRolePool(pool, "semprec_side");
    try {
      await expect(sidePool.query("SELECT * FROM route_gmail_address('user@example.com')")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await sidePool.end();
    }
  });

  it("returns every tenant's mailbox for an address watched in two tenants", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const zero = await registerMailbox(tenantZero, "shared@example.com");
    const b = await registerMailbox(tenantB, "shared@example.com");
    const routed = await withTransaction(pool, (client) => routeGmailAddress(client, "shared@example.com"));
    expect(routed).toHaveLength(2);
    expect(routed).toEqual(
      expect.arrayContaining([
        { tenantId: tenantZero, mailboxItemId: zero },
        { tenantId: tenantB, mailboxItemId: b },
      ]),
    );
  });

  it("dispatches one notification to both tenants' mailboxes and acknowledges it once", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const zero = await registerMailbox(tenantZero, "shared@example.com");
    const b = await registerMailbox(tenantB, "shared@example.com");
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    const { transport, acks } = fakeTransport([{ ackId: "ack-1", emailAddress: "shared@example.com", historyId: "1" }]);
    const dispatcher = createGmailPubSubDispatcher(dataPool, transport, { pullEmptyBackoffMs: 1 });

    await dispatcher.start();
    await vi.waitFor(() => expect(acks).toEqual([["ack-1"]]));
    await dispatcher.stop();

    expect(await jobTenants(zero)).toEqual([tenantZero]);
    expect(await jobTenants(b)).toEqual([tenantB]);
  });

  it("routes and enqueues in strict mode when started and stopped with no scope", async () => {
    const tenantB = await createTestTenant(pool);
    const b = await registerMailbox(tenantB, "strict@example.com");
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    vi.stubEnv("SEMPREC_TENANT_SCOPE", "strict");
    const errors: unknown[] = [];
    const { transport, acks } = fakeTransport([{ ackId: "ack-s", emailAddress: "strict@example.com", historyId: "1" }]);
    const dispatcher = createGmailPubSubDispatcher(dataPool, transport, {
      pullEmptyBackoffMs: 1,
      onError: (_target, _phase, err) => errors.push(err),
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(acks).toEqual([["ack-s"]]));
    await dispatcher.stop();

    expect(errors).toEqual([]);
    expect(await jobTenants(b)).toEqual([tenantB]);
  });
});
