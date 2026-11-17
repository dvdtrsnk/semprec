-- Fixture structural migration for the "e2e-alpha" module (module-contract issue #114): proves
-- the forward-only runner (`runMigrations`, issue #224) applies a manifest-declared migration
-- file exactly once, tracked alongside core's own migrations in the shared `schema_migrations`
-- table.
CREATE TABLE IF NOT EXISTS e2e_alpha_marker (
  id int PRIMARY KEY
);
