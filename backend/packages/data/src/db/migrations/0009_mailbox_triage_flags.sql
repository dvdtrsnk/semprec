-- Mailbox triage flags (issue #97). Both statements are additive property-row changes on
-- already-seeded databases; fresh installs get the same shape from seed/seedEmailModule.ts.
-- Both are no-ops when the Emails database does not exist yet (migrations run before the
-- seed) and re-runnable.

-- Emails.flagged: flag state as an ordinary generic checkbox, the counterpart of `read`.
-- owner:'user' — the mailbox's triage actions set it through the generic item-update path,
-- and it mirrors the canonical IMAP `\Flagged` flag (mail/messageFlags.ts).
INSERT INTO properties (database_id, key, name, type, config, owner)
SELECT id, 'flagged', 'Flagged', 'checkbox', '{}'::jsonb, 'user'
FROM databases
WHERE owner_module_id = 'emails'
ON CONFLICT (database_id, key) DO NOTHING;

-- Emails.read was seeded owner:'system' by issue #96, when nothing could set it yet. Read
-- state is user state: the triage action marks a message read or unread through the same
-- generic update path as any other user-owned property, so the owner is relaxed to 'user'.
-- Widening only — nothing that could write it before loses that ability.
UPDATE properties
SET owner = 'user'
FROM databases
WHERE properties.database_id = databases.id AND databases.owner_module_id = 'emails' AND properties.key = 'read';
