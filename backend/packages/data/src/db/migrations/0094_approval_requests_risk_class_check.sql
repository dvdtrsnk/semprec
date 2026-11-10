-- Issue #1423: approval_requests.risk_class becomes a closed set shared with the generic
-- operation metadata (RISK_CLASSES in packages/shared). Unknown legacy values are backfilled to
-- 'unclassified' first so the CHECK can be added. mcp_tool_registrations.risk_class stays free
-- text here; the snapshot into an approval request normalises unknown values.
UPDATE approval_requests
  SET risk_class = 'unclassified'
  WHERE risk_class NOT IN ('unclassified', 'read', 'write', 'destructive', 'outbound', 'breaksLink');

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_risk_class_check
    CHECK (risk_class IN ('unclassified', 'read', 'write', 'destructive', 'outbound', 'breaksLink'));
