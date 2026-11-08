-- Inbox item types' processingMethod/targetDatabase (issue #102). Additive property-row
-- changes on the already-seeded, schema-locked Inbox item types database (issue #101);
-- fresh installs get the same shape from seed/seedInboxPipeline.ts. No-op when the
-- database does not exist yet (migrations run before the seed) and re-runnable.

-- processingMethod: replaces the mock's hardcoded label-text comparison. Cross-field
-- validation against targetDatabase is enforced in inbox/inboxTypesStore.ts, not by a
-- DB constraint here (same reason Inbox's date/time are enforced in inboxStore.ts).
INSERT INTO properties (database_id, key, name, type, config, owner)
SELECT id, 'processingMethod', 'Processing method', 'select', '{"options": ["pageContent", "database"]}'::jsonb, 'user'
FROM databases
WHERE owner_module_id = 'inboxItemTypes'
ON CONFLICT (database_id, key) DO NOTHING;

-- targetDatabase: not a `relation` property — a relation's target database is fixed at
-- creation time, but this must point at any one of the ten hardcoded databases (issue
-- #24), the same reason Processing proposals' resultItemId is `text`, not `relation`.
-- Stores the target's canonical `owner_module_id` key ('tasks', 'events', ...).
INSERT INTO properties (database_id, key, name, type, config, owner)
SELECT id, 'targetDatabase', 'Target database', 'select',
  '{"options": ["areas", "projects", "tasks", "people", "files", "events", "healthRecords", "companies", "transcripts", "journal"]}'::jsonb,
  'user'
FROM databases
WHERE owner_module_id = 'inboxItemTypes'
ON CONFLICT (database_id, key) DO NOTHING;
