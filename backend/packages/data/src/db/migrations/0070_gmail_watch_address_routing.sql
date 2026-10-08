-- Gmail Pub/Sub dispatch (docs/adr/2026-10-07-cross-tenant-router-functions.md): one shared
-- subscription carries every tenant's notifications, each naming only the Google account's
-- address. `gmail_watch_email_address` records the address the Google account behind the
-- mailbox's credential was watched as (written by the watch-renewal lifecycle from the account
-- the credential authenticates, never from the user-editable `Mailboxes.addresses`), so one
-- tenant cannot claim another's pushes. `route_gmail_address` maps an address to every
-- matching (tenant, mailbox) past row-level security and returns ids only; the dispatcher then
-- enqueues each target's sync inside that target's tenant. The index is not unique: one
-- address may be connected in several tenants.
--
-- Additive only: a nullable column, an index, a grant and a new function. The previous release
-- never reads or writes any of them and is unaffected after a rollback.
ALTER TABLE mail_account_sync_state ADD COLUMN gmail_watch_email_address text;

CREATE INDEX mail_account_sync_state_gmail_watch_email_idx
  ON mail_account_sync_state (gmail_watch_email_address) WHERE gmail_watch_email_address IS NOT NULL;

GRANT SELECT (item_id, tenant_id, sync_mode, gmail_watch_email_address) ON mail_account_sync_state TO semprec_router;

CREATE FUNCTION route_gmail_address(email_address text) RETURNS TABLE (tenant_id uuid, mailbox_item_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, s.item_id FROM public.mail_account_sync_state s
  WHERE s.sync_mode = 'gmail_api' AND s.gmail_watch_email_address = email_address
$$;

ALTER FUNCTION route_gmail_address(text) OWNER TO semprec_router;
REVOKE EXECUTE ON FUNCTION route_gmail_address(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_gmail_address(text) TO semprec_data;
