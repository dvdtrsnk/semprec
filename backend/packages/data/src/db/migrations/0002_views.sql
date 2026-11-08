-- Views layer (issue #22): views, curated view membership.
--
-- Deviation from the issue's literal DDL, same reason as `item_relations` in
-- 0001_core_schema.sql: `items`'s primary key is the composite (database_id, id)
-- because it is LIST-partitioned by database_id, so Postgres cannot express a bare
-- `REFERENCES items(id)` foreign key. `view_items.item_id` is therefore a plain
-- indexed uuid column with no Postgres FK; referential integrity for it is enforced
-- at the application layer (the choke-point), not by Postgres. Everything else
-- follows the issue's DDL as given.

CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id uuid REFERENCES databases(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  owner_module_id text,
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'ai_agent', 'system')),
  CONSTRAINT views_curated_no_db CHECK (
    (database_id IS NULL) = (config->>'membership' IS NOT DISTINCT FROM 'manual')
  )
);

CREATE UNIQUE INDEX views_one_default_per_db
  ON views (database_id) WHERE is_default;

CREATE TABLE view_items (
  view_id uuid NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (view_id, item_id)
);

CREATE INDEX view_items_item_id_idx ON view_items (item_id);
