-- Ten hardcoded databases (issue #24): standalone tables that back Tasks'
-- recurrence and the Files DB's `file` property. The ten databases themselves,
-- their properties, and their relations are seeded in code (seed/seedTenDatabases.ts),
-- the same "code-level migration with direct DB access" pattern already used by
-- seed/seedSystem.ts for the Projects/System settings system databases — not DDL,
-- since a `databases`/`properties` row isn't a structural schema change.
--
-- Deviation from the issue's literal DDL, same reason as `item_relations`
-- (0001_core_schema.sql), `view_items` (0002_views.sql), and `docs.item_id`
-- (0003_docs.sql): `items` is PARTITION BY LIST (database_id) with composite PK
-- (database_id, id), so Postgres cannot express a bare `REFERENCES items(id)`
-- foreign key. `task_recurrence.item_id` is therefore a plain indexed uuid
-- column (here as the primary key itself, per the issue's DDL) with no Postgres
-- FK; referential integrity is enforced at the application layer. Everything
-- else follows the issue's DDL as given.

CREATE TABLE task_recurrence (
  item_id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('fixed', 'floating')),
  rule jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true
);

-- Not Files-specific: also used later by library cover images (issue #25) and
-- email attachments (issue #26). `content_hash` is nullable — dedup enforcement
-- is out of this issue's scope, only the column and partial unique index are.
CREATE TABLE blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  storage_key text NOT NULL,
  source_url text,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX blobs_content_hash_uq ON blobs (content_hash) WHERE content_hash IS NOT NULL;

-- Journal's lazy item creation (issue #24, "an item for a given date is created implicitly
-- by the first write") needs no schema here: concurrency-safety comes from a deterministic
-- per-period idempotency key through the existing `idempotency_keys` reservation mechanism
-- (see journal/journalStore.ts, chokePoint/itemsStore.ts's insertItem), not a DB constraint.
