-- Issue #1446: a stable, closed reason on every agent run that fails.
--
-- Additive and rollback-safe: two nullable columns, no backfill, no NOT NULL. A previous release
-- keeps closing runs as 'error' without a code; such a row reads back as 'internal'. The "every
-- error run carries a code" guarantee is enforced in code, not by a constraint.
--
-- error_detail holds a plain object of ids and counters only, never user content.
ALTER TABLE agent_runs
  ADD COLUMN error_code text CHECK (error_code IN ('budgetExceeded', 'modelError', 'cancelled', 'interrupted', 'internal')),
  ADD COLUMN error_detail jsonb;
