import type { Pool, PoolClient } from "pg";
import { CAPABILITY_IDS, type CapabilityId } from "@semprec/shared";
import { ValidationError } from "../errors.js";
import { generateOpaqueToken, hashToken } from "../auth/token.js";
import { createAgentRun, type AgentRunRow } from "../agentRuns/agentRunsStore.js";
import {
  createMcpRunCredential,
  getActiveMcpRunCredentialByTokenHash,
  type ActiveMcpRunCredential,
} from "./mcpRunCredentialsStore.js";

/**
 * How long a minted MCP run-credential stays valid. Short by design (unlike `SESSION_TTL_SECONDS`'s
 * 30 days): this credential authenticates one particular run's own `POST /mcp` calls, not a
 * standing integration, so there is no reason for it to outlive the task it was minted for by much.
 */
export const MCP_RUN_CREDENTIAL_TTL_SECONDS = 60 * 60; // 1 hour

export interface MintMcpRunCredentialInput {
  projectItemId: string;
  capabilities: readonly string[];
  task?: string;
  /**
   * The authenticated session user minting this credential (issue #220, AC11) — attributed to
   * the root `agent_run` this mints via `CreateAgentRunInput.userId`, instead of the
   * single-tenant setup-owner proxy `createAgentRun` falls back to for a root run with no
   * session to capture (a heartbeat-triggered one).
   */
  userId: string;
}

export interface MintMcpRunCredentialResult {
  token: string;
  run: AgentRunRow;
  capabilities: CapabilityId[];
  expiresAt: string;
}

function assertCapabilityIds(values: readonly string[]): CapabilityId[] {
  if (values.length === 0) {
    throw new ValidationError("'capabilities' must include at least one capability id");
  }
  const known: readonly string[] = CAPABILITY_IDS;
  for (const value of values) {
    if (!known.includes(value)) throw new ValidationError(`Unknown capability id '${value}'`);
  }
  return values as CapabilityId[];
}

/**
 * Mints a new root `agent_run` (`triggeredBy: 'mcp'`) scoped to `input.projectItemId`, plus a
 * single-run-scoped opaque credential restricted to `input.capabilities` (issue #220, AC34/44/47).
 * The credential is `POST /mcp`'s second, additive way to authenticate: presenting it as a Bearer
 * token resolves to a restricted `AuthenticatedActor { userId, runId, agentProjectItemId }` that
 * `gateway.invoke`'s approval gate actually applies to, unlike the plain human-session actor
 * (`authenticateRequest`, unmodified), which never carries a `runId` at all.
 *
 * Only reachable behind an already-authenticated human session — this function does not
 * authenticate anyone itself; it is the write a route handler performs once it already knows who
 * is asking (mirrors `login`'s split: token generation and expiry computation happen here, only
 * the hash is ever persisted, and the plaintext token is returned exactly once).
 */
export async function mintMcpRunCredential(
  client: Pool | PoolClient,
  input: MintMcpRunCredentialInput,
): Promise<MintMcpRunCredentialResult> {
  const capabilities = assertCapabilityIds(input.capabilities);

  const run = await createAgentRun(client, {
    projectItemId: input.projectItemId,
    triggeredBy: "mcp",
    task: input.task ?? "MCP run-credential session",
    userId: input.userId,
  });

  const { token, tokenHash } = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + MCP_RUN_CREDENTIAL_TTL_SECONDS * 1000);
  await createMcpRunCredential(client, { agentRunId: run.id, tokenHash, capabilities, expiresAt });

  return { token, run, capabilities, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolves a presented MCP run-credential token to the run it authenticates — the credential
 * counterpart to `verifySessionToken`, hashing internally so a composition root only ever handles
 * the raw bearer token, never its hash. Returns `null` for an unknown, expired, or no-longer-
 * `running` credential; `POST /mcp` falls back to the ordinary human-session path in that case
 * rather than rejecting outright, since the same bearer value could simply be a session token.
 */
export async function resolveMcpRunCredential(
  client: Pool | PoolClient,
  token: string,
): Promise<ActiveMcpRunCredential | null> {
  return getActiveMcpRunCredentialByTokenHash(client, hashToken(token));
}
