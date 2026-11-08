-- Issue #235 (system-i18n 01/05): adds `databases.key`, the stable unique English camelCase
-- identifier `properties.key` already has, and relaxes `databases.name`/`properties.name` to
-- nullable. A null name is an override slot for the translation catalog issue #146 ships, not
-- a "no name" state: until issue #147 wires the resolver, a serializer needing a display
-- string falls back to the raw `key` as a placeholder. `system: false` rows still require a
-- name — enforced by application validation (databasesStore.createDatabase /
-- propertiesStore.createProperty), not by a DB constraint, since the column now carries both
-- kinds of row. Purely additive/relaxing, per the db-migrations skill: new nullable column,
-- new unique constraint, dropped NOT NULLs.
ALTER TABLE databases ADD COLUMN IF NOT EXISTS key text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'databases_key_unique') THEN
    ALTER TABLE databases ADD CONSTRAINT databases_key_unique UNIQUE (key);
  END IF;
END $$;
ALTER TABLE databases ALTER COLUMN name DROP NOT NULL;
ALTER TABLE properties ALTER COLUMN name DROP NOT NULL;

-- Backfill for installs provisioned before this migration existed: assigns the ten hardcoded
-- databases' (issue #24) stable key — their existing `owner_module_id`, already English
-- camelCase per seed/tenDatabaseKeys.ts — and nulls their name plus their built-in
-- properties' names, converting the mandatory labels seed/seedTenDatabases.ts used to write
-- into overrides the future translation catalog can replace. A fresh install gets this
-- directly from seed/seedTenDatabases.ts instead, so this is a no-op there. Idempotent: safe
-- to re-run on every deploy.
--
-- Only the property keys seed/seedTenDatabasesInTransaction itself creates on each database
-- (own fields + every relation/inverse key it wires between the ten) are nulled below — not
-- every property under these database ids. Other module seeds add further properties onto
-- these same ids after schema_locked flips true (e.g. seed/seedEmailModule.ts's raw-SQL
-- People.emails insert), and those are out of this issue's scope, so their name is left as-is.
DO $$
DECLARE
  module_id text;
  db_id uuid;
  builtin_keys jsonb := '{
    "areas": ["name", "active", "note", "projects", "company", "healthRecord"],
    "projects": ["name", "pinned", "status", "date", "color", "agents", "systemActive", "area", "company", "people", "files", "healthRecords", "tasks", "events"],
    "tasks": ["name", "status", "date", "timeFrom", "timeTo", "time", "notifications", "persistent", "project"],
    "people": ["name", "relationship", "contact", "projects", "companies"],
    "files": ["name", "type", "date", "file", "area", "projects", "healthRecords", "companies"],
    "events": ["name", "type", "date", "people", "transcript", "actionItems", "company", "project"],
    "healthRecords": ["name", "date", "status", "subject", "type", "tags", "projects", "area", "files"],
    "companies": ["name", "ico", "web", "projects", "area", "people", "files", "meetings"],
    "transcripts": ["name", "status", "date", "notes", "link", "speakers", "event"],
    "journal": ["name", "type", "period", "area"]
  }'::jsonb;
BEGIN
  FOREACH module_id IN ARRAY ARRAY[
    'areas', 'projects', 'tasks', 'people', 'files',
    'events', 'healthRecords', 'companies', 'transcripts', 'journal'
  ]
  LOOP
    SELECT id INTO db_id FROM databases WHERE owner_module_id = module_id AND system = true;
    IF db_id IS NULL THEN
      CONTINUE;
    END IF;

    UPDATE databases SET key = module_id WHERE id = db_id AND key IS NULL;
    UPDATE databases SET name = NULL WHERE id = db_id;
    UPDATE properties
      SET name = NULL
      WHERE database_id = db_id
        AND name IS NOT NULL
        AND key IN (SELECT jsonb_array_elements_text(builtin_keys -> module_id));
  END LOOP;
END $$;
