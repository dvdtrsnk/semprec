-- Bookkeeping for manifest-declared, resumable module data migrations (issue #111): a
-- version-pair transition of a database's items, run in batches by the module data
-- migration runner (migrationJob/moduleDataMigration.ts), not by this file itself — a
-- deploy must never block on a long-running backfill (see the db-migrations skill).
--
-- A row here means "(module_id, database_key, from_version, to_version) fully converted,
-- every row exactly once" and is only ever inserted after every item finishes, so its mere
-- existence answers "is this transition done" with no other state to consult.
CREATE TABLE module_migrations (
  module_id text NOT NULL,
  database_key text NOT NULL,
  from_version text NOT NULL,
  to_version text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module_id, database_key, from_version, to_version)
);

-- The in-progress cursor for whatever data migration is currently converting this
-- database's items: the last successfully committed item id, so a crash retry resumes
-- id-ordered pagination from here instead of restarting from zero. Deviation from the
-- issue's literal `properties.migration_cursor`: `properties` already carries an unrelated
-- per-property `migration_status` (the existing single-property type-conversion feature,
-- migrationJob/propertyTypeMigration.ts), and a module data migration converts a whole
-- database's items for one (module_id, database_key, from_version, to_version) transition,
-- not one property — so its progress is scoped to the `databases` row identified by
-- `database_key` (`databases.owner_module_id`), not to `properties`. Cleared back to NULL
-- once the transition's `module_migrations` row is recorded.
ALTER TABLE databases ADD COLUMN migration_cursor uuid;
