import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";

export interface CreateMcpRunCredentialInput {
  agentRunId: string;
  tokenHash: string;
  /** Validated by the mint action; readers intersect them with what is granted. */
  capabilities: readonly string[];
  expiresAt: Date;
}

export interface McpRunCredentialRow {
  id: string;
  agentRunId: string;
  capabilities: string[];
  expiresAt: string;
}

type McpRunCredentialDbRow = {
  id: string;
  agent_run_id: string;
  capabilities: string[];
  expires_at: Date;
};

function mapRow(row: McpRunCredentialDbRow): McpRunCredentialRow {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    capabilities: row.capabilities,
    expiresAt: row.expires_at.toISOString(),
  };
}

/**
 * One credential per run (unique violation otherwise). The tenant is copied from the run in the same statement; an
 * invisible run inserts nothing and fails `requireSingleRow`.
 */
export async function createMcpRunCredential(
  client: Pool | PoolClient,
  input: CreateMcpRunCredentialInput,
): Promise<McpRunCredentialRow> {
  const { rows } = await client.query<McpRunCredentialDbRow>(
    `INSERT INTO agent_run_mcp_credentials (tenant_id, agent_run_id, token_hash, capabilities, expires_at)
     SELECT r.tenant_id, r.id, $2, $3, $4 FROM agent_runs r WHERE r.id = $1
     RETURNING id, agent_run_id, capabilities, expires_at`,
    [input.agentRunId, input.tokenHash, [...input.capabilities], input.expiresAt],
  );
  return mapRow(requireSingleRow(rows, "agent_run_mcp_credentials row"));
}

export interface ActiveMcpRunCredential {
  tenantId: string;
  runId: string;
  agentProjectItemId: string;
  actorUserId: string;
  /** A reader keeps only the ids it knows and that are granted. */
  capabilities: string[];
}

/**
 * Must run inside the tenant `getMcpRunCredentialTenantByTokenHash` returned, so `agent_runs` is read under RLS.
 * `null` when unknown, expired, or the run is no longer `running`. A `NULL` project is treated as no credential
 * rather than trusted, since the mint action always sets one.
 */
export async function getActiveMcpRunCredentialByTokenHash(
  client: Pool | PoolClient,
  tokenHash: string,
): Promise<ActiveMcpRunCredential | null> {
  const { rows } = await client.query<{
    run_id: string;
    tenant_id: string;
    project_item_id: string | null;
    actor_user_id: string;
    capabilities: string[];
  }>(
    `SELECT r.id AS run_id, r.tenant_id, r.project_item_id, r.actor_user_id, c.capabilities
     FROM agent_run_mcp_credentials c
     JOIN agent_runs r ON r.id = c.agent_run_id
     WHERE c.token_hash = $1 AND c.tenant_id = r.tenant_id AND c.expires_at > now() AND r.status = 'running'`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row || row.project_item_id === null) return null;
  return {
    tenantId: row.tenant_id,
    runId: row.run_id,
    agentProjectItemId: row.project_item_id,
    actorUserId: row.actor_user_id,
    capabilities: row.capabilities,
  };
}

/** Global-plane read before any tenant is known, so it must run in system scope. */
export async function getMcpRunCredentialTenantByTokenHash(
  client: Pool | PoolClient,
  tokenHash: string,
): Promise<string | null> {
  const { rows } = await client.query<{ tenant_id: string }>(
    `SELECT c.tenant_id
     FROM agent_run_mcp_credentials c
     JOIN tenants t ON t.id = c.tenant_id
     WHERE c.token_hash = $1 AND c.expires_at > now() AND t.status = 'active'`,
    [tokenHash],
  );
  return rows[0]?.tenant_id ?? null;
}
