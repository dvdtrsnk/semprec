import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { mintMcpRunCredential, resolveMcpRunCredential } from "../mcp/mcpRunCredentialAction.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantZero: string;
let tenantB: string;
let userId: string;

describe("MCP run credentials resolve to their tenant (issue #994)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    const { rows } = await adminPool.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id",
      [`${randomUUID()}@example.com`],
    );
    userId = rows[0]!.id;
  });

  /** Mints a credential inside `tenantId` for a Projects item created in that same tenant. */
  async function mintIn(tenantId: string) {
    return runInTenant(tenantId, async () => {
      const projectItemId = await createTestProjectItem(pool);
      return withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId }),
      );
    });
  }

  it("declares tenant_id NOT NULL with the app_tenant_default() default on a global table", async () => {
    const { rows } = await adminPool.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'agent_run_mcp_credentials' AND column_name = 'tenant_id'`,
    );
    const comment = await adminPool.query<{ comment: string }>(
      `SELECT obj_description('agent_run_mcp_credentials'::regclass) AS comment`,
    );

    expect(rows).toEqual([{ is_nullable: "NO", column_default: "app_tenant_default()" }]);
    expect(comment.rows[0]!.comment).toBe("semprec:tenancy=global");
  });

  it("stores the run's tenant on the credential", async () => {
    const minted = await mintIn(tenantB);

    const { rows } = await adminPool.query<{ credential_tenant: string; run_tenant: string }>(
      `SELECT c.tenant_id AS credential_tenant, r.tenant_id AS run_tenant
       FROM agent_run_mcp_credentials c JOIN agent_runs r ON r.id = c.agent_run_id
       WHERE c.agent_run_id = $1`,
      [minted.run.id],
    );

    expect(rows).toEqual([{ credential_tenant: tenantB, run_tenant: tenantB }]);
  });

  it("resolves each tenant's credential into its own tenant", async () => {
    const zero = await mintIn(tenantZero);
    const b = await mintIn(tenantB);

    expect(await resolveMcpRunCredential(pool, zero.token)).toMatchObject({ tenantId: tenantZero, runId: zero.run.id });
    expect(await resolveMcpRunCredential(pool, b.token)).toMatchObject({ tenantId: tenantB, runId: b.run.id });
  });

  it("returns null for an unknown token and for a credential of a suspended tenant", async () => {
    const b = await mintIn(tenantB);
    expect(await resolveMcpRunCredential(pool, "unknown-token")).toBeNull();

    await adminPool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantB]);

    expect(await resolveMcpRunCredential(pool, b.token)).toBeNull();
  });

  it("refuses to mint for another tenant's Projects item, creating no run or credential", async () => {
    const foreignItemId = await runInTenant(tenantZero, () => createTestProjectItem(pool));
    await runInTenant(tenantB, () => createTestProjectItem(pool));

    await expect(
      runInTenant(tenantB, () =>
        withTransaction(pool, (client) =>
          mintMcpRunCredential(client, { projectItemId: foreignItemId, capabilities: ["core.item.read"], userId }),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { rows } = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM agent_runs`);
    expect(rows[0]!.count).toBe("0");
  });

  it("keeps working inside a tenant scope for an insert that omits tenant_id, as the previous release's mint does", async () => {
    const minted = await mintIn(tenantZero);
    await adminPool.query(`DELETE FROM agent_run_mcp_credentials WHERE agent_run_id = $1`, [minted.run.id]);

    // Two tenants exist, so the default only resolves inside a tenant scope.
    const result = await withTenantTransaction(adminPool, tenantZero, (client) =>
      client.query(
        `INSERT INTO agent_run_mcp_credentials (agent_run_id, token_hash, capabilities, expires_at)
         SELECT id, 'legacy-hash', ARRAY['core.item.read'], now() + interval '1 hour' FROM agent_runs WHERE id = $1`,
        [minted.run.id],
      ),
    );

    expect(result.rowCount).toBe(1);
  });
});
