-- Issue #674: message identity in `mail_message_meta` becomes per mailbox. An RFC 5322
-- `Message-ID` is global — the same message delivered to two of the user's mailboxes (a CC to
-- a work and a private address, a mailing list on both) carries one id — so deduping on
-- `message_id` alone made the second mailbox's sync converge onto the first mailbox's Emails
-- item, sharing its read/flag state and its pending IMAP flag writes across both mailboxes.
-- From this release on, `ingestEmailMessage` dedups on `(mailbox_item_id, message_id)`: the
-- same message in two mailboxes is two Emails items, each linked only to its own folders.
--
-- `mailbox_item_id` has no foreign key: `items` is partitioned by database, so its primary
-- key is `(database_id, id)` and a single-column reference is impossible. It stays nullable in
-- this release — legacy-migrated rows (migrationJob/mailLegacyEmailMigration.ts) have no
-- mailbox, and a pre-existing row with no resolvable folder edge is left NULL by the backfill
-- below. `NOT NULL` is a later contract step.
--
-- Rollback consequence: `UNIQUE (message_id)` has to go in this same release, or two rows
-- sharing one `message_id` could never coexist. The previous release's
-- `ON CONFLICT (message_id)` then has no arbiter index, so a `deploy.sh --rollback` past this
-- migration breaks mail ingest — this release is fix-forward only.
--
-- Every statement is idempotent so the file can be re-run against existing data
-- (mailSync.test.ts re-runs it to exercise the backfill).
--
-- expand-contract-exemption: dropping mail_message_meta_message_id_key is the intentionally breaking change issue #674's Task calls for (per-mailbox message identity); rollback past this release breaks the previous release's ON CONFLICT (message_id), fix-forward only.

ALTER TABLE mail_message_meta ADD COLUMN IF NOT EXISTS mailbox_item_id uuid;

-- Backfill: the Mailbox item reached through the message's Emails.folder edge and that
-- folder's Mailboxes.folders edge. Both relation definitions are resolved by property key on
-- the module-owned database (either side of the definition), and each edge is read from
-- whichever side the item sits on. A message linked to several folders takes the folder with
-- the lowest item id — a pre-#674 message shared by two mailboxes can only keep one of them.
WITH email_folder_defs AS (
  SELECT rd.id
  FROM relation_definitions rd
  JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN databases d ON d.id = p.database_id
  WHERE p.key = 'folder' AND d.owner_module_id = 'emails'
),
mailbox_folder_defs AS (
  SELECT rd.id
  FROM relation_definitions rd
  JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN databases d ON d.id = p.database_id
  WHERE p.key = 'folders' AND d.owner_module_id = 'mailboxes'
),
message_mailbox AS (
  SELECT DISTINCT ON (meta.item_id)
    meta.item_id AS message_item_id,
    CASE WHEN mailbox_folder.item_a = folder.item_id THEN mailbox_folder.item_b ELSE mailbox_folder.item_a END
      AS mailbox_item_id
  FROM mail_message_meta meta
  JOIN item_relations email_folder
    ON email_folder.relation_definition_id IN (SELECT id FROM email_folder_defs)
   AND (email_folder.item_a = meta.item_id OR email_folder.item_b = meta.item_id)
  CROSS JOIN LATERAL (
    SELECT CASE WHEN email_folder.item_a = meta.item_id THEN email_folder.item_b ELSE email_folder.item_a END
      AS item_id
  ) folder
  JOIN item_relations mailbox_folder
    ON mailbox_folder.relation_definition_id IN (SELECT id FROM mailbox_folder_defs)
   AND (mailbox_folder.item_a = folder.item_id OR mailbox_folder.item_b = folder.item_id)
  WHERE meta.mailbox_item_id IS NULL
  ORDER BY meta.item_id, folder.item_id
)
UPDATE mail_message_meta meta
SET mailbox_item_id = mm.mailbox_item_id
FROM message_mailbox mm
WHERE meta.item_id = mm.message_item_id
  AND meta.mailbox_item_id IS NULL;

-- `message_id` leads the index so threading.ts's `message_id = ANY(...)` lookups and the
-- legacy migration's collision check stay indexed once the single-column UNIQUE is gone;
-- `ON CONFLICT (mailbox_item_id, message_id)` infers it by column set, not order.
CREATE UNIQUE INDEX IF NOT EXISTS mail_message_meta_mailbox_message_uq
  ON mail_message_meta (message_id, mailbox_item_id);

ALTER TABLE mail_message_meta DROP CONSTRAINT IF EXISTS mail_message_meta_message_id_key;
