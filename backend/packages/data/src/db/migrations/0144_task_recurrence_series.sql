-- Issue #1605: a recurring task series (docs/adr/2026-10-25-task-and-event-recurrence-model.md) is one
-- `task_recurrence` row with a stable `series_id`, the `anchor_date` the series starts on and the `template`
-- its occurrences are created from. The row's `item_id` follows the current open instance.
--
-- Expand only: the three columns are nullable and have no default, so the ALTER is catalog-only and the
-- previous release, which never names them, keeps inserting and reading rows unchanged. The per-tenant cutover
-- `tasks/taskRecurrenceSeriesCutoverMigration.ts` fills them for active rows; rows it leaves without a series
-- (inactive rows and rows whose instance is done) keep NULL. An active row whose instance is missing or dateless
-- fails that tenant's cutover instead of being left behind.
--
-- The table keeps its existing tenant column, row-level security policies (0059, 0060) and table-level grants
-- (0040), which cover the new columns. The unique index leads with `tenant_id`; Postgres treats NULLs as
-- distinct, so any number of rows without a series coexist. No `INSERT ... ON CONFLICT` targets this table.
--
-- Lock: ADD COLUMN and CREATE INDEX take ACCESS EXCLUSIVE and SHARE on `task_recurrence` until this transaction
-- commits. The table holds one row per recurring series, so the index build is short; the lock timeout makes the
-- migration fail instead of queueing every completion behind a long transaction that holds the table.
SET LOCAL lock_timeout = '5s';
ALTER TABLE task_recurrence
  ADD COLUMN series_id uuid,
  ADD COLUMN anchor_date date,
  ADD COLUMN template jsonb;
CREATE UNIQUE INDEX task_recurrence_tenant_series_id_uq ON task_recurrence (tenant_id, series_id);
