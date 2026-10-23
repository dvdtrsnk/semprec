-- Issue #220 (AC34/44/47): a restricted MCP run-credential. `POST /mcp`'s actor has always been
-- derived solely from the human session (`authenticateRequest`) and so never carried a `runId`/
-- `agentProjectItemId` pair — `gateway.invoke`'s approval gate is unreachable from this transport,
-- and every session shares the same fixed, process-wide capability set. This table backs a second,
-- additive way to authenticate to `POST /mcp`: a short-lived, single-run-scoped opaque credential
-- minted (still only by an authenticated human session, via `POST /api/agent-runs/mcp-credentials`)
-- for one `agent_runs` row and an explicit capability subset, so an MCP actor presenting it gets a
-- restricted `AuthenticatedActor { userId, runId, agentProjectItemId }` the approval gate actually
-- applies to. The existing session/cookie path (`sessions`, `authHandler.ts`) is untouched.
--
-- Mirrors `sessions` (0025_auth_schema.sql) and `password_reset_tokens` (0027_password_reset_tokens.sql):
-- a dedicated table keyed by a hashed opaque token, not columns bolted onto `agent_runs` itself, so
-- that table's shape and its many existing readers stay untouched. One credential per run (`UNIQUE
-- (agent_run_id)`) — this mechanism exists to let one particular MCP-triggered run authenticate,
-- not to be a general reusable API-token system.
CREATE TABLE agent_run_mcp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id),
  token_hash text NOT NULL,
  capabilities text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_run_mcp_credentials_token_hash_key ON agent_run_mcp_credentials (token_hash);
CREATE UNIQUE INDEX agent_run_mcp_credentials_agent_run_id_key ON agent_run_mcp_credentials (agent_run_id);
