-- Issue #1659: records, for every item a confirmed Inbox proposal created, which card, Inbox item or
-- transcript and capture time produced it, so a reader can answer "where did this come from" for
-- one item or many rows without walking the card's filtered Processing view.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- `item_id`, `proposal_id`, `inbox_item_id` and `source_transcript_id` name partitioned `items`
-- rows, which have no (tenant_id, id) key to reference, so there is no foreign key to them: the
-- confirm path writes the row and `deleteItemDependents` removes it with the item. The primary key
-- leads with tenant_id, so an id existing in another tenant never collides.
CREATE TABLE item_origins (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  item_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  inbox_item_id uuid,
  source_transcript_id uuid,
  captured_at timestamptz NOT NULL,
  capture_channel text NOT NULL CHECK (capture_channel IN ('inbox', 'transcript')),
  PRIMARY KEY (tenant_id, item_id)
);
CREATE INDEX item_origins_tenant_proposal_idx ON item_origins (tenant_id, proposal_id);
COMMENT ON TABLE item_origins IS 'semprec:tenancy=tenant';
ALTER TABLE item_origins ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_origins AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON item_origins AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON item_origins TO semprec_side;
