-- Issue #89: the exactly-once execution protocol needs a state machine independent of the
-- human decision (`status`), an authoritative snapshot of the resource an approval was granted
-- against (to detect it changing before execution), and a structured execution result. Added
-- nullable/untyped per the expand/contract migration ADR
-- (docs/adr/2026-09-10-expand-contract-forward-only-migrations.md) — backfilling every existing
-- row (including recomputing a `legacy_unavailable` snapshot for rows that predate this column)
-- requires application code, so that step runs as
-- approvalRequestExecutionStatusCutoverMigration.ts immediately after structural migrations, the
-- same way 0042's actor_user_id cutover does.
--
-- `execution_result` was `text` (0022_approval_request_execution.sql), historically holding plain
-- (non-JSON) error/result strings, not just JSON-shaped ones — `to_jsonb()` wraps any existing
-- value as a JSON string scalar rather than attempting to parse it, so this conversion can never
-- fail on old data. Every pre-existing row's `execution_result` is unconditionally overwritten by
-- the `legacy_terminal` cutover backfill that runs immediately after this migration anyway (see
-- approvalRequestExecutionStatusCutoverMigration.ts), so what this cast produces for old rows is
-- moot beyond "must not throw".
ALTER TABLE approval_requests
  ADD COLUMN resource_snapshot jsonb,
  ADD COLUMN execution_status text;

ALTER TABLE approval_requests
  ALTER COLUMN execution_result TYPE jsonb USING to_jsonb(execution_result);
