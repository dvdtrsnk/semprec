-- The account address a mailbox was connected as, as the provider reports it (issue #1454).
-- It lives in its own column, apart from `Mailboxes.addresses` (`owner: 'system'` since #1454),
-- so a connect or reauthorization can recognise the same provider account and refuse a second
-- mailbox of the same tenant for it. Stored normalized, as
-- `normalizeEmailAddress` does it (trimmed, lower case). Null means "not recorded yet" and
-- blocks nothing.
--
-- Additive only: a nullable column and an index. The previous release never reads or writes
-- them, so it is unaffected after a rollback. The router grants and `route_gmail_address` do
-- not change: routing still matches `gmail_watch_email_address`.
ALTER TABLE mail_account_sync_state ADD COLUMN provider_account_address text;

-- Backfill for Gmail mailboxes from the watch address, normalized the same way. The unique index
-- below is created after this statement. It is unique per tenant, so two Gmail mailboxes of one
-- tenant that watch the same account cannot both take the address: the lowest item id keeps it
-- and the other stays null, which blocks nothing, instead of failing the migration.
UPDATE mail_account_sync_state AS s
SET provider_account_address = chosen.address
FROM (
  SELECT DISTINCT ON (tenant_id, lower(btrim(gmail_watch_email_address)))
    item_id,
    lower(btrim(gmail_watch_email_address)) AS address
  FROM mail_account_sync_state
  WHERE sync_mode = 'gmail_api' AND gmail_watch_email_address IS NOT NULL
  ORDER BY tenant_id, lower(btrim(gmail_watch_email_address)), item_id
) AS chosen
WHERE s.item_id = chosen.item_id;

-- Tenant-scoped, like every unique key on a tenant table, so the same account may be connected in
-- several tenants. No existing `ON CONFLICT` on this table names this index or sets this column.
CREATE UNIQUE INDEX mail_account_sync_state_tenant_provider_address_uq
  ON mail_account_sync_state (tenant_id, provider_account_address)
  WHERE provider_account_address IS NOT NULL;
