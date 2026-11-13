-- Issue #1788: the name an MCP client reports about itself in `initialize`, stored on the run whose
-- credential the client connected with. It is display text: nothing reads it to authorize a call.
--
-- Additive and rollback-safe: one nullable column without a default, so every existing run reads
-- NULL without a backfill and an INSERT from the previous release, which omits the column, still
-- succeeds. The runtime roles already hold table-level privileges on `agent_runs`, so they can
-- write the new column. The check bounds the stored length in characters; the store shortens a
-- name to the same limit before it writes.
ALTER TABLE agent_runs
  ADD COLUMN mcp_client_name text CHECK (mcp_client_name IS NULL OR char_length(mcp_client_name) <= 64);
