import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, getTenantZeroId } from "../../testSupport/tenantFixtures.js";
import { withTransaction } from "../../db/pool.js";
import { MCP_CONNECTION_ERROR_REASONS } from "../mcpConnectionError.js";
import {
  getMcpConnectionStates,
  recordMcpConnectionFailure,
  recordMcpConnectionSuccess,
} from "../mcpServerConnectionStateStore.js";

let adminPool: Pool;
// A runtime-role pool from the production constructor: row-level security applies and each checkout
// takes the active tenant scope.
let dataPool: Pool;
let serverId: string;

function inZero<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

async function stateOf(id: string, tenantId = getTenantZeroId()) {
  const states = await runInTenant(tenantId, () => getMcpConnectionStates(dataPool, [id]));
  return states[0];
}

describe("mcp_server_connection_state (issue #1450)", () => {
  beforeEach(async () => {
    adminPool ??= getTestPool();
    await resetDatabase(adminPool);
    dataPool ??= await createRuntimeRolePool(adminPool, "semprec_data");
    serverId = randomUUID();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("success sets last_connected_at and clears a previous error", async () => {
    await inZero(() => recordMcpConnectionFailure(dataPool, serverId, "handshake_failed"));
    expect((await stateOf(serverId))?.lastErrorReason).toBe("handshake_failed");
    expect((await stateOf(serverId))?.lastConnectedAt).toBeNull();
    const failed = await stateOf(serverId);
    expect(typeof failed?.updatedAt).toBe("string");
    expect(new Date(failed!.updatedAt).toISOString()).toBe(failed!.updatedAt);

    await inZero(() => recordMcpConnectionSuccess(dataPool, serverId));
    const state = await stateOf(serverId);
    expect(state?.lastErrorReason).toBeNull();
    expect(typeof state?.lastConnectedAt).toBe("string");
    expect(new Date(state!.lastConnectedAt!).toISOString()).toBe(state!.lastConnectedAt);
    expect(new Date(state!.updatedAt).toISOString()).toBe(state!.updatedAt);
  });

  it("requires a pool rather than a transaction client for independent writes", () => {
    expectTypeOf<PoolClient>().not.toExtend<Parameters<typeof recordMcpConnectionSuccess>[0]>();
    expectTypeOf<PoolClient>().not.toExtend<Parameters<typeof recordMcpConnectionFailure>[0]>();
  });

  it("a failure records the reason and keeps the previous last_connected_at", async () => {
    await inZero(() => recordMcpConnectionSuccess(dataPool, serverId));
    const before = await stateOf(serverId);
    await inZero(() => recordMcpConnectionFailure(dataPool, serverId, "handshake_failed"));
    const after = await stateOf(serverId);
    expect(after?.lastErrorReason).toBe("handshake_failed");
    expect(before?.lastConnectedAt).not.toBeNull();
    expect(after?.lastConnectedAt).toEqual(before?.lastConnectedAt);
    expect(JSON.stringify(after)).not.toMatch(/https?:/);
  });

  it("accepts every connection error reason and rejects an unknown one", async () => {
    for (const reason of MCP_CONNECTION_ERROR_REASONS) {
      await inZero(() => recordMcpConnectionFailure(dataPool, serverId, reason));
      expect((await stateOf(serverId))?.lastErrorReason).toBe(reason);
    }
    // The production writer cannot construct an off-list reason; exercise the database constraint directly.
    await expect(
      inZero(() =>
        dataPool.query("UPDATE mcp_server_connection_state SET last_error_reason = $1 WHERE mcp_server_item_id = $2", [
          "secret https://x",
          serverId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("a recorded failure survives the rollback of a caller transaction", async () => {
    await expect(
      inZero(() =>
        withTransaction(dataPool, async () => {
          await recordMcpConnectionFailure(dataPool, serverId, "connect_timeout");
          throw new Error("caller rolls back");
        }),
      ),
    ).rejects.toThrow("caller rolls back");
    expect((await stateOf(serverId))?.lastErrorReason).toBe("connect_timeout");
  });

  it("tenant B cannot see tenant A's row", async () => {
    await inZero(() => recordMcpConnectionFailure(dataPool, serverId, "handshake_failed"));
    const tenantB = await createTestTenant(adminPool);
    expect(await stateOf(serverId, tenantB)).toBeUndefined();
    const rows = await runInTenant(tenantB, () =>
      dataPool.query<{ n: string }>("SELECT count(*)::text AS n FROM mcp_server_connection_state"),
    );
    expect(rows.rows[0]?.n).toBe("0");

    // The same server id in tenant B is a row of its own and leaves tenant A's untouched.
    await runInTenant(tenantB, () => recordMcpConnectionSuccess(dataPool, serverId));
    expect((await stateOf(serverId, tenantB))?.lastErrorReason).toBeNull();
    expect((await stateOf(serverId))?.lastErrorReason).toBe("handshake_failed");
  });
});
