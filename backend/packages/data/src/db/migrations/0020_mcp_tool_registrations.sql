-- MCP tool registrations and per-project grants (issue #124).
--
-- `mcp_server_item_id` references an `mcpServers` item (issue #123's item-model system
-- database). Like every other column across this schema that references a row in the
-- partitioned `items` table (see migration 0001's header note), it's a plain indexed `uuid`
-- with no Postgres foreign key — referential integrity there is an application-layer concern.
--
-- `mcp_tool_registrations` is a plain (non-partitioned) table, so `project_mcp_grants` CAN
-- carry a real foreign key to it, unlike the `items`-referencing columns above.
--
-- `risk_class` intentionally has no CHECK-constrained enum: this issue persists the column
-- and its 'unclassified' default, but the actual classification taxonomy is out of scope
-- ("Automatic risk classification" — see the issue's Out of scope section) and undefined by
-- it, so constraining it here would invent values nobody has specified yet.
--
-- Discoverability/availability (`mcp_tool_registrations`) and per-project visibility
-- (`project_mcp_grants.granted`) are independent facts per the issue's Context — a tool can
-- be registered and active without any project having granted it yet, which is exactly what
-- the `granted boolean NOT NULL DEFAULT false` below encodes.
CREATE TABLE mcp_tool_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_server_item_id uuid NOT NULL,
  tool_name text NOT NULL,
  tool_schema jsonb NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  risk_class text NOT NULL DEFAULT 'unclassified',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mcp_server_item_id, tool_name)
);

CREATE INDEX mcp_tool_registrations_server_item_idx ON mcp_tool_registrations (mcp_server_item_id);

-- No FK on `project_item_id` for the same partitioned-`items` reason as above; a real FK on
-- `mcp_tool_registration_id` since that table is not partitioned.
CREATE TABLE project_mcp_grants (
  project_item_id uuid NOT NULL,
  mcp_tool_registration_id uuid NOT NULL REFERENCES mcp_tool_registrations(id),
  granted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_item_id, mcp_tool_registration_id)
);

CREATE INDEX project_mcp_grants_tool_registration_idx ON project_mcp_grants (mcp_tool_registration_id);
