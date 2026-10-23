-- Emails.read (issue #96): read state as an ordinary generic checkbox property, so the
-- mailbox client's unread counts are a plain generic filter/count rather than a mailbox-only
-- read path. owner:'system' like every other Emails property — written by the triage action
-- and the sync worker, never through the generic update path.
--
-- Fresh installs get this property from seed/seedEmailModule.ts instead; this statement is
-- for databases seeded before it existed, and is a no-op both when the Emails database does
-- not exist yet (migrations run before the seed) and when the property already does.
INSERT INTO properties (database_id, key, name, type, config, owner)
SELECT id, 'read', 'Read', 'checkbox', '{}'::jsonb, 'system'
FROM databases
WHERE owner_module_id = 'emails'
ON CONFLICT (database_id, key) DO NOTHING;
