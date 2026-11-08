-- Issue #1683: the localisable description of an approval request, snapshotted when the request is
-- created. It holds a template key and parameters (never rendered text), so clients and pushes
-- render it from the user's locale catalogs and later renames or data changes never alter it.
--
-- Expand-only and rollback-safe: one nullable column with no default, no backfill and no CHECK
-- that the previous release neither reads nor writes (its `SELECT *` mapping ignores unknown
-- columns). Rows created before this migration keep NULL and clients fall back to the operation label.
ALTER TABLE approval_requests ADD COLUMN description jsonb NULL;
