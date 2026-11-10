-- Records when and by whom a document was last edited (issue #1405). Expand-only:
-- both columns are nullable and there is no backfill; a document without a recorded
-- edit reads its created_at as the last edit time. The existing docs row-level
-- security policies and role grants are table-level and already cover new columns.
ALTER TABLE docs
  ADD COLUMN last_edited_at timestamptz NULL,
  ADD COLUMN last_edited_by text NULL,
  ADD CONSTRAINT docs_last_edited_by_check CHECK (last_edited_by IN ('user', 'ai_agent', 'system'));
