import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { getProjectMcpGrant, listProjectMcpGrants } from "../mcp/mcpProjectGrantsStore.js";
import { setProjectMcpGrant } from "../mcp/mcpGrantsAdminStore.js";
import { NotFoundError } from "../errors.js";

let pool: Pool;

describe("mcpProjectGrantsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("defaults a new project/tool pair to ungranted", async () => {
    const projectItemId = randomUUID();
    const registration = await upsertMcpToolRegistration(pool, { mcpServerItemId: randomUUID(), toolName: "search_web", toolSchema: {} });

    expect(await getProjectMcpGrant(pool, projectItemId, registration.id)).toBeNull();

    const grant = await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: false });
    expect(grant.granted).toBe(false);
  });

  it("grants and revokes idempotently on the composite key", async () => {
    const projectItemId = randomUUID();
    const registration = await upsertMcpToolRegistration(pool, { mcpServerItemId: randomUUID(), toolName: "search_web", toolSchema: {} });

    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });
    const granted = await getProjectMcpGrant(pool, projectItemId, registration.id);
    expect(granted?.granted).toBe(true);

    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: false });
    const revoked = await getProjectMcpGrant(pool, projectItemId, registration.id);
    expect(revoked?.granted).toBe(false);

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM project_mcp_grants`);
    expect(rows[0].count).toBe(1);
  });

  it("lists all of a project's grants", async () => {
    const projectItemId = randomUUID();
    const toolA = await upsertMcpToolRegistration(pool, { mcpServerItemId: randomUUID(), toolName: "tool_a", toolSchema: {} });
    const toolB = await upsertMcpToolRegistration(pool, { mcpServerItemId: randomUUID(), toolName: "tool_b", toolSchema: {} });
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: toolA.id, granted: true });
    await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: toolB.id, granted: false });

    const grants = await listProjectMcpGrants(pool, projectItemId);
    expect(grants).toHaveLength(2);
    expect(grants.find((g) => g.mcpToolRegistrationId === toolA.id)?.granted).toBe(true);
    expect(grants.find((g) => g.mcpToolRegistrationId === toolB.id)?.granted).toBe(false);
  });

  it("rejects a grant referencing a nonexistent tool registration", async () => {
    await expect(
      setProjectMcpGrant(pool, { projectItemId: randomUUID(), mcpToolRegistrationId: randomUUID(), granted: true }),
    ).rejects.toThrow(NotFoundError);
  });
});
