-- Issue gh-1979, docs/adr/2026-11-14-mcp-tool-classification-is-owned-by-the-annotation-sync-until-a-person-sets-it.md:
-- records who set an MCP tool registration's `risk_class` and `requires_approval`.
-- 'annotation' means a tool sync derives them from the server's tool annotations and may rewrite
-- them on the next sync; 'manual' means a person set one of them (`setMcpToolRiskClass`,
-- `setMcpToolRequiresApproval`) and no sync rewrites them any more.
--
-- Existing rows are backfilled conservatively: a row that still holds the column defaults
-- (`unclassified`, approval required) becomes 'annotation', every other row becomes 'manual', so
-- nothing a person may have set is lost.
--
-- The whole change runs only when the column does not exist yet. A second run would otherwise
-- reclassify rows that a sync has since derived from annotations as 'manual', so it does nothing.
-- Additive: one new column with a default, existing readers and writers keep working.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'mcp_tool_registrations'::regclass
      AND attname = 'classification_source'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE mcp_tool_registrations
      ADD COLUMN classification_source text NOT NULL DEFAULT 'annotation',
      ADD CONSTRAINT mcp_tool_registrations_classification_source_check
        CHECK (classification_source IN ('annotation', 'manual'));

    UPDATE mcp_tool_registrations
      SET classification_source = 'manual'
      WHERE NOT (risk_class = 'unclassified' AND requires_approval = true);
  END IF;
END
$$;
