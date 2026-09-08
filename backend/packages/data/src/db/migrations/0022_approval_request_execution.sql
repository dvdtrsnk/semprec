-- Execution outcome columns for `approval_requests` (issue #131). `approval_requests` is
-- itself the audit trail for a decision (see #130's migration and agentRunsStore.ts's own
-- "no second log table" convention) — these columns extend that same row with the outcome of
-- the deferred choke-point call once it actually runs, instead of a separate log table.
--
-- `executed_at` doubles as an execution claim: the handler atomically sets it (`WHERE
-- executed_at IS NULL`) before calling out, so a redelivered queue job is a deterministic
-- no-op rather than a second external side effect. `execution_error`/`execution_result` are
-- filled in immediately after, mirroring the shape of `McpInvokeResult`.
ALTER TABLE approval_requests
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN execution_error boolean,
  ADD COLUMN execution_result text;
