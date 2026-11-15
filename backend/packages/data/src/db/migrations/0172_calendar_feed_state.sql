-- Issue gh-1960: what the hourly download of a subscription calendar's feed (calendar/calendarSubscriptionSweep.ts)
-- keeps between two runs, one row per subscription calendar: the validators of the last feed a consumer took over
-- (etag, last_modified, sent back as If-None-Match and If-Modified-Since) and the hash of the address they came from
-- (feed_url_hash, sent back only to that address, so a calendar whose address changed is requested in full), when the
-- feed was last requested, the HTTP status the last request answered with (NULL when it got no answer) and the short
-- code of the last failure (NULL after a success). The store is calendar/calendarFeedState.ts. The validators advance
-- only after the consumer of the feed succeeded, so a failed import is requested in full again by the next run.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes. A rollback leaves the rows in
-- place and the previous release ignores them.
--
-- calendar_item_id names a Calendars item and carries no foreign key: items is partitioned. The row is deleted when the
-- calendar item is purged, by the item purge hook calendarFeedStatePurgeHook (calendar/calendarFeedStatePurgeHook.ts,
-- registered in domainWriteHooks.ts and run by runItemPurgeHooks,
-- docs/adr/2026-11-10-item-purge-domain-hooks.md). The primary key (tenant_id, calendar_item_id) leads with tenant_id,
-- so a calendar id of another tenant is a different row.
--
-- Role grants are those of `idempotent_responses`: full DML to `semprec_side`, which `semprec_data` inherits through
-- its membership.
CREATE TABLE calendar_feed_state (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  calendar_item_id uuid NOT NULL,
  etag text,
  last_modified text,
  feed_url_hash text,
  last_fetched_at timestamptz,
  last_status integer,
  last_error_code text,
  PRIMARY KEY (tenant_id, calendar_item_id)
);
COMMENT ON TABLE calendar_feed_state IS 'semprec:tenancy=tenant';
ALTER TABLE calendar_feed_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON calendar_feed_state AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON calendar_feed_state AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_feed_state TO semprec_side;
