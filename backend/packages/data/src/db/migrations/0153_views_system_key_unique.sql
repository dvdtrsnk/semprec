-- A system view is found by a stable key stored in its config (`config.systemKey`), not by its display name.
-- One view per key in a database. The index is scoped by the server-generated id of the database, which belongs
-- to one tenant, so it needs no tenant_id column. Additive: no existing view carries the key.
CREATE UNIQUE INDEX views_database_system_key_uq
  ON views (database_id, (config->>'systemKey'))
  WHERE config ? 'systemKey';
