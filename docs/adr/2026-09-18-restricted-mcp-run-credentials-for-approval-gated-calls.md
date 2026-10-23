---
status: accepted
date: 2026-09-18
area: [backend]
supersedes: []
superseded-by: null
---

# Restricted, single-run MCP credentials for approval-gated tool calls

## Context

[[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]
established `POST /mcp`'s actor as derived exclusively from the human
session/Bearer identity (`authenticateRequest`), carrying only `userId` —
never `runId`/`agentProjectItemId`. That was a correct baseline for the
issue's core transport work, but it leaves two of #220's acceptance criteria
structurally unreachable: `GenericOperationGateway`'s approval gate only
activates when an actor carries both `runId` and `agentProjectItemId`
(`assertCompleteAgentIdentity`), so a human-session MCP actor can never hit
it (AC44/47's "the approval-required path is reachable over MCP"); and
`grantedCapabilities` is fixed once per process, so every authenticated MCP
caller sees the same tool set regardless of who or what they are (AC34's
"per-identity capability restriction for restricted Bearer identities").

Neither gap has a defensible workaround inside the existing session model:
weakening `authenticateRequest` itself to sometimes carry a `runId`, or
letting a JSON-RPC param supply one, would make the approval gate's identity
provenance guarantee something a caller could simply assert about itself. A
new mechanism is required — its explicit design goal was to be the minimum
needed to make AC34/44/47 true and testable, not a general-purpose
API-token/service-account system.

## Decision

**Storage: a dedicated table, not columns on `agent_runs`.** A new
`agent_run_mcp_credentials` table (migration `0043`) mirrors `sessions`
(`0025_auth_schema.sql`) and `password_reset_tokens`
(`0027_password_reset_tokens.sql`) — `token_hash`, an expiry, a unique index
on the hash — rather than adding nullable token/expiry/capability columns
directly to `agent_runs`. This is the codebase's established shape for "an
opaque token that resolves to an identity, with expiry," and it keeps
`agent_runs`'s own schema, and its many existing readers, at zero diff. One
row per run (`UNIQUE (agent_run_id)`): this credential authenticates the one
run it was minted for, not a reusable token a caller can attach to arbitrary
runs.

**Minting is a write behind the existing session, not a new authentication
path.** `POST /api/agent-runs/mcp-credentials` (`agentRunHandler.ts`) is
gated by the same unmodified `authenticateRequest` every other write in that
handler uses. It creates a root `agent_run` (`triggeredBy: 'mcp'`, already a
valid but previously-dormant value) scoped to a caller-supplied
`projectItemId`, and a credential restricted to a caller-chosen subset of
`CAPABILITY_IDS` (rejecting an empty list or an unknown id outright). The
opaque token is generated and returned exactly once
(`mintMcpRunCredential`, mirroring `login`'s token-generation idiom byte for
byte); only its hash is ever persisted.

**Resolution is a second, additive branch in `mcpHandler.ts`, not a change to
the first.** `POST /mcp` now tries `resolveMcpRunCredential` (hash the
presented bearer token, look up the still-`running`, unexpired credential)
before falling back to the original, unmodified `authenticateRequest` path.
A resolved credential produces a restricted
`AuthenticatedActor { userId, runId, agentProjectItemId }` — the approval
gate applies to it exactly as it already does to an AgentTool actor. A
bearer token that isn't a live credential (including an ordinary session
token) falls through to `authenticateRequest` unchanged; `authHandler.ts`
itself — `extractToken`, `login`, `verifySessionToken`, `logout` — is not
modified anywhere by this decision.

**Capabilities intersect the process constant; they never call the manifest
machinery again.** A credential's stored capability list is intersected
against the same `grantedCapabilities: ReadonlySet<CapabilityId>` the
listener already closes over (computed once in `app.ts`), not by invoking
`generatePermissionManifest` per request. `generatePermissionManifest`'s own
`grantedCapabilities` output is computed as
`CAPABILITY_IDS.filter((id) => grantedModuleCapabilities.has(id))` — identical
for every `projectItemId`, i.e. not actually project-specific — so a second,
per-credential manifest call would cost a transaction and a query for a
value `app.ts` has already computed once at startup. A credential can only
ever narrow that process-wide set, never widen it.

**Short-lived, no revocation beyond expiry.** `MCP_RUN_CREDENTIAL_TTL_SECONDS`
is one hour, far shorter than `SESSION_TTL_SECONDS`'s 30 days: this
credential exists to let one particular MCP-triggered run authenticate its
own `POST /mcp` calls for roughly as long as that run is expected to act, not
to be a standing integration credential. There is deliberately no explicit
revoke endpoint — expiry, plus the existing `r.status = 'running'` check in
the resolution query, is the entire lifecycle story. Building revocation is
out of scope for what AC34/44/47 actually require.

## Consequences

- [[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]'s
  "there is no MCP-specific credential type" and "the approval gate is
  always a no-op for this transport" describe that ADR's original baseline;
  this decision is the one case where they no longer hold. Everything else in
  that ADR — hand-rolled JSON-RPC framing, one dispatch path through
  `GenericOperationGateway`, `semprec.`-prefixed tool names, the JSON-RPC
  error-code mapping — is unaffected and still governs.
- A future need for a longer-lived or explicitly revocable MCP credential is
  a new decision, not a quiet extension of this one's 1-hour/no-revocation
  choice.
- Expired `agent_run_mcp_credentials` rows are inert (excluded by
  `expires_at > now()`) but are never swept by this decision. A retention
  job, if one is ever needed, is a separate later concern — the same
  position the codebase already takes with `repairInterruptedRuns` having no
  production caller yet.
- Any future MCP-adjacent write that needs "prove which run you are" gets a
  credential the same way — minted behind an authenticated session, resolved
  as a second branch ahead of the primary auth path — rather than a new
  bespoke scheme per caller.
