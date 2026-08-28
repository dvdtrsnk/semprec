-- Row-level status/lock for per-item automation (issue #25): replaces the ad-hoc,
-- user-toggleable "processedByHeartbeat" boolean, which conflated status and lock and
-- had no way to represent an error. Not library-specific — a plain per-item table any
-- heartbeat-driven process can adopt, the same way `blobs` (0004_ten_databases.sql)
-- isn't Files-specific.
--
-- No Postgres FK to `items(id)`, same reason as `item_relations`/`task_recurrence`/
-- `view_items.item_id`: `items` is PARTITION BY LIST (database_id) with composite PK
-- (database_id, id), so a bare `REFERENCES items(id)` cannot be expressed. Referential
-- integrity is enforced at the application layer, same as those tables.
CREATE TABLE item_automation (
  item_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error', 'locked')),
  error text,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz
);
