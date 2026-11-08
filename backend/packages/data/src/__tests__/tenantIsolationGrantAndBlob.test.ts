import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { findOrCreateBlob, getBlob } from "../blobs/blobsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { setProjectMcpGrant } from "../mcp/mcpGrantsAdminStore.js";
import { listProjectMcpGrants } from "../mcp/mcpProjectGrantsStore.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { createRuntimeRolePool, createTestTenant } from "../testSupport/tenantFixtures.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

describe("tenant isolation for blob deduplication and MCP grants", () => {
  let adminPool: Pool;
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  const previousScope = process.env.SEMPREC_TENANT_SCOPE;

  beforeAll(async () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = await createTestTenant(adminPool);
    tenantB = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = previousScope;
    await pool?.end();
    await adminPool?.end();
  });

  it("stores identical content independently and deduplicates only within each tenant", async () => {
    const contentHash = "a".repeat(64);
    const store = (tenant: string) =>
      runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          findOrCreateBlob(client, {
            mimeType: "application/octet-stream",
            byteSize: 10,
            storageKey: `${tenant}/${randomUUID()}`,
            contentHash,
          }),
        ),
      );
    const a = await store(tenantA);
    const b = await store(tenantB);
    expect(b.id).not.toBe(a.id);
    expect(await store(tenantA)).toEqual(a);
    expect(await store(tenantB)).toEqual(b);
    expect(await runInTenant(tenantA, () => getBlob(pool, b.id))).toBeNull();
    expect(await runInTenant(tenantB, () => getBlob(pool, a.id))).toBeNull();
  });

  it.each([true, false])(
    "refuses foreign and missing registrations for granted=%s without side effects",
    async (granted) => {
      const projectItemId = randomUUID();
      const registration = await runInTenant(tenantA, () =>
        upsertMcpToolRegistration(pool, {
          mcpServerItemId: randomUUID(),
          toolName: "search",
          toolSchema: {},
        }),
      );
      const write = (tenant: string, registrationId: string, value: boolean, project = projectItemId) =>
        runInTenant(tenant, () =>
          setProjectMcpGrant(pool, {
            projectItemId: project,
            mcpToolRegistrationId: registrationId,
            granted: value,
          }),
        );
      const original = await write(tenantA, registration.id, true);
      expect(original).toMatchObject({ projectItemId, mcpToolRegistrationId: registration.id, granted: true });
      // Exercise both the existing grant's conflict key and a new key that would otherwise
      // insert a cross-tenant reference: FK checks themselves do not enforce RLS.
      for (const project of [projectItemId, randomUUID()]) {
        for (const id of [registration.id, randomUUID()]) {
          await expect(write(tenantB, id, granted, project)).rejects.toEqual(
            new NotFoundError(`No mcp_tool_registrations row with id '${id}'`),
          );
          expect(await runInTenant(tenantB, () => listProjectMcpGrants(pool, project))).toEqual([]);
          expect(await runInTenant(tenantA, () => listProjectMcpGrants(pool, projectItemId))).toEqual([original]);
        }
      }
      expect(await write(tenantA, registration.id, false)).toMatchObject({
        projectItemId,
        mcpToolRegistrationId: registration.id,
        createdAt: original.createdAt,
        granted: false,
      });
    },
  );
});
