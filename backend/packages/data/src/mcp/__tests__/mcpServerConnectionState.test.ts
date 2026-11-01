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

  it.each([
    [
      "lastConnectedAt",
      "UPDATE mcp_server_connection_state SET last_connected_at = 'infinity' WHERE mcp_server_item_id = $1",
    ],
    ["updatedAt", "UPDATE mcp_server_connection_state SET updated_at = 'infinity' WHERE mcp_server_item_id = $1"],
  ])("rejects non-finite %s from an actual tenant row", async (_field, sql) => {
    await inZero(() => recordMcpConnectionSuccess(dataPool, serverId));
    await inZero(() => dataPool.query(sql, [serverId]));
    await expect(stateOf(serverId)).rejects.toMatchObject({ message: "Invalid stored MCP connection timestamp" });
  });

  it("rejects an off-catalog historical reason and rolls back the fixture constraint change", async () => {
    await inZero(() => recordMcpConnectionSuccess(dataPool, serverId));
    const sentinel = "private-reason-sentinel";
    await expect(
      inZero(() =>
        withTransaction(adminPool, async (client) => {
          await client.query(
            "ALTER TABLE mcp_server_connection_state DROP CONSTRAINT mcp_server_connection_state_last_error_reason_check",
          );
          const changed = await client.query(
            "UPDATE mcp_server_connection_state SET last_error_reason = $1 WHERE tenant_id = $2 AND mcp_server_item_id = $3",
            [sentinel, getTenantZeroId(), serverId],
          );
          expect(changed.rowCount).toBe(1);
          await expect(getMcpConnectionStates(client, [serverId])).rejects.toMatchObject({
            message: "Invalid stored MCP connection reason",
          });
          throw new Error("rollback fixture");
        }),
      ),
    ).rejects.toThrow("rollback fixture");
    expect((await stateOf(serverId))?.lastErrorReason).toBeNull();
    const { rows } = await adminPool.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mcp_server_connection_state'::regclass AND conname = 'mcp_server_connection_state_last_error_reason_check') AS present",
    );
    expect(rows[0]?.present).toBe(true);
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
