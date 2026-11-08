-- Core schema for the generic data engine (issue #21).
--
-- Deviation from the illustrative DDL in the issue: `items` is
-- `PARTITION BY LIST (database_id)`. Postgres requires every unique/primary-key
-- constraint on a partitioned table to include the partition key column, so a
-- bare `id uuid PRIMARY KEY` (as sketched in the issue) is not valid DDL, and a
-- plain `UNIQUE (id)` is equally impossible. Two consequences follow, applied
-- consistently below:
--   1. `items`'s primary key is the composite `(database_id, id)`.
--   2. Other tables that reference an item by id (`item_relations`,
--      `project_heartbeats.project_item_id`, `agent_runs.project_item_id`,
--      `databases.parent_item_id`, `databases.owner_project_item_id`) store a
--      plain indexed `uuid` column with NO Postgres foreign key, since Postgres
--      cannot express "references items(id)" against a partitioned table
--      without also carrying database_id. Referential integrity for these
--      columns is enforced at the application layer (the choke-point /
--      SchedulerStore), not by Postgres. This is a narrow, necessary deviation
--      to make the requested partitioning scheme valid SQL — everything else
--      follows the issue's DDL as given.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- parent_item_id / owner_project_item_id point at rows in `items`, which does
-- not exist yet (and, per the note above, can never carry a real FK from here
-- anyway). Left as plain indexed uuid columns.
CREATE TABLE databases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  parent_item_id uuid,
  owner_project_item_id uuid,
  owner_module_id text,
  schema_locked boolean NOT NULL DEFAULT false,
  system boolean NOT NULL DEFAULT false,
  archived_at timestamptz
);

CREATE INDEX databases_parent_item_id_idx ON databases (parent_item_id) WHERE parent_item_id IS NOT NULL;
CREATE INDEX databases_owner_project_item_id_idx ON databases (owner_project_item_id) WHERE owner_project_item_id IS NOT NULL;

CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id uuid NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  locked boolean NOT NULL DEFAULT false,
  owner text NOT NULL DEFAULT 'user' CHECK (owner IN ('user', 'system')),
  owner_process text,
  migration_status text NOT NULL DEFAULT 'stable'
    CHECK (migration_status IN ('stable', 'pending', 'running', 'done', 'partial')),
  UNIQUE (database_id, key)
);

CREATE TABLE relation_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id_a uuid NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
  property_id_b uuid UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
  cardinality text NOT NULL DEFAULT 'many_to_many'
    CHECK (cardinality IN ('one_to_one', 'one_to_many', 'many_to_many'))
);

-- See the header note: composite PK (database_id, id) because Postgres
-- requires the partition key in every unique constraint on a partitioned
-- table. Every partition is created explicitly by DatabasesStore.createDatabase
-- in the same transaction as the owning `databases` row — there is no DEFAULT
-- partition, so an insert for an unknown database_id fails loudly.
CREATE TABLE items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  database_id uuid NOT NULL REFERENCES databases(id),
  properties jsonb NOT NULL DEFAULT '{}',
  computed jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (database_id, id)
) PARTITION BY LIST (database_id);

CREATE INDEX items_props_gin ON items USING gin (properties jsonb_path_ops);

CREATE TABLE item_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_definition_id uuid NOT NULL REFERENCES relation_definitions(id) ON DELETE CASCADE,
  item_a uuid NOT NULL,
  item_b uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (relation_definition_id, item_a, item_b)
);

CREATE INDEX item_relations_item_a_idx ON item_relations (item_a);
CREATE INDEX item_relations_item_b_idx ON item_relations (item_b);

CREATE TABLE project_heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_item_id uuid NOT NULL,
  name text NOT NULL,
  rule jsonb NOT NULL,
  action_id text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_heartbeats_due_idx
  ON project_heartbeats (next_fire_at) WHERE enabled AND next_fire_at IS NOT NULL;
CREATE INDEX project_heartbeats_project_idx
  ON project_heartbeats (project_item_id);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_item_id uuid,
  parent_run_id uuid REFERENCES agent_runs(id),
  heartbeat_id uuid REFERENCES project_heartbeats(id),
  triggered_by text NOT NULL CHECK (triggered_by IN ('user', 'heartbeat', 'supervisor', 'mcp')),
  unit text NOT NULL DEFAULT 'invocation' CHECK (unit IN ('invocation', 'session')),
  task text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
  result text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX agent_runs_project_item_id_idx ON agent_runs (project_item_id);
CREATE INDEX agent_runs_parent_run_id_idx ON agent_runs (parent_run_id);
CREATE INDEX agent_runs_heartbeat_id_idx ON agent_runs (heartbeat_id);

CREATE TABLE resource_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL CHECK (resource_type = 'project'),
  resource_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, grantee_user_id)
);

CREATE TABLE rollup_dependencies (
  rollup_property_id uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  relation_definition_id uuid NOT NULL REFERENCES relation_definitions(id) ON DELETE CASCADE,
  source_database_id uuid NOT NULL REFERENCES databases(id),
  source_property_key text
);
CREATE INDEX rollup_dependencies_source_idx ON rollup_dependencies (source_database_id, source_property_key);
CREATE INDEX rollup_dependencies_reldef_idx ON rollup_dependencies (relation_definition_id);

-- Minimal stub sufficient for the heartbeat_error write this issue makes; the
-- full notifications system (typology, delivery channels) is a later issue.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Backs the choke-point's Idempotency-Key handling for create-item: a repeat
-- request with the same key returns the row created the first time instead of
-- inserting a second one. No FK to items(id): see the header note.
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  database_id uuid NOT NULL,
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
