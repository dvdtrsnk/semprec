import type { Pool, PoolClient } from "pg";
import { CAPABILITY_IDS, type CapabilityId } from "@semprec/shared";
import { requireSingleRow } from "../db/pool.js";

export interface CreateMcpRunCredentialInput {
  agentRunId: string;
  tokenHash: string;
  capabilities: readonly CapabilityId[];
  expiresAt: Date;
}

export interface McpRunCredentialRow {
  id: string;
  agentRunId: string;
  capabilities: CapabilityId[];
  expiresAt: string;
}

type McpRunCredentialDbRow = {
  id: string;
  agent_run_id: string;
  capabilities: string[];
  expires_at: Date;
};

/** Drops any stored value outside the current `CAPABILITY_IDS` set rather than trusting the column's declared `text[]` shape. */
function toCapabilityIds(values: string[]): CapabilityId[] {
  return values.filter((value): value is CapabilityId => (CAPABILITY_IDS as readonly string[]).includes(value));
}

function mapRow(row: McpRunCredentialDbRow): McpRunCredentialRow {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    capabilities: toCapabilityIds(row.capabilities),
    expiresAt: row.expires_at.toISOString(),
  };
}

/** Throws (unique violation) if `agentRunId` already has a credential — one credential per run, by design. */
export async function createMcpRunCredential(
  client: Pool | PoolClient,
  input: CreateMcpRunCredentialInput,
): Promise<McpRunCredentialRow> {
  const { rows } = await client.query<McpRunCredentialDbRow>(
    `INSERT INTO agent_run_mcp_credentials (agent_run_id, token_hash, capabilities, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, agent_run_id, capabilities, expires_at`,
    [input.agentRunId, input.tokenHash, [...input.capabilities], input.expiresAt],
  );
  return mapRow(requireSingleRow(rows, "agent_run_mcp_credentials row"));
}

export interface ActiveMcpRunCredential {
  runId: string;
  agentProjectItemId: string;
  actorUserId: string;
  capabilities: CapabilityId[];
}

/**
 * Resolves a presented token to the run it authenticates, or `null` if the token is unknown,
 * expired, or its run is no longer `running` — the same "credential still live" bar
 * `getActiveSessionByTokenHash` applies to a session, plus the owning run's own status.
 * `agent_runs.project_item_id` is nullable in general, but the mint action always supplies one for
 * a credentialed run; a `NULL` here would mean the schema was reached from outside that action, so
 * it is treated the same as "no credential" rather than trusted.
 */
export async function getActiveMcpRunCredentialByTokenHash(
  client: Pool | PoolClient,
  tokenHash: string,
): Promise<ActiveMcpRunCredential | null> {
  const { rows } = await client.query<{
    run_id: string;
    project_item_id: string | null;
    actor_user_id: string;
    capabilities: string[];
  }>(
    `SELECT r.id AS run_id, r.project_item_id, r.actor_user_id, c.capabilities
     FROM agent_run_mcp_credentials c
     JOIN agent_runs r ON r.id = c.agent_run_id
     WHERE c.token_hash = $1 AND c.expires_at > now() AND r.status = 'running'`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row || row.project_item_id === null) return null;
  return {
    runId: row.run_id,
    agentProjectItemId: row.project_item_id,
    actorUserId: row.actor_user_id,
    capabilities: toCapabilityIds(row.capabilities),
  };
}
