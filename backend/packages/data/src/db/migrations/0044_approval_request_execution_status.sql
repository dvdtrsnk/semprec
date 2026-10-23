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
-- `execution_result` (0022_approval_request_execution.sql) is `text`, historically holding plain
-- (non-JSON) error/result strings, not just JSON-shaped ones. Narrowing it in place with `ALTER
-- COLUMN ... TYPE jsonb` would be a type-narrowing change forbidden by the expand/contract ADR:
-- during a rolling deploy, an old process still running the previous release's
-- `recordApprovalRequestOutcome` (which writes a plain non-JSON string) would fail every
-- INSERT/UPDATE the instant this migration runs, before that process ever gets the new binary —
-- and a rollback afterwards would be unsafe, since the column could no longer hold what the old
-- code writes. Instead this is a pure expand step: `execution_result` stays exactly as it was,
-- untouched, and a new nullable `execution_result_jsonb` column is added alongside it.
-- `approvalRequestExecutionStatusCutoverMigration.ts` backfills `execution_result_jsonb` for
-- every pre-existing row, and this release's code (`approvalRequestsStore.ts`) reads and writes
-- only `execution_result_jsonb` going forward — `execution_result` becomes dead weight that a
-- later contract-step migration can drop once the pre-#89 binary is fully retired.
ALTER TABLE approval_requests
  ADD COLUMN resource_snapshot jsonb,
  ADD COLUMN execution_status text,
  ADD COLUMN execution_result_jsonb jsonb;
