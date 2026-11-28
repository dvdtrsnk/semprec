import type { Pool, PoolClient } from "pg";
import { CAPABILITY_IDS } from "@alldots/shared";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { NotFoundError, ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { generateOpaqueToken, hashToken } from "../auth/token.js";
import { createAgentRun, type AgentRunRow } from "../agentRuns/agentRunsStore.js";
import {
  createMcpRunCredential,
  getActiveMcpRunCredentialByTokenHash,
  getMcpRunCredentialTenantByTokenHash,
  type ActiveMcpRunCredential,
} from "./mcpRunCredentialsStore.js";

/** Short by design: it authenticates one run's own `POST /mcp` calls, not a standing integration. */
export const MCP_RUN_CREDENTIAL_TTL_SECONDS = 60 * 60; // 1 hour

export interface MintMcpRunCredentialInput {
  projectItemId: string;
  capabilities: readonly string[];
  /**
   * A credential's list bounds what it may do, module tools included, so a module capability must be one of these;
   * left out, only core ids are accepted.
   */
  moduleCapabilityIds?: readonly string[];
  task?: string;
  /** The session user minting it, recorded as the root run's actor. */
  userId: string;
}

export interface MintMcpRunCredentialResult {
  token: string;
  run: AgentRunRow;
  capabilities: string[];
  expiresAt: string;
}

function assertCapabilityIds(values: readonly string[], moduleCapabilityIds: readonly string[]): string[] {
  if (values.length === 0) {
    throw new ValidationError("'capabilities' must include at least one capability id");
  }
  const known: readonly string[] = [...CAPABILITY_IDS, ...moduleCapabilityIds];
  for (const value of values) {
    if (!known.includes(value)) throw new ValidationError(`Unknown capability id '${value}'`);
  }
  return [...values];
}

/**
 * The credential is `POST /mcp`'s additional Bearer auth: it resolves to a restricted actor with a `runId`, which
 * the approval gate applies to (a plain human-session actor has none).
 *
 * Does not authenticate anyone itself; the route already knows the caller. Only the hash is persisted and the
 * plaintext token is returned exactly once. `projectItemId` must be a live Projects item visible under RLS, else
 * `NotFoundError` before any write.
 */
export async function mintMcpRunCredential(
  client: PoolClient,
  input: MintMcpRunCredentialInput,
): Promise<MintMcpRunCredentialResult> {
  const capabilities = assertCapabilityIds(input.capabilities, input.moduleCapabilityIds ?? []);

  const projectsDatabase = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projectsDatabase) throw new Error("The Projects system database does not exist");
  const project = await getItemById(client, projectsDatabase.id, input.projectItemId);
  if (!project || project.deletedAt !== null) throw new NotFoundError("Project not found");

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
 * `null` for an unknown, expired or non-`running` credential or an inactive tenant; `POST /mcp` then falls back to
 * the session path, since the same bearer value may be a session token.
 *
 * Reads the token's tenant in system scope, then the credential and run under RLS in that tenant, so it must not be
 * called inside a tenant scope (`runAsSystem` throws there).
 */
export async function resolveMcpRunCredential(pool: Pool, token: string): Promise<ActiveMcpRunCredential | null> {
  const tokenHash = hashToken(token);
  const tenantId = await runAsSystem("mcp:runCredentialTenant", () =>
    withTransaction(pool, (client) => getMcpRunCredentialTenantByTokenHash(client, tokenHash)),
  );
  if (tenantId === null) return null;
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) => getActiveMcpRunCredentialByTokenHash(client, tokenHash)),
  );
}
