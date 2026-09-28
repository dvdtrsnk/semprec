-- Issue #663: the in-progress state of one module data migration transition, keyed by the
-- same (module_id, database_key, from_version, to_version) as its advisory lock and its
-- `module_migrations` row, so two transitions on the same database no longer share (and
-- clobber) one cursor. `pass` is the runner's current pass (1 skips locked rows, 2 revisits
-- every row), `cursor` the last item id committed in that pass. The row is deleted in the
-- same transaction that records the transition's `module_migrations` row.
--
-- Expand-only: `databases.migration_cursor` (0011) is left in place, unused by this release;
-- dropping it is a later contract step. The `semprec_side` grant follows
-- 0040_least_privilege_roles.sql's side-table convention (`semprec_data` inherits it).
CREATE TABLE module_migration_progress (
  module_id text NOT NULL,
  database_key text NOT NULL,
  from_version text NOT NULL,
  to_version text NOT NULL,
  pass smallint NOT NULL DEFAULT 1 CHECK (pass IN (1, 2)),
  cursor uuid,
  PRIMARY KEY (module_id, database_key, from_version, to_version)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON module_migration_progress TO semprec_side;
