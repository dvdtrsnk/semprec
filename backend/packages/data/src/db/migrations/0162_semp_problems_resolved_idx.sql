-- Issue gh-1919: the recently resolved problems of GET /api/semp-status. Additive only: one index,
-- so the previous release's code is unaffected.
--
-- The list reads the resolved problems of one tenant of the last seven days, newest first. The two
-- existing indexes of semp_problems are partial on `resolved_at IS NULL` (the active problems), so
-- neither can serve it. The index keeps the order of that read (and, scanned backwards, the order of
-- the retention sweep's `ORDER BY resolved_at, id`).
CREATE INDEX semp_problems_tenant_resolved_idx
  ON semp_problems (tenant_id, resolved_at DESC, id DESC) WHERE resolved_at IS NOT NULL;
