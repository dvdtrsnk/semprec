import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  getMcpToolRegistration,
  listMcpToolRegistrationsForServer,
  setMcpToolRequiresApproval,
  setMcpToolRiskClass,
  upsertMcpToolRegistration,
} from "../mcp/mcpToolRegistrationsStore.js";
import { NotFoundError } from "../errors.js";

let pool: Pool;

describe("mcpToolRegistrationsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("defaults active/requiresApproval/riskClass on a new tool/server pair", async () => {
    const mcpServerItemId = randomUUID();

    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId,
      toolName: "search_web",
      toolSchema: { type: "object", properties: {} },
      description: "Searches the web",
    });

    expect(registration.active).toBe(true);
    expect(registration.requiresApproval).toBe(true);
    expect(registration.riskClass).toBe("unclassified");
    expect(registration.mcpServerItemId).toBe(mcpServerItemId);
    expect(registration.toolName).toBe("search_web");
  });

  it("rejects a duplicate (mcp_server_item_id, tool_name) pair from a raw insert", async () => {
    const mcpServerItemId = randomUUID();
    await upsertMcpToolRegistration(pool, { mcpServerItemId, toolName: "search_web", toolSchema: {} });

    await expect(
      pool.query(`INSERT INTO mcp_tool_registrations (mcp_server_item_id, tool_name, tool_schema) VALUES ($1, $2, '{}'::jsonb)`, [
        mcpServerItemId,
        "search_web",
      ]),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("re-syncing a tool's schema snapshot leaves risk_class/requires_approval untouched", async () => {
    const mcpServerItemId = randomUUID();
    const created = await upsertMcpToolRegistration(pool, { mcpServerItemId, toolName: "search_web", toolSchema: { v: 1 } });
    await setMcpToolRiskClass(pool, created.id, "high");
    await setMcpToolRequiresApproval(pool, created.id, false);

    const resynced = await upsertMcpToolRegistration(pool, {
      mcpServerItemId,
      toolName: "search_web",
      toolSchema: { v: 2 },
      description: "updated description",
    });

    expect(resynced.id).toBe(created.id);
    expect(resynced.toolSchema).toEqual({ v: 2 });
    expect(resynced.description).toBe("updated description");
    expect(resynced.riskClass).toBe("high");
    expect(resynced.requiresApproval).toBe(false);
  });

  it("lists a server's tools and fetches one by id", async () => {
    const mcpServerItemId = randomUUID();
    await upsertMcpToolRegistration(pool, { mcpServerItemId, toolName: "b_tool", toolSchema: {} });
    const first = await upsertMcpToolRegistration(pool, { mcpServerItemId, toolName: "a_tool", toolSchema: {} });

    const list = await listMcpToolRegistrationsForServer(pool, mcpServerItemId);
    expect(list.map((r) => r.toolName)).toEqual(["a_tool", "b_tool"]);

    const fetched = await getMcpToolRegistration(pool, first.id);
    expect(fetched?.toolName).toBe("a_tool");
    expect(await getMcpToolRegistration(pool, randomUUID())).toBeNull();
  });

  it("throws NotFoundError setting risk_class/requires_approval on a nonexistent registration", async () => {
    await expect(setMcpToolRiskClass(pool, randomUUID(), "high")).rejects.toThrow(NotFoundError);
    await expect(setMcpToolRequiresApproval(pool, randomUUID(), false)).rejects.toThrow(NotFoundError);
  });
});
