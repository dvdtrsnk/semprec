import type { Pool } from "pg";
import { resolveMcpRunCredential } from "@semprec/data";
import { CAPABILITY_IDS, runAsSystem, type AuthenticatedActor, type CapabilityId } from "@semprec/shared";

export interface RunCredentialCaller {
  actor: AuthenticatedActor;
  /**
   * The credential's capabilities intersected with the process's granted set: a credential only
   * ever narrows it.
   */
  capabilities: ReadonlySet<CapabilityId>;
  /**
   * What the credential lists that is not a core id. Not intersected with the process's set (core
   * ids only); the module tool resolver intersects them with the project's grants, so a credential
   * never gets tools of a module capability it does not list.
   */
  moduleCapabilities: ReadonlySet<string>;
  tenantId: string;
}

/**
 * `null` when the token is no run credential (a session token, an expired or unknown value). The
 * token is resolved to its tenant in the global plane inside the one scoped system lookup
 * `resolveMcpRunCredential` exists for; the credential is then read under RLS in that tenant. The
 * actor carries `runId` and `agentProjectItemId`, never `restSession`, so the gateway applies its
 * approval gate.
 *
 * Shared by `POST /mcp` and `POST /api/items/:id/page/insert`; each caller decides what `null`
 * means.
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
    moduleCapabilities: new Set(
      credential.capabilities.filter((id) => !(CAPABILITY_IDS as readonly string[]).includes(id)),
    ),
    tenantId: credential.tenantId,
  };
}
