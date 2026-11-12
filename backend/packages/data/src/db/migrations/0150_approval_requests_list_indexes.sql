-- Issue #1785: the two lists of GET /api/approval-requests. Additive only: two indexes and an
-- extension statement that changes nothing where the extension exists, so the previous release's
-- code is unaffected.
--
-- The pending list reads the requests of one status in the order of requested_at, the decided list
-- reads the requests that are no longer pending and have a decision time in the order of
-- decided_at; both are read newest first by default. No index of the table had either instant among
-- its keys.
--
-- The list's search folds text with unaccent(). 0006_mail_sync.sql creates the extension, so the
-- statement below does nothing on a database that ran it; a database without the extension gets it
-- here.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE INDEX approval_requests_tenant_status_requested_idx
  ON approval_requests (tenant_id, status, requested_at DESC);

CREATE INDEX approval_requests_tenant_decided_idx
  ON approval_requests (tenant_id, decided_at DESC) WHERE status <> 'pending';
