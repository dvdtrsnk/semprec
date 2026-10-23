-- CRDT doc layer for free-form page/canvas content on Yjs (issue #23).
--
-- Deviation from the issue's literal DDL, same reason as `item_relations`
-- (0001_core_schema.sql) and `view_items` (0002_views.sql): `items` is
-- PARTITION BY LIST (database_id) with composite PK (database_id, id), so
-- Postgres cannot express a bare `REFERENCES items(id)` foreign key.
-- `docs.item_id` is therefore a plain indexed uuid column with no Postgres FK;
-- referential integrity for it is enforced at the application layer (the doc
-- store), not by Postgres. Everything else follows the issue's DDL as given.
--
-- `docs_item_id_idx` is UNIQUE: the issue states docs have "a 1:1 or 0:1
-- relationship to items" (singular, not one doc per kind), so at most one doc
-- row exists per item regardless of whether it ends up 'page' or 'canvas'.

CREATE TABLE docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'canvas')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX docs_item_id_idx ON docs (item_id);

CREATE TABLE doc_snapshots (
  doc_id uuid PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  state_vector bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only log of binary Yjs updates, periodically merged into doc_snapshots
-- (compaction) and deleted once merged. created_by reuses the CreatedBy vocabulary
-- (types.ts) — the Yjs `origin` parameter of doc.transact(fn, origin) propagates here.
CREATE TABLE doc_updates (
  id bigserial PRIMARY KEY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  update bytea NOT NULL,
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'ai_agent', 'system')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doc_updates_doc_id_idx ON doc_updates (doc_id, id);

-- Periodic full checkpoints for version history, independent of the ongoing
-- doc_updates log — see docHistory.ts. Retention is a time window (expires_at);
-- a cleanup job deletes expired rows.
CREATE TABLE doc_snapshot_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (created_by IN ('user', 'ai_agent', 'system'))
);

CREATE INDEX doc_snapshot_history_doc_id_taken_at_idx ON doc_snapshot_history (doc_id, taken_at);
CREATE INDEX doc_snapshot_history_expires_at_idx ON doc_snapshot_history (expires_at);
