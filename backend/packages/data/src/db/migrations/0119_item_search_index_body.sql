-- Issue #1658, expand step: two nullable columns on the tenant-scoped search index, with no default
-- and no backfill, so the previous release keeps working against this schema after a rollback.
-- `page_text` holds the converted text of the item's own page and is written only by the page-text
-- job; `body` holds the excerpt source and is written only by the item search indexer. Existing
-- pages are converted on their next edit.
ALTER TABLE item_search_index ADD COLUMN body text;
ALTER TABLE item_search_index ADD COLUMN page_text text;
