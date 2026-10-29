-- Issue #1391: a user-editable, localized human label per MCP tool registration, shaped
-- `{ "cs"?: string, "en"?: string }`, NULL when no label exists. Written only by the user-only
-- `setMcpToolDisplayLabel`; a discovery sync never touches it. Additive: nullable, no default.
ALTER TABLE mcp_tool_registrations
  ADD COLUMN display_label jsonb,
  ADD CONSTRAINT mcp_tool_registrations_display_label_object
    CHECK (display_label IS NULL OR jsonb_typeof(display_label) = 'object');
