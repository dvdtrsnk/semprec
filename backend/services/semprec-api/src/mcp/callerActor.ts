import type { Pool } from "pg";
import { resolveMcpRunCredential } from "@semprec/data";
import { CAPABILITY_IDS, runAsSystem, type AuthenticatedActor, type CapabilityId } from "@semprec/shared";

/** A caller authenticated by a restricted MCP run credential, with what it may do and the tenant it belongs to. */
export interface RunCredentialCaller {
  actor: AuthenticatedActor;
  /** The credential's own capabilities intersected with the process's granted set: a credential only ever narrows it. */
  capabilities: ReadonlySet<CapabilityId>;
  tenantId: string;
}

/**
 * Resolves a bearer token to its run-credential caller, or `null` when the token is no run credential (a session
 * token, an expired or unknown value). The token is resolved to its tenant in the global plane before any tenant is
 * known, inside the one scoped system lookup `resolveMcpRunCredential` exists for; the credential itself is then
 * read under row-level security inside that tenant. The actor carries `runId` and `agentProjectItemId`, never a
 * `restSession` flag, so the gateway applies its approval gate and the writer is an agent run.
 *
 * Shared by `POST /mcp` and the one REST route that also accepts a run credential (`POST /api/items/:id/page/insert`);
 * what to do when this returns `null` (a session, or a refusal) stays with each caller.
 */
export async function resolveRunCredentialCaller(
  pool: Pool,
  bearerToken: string,
  grantedCapabilities: ReadonlySet<CapabilityId>,
): Promise<RunCredentialCaller | null> {
  const credential = await runAsSystem("mcp-run-credential-lookup", () => resolveMcpRunCredential(pool, bearerToken));
  if (!credential) return null;
  const capabilities = new Set(
    (CAPABILITY_IDS as readonly CapabilityId[]).filter(
      (id) => credential.capabilities.includes(id) && grantedCapabilities.has(id),
    ),
  );
  return {
    actor: {
      userId: credential.actorUserId,
      runId: credential.runId,
      agentProjectItemId: credential.agentProjectItemId,
    },
    capabilities,
    tenantId: credential.tenantId,
  };
}
