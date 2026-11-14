-- Issue gh-1882: trashing a recurring task series (docs/adr/2026-11-14-a-recurring-task-series-is-trashed-and-restored-as-one-cascade.md)
-- turns its repeat rule off while the series is in the Trash and records which instance held the active rule, so
-- restoring that instance turns the rule on again and a rule that was already off stays off. The marker lives in the
-- series row, next to the `active` flag it qualifies: `trashed_active_item_id` is the `item_id` of the row at the
-- moment the trash set `active` to false, and NULL otherwise.
--
-- Expand only: one nullable column without a default, so the ALTER is catalog-only and the previous release, which
-- never names it, keeps inserting and reading rows unchanged. There is no foreign key (`items` is partitioned with a
-- composite key) and no index: the column is read and written only through the row's own `series_id` lookup.
--
-- The table keeps its tenant column, row-level security policies (0059, 0060) and table-level grants (0040), which
-- cover the new column.
--
-- Lock: ADD COLUMN takes ACCESS EXCLUSIVE on `task_recurrence` until this transaction commits. The table holds one row
-- per recurring series; the lock timeout makes the migration fail instead of queueing every completion behind a long
-- transaction that holds the table.
SET LOCAL lock_timeout = '5s';
ALTER TABLE task_recurrence ADD COLUMN trashed_active_item_id uuid;
